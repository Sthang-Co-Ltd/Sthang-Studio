import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionAppearance, type CaptionProject, type CaptionSegment, type VideoExportCapabilities } from '@kcs/shared';

// Only synthetic media, isolated state, no API keys/network/Gemini calls. This suite is
// deliberately separate from portable unit tests and fails if native prerequisites are absent.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-native-test-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { buildAssDocument, buildAssCaptionFilter, fontCapabilities, prepareCaptionFonts } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { renderCaptionedVideo, probeVideoExportCapabilities } = await import('../apps/server/src/services/video-export.js');
after(() => fs.rm(root, { recursive: true, force: true }));

const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'Native tests require a reviewed regular+bold Khmer font (Windows Khmer UI or Linux Noto Sans Khmer).');
const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name };
const source = { width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0, durationMs: 4000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr' as const, audioCodecs: [], audioStreams: 0 };
const capabilities: VideoExportCapabilities = { supported: true, source, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [] };

function ffmpeg(args: string[], input?: Buffer) {
  return execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { input, maxBuffer: 160 * 1024 * 1024, windowsHide: true, timeout: 30_000 });
}

function decodePng(png: string) {
  return ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], Buffer.from(png, 'base64'));
}

async function referenceFrame(captions: CaptionSegment[], style: CaptionAppearance, width: number, height: number, atMs: number) {
  const dir = await fs.mkdtemp(path.join(root, 'reference-'));
  try {
    const file = path.join(dir, 'captions.ass');
    await fs.writeFile(file, buildAssDocument(captions, style, width, height));
    const fontsDir = await prepareCaptionFonts(dir, style);
    return ffmpeg(['-f', 'lavfi', '-i', `color=0x204060:s=${width}x${height}:r=1,format=rgba`, '-vf', `settb=1/1000,setpts=${atMs},${buildAssCaptionFilter(file, fontsDir)}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function compareComposite(png: Buffer, direct: Buffer, label: string) {
  assert.equal(png.length, direct.length, label);
  let affected = 0;
  let totalError = 0;
  let largeErrors = 0;
  for (let offset = 0; offset < png.length; offset += 4) {
    const alpha = png[offset + 3] / 255;
    const nativePaint = [32, 64, 96].some((base, channel) => Math.abs(direct[offset + channel] - base) > 1);
    if (!alpha && !nativePaint) continue;
    affected += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const composited = Math.round(png[offset + channel] * alpha + [32, 64, 96][channel] * (1 - alpha));
      const error = Math.abs(composited - direct[offset + channel]);
      totalError += error;
      if (error > 6) largeErrors += 1;
    }
  }
  assert.ok(affected > 20, `${label}: must paint actual glyphs`);
  // Straight-alpha conversion and integer compositing can differ by a few code values.
  // A different font/position/size/box/shadow affects thousands of pixels, not that rounding.
  assert.ok(totalError / (affected * 3) < 1.5, `${label}: mean painted-pixel error ${totalError / (affected * 3)}`);
  assert.equal(largeErrors, 0, `${label}: unexpected geometry/color differences`);
}

const sample = 'កម្ពុជា CapCut 2026\nខ្មែរជាភាសារបស់យើង';
const cue = (text = sample): CaptionSegment[] => [{ id: 'first', startMs: 100, endMs: 2000, text }];

test('native preview matches ASS rasterization across fonts, sizes, layouts and every appearance control', async () => {
  const styles: CaptionAppearance[] = [
    appearance,
    { ...appearance, bold: false, fontSize1080: 22, alignment: 'left', positionBottomPct: 3, maxWidthPct: 96, outlineWidth1080: 0, shadowWidth1080: 0 },
    { ...appearance, fontSize1080: 120, alignment: 'right', positionBottomPct: 82, maxWidthPct: 45, textColor: '#FF8000', outlineColor: '#1A80FF', outlineWidth1080: 12, shadowWidth1080: 12 },
    { ...appearance, backgroundEnabled: true, backgroundColor: '#2080F0', backgroundOpacity: 0.58, backgroundPadding1080: 8 },
    { ...appearance, backgroundEnabled: true, backgroundColor: '#FF0033', backgroundOpacity: 1, backgroundPadding1080: 28, outlineWidth1080: 0, shadowWidth1080: 0 },
    { ...appearance, backgroundEnabled: true, backgroundOpacity: 0.05, backgroundPadding1080: 0, outlineWidth1080: 5.5, shadowWidth1080: 8.5, fontSize1080: 71.3 },
  ];
  for (const [width, height] of [[640, 360], [360, 640], [1080, 1080]]) {
    for (const [index, style] of styles.entries()) {
      const caps = { ...capabilities, source: { ...source, displayWidth: width, displayHeight: height } };
      const result = await renderCaptionPreview(parseCaptionPreviewInput({ captions: cue(), timesMs: [200], appearance: style, resolution: 'source' }), caps);
      const png = decodePng(result.frames[0].png);
      const reference = await referenceFrame(cue(), style, width, height, 200);
      compareComposite(png, reference, `${width}x${height}/style-${index}`);
    }
  }
});

test('native batch seeks respect gaps, overlaps and literal ASS-looking creator text', async () => {
  const captions = [...cue('កម្ពុជា \\N {\\bord50} CapCut'), { id: 'second', startMs: 500, endMs: 2500, text: 'Second line ខ្មែរ' }];
  const result = await renderCaptionPreview(parseCaptionPreviewInput({ captions, timesMs: [0, 100, 500, 2200, 2700], appearance, resolution: 'source' }), capabilities);
  assert.equal(result.frames[0].bounds, null);
  assert.equal(result.frames[4].bounds, null);
  for (const frame of result.frames.slice(1, 4)) compareComposite(decodePng(frame.png), await referenceFrame(captions, appearance, 640, 360, frame.atMs), `seek-${frame.atMs}`);
  assert.ok(result.frames[2].bounds!.height > result.frames[1].bounds!.height, 'overlapping captions are both rendered, not just the first match');
});

test('native filter paths survive apostrophes, spaces and filtergraph punctuation', async () => {
  const dir = path.join(root, "creator's [captions], v2;");
  await fs.mkdir(dir);
  const file = path.join(dir, 'captions.ass');
  await fs.writeFile(file, buildAssDocument(cue(), appearance, 640, 360));
  const fontsDir = await prepareCaptionFonts(dir, appearance);
  assert.doesNotThrow(() => ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=1', '-vf', buildAssCaptionFilter(file, fontsDir), '-frames:v', '1', '-f', 'null', '-']));
});

test('cancelled and rejected previews clean up after the native child has actually started', async (t) => {
  const input = parseCaptionPreviewInput({ captions: cue(), timesMs: [100], appearance, resolution: '2160p' });
  const controller = new AbortController();
  let nativeStarted = false;
  const addListener = controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal, 'addEventListener', (type, listener, options) => {
    addListener(type, listener, options);
    // The subprocess installs this listener after spawn. Abort there, rather than before
    // setup, so removing process cancellation would fail this test instead of passing it.
    if (type === 'abort') { nativeStarted = true; queueMicrotask(() => controller.abort()); }
  });
  await assert.rejects(renderCaptionPreview(input, capabilities, controller.signal), /Caption preview cancelled/);
  assert.equal(nativeStarted, true, 'must exercise a running native child');
  await assert.rejects(renderCaptionPreview({ ...input, appearance: { ...appearance, fontFamily: 'Missing Font' } }, capabilities), /unavailable/);
  const remaining = await fs.readdir(path.join(config.exportDir, '.working')).catch(() => []);
  assert.deepEqual(remaining, []);
});

test('real MP4 export uses the selected native look and accepts valid small files without modifying the source', async () => {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = 'synthetic.mp4';
  const input = path.join(config.uploadDir, filename);
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
  const original = await fs.readFile(input);
  const project: CaptionProject = { id: 'native-fixture', title: 'Synthetic renderer test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), media: { filename, originalName: filename, mimeType: 'video/mp4', size: original.length, url: `/media/${filename}` }, transcript: null, captions: cue(), mode: 'phrase', captionAppearance: appearance };
  const caps = await probeVideoExportCapabilities(project);
  assert.ok(caps.supported, caps.blockingReason);
  const rendered = await renderCaptionedVideo(project, cue(), appearance, { encoder: 'software', quality: 'high' });
  assert.ok(rendered.sizeBytes > 0 && rendered.sizeBytes < 16_384, 'fixture exercises valid small-file verification');
  assert.equal(createHash('sha256').update(await fs.readFile(input)).digest('hex'), createHash('sha256').update(original).digest('hex'));
  const raw = ffmpeg(['-ss', '0.2', '-i', path.join(config.exportDir, rendered.filename), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions: cue(), timesMs: [200], appearance, resolution: 'source' }), caps);
  const pixels = decodePng(preview.frames[0].png);
  const box = preview.frames[0].bounds!;
  let error = 0, count = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) {
    const offset = (y * 640 + x) * 4; const alpha = pixels[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) { error += Math.abs(raw[offset + channel] - (pixels[offset + channel] * alpha + [32,64,96][channel] * (1 - alpha))); count += 1; }
  }
  assert.ok(error / count < 8, `lossy MP4 caption region differs unexpectedly: ${error / count}`);
});


test('Review Focus isolates selected overlapping cues without altering preview or export pixels', async () => {
  const captions = [...cue('កម្ពុជា CapCut'), { id: 'second', startMs: 500, endMs: 2500, text: 'Second caption ខ្មែរ' }];
  const input = parseCaptionPreviewInput({ captions, timesMs: [600], appearance, resolution: 'source' });
  const normal = await renderCaptionPreview(input, capabilities);
  const first = await renderCaptionPreview({ ...input, focusIndices: [0] }, capabilities);
  const second = await renderCaptionPreview({ ...input, focusIndices: [1] }, capabilities);
  assert.equal(first.frames[0].png, normal.frames[0].png);
  assert.equal(second.frames[0].png, normal.frames[0].png);
  assert.ok(first.frames[0].focusBounds && second.frames[0].focusBounds);
  assert.ok(first.frames[0].focusBounds.y < second.frames[0].focusBounds.y);
  assert.ok(first.frames[0].focusBounds.height < normal.frames[0].bounds!.height);
  assert.ok(second.frames[0].focusBounds.height < normal.frames[0].bounds!.height);
});


test('selected output resolutions use the same native font geometry rather than a source-size CSS approximation', async () => {
  const style = { ...appearance, fontSize1080: 71.3, backgroundEnabled: true, shadowWidth1080: 8.5 };
  for (const resolution of ['720p', '1080p', '1440p', '2160p'] as const) {
    const result = await renderCaptionPreview(parseCaptionPreviewInput({ captions: cue(), timesMs: [200], appearance: style, resolution }), capabilities);
    assert.notEqual(result.width, source.displayWidth);
    compareComposite(decodePng(result.frames[0].png), await referenceFrame(cue(), style, result.width, result.height, 200), resolution);
  }
});

test('native preview concurrency is bounded and cancelled work frees both slots', async () => {
  const input = parseCaptionPreviewInput({ captions: cue(), timesMs: [100], appearance, resolution: 'source' });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) => renderCaptionPreview(input, capabilities, controller.signal));
  const settled = Promise.allSettled(pending);
  try {
    await assert.rejects(renderCaptionPreview(input, capabilities), /preview is busy/);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await settled;
  }
  const retry = await renderCaptionPreview(input, capabilities);
  assert.ok(retry.frames[0].bounds);
});
