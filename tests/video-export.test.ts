import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPTION_APPEARANCE,
  type VideoExportSourceInfo,
} from '@kcs/shared';
import {
  buildAssDocument,
  classifyHdr,
  escapeAssText,
  estimateVideoExportBytes,
  normalizeCaptionAppearance,
  normalizeVideoExportSettings,
  parseRate,
  resolveVideoDimensions,
} from '../apps/server/src/services/video-export.js';

const source: VideoExportSourceInfo = {
  width: 1920,
  height: 1080,
  displayWidth: 1920,
  displayHeight: 1080,
  rotation: 0,
  durationMs: 60_000,
  frameRate: 30,
  variableFrameRate: false,
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  colorRange: 'tv',
  hdr: 'sdr',
  audioCodecs: ['aac'],
  audioStreams: 1,
};

test('resolution presets preserve orientation and aspect ratio without cropping', () => {
  assert.deepEqual(resolveVideoDimensions(1920, 1080, '720p'), { width: 1280, height: 720, upscaled: false });
  assert.deepEqual(resolveVideoDimensions(1080, 1920, '2160p'), { width: 2160, height: 3840, upscaled: true });
  assert.deepEqual(resolveVideoDimensions(1080, 1080, '2160p'), { width: 2160, height: 2160, upscaled: true });
  assert.deepEqual(resolveVideoDimensions(1919, 1079, 'source'), { width: 1920, height: 1080, upscaled: false });

  // Portrait 1080p is a 1080x1920 envelope, so a 4:5 source already fits at source size.
  const unusual = resolveVideoDimensions(1080, 1350, '1080p');
  assert.equal(unusual.width, 1080);
  assert.equal(unusual.height, 1350);
  assert.equal(unusual.upscaled, false);
});

test('frame-rate parsing handles common rational and invalid values', () => {
  assert.ok(Math.abs(parseRate('30000/1001') - 29.97002997) < 0.0001);
  assert.equal(parseRate('25/1'), 25);
  assert.equal(parseRate('0/0'), 0);
  assert.equal(parseRate('not-a-rate'), 0);
});

test('HDR classification is fail-safe for PQ, HLG and Dolby Vision', () => {
  assert.equal(classifyHdr({ color_transfer: 'smpte2084' }), 'hdr10');
  assert.equal(classifyHdr({ color_transfer: 'arib-std-b67' }), 'hlg');
  assert.equal(classifyHdr({ codec_tag_string: 'dvh1' }), 'dolby-vision');
  assert.equal(classifyHdr({ color_primaries: 'bt2020', color_transfer: 'smpte428' }), 'unknown-hdr');
  assert.equal(classifyHdr({ color_primaries: 'bt709', color_transfer: 'bt709' }), 'sdr');
});

test('video settings normalization rejects invalid or extreme inputs', () => {
  assert.deepEqual(normalizeVideoExportSettings({}), {
    resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto',
  });
  assert.deepEqual(normalizeVideoExportSettings({
    resolution: '2160p', frameRate: 60, quality: 'high', codec: 'hevc', encoder: 'nvidia', customBitrateMbps: 80,
  }), {
    resolution: '2160p', frameRate: 60, quality: 'high', codec: 'hevc', encoder: 'nvidia', customBitrateMbps: 80,
  });
  assert.deepEqual(normalizeVideoExportSettings({
    resolution: 'bad' as never, frameRate: 120 as never, quality: 'bad' as never, codec: 'bad' as never, encoder: 'bad' as never, customBitrateMbps: 1000,
  }), {
    resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto',
  });
});

test('caption appearance normalization clamps values and sanitizes colors', () => {
  const result = normalizeCaptionAppearance({
    fontFamily: '  Khmer UI  ',
    fontSize1080: 999,
    textColor: 'red',
    outlineColor: '#123abc',
    outlineWidth1080: -4,
    shadowWidth1080: 99,
    backgroundOpacity: 5,
    positionBottomPct: -20,
    maxWidthPct: 200,
  });
  assert.equal(result.fontFamily, 'Khmer UI');
  assert.equal(result.fontSize1080, 120);
  assert.equal(result.textColor, DEFAULT_CAPTION_APPEARANCE.textColor);
  assert.equal(result.outlineColor, '#123ABC');
  assert.equal(result.outlineWidth1080, 0);
  assert.equal(result.shadowWidth1080, 12);
  assert.equal(result.backgroundOpacity, 1);
  assert.equal(result.positionBottomPct, 3);
  assert.equal(result.maxWidthPct, 96);
});

test('ASS escaping prevents control injection while preserving explicit line breaks', () => {
  const escaped = escapeAssText('ខ្មែរ\\N{\\bord50}\nSecond');
  assert.equal(escaped.includes('{'), false);
  assert.equal(escaped.includes('}'), false);
  assert.equal(escaped.includes('\\bord50'), false);
  assert.ok(escaped.includes('\\NSecond'));
});

test('ASS rendering scales style to output and wraps long Khmer on grapheme boundaries', () => {
  const longKhmer = 'ខ្មែរជាភាសារបស់យើងដែលត្រូវការការបង្ហាញច្បាស់លាស់ក្នុងវីដេអូខ្លីៗដោយមិនពឹងផ្អែកលើចន្លោះពាក្យ';
  const document = buildAssDocument([
    { id: '1', startMs: 0, endMs: 2500, text: longKhmer },
  ], {
    ...DEFAULT_CAPTION_APPEARANCE,
    fontSize1080: 72,
    maxWidthPct: 45,
    positionBottomPct: 10,
  }, 3840, 2160);

  assert.match(document, /PlayResX: 3840/);
  assert.match(document, /PlayResY: 2160/);
  assert.match(document, /Style: Default,Khmer UI,144/);
  assert.match(document, /Dialogue: 0,0:00:00\.00,0:00:02\.50/);
  assert.ok(document.includes('\\N'), 'long Khmer should receive an explicit render-only wrap');
  assert.ok(document.includes(longKhmer.slice(0, 4)), 'Khmer graphemes should remain in the render document');
});

test('quality and resolution materially change the estimated output size', () => {
  const smaller = estimateVideoExportBytes(source, { resolution: '1080p', frameRate: 'source', quality: 'smaller', codec: 'h264', encoder: 'auto' });
  const high = estimateVideoExportBytes(source, { resolution: '1080p', frameRate: 'source', quality: 'high', codec: 'h264', encoder: 'auto' });
  const fourK = estimateVideoExportBytes(source, { resolution: '2160p', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' });
  assert.ok(high > smaller);
  assert.ok(fourK > smaller);
});
