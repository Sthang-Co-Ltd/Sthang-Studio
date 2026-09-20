import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildCaptionWordTiming,
  DEFAULT_CAPTION_APPEARANCE,
  planCaptionRenderStates,
  type CaptionAppearance,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
  type VideoExportCapabilities,
} from '@kcs/shared';

// Synthetic local media only. Native fonts are staged under this disposable root.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-effects-native-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { buildAssDocument, buildAssCaptionFilter, fontCapabilities, prepareCaptionFonts } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { disposePersistentCaptionPreviews, persistentPreviewDiagnostics, previewSample } = await import('../apps/server/src/services/persistent-caption-preview.js');
const { probeVideoExportCapabilities, renderCaptionedVideo } = await import('../apps/server/src/services/video-export.js');
after(async () => { await disposePersistentCaptionPreviews(); await fs.rm(root, { recursive: true, force: true }); });

const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'Effects native tests require a reviewed regular+bold Khmer font.');
const baseAppearance: CaptionAppearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name };
const width = 640;
const height = 360;
const background = [32, 64, 96] as const;
const previewCapabilities: VideoExportCapabilities = {
  supported: true,
  fonts,
  subtitlesFilter: true,
  encoders: [],
  resolutions: [],
  availableDiskBytes: 0,
  warnings: [],
  source: { width, height, displayWidth: width, displayHeight: height, rotation: 0, durationMs: 2000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
};

function ffmpeg(args: string[], input?: Buffer) {
  return execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    input,
    maxBuffer: 160 * 1024 * 1024,
    windowsHide: true,
    timeout: 30_000,
  });
}

function decodePng(png: string) {
  return ffmpeg(['-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], Buffer.from(png, 'base64'));
}

const fontDir = await prepareCaptionFonts(root, baseAppearance);

async function renderDocument(document: string, atMs: number) {
  const dir = await fs.mkdtemp(path.join(root, 'ass-frame-'));
  try {
    const file = path.join(dir, 'captions.ass');
    await fs.writeFile(file, document, 'utf8');
    return ffmpeg([
      '-f', 'lavfi', '-i', `color=0x204060:s=${width}x${height}:r=1,format=rgba`,
      '-vf', `settb=1/1000,setpts=${atMs},${buildAssCaptionFilter(file, fontDir)}`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function renderFull(captions: CaptionSegment[], appearance: CaptionAppearance, atMs: number) {
  return renderDocument(buildAssDocument(captions, appearance, width, height), atMs);
}

async function renderFrozen(captions: CaptionSegment[], appearance: CaptionAppearance, sampleAtMs: number) {
  return renderDocument(buildAssDocument(captions, appearance, width, height, undefined, sampleAtMs), 0);
}

function spokenCue(): CaptionSegment {
  const caption: CaptionSegment = { id: 'spoken', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា' };
  const tokens: TimedToken[] = [
    { id: 'khmer', text: 'ខ្មែរ', startMs: 180, endMs: 340, spaceBefore: false, timingSource: 'stt' },
    { id: 'cambodia', text: 'កម្ពុជា', startMs: 500, endMs: 700, spaceBefore: false, timingSource: 'stt' },
  ];
  const wordTiming = buildCaptionWordTiming(caption, tokens);
  assert.ok(wordTiming);
  return { ...caption, wordTiming };
}

function whiteCoreBounds(frame: Buffer) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    if (frame[offset] < 245 || frame[offset + 1] < 245 || frame[offset + 2] < 245) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function paintedBounds(frame: Buffer) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const delta = Math.abs(frame[offset] - background[0]) + Math.abs(frame[offset + 1] - background[1]) + Math.abs(frame[offset + 2] - background[2]);
    if (delta <= 5) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function assertRegionEqual(left: Buffer, right: Buffer, bounds: NonNullable<ReturnType<typeof paintedBounds>>, label: string) {
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    assert.deepEqual(left.subarray(offset, offset + 4), right.subarray(offset, offset + 4), `${label} at ${x},${y}`);
  }
}

function meanAbsoluteError(left: Buffer, right: Buffer) {
  assert.equal(left.length, right.length);
  let error = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) error += Math.abs(left[offset + channel] - right[offset + channel]);
  }
  return error / (left.length / 4 * 3);
}

function unionBounds(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) {
  const x = Math.min(left.x, right.x), y = Math.min(left.y, right.y);
  const endX = Math.max(left.x + left.width, right.x + right.width), endY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: endX - x, height: endY - y };
}

function previewPaintedPixels(frame: Buffer) {
  let count = 0;
  for (let offset = 3; offset < frame.length; offset += 4) if (frame[offset] > 4) count += 1;
  return count;
}

function previewAlphaEnergy(frame: Buffer) {
  let energy = 0;
  for (let offset = 3; offset < frame.length; offset += 4) energy += frame[offset] / 255;
  return energy;
}

function roiCompositeError(encoded: Buffer, preview: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let error = 0, count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4, alpha = preview[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      error += Math.abs(encoded[offset + channel] - (preview[offset + channel] * alpha + background[channel] * (1 - alpha)));
      count += 1;
    }
  }
  return count ? error / count : Infinity;
}

function roiPaintEnergy(encoded: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let energy = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    energy += Math.abs(encoded[offset] - background[0]) + Math.abs(encoded[offset + 1] - background[1]) + Math.abs(encoded[offset + 2] - background[2]);
  }
  return energy;
}

function fullFrameBackgroundError(encoded: Buffer) {
  let error = 0, count = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) for (let channel = 0; channel < 3; channel += 1) {
    error += Math.abs(encoded[offset + channel] - background[channel]); count += 1;
  }
  return error / count;
}

test('fade planner uses at most 16 opacity levels, reuses symmetric paint keys, and keeps short cues visible', () => {
  const appearance = { motionPreset: 'fade' as const, motionDurationMs: 160 };
  const cue = { id: 'fade', startMs: 100, endMs: 900, text: 'ខ្មែរ' };
  const states = planCaptionRenderStates([cue], false, appearance).filter((state) => state.key === '0');
  const levels = new Set(states.flatMap((state) => state.cueOpacities || []).map((cueOpacity) => Math.round(cueOpacity.opacity * 15)));
  assert.ok(levels.size <= 16);
  assert.ok(levels.has(0));
  assert.ok(levels.has(15));
  const repeatedPaint = new Map<string, number>();
  for (const state of states) repeatedPaint.set(state.paintKey!, (repeatedPaint.get(state.paintKey!) || 0) + 1);
  assert.ok([...repeatedPaint.values()].some((count) => count > 1), 'fade-in/out should reuse identical quantized paint identities');

  for (const duration of [10, 20, 40]) {
    const short = planCaptionRenderStates([{ id: `short-${duration}`, startMs: 0, endMs: duration, text: 'ខ្មែរ' }], false, appearance);
    assert.ok(short.some((state) => state.cueOpacities?.[0]?.opacity === 1), `${duration}ms cue must reach full opacity`);
  }

  const overlap = planCaptionRenderStates([
    { id: 'a', startMs: 100, endMs: 900, text: 'A' },
    { id: 'b', startMs: 400, endMs: 1000, text: 'B' },
  ], false, appearance).find((state) => state.atMs === 400);
  assert.equal(overlap?.key, '0,1');
  assert.deepEqual(overlap?.cueOpacities, [{ captionIndex: 0, opacity: 1 }, { captionIndex: 1, opacity: 0 }]);
});

test('fade composes with background/glow alpha without exposing lower-layer glyph fills', () => {
  const style: CaptionAppearance = {
    ...baseAppearance,
    backgroundEnabled: true,
    backgroundOpacity: 0.58,
    glowEnabled: true,
    glowColor: '#D7FF4F',
    glowWidth1080: 6,
    glowOpacity: 0.55,
    motionPreset: 'fade',
    motionDurationMs: 160,
  };
  const caption = [{ id: 'a', startMs: 100, endMs: 900, text: 'ខ្មែរ' }];
  const state = planCaptionRenderStates(caption, false, style).find((item) => item.atMs === 180)!;
  const opacity = state.cueOpacities![0].opacity;
  const alpha = (value: number) => Math.round((1 - value) * 255).toString(16).toUpperCase().padStart(2, '0');
  const doc = buildAssDocument(caption, style, width, height, undefined, 180);
  const dialogue = Object.fromEntries(doc.split('\n').filter((line) => line.startsWith('Dialogue:')).map((line) => [line.split(',')[3], line]));
  assert.match(dialogue.Glow, /\\blur1(?:\.0)?/, '360p Glow derives a 1px blur from the scaled 6px-at-1080 glow width');
  assert.doesNotMatch(dialogue.Background, /\\blur/);
  assert.doesNotMatch(dialogue.Default, /\\blur/);
  assert.match(dialogue.Glow, new RegExp(`\\\\1a&HFF&\\\\3a&H${alpha(style.glowOpacity! * opacity)}&\\\\4a&HFF&`));
  assert.match(dialogue.Background, new RegExp(`\\\\1a&HFF&\\\\3a&H${alpha(style.backgroundOpacity * opacity)}&\\\\4a&HFF&`));
  assert.match(dialogue.Default, new RegExp(`\\\\1a&H${alpha(opacity)}&\\\\3a&H${alpha(opacity)}&`));
  assert.match(dialogue.Glow, /ខ្មែរ/);
  assert.match(dialogue.Background, /ខ្មែរ/);

  const staticDoc = buildAssDocument(caption, { ...style, glowEnabled: false, backgroundEnabled: false, motionPreset: 'none' }, width, height);
  assert.doesNotMatch(staticDoc, /\\1a&H/);
  assert.match(buildAssDocument(caption, style, 1920, 1080), /Dialogue: \d+,[^\n]*,Glow,[^\n]*\{\\blur3\}/);
  assert.match(buildAssDocument(caption, style, 3840, 2160), /Dialogue: \d+,[^\n]*,Glow,[^\n]*\{\\blur6\}/);
  assert.doesNotMatch(buildAssDocument(caption, style, width, height, new Set([0]), 180), /\\blur/, 'focus-mask geometry ignores visual glow blur');
});

test('full timeline and persistent compact snapshots match through fades, words, overlaps and gaps', async () => {
  const captions: CaptionSegment[] = [
    spokenCue(),
    { id: 'second', startMs: 400, endMs: 1000, text: 'Second ខ្មែរ' },
  ];
  const style: CaptionAppearance = {
    ...baseAppearance,
    highlightMode: 'word',
    highlightColor: '#D7FF4F',
    glowEnabled: true,
    glowColor: '#D7FF4F',
    glowWidth1080: 6,
    glowOpacity: 0.55,
    motionPreset: 'fade',
    motionDurationMs: 160,
  };
  const input = { captions, appearance: style, timesMs: [] as number[] };
  for (const atMs of [120, 220, 360, 430, 560, 860, 1050]) {
    const sample = previewSample(input, atMs);
    const whole = await renderFull(captions, style, atMs);
    const frozen = await renderFrozen(sample.captions, style, sample.sampleAtMs);
    assert.deepEqual(frozen, whole, `persistent snapshot must freeze the exact whole-timeline paint at ${atMs}ms`);
  }
});

test('overlapping cues reset native alpha at every line so a full cue never inherits its neighbor fade', async () => {
  const fadingStyle: CaptionAppearance = {
    ...baseAppearance,
    outlineWidth1080: 0,
    shadowWidth1080: 0,
    backgroundEnabled: false,
    glowEnabled: false,
    motionPreset: 'fade',
    motionDurationMs: 160,
  };
  const staticStyle: CaptionAppearance = { ...fadingStyle, motionPreset: 'none' };
  const short: CaptionSegment = { id: 'short', startMs: 100, endMs: 900, text: 'ខ្មែរ' };
  const long: CaptionSegment = { id: 'long', startMs: 400, endMs: 1200, text: 'កម្ពុជា' };
  const atMs = 860;

  for (const fixture of [
    { captions: [short, long], fullIndex: 1, label: 'faded first, full second' },
    { captions: [long, short], fullIndex: 0, label: 'full first, faded second' },
  ]) {
    const fadeFrame = await renderFull(fixture.captions, fadingStyle, atMs);
    const staticFrame = await renderFull(fixture.captions, staticStyle, atMs);
    assert.notDeepEqual(fadeFrame, staticFrame, `${fixture.label}: neighboring cue should actually be faded`);
    const mask = await renderDocument(buildAssDocument(fixture.captions, fadingStyle, width, height, new Set([fixture.fullIndex])), atMs);
    const bounds = paintedBounds(mask);
    assert.ok(bounds, `${fixture.label}: selected full-opacity cue needs native bounds`);
    assertRegionEqual(fadeFrame, staticFrame, bounds, `${fixture.label}: full-opacity cue pixels`);
  }
});

test('eight-frame fade preparation keeps pixel parity while using the faster bounded one-shot batch', async () => {
  await disposePersistentCaptionPreviews();
  const input = parseCaptionPreviewInput({
    captions: [{ id: 'fade-batch', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា' }],
    timesMs: [120, 140, 160, 180, 200, 220, 240, 260],
    resolution: 'source',
    appearance: { ...baseAppearance, motionPreset: 'fade', motionDurationMs: 160, glowEnabled: true },
  });
  const expected = await renderCaptionPreview(input, previewCapabilities);
  const before = persistentPreviewDiagnostics();
  const actual = await renderCaptionPreview(input, previewCapabilities, undefined, { projectId: 'fade-batch', mediaIdentity: 'v1' });
  const after = persistentPreviewDiagnostics();
  assert.deepEqual(actual, expected);
  assert.equal(after.starts, before.starts, 'full replay batch should not start the per-frame persistent transport');
  assert.equal(after.workers, 0);
});

test('native glow paints a halo without moving the white Khmer glyph core', async () => {
  const captions = [{ id: 'khmer', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា' }];
  const clean: CaptionAppearance = { ...baseAppearance, outlineWidth1080: 2, shadowWidth1080: 0, motionPreset: 'none', glowEnabled: false };
  const glow: CaptionAppearance = { ...clean, glowEnabled: true, glowColor: '#D7FF4F', glowWidth1080: 6, glowOpacity: 0.55 };
  const cleanFrame = await renderFull(captions, clean, 400);
  const glowDocument = buildAssDocument(captions, glow, width, height);
  assert.match(glowDocument, /\{\\blur1\}/);
  const glowFrame = await renderDocument(glowDocument, 400);
  const hardGlowFrame = await renderDocument(glowDocument.replace(/\{\\blur[^}]+\}/g, ''), 400);
  assert.deepEqual(whiteCoreBounds(glowFrame), whiteCoreBounds(cleanFrame), 'lower glow layer must not move the shaped white glyph core');
  assert.notDeepEqual(glowFrame, hardGlowFrame, 'native blur must soften the Glow beyond the underlying wide outline');
  const softBounds = paintedBounds(glowFrame);
  const hardBounds = paintedBounds(hardGlowFrame);
  assert.ok(softBounds && hardBounds);
  assert.ok(softBounds.width >= hardBounds.width && softBounds.height >= hardBounds.height, 'soft glow must not contract the painted halo bounds');
  let changed = 0;
  let limeLift = 0;
  for (let offset = 0; offset < cleanFrame.length; offset += 4) {
    const delta = Math.abs(glowFrame[offset] - cleanFrame[offset]) + Math.abs(glowFrame[offset + 1] - cleanFrame[offset + 1]) + Math.abs(glowFrame[offset + 2] - cleanFrame[offset + 2]);
    if (delta > 8) changed += 1;
    if (glowFrame[offset + 1] > cleanFrame[offset + 1] + 8 && glowFrame[offset] > cleanFrame[offset] + 5) limeLift += 1;
  }
  assert.ok(changed > 100, 'glow must paint a visible native halo');
  assert.ok(limeLift > 50, 'halo must use the configured lime glow paint');
});

test('actual MP4 matches exact Fade/Glow preview at entry, middle, exit and post-end with visible ROI evidence', async () => {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = 'effects-synthetic.mp4';
  const sourcePath = path.join(config.uploadDir, filename);
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const sourceBytes = await fs.readFile(sourcePath);
  const captions = [spokenCue()];
  const style: CaptionAppearance = {
    ...baseAppearance,
    glowEnabled: true,
    glowColor: '#D7FF4F',
    glowWidth1080: 6,
    glowOpacity: 0.55,
    motionPreset: 'fade',
    motionDurationMs: 160,
  };
  const now = new Date().toISOString();
  const project: CaptionProject = {
    id: 'effects-native', title: 'Effects synthetic', createdAt: now, updatedAt: now,
    media: { filename, originalName: filename, mimeType: 'video/mp4', size: sourceBytes.length, url: `/media/${filename}` },
    transcript: null, captions, mode: 'phrase', captionAppearance: style,
  };
  const capabilities = await probeVideoExportCapabilities(project);
  assert.ok(capabilities.supported, capabilities.blockingReason);
  const rendered = await renderCaptionedVideo(project, captions, style, { encoder: 'software', quality: 'high' });
  const outputPath = path.join(config.exportDir, rendered.filename);
  const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions, timesMs: [160, 400, 840, 920], appearance: style, resolution: 'source', focusIndices: [0] }), capabilities);
  const comparisonRoi = unionBounds(preview.frames[0].focusBounds!, preview.frames[1].focusBounds!);
  const previewEnergy: number[] = [], mp4Energy: number[] = [];
  for (const frame of preview.frames.slice(0, 3)) {
    assert.ok(frame.bounds && frame.focusBounds, `Fade/${frame.atMs}: preview must contain visible caption paint`);
    const transparent = decodePng(frame.png);
    assert.ok(previewPaintedPixels(transparent) > 20, `Fade/${frame.atMs}: preview cannot pass as a blank frame`);
    const encoded = ffmpeg(['-ss', String(frame.atMs / 1000), '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    assert.ok(roiCompositeError(encoded, transparent, comparisonRoi) < 8, `Fade/${frame.atMs}: MP4 union ROI must match exact preview paint`);
    previewEnergy.push(previewAlphaEnergy(transparent));
    mp4Energy.push(roiPaintEnergy(encoded, comparisonRoi));
  }
  assert.ok(previewEnergy[2] > 0 && previewEnergy[2] < previewEnergy[1], 'Fade exit preview stays visible but below middle paint energy');
  assert.ok(mp4Energy[2] > 0 && mp4Energy[2] < mp4Energy[1], 'Fade exit MP4 stays visible but below middle paint energy');
  const post = preview.frames[3];
  assert.equal(post.bounds, null);
  assert.equal(post.focusBounds, null);
  assert.equal(previewPaintedPixels(decodePng(post.png)), 0, 'Fade post-end preview must be truly blank');
  const postEncoded = ffmpeg(['-ss', String(post.atMs / 1000), '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  assert.ok(fullFrameBackgroundError(postEncoded) < 5, 'Fade post-end MP4 full frame must return to source background');
});
