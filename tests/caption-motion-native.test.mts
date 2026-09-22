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
import { captionMotionContextIndices } from '../packages/shared/src/caption-layout.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-motion-native-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { buildAssDocument, buildAssCaptionFilter, fontCapabilities, prepareCaptionFonts } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { previewSample, disposePersistentCaptionPreviews } = await import('../apps/server/src/services/persistent-caption-preview.js');
const { renderCaptionedVideo, probeVideoExportCapabilities } = await import('../apps/server/src/services/video-export.js');
after(async () => { await disposePersistentCaptionPreviews(); await fs.rm(root, { recursive: true, force: true }); });

const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'Motion native tests require a reviewed regular+bold Khmer font.');
const baseAppearance: CaptionAppearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, outlineWidth1080: 2, shadowWidth1080: 0 };
const width = 640;
const height = 360;
const background = [32, 64, 96] as const;
const fontDir = await prepareCaptionFonts(root, baseAppearance);

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

async function renderDocument(document: string, atMs: number, frameWidth = width, frameHeight = height) {
  const dir = await fs.mkdtemp(path.join(root, 'motion-frame-'));
  try {
    const file = path.join(dir, 'captions.ass');
    await fs.writeFile(file, document, 'utf8');
    return ffmpeg([
      '-f', 'lavfi', '-i', `color=0x204060:s=${frameWidth}x${frameHeight}:r=1,format=rgba`,
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

async function renderFrozen(captions: CaptionSegment[], appearance: CaptionAppearance, sampleAtMs: number, focus?: ReadonlySet<number>) {
  return renderDocument(buildAssDocument(captions, appearance, width, height, focus, sampleAtMs), 0);
}

async function renderFrozenAtSize(captions: CaptionSegment[], appearance: CaptionAppearance, sampleAtMs: number, focus: ReadonlySet<number>, frameWidth: number, frameHeight: number) {
  return renderDocument(buildAssDocument(captions, appearance, frameWidth, frameHeight, focus, sampleAtMs), 0, frameWidth, frameHeight);
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

function paintedBounds(frame: Buffer, frameWidth = width, frameHeight = height) {
  let minX = frameWidth, minY = frameHeight, maxX = -1, maxY = -1;
  for (let y = 0; y < frameHeight; y += 1) for (let x = 0; x < frameWidth; x += 1) {
    const offset = (y * frameWidth + x) * 4;
    const delta = Math.abs(frame[offset] - background[0]) + Math.abs(frame[offset + 1] - background[1]) + Math.abs(frame[offset + 2] - background[2]);
    if (delta <= 8) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
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

function unionBounds(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const endX = Math.max(left.x + left.width, right.x + right.width);
  const endY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: endX - x, height: endY - y };
}

function roiCompositeError(encoded: Buffer, preview: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let error = 0;
  let count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    const alpha = preview[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const expected = preview[offset + channel] * alpha + background[channel] * (1 - alpha);
      error += Math.abs(encoded[offset + channel] - expected);
      count += 1;
    }
  }
  return count ? error / count : Infinity;
}

function roiPaintedPixels(encoded: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    const delta = Math.abs(encoded[offset] - background[0]) + Math.abs(encoded[offset + 1] - background[1]) + Math.abs(encoded[offset + 2] - background[2]);
    if (delta > 12) count += 1;
  }
  return count;
}

function roiPaintEnergy(encoded: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let energy = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    energy += Math.abs(encoded[offset] - background[0]) + Math.abs(encoded[offset + 1] - background[1]) + Math.abs(encoded[offset + 2] - background[2]);
  }
  return energy;
}

function roiBackgroundError(encoded: Buffer, bounds: { x: number; y: number; width: number; height: number }) {
  let error = 0;
  let count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) { error += Math.abs(encoded[offset + channel] - background[channel]); count += 1; }
  }
  return count ? error / count : Infinity;
}

function fullFrameBackgroundError(encoded: Buffer) {
  let error = 0;
  let count = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) { error += Math.abs(encoded[offset + channel] - background[channel]); count += 1; }
  }
  return error / count;
}

test('Rise and Soft Pop use original cue clocks, finish geometry before exit fade, and stay geometry-neutral in overlaps', () => {
  const cue: CaptionSegment = { id: 'motion', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា CapCut' };
  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const states = planCaptionRenderStates([cue], false, { motionPreset, motionDurationMs: 160 }).filter((state) => state.key);
    assert.equal(states[0].cueOpacities?.[0]?.opacity, 0);
    assert.ok(states.some((state) => state.cueOpacities?.[0]?.opacity === 1));
    const entry = states.find((state) => state.atMs === 120)!;
    const middle = states.find((state) => state.atMs <= 400 && state.endMs > 400)!;
    const exit = states.find((state) => state.atMs === 840)!;
    if (motionPreset === 'rise') {
      assert.ok((entry.motionTranslateY1080 || 0) > 0);
      assert.equal(middle.motionTranslateY1080, 0);
      assert.equal(exit.motionTranslateY1080, 0);
    } else {
      assert.ok((entry.motionScale || 1) < 1);
      assert.equal(middle.motionScale, 1);
      assert.equal(exit.motionScale, 1);
    }
    assert.ok((exit.cueOpacities?.[0]?.opacity || 0) < 1, 'exit fades with final geometry');

    for (const duration of [20, 40, 80]) {
      const short = planCaptionRenderStates([{ ...cue, startMs: 0, endMs: duration }], false, { motionPreset, motionDurationMs: 160 });
      assert.ok(short.some((state) => state.cueOpacities?.[0]?.opacity === 1), `${motionPreset}/${duration}ms reaches full opacity`);
      assert.ok(short.some((state) => motionPreset === 'rise' ? state.motionTranslateY1080 === 0 : state.motionScale === 1), `${motionPreset}/${duration}ms reaches saved geometry`);
      assert.ok(short.filter((state) => state.key).every((state) => state.cueOpacities?.[0]?.opacity === 1), `${motionPreset}/${duration}ms stays fully opaque for its whole cue`);
      assert.ok(short.filter((state) => state.key).every((state) => state.motionTranslateY1080 === undefined || state.motionTranslateY1080 === 0), `${motionPreset}/${duration}ms has neutral Rise geometry`);
      assert.ok(short.filter((state) => state.key).every((state) => state.motionScale === undefined || state.motionScale === 1), `${motionPreset}/${duration}ms has neutral Soft Pop geometry`);
    }

    const ordinary = planCaptionRenderStates([{ ...cue, startMs: 0, endMs: 90 }], false, { motionPreset, motionDurationMs: 160 }).filter((state) => state.key);
    assert.equal(ordinary[0].cueOpacities?.[0]?.opacity, 0, `${motionPreset}/90ms keeps ordinary motion math above the instant threshold`);

    const overlap = planCaptionRenderStates([
      { id: 'a', startMs: 100, endMs: 1000, text: 'A' },
      { id: 'b', startMs: 400, endMs: 900, text: 'B' },
    ], false, { motionPreset, motionDurationMs: 160 }).find((state) => state.atMs === 400)!;
    assert.equal(overlap.key, '0,1');
    assert.equal(overlap.motionTranslateY1080, undefined);
    assert.equal(overlap.motionScale, undefined);
    assert.deepEqual(overlap.cueOpacities, [{ captionIndex: 0, opacity: 1 }, { captionIndex: 1, opacity: 0 }]);
  }
});

test('Rise/Soft Pop preserve entrance-overlap context after the blocker has ended', async () => {
  const captions: CaptionSegment[] = [
    { id: 'selected', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា selected' },
    // Rounds to 100..110ms, so this cue has zero bounded motion duration itself but
    // still intersects the selected cue's entrance and must suppress its geometry.
    { id: 'blocker', startMs: 95, endMs: 105, text: 'short blocker' },
  ];
  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const appearance: CaptionAppearance = { ...baseAppearance, motionPreset, motionDurationMs: 160 };
    assert.deepEqual(captionMotionContextIndices(captions, [0], appearance), [0, 1]);
    const state = planCaptionRenderStates(captions, false, appearance).find((item) => item.atMs <= 150 && item.endMs > 150)!;
    assert.equal(state.key, '0');
    assert.equal(state.motionTranslateY1080, undefined);
    assert.equal(state.motionScale, undefined);
    const withoutBlocker = planCaptionRenderStates([captions[0]], false, appearance).find((item) => item.atMs <= 150 && item.endMs > 150)!;
    assert.ok(motionPreset === 'rise' ? (withoutBlocker.motionTranslateY1080 || 0) > 0 : (withoutBlocker.motionScale || 1) < 1, `${motionPreset}: blocker context must be what suppresses entrance geometry`);

    const sample = previewSample({ captions, appearance, timesMs: [], focusIndices: [0] }, 150);
    assert.equal(sample.captions.length, 2, `${motionPreset}: persistent sampling retains the inactive entrance blocker`);
    assert.deepEqual([...sample.focus], [0]);
    assert.deepEqual(await renderFrozen(sample.captions, appearance, sample.sampleAtMs), await renderFull(captions, appearance, 150), `${motionPreset}: compact preview context matches whole-timeline blocked entrance`);
  }

  const fadeAppearance: CaptionAppearance = { ...baseAppearance, motionPreset: 'fade', motionDurationMs: 160 };
  assert.deepEqual(captionMotionContextIndices(captions, [0], fadeAppearance), [0]);
  assert.equal(previewSample({ captions, appearance: fadeAppearance, timesMs: [], focusIndices: [0] }, 150).captions.length, 1, 'Fade keeps the established active-cue compact path');
});

test('Rise displacement is capped by the saved bottom margin after conservative decoration clearance', async () => {
  const caption: CaptionSegment = { id: 'rise-clearance', startMs: 100, endMs: 900, text: 'ខ្មែរកម្ពុជា' };
  const style: CaptionAppearance = {
    ...baseAppearance,
    positionBottomPct: 3,
    outlineWidth1080: 12,
    shadowWidth1080: 12,
    backgroundEnabled: true,
    backgroundPadding1080: 28,
    glowEnabled: true,
    glowWidth1080: 16,
    glowOpacity: 1,
    motionPreset: 'rise',
    motionDurationMs: 160,
  };
  const document = buildAssDocument([caption], style, 1920, 1080, undefined, 120);
  const dialogue = document.split('\n').find((line) => line.startsWith('Dialogue:') && line.includes(',Default,'))!;
  const marginV = Number(dialogue.split(',')[7]);
  const bottom = Math.max(8, Math.round(1080 * style.positionBottomPct / 100));
  const decorationClearance = Math.max(style.outlineWidth1080 + style.shadowWidth1080, style.backgroundPadding1080, style.glowWidth1080! + 8);
  assert.ok(bottom - marginV <= Math.max(0, bottom - decorationClearance - 1), 'Rise cannot consume space reserved for outline/shadow/background/glow blur plus a one-pixel safety edge');
  assert.ok(marginV > 0, 'extreme decoration still uses an explicit safe Rise margin when room remains');

  const entry = paintedBounds(await renderFull([caption], style, 160))!;
  const rest = paintedBounds(await renderFull([caption], style, 400))!;
  assert.ok(entry.y + entry.height <= rest.y + rest.height, 'Rise must not move extreme decoration below its saved resting extent');
  assert.ok(entry.y + entry.height < height, 'Rise must not paint the final frame row under minimum bottom spacing');
});

test('Soft Pop proportional width compensation preserves native mixed-text line plan and saved anchors', async () => {
  const phrases = ['ខ្មែរ caption', 'Cambodia ខ្មែរ', 'Sthang Studio', 'ខ្មែរកម្ពុជា CapCut'];
  for (const alignment of ['left', 'center', 'right'] as const) {
    for (const repeat of [3, 6, 9, 12]) {
      const caption: CaptionSegment = { id: `${alignment}-${repeat}`, startMs: 100, endMs: 900, text: Array.from({ length: repeat }, (_, index) => phrases[index % phrases.length]).join(' ') };
      const style: CaptionAppearance = { ...baseAppearance, alignment, maxWidthPct: 45, motionPreset: 'soft-pop', motionDurationMs: 160 };
      const entryMask = await renderFrozen([caption], style, 120, new Set([0]));
      const middleMask = await renderFrozen([caption], style, 400, new Set([0]));
      const entry = paintedBounds(entryMask)!;
      const middle = paintedBounds(middleMask)!;
      assert.ok(entry.height / middle.height > 0.86, `${alignment}/${repeat}: entry height must retain the 100% native line count`);
      assert.ok(entry.height < middle.height, `${alignment}/${repeat}: entry should be uniformly smaller than the saved geometry`);
      if (alignment === 'left') assert.equal(entry.x, middle.x, `${alignment}/${repeat}: left anchor must stay fixed`);
      else if (alignment === 'right') assert.equal(entry.x + entry.width, middle.x + middle.width, `${alignment}/${repeat}: right anchor must stay fixed`);
      else assert.ok(Math.abs((entry.x + entry.width / 2) - (middle.x + middle.width / 2)) <= 1, `${alignment}/${repeat}: center anchor must stay fixed`);
    }
  }

  for (const [label, text] of [
    ['explicit-newlines', 'ខ្មែរកម្ពុជា CapCut\nSecond line ខ្មែរ\nបន្ទាត់ទីបី Sthang'],
    ['unspaced-khmer', 'ខ្មែរកម្ពុជា'.repeat(10)],
  ] as const) {
    const caption: CaptionSegment = { id: label, startMs: 100, endMs: 900, text };
    const style: CaptionAppearance = { ...baseAppearance, maxWidthPct: 45, motionPreset: 'soft-pop', motionDurationMs: 160 };
    const entry = paintedBounds(await renderFrozen([caption], style, 120, new Set([0])))!;
    const middle = paintedBounds(await renderFrozen([caption], style, 400, new Set([0])))!;
    assert.ok(entry.height / middle.height > 0.86 && entry.height < middle.height, `${label}: explicit/hard native line plan must stay stable while scaling`);
  }
});

test('Soft Pop compensation preserves odd-width portrait wrap geometry and asymmetric left/right anchors', async () => {
  const frameWidth = 361;
  const frameHeight = 640;
  const text = 'ខ្មែរ caption Cambodia ខ្មែរ Sthang Studio ខ្មែរកម្ពុជា CapCut ខ្មែរ caption';
  for (const alignment of ['left', 'right'] as const) {
    const caption: CaptionSegment = { id: `portrait-${alignment}`, startMs: 100, endMs: 900, text };
    const style: CaptionAppearance = { ...baseAppearance, alignment, maxWidthPct: 45, motionPreset: 'soft-pop', motionDurationMs: 160 };
    const entryDocument = buildAssDocument([caption], style, frameWidth, frameHeight, new Set([0]), 120);
    const neutralDocument = buildAssDocument([caption], style, frameWidth, frameHeight, new Set([0]), 400);
    const dialogue = entryDocument.split('\n').find((line) => line.startsWith('Dialogue:'))!;
    const fields = dialogue.split(',');
    const marginL = Number(fields[5]);
    const marginR = Number(fields[6]);
    assert.ok(Math.abs(marginL - marginR) <= 1, `${alignment}: odd-width compensation splits the integer residual by at most one pixel`);
    assert.match(dialogue, /\\pos\([^)]*\)\\fscx\d+(?:\.\d+)?\\fscy\d+(?:\.\d+)?/);
    assert.doesNotMatch(neutralDocument.split('\n').find((line) => line.startsWith('Dialogue:'))!, /\\pos|\\fscx|\\fscy/, `${alignment}: neutral 100% state must retain the original no-override path`);

    const entry = paintedBounds(await renderFrozenAtSize([caption], style, 120, new Set([0]), frameWidth, frameHeight), frameWidth, frameHeight)!;
    const middle = paintedBounds(await renderFrozenAtSize([caption], style, 400, new Set([0]), frameWidth, frameHeight), frameWidth, frameHeight)!;
    assert.ok(entry.height / middle.height > 0.86 && entry.height < middle.height, `${alignment}: portrait line plan remains stable`);
    if (alignment === 'left') assert.equal(entry.x, middle.x, 'portrait left anchor stays fixed');
    else assert.equal(entry.x + entry.width, middle.x + middle.width, 'portrait right anchor stays fixed');
  }
});

test('Rise/Soft Pop seeking freezes exact Khmer word-paint states and Review Focus tracks geometry while ignoring alpha', async () => {
  const captions = [spokenCue()];
  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const style: CaptionAppearance = { ...baseAppearance, highlightMode: 'word', highlightColor: '#D7FF4F', motionPreset, motionDurationMs: 160 };
    for (const atMs of [120, 220, 450, 600, 840]) {
      const sample = previewSample({ captions, appearance: style, timesMs: [] }, atMs);
      assert.deepEqual(await renderFrozen(sample.captions, style, sample.sampleAtMs), await renderFull(captions, style, atMs), `${motionPreset}/${atMs}: sampled state must equal whole timeline`);
    }

    const capabilities: VideoExportCapabilities = {
      supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
      source: { width, height, displayWidth: width, displayHeight: height, rotation: 0, durationMs: 1200, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
    };
    const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions, timesMs: [120, 400, 840], appearance: style, resolution: 'source', focusIndices: [0] }), capabilities);
    assert.ok(preview.frames.every((frame) => frame.focusBounds));
    const [entry, middle, exit] = preview.frames.map((frame) => frame.focusBounds!);
    if (motionPreset === 'rise') {
      assert.ok(entry.y > middle.y, 'Rise focus follows the lower entrance position');
      assert.equal(entry.width, middle.width);
      assert.equal(entry.height, middle.height);
    } else {
      assert.ok(entry.width < middle.width || entry.height < middle.height, 'Soft Pop focus follows the smaller entrance geometry');
    }
    assert.deepEqual(exit, middle, `${motionPreset}: exit focus stays at saved geometry while paint fades`);
  }
});

test('overlap fallback preserves the established single-block collision pixels while per-cue motion alpha remains active', async () => {
  const captions: CaptionSegment[] = [
    { id: 'a', startMs: 100, endMs: 1000, text: 'ខ្មែរកម្ពុជា A' },
    { id: 'b', startMs: 400, endMs: 900, text: 'Second ខ្មែរ B' },
  ];
  const fade: CaptionAppearance = { ...baseAppearance, motionPreset: 'fade', motionDurationMs: 160 };
  const reference = await renderFull(captions, fade, 420);
  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const actual = await renderFull(captions, { ...fade, motionPreset }, 420);
    assert.deepEqual(actual, reference, `${motionPreset}: overlap uses fade-only paint on the same stable native block geometry`);
  }
});

test('actual MP4 and exact native preview agree for Rise and Soft Pop at entry, middle, exit and post-end', async () => {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = 'motion-synthetic.mp4';
  const sourcePath = path.join(config.uploadDir, filename);
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const sourceBytes = await fs.readFile(sourcePath);
  const caption: CaptionSegment = {
    id: 'motion-mp4', startMs: 100, endMs: 900,
    text: 'ខ្មែរ caption Cambodia ខ្មែរ Sthang Studio ខ្មែរកម្ពុជា CapCut',
  };
  const sampleTimes = [160, 400, 840, 920];

  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const style: CaptionAppearance = { ...baseAppearance, maxWidthPct: 45, motionPreset, motionDurationMs: 160 };
    const now = new Date().toISOString();
    const project: CaptionProject = {
      id: `motion-${motionPreset}`, title: `Motion ${motionPreset}`, createdAt: now, updatedAt: now,
      media: { filename, originalName: filename, mimeType: 'video/mp4', size: sourceBytes.length, url: `/media/${filename}` },
      transcript: null, captions: [caption], mode: 'phrase', captionAppearance: style,
    };
    const capabilities = await probeVideoExportCapabilities(project);
    assert.ok(capabilities.supported, capabilities.blockingReason);
    const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions: [caption], timesMs: sampleTimes, appearance: style, resolution: 'source', focusIndices: [0] }), capabilities);
    const rendered = await renderCaptionedVideo(project, [caption], style, { encoder: 'software', quality: 'high' });
    const outputPath = path.join(config.exportDir, rendered.filename);

    const comparisonRoi = unionBounds(preview.frames[0].focusBounds!, preview.frames[1].focusBounds!);
    const paintEnergies: number[] = [];
    const previewEnergies: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const frame = preview.frames[index];
      assert.ok(frame.bounds && frame.focusBounds, `${motionPreset}/${frame.atMs}: preview must contain visible caption pixels and focus geometry`);
      const transparent = decodePng(frame.png);
      assert.ok(previewPaintedPixels(transparent) > 20, `${motionPreset}/${frame.atMs}: preview cannot pass as a blank frame`);
      const encoded = ffmpeg(['-ss', String(frame.atMs / 1000), '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
      assert.ok(roiPaintedPixels(encoded, comparisonRoi) > 20, `${motionPreset}/${frame.atMs}: MP4 union ROI must contain visible caption paint`);
      assert.ok(roiCompositeError(encoded, transparent, comparisonRoi) < 8, `${motionPreset}/${frame.atMs}: MP4 union ROI must match exact native preview paint`);
      paintEnergies.push(roiPaintEnergy(encoded, comparisonRoi));
      previewEnergies.push(previewAlphaEnergy(transparent));
    }

    const [entry, middle, exit, post] = preview.frames;
    if (motionPreset === 'rise') assert.ok(entry.focusBounds!.y > middle.focusBounds!.y, 'Rise MP4 preview enters below the saved placement');
    else assert.ok(entry.focusBounds!.width < middle.focusBounds!.width || entry.focusBounds!.height < middle.focusBounds!.height, 'Soft Pop MP4 preview enters smaller than saved geometry');
    assert.deepEqual(exit.focusBounds, middle.focusBounds, `${motionPreset}: exit uses saved geometry while fading`);
    assert.ok(previewEnergies[2] > 0 && previewEnergies[2] < previewEnergies[1], `${motionPreset}: exit preview remains visible but fades below middle paint energy`);
    assert.ok(paintEnergies[2] > 0 && paintEnergies[2] < paintEnergies[1], `${motionPreset}: exit MP4 remains visible but fades below middle paint energy`);
    assert.equal(post.bounds, null);
    assert.equal(post.focusBounds, null);
    assert.equal(previewPaintedPixels(decodePng(post.png)), 0, `${motionPreset}: post-end preview must be truly blank`);
    const postEncoded = ffmpeg(['-ss', String(post.atMs / 1000), '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    assert.ok(roiBackgroundError(postEncoded, middle.focusBounds!) < 5, `${motionPreset}: post-end MP4 must return to source background in the caption ROI`);
    assert.ok(fullFrameBackgroundError(postEncoded) < 5, `${motionPreset}: post-end MP4 full frame must return to the source background`);
  }
});

test('25fps MP4 keeps a valid 40ms cue visible on frame zero with resting geometry for every motion', async () => {
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = 'motion-short40.mp4';
  const sourcePath = path.join(config.uploadDir, filename);
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=640x360:r=25:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath]);
  const sourceBytes = await fs.readFile(sourcePath);
  const caption: CaptionSegment = { id: 'short40', startMs: 0, endMs: 40, text: 'ខ្មែរកម្ពុជា' };
  const now = new Date().toISOString();
  const staticStyle: CaptionAppearance = { ...baseAppearance, motionPreset: 'none' };
  const staticPreviewCapabilities: VideoExportCapabilities = {
    supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
    source: { width, height, displayWidth: width, displayHeight: height, rotation: 0, durationMs: 200, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
  };
  const staticPreview = await renderCaptionPreview(parseCaptionPreviewInput({ captions: [caption], timesMs: [0], appearance: staticStyle, resolution: 'source', focusIndices: [0] }), staticPreviewCapabilities);
  assert.ok(staticPreview.frames[0].focusBounds, 'static 40ms cue establishes the resting native geometry');

  for (const motionPreset of ['fade', 'rise', 'soft-pop'] as const) {
    const style: CaptionAppearance = { ...baseAppearance, motionPreset, motionDurationMs: 160 };
    const project: CaptionProject = {
      id: `short40-${motionPreset}`, title: `Short ${motionPreset}`, createdAt: now, updatedAt: now,
      media: { filename, originalName: filename, mimeType: 'video/mp4', size: sourceBytes.length, url: `/media/${filename}` },
      transcript: null, captions: [caption], mode: 'phrase', captionAppearance: style,
    };
    const capabilities = await probeVideoExportCapabilities(project);
    assert.ok(capabilities.supported, capabilities.blockingReason);
    const preview = await renderCaptionPreview(parseCaptionPreviewInput({ captions: [caption], timesMs: [0, 40], appearance: style, resolution: 'source', focusIndices: [0] }), capabilities);
    assert.deepEqual(preview.frames[0].focusBounds, staticPreview.frames[0].focusBounds, `${motionPreset}: frame-zero geometry must be the saved resting layout`);
    assert.ok(previewPaintedPixels(decodePng(preview.frames[0].png)) > 20, `${motionPreset}: frame-zero preview must be visibly painted`);
    assert.equal(preview.frames[1].bounds, null, `${motionPreset}: half-open 40ms cue ends before the next 25fps frame`);

    const rendered = await renderCaptionedVideo(project, [caption], style, { encoder: 'software', quality: 'high' });
    const outputPath = path.join(config.exportDir, rendered.filename);
    const frame0 = ffmpeg(['-ss', '0', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const frame40 = ffmpeg(['-ss', '0.04', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    assert.ok(roiPaintedPixels(frame0, staticPreview.frames[0].focusBounds!) > 20, `${motionPreset}: encoded frame zero must retain the valid short cue`);
    assert.ok(roiBackgroundError(frame40, staticPreview.frames[0].focusBounds!) < 5, `${motionPreset}: encoded frame 40 must be blank after the half-open cue end`);
  }
});
