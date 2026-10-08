import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCaptionWordTiming, DEFAULT_CAPTION_APPEARANCE, type CaptionSegment, type TimedToken, type VideoExportCapabilities } from '@kcs/shared';

// Synthetic local-only latency evidence: the old temporal-preview client put
// eight distinct word paints in one response, which could not display the
// requested word until all eight native PNG frames finished. Phase 3 requests
// the current paint alone, then prefetches nearby paints independently.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-word-preview-phase3-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { disposePersistentCaptionPreviews, persistentPreviewDiagnostics } = await import('../apps/server/src/services/persistent-caption-preview.js');

const tokens = ['ខ្មែរ', 'AI', 'one', 'two', 'three', 'four', 'five', 'six'];
const caption: CaptionSegment = { id: 'synthetic-words', text: tokens.join(' '), startMs: 100, endMs: 1_000 };
const words: TimedToken[] = tokens.map((text, index) => ({
  id: `w${index}`, text, startMs: 100 + index * 100, endMs: 190 + index * 100,
  spaceBefore: index > 0, timingSource: 'stt', alignmentScore: 1,
}));
caption.wordTiming = buildCaptionWordTiming(caption, words);
if (!caption.wordTiming) throw new Error('Could not construct a complete Khmer/Latin synthetic word track.');
const samples = words.map((word) => word.startMs + 10);
const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)];

try {
  const fonts = await fontCapabilities();
  const font = fonts.find((item) => item.available && item.boldAvailable);
  if (!font) throw new Error('A compatible local Khmer font is required for native benchmarking.');
  console.log(JSON.stringify({ platform: process.platform, node: process.version, cpu: os.cpus()[0]?.model, font: font.name, samples: samples.length }));

  for (const [width, height] of [[640, 360], [1080, 1920]]) {
    await disposePersistentCaptionPreviews();
    const capabilities: VideoExportCapabilities = {
      supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
      source: { width, height, displayWidth: width, displayHeight: height, rotation: 0, durationMs: 2000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
    };
    const base = { captions: [caption], resolution: 'source', appearance: { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, highlightMode: 'word' as const, highlightColor: '#D7FF4F' } };
    const single = parseCaptionPreviewInput({ ...base, timesMs: [samples[0]] });
    const eight = parseCaptionPreviewInput({ ...base, timesMs: samples });
    const reference = await renderCaptionPreview(single, capabilities);
    const scope = { projectId: 'synthetic-phase3', mediaIdentity: `${width}x${height}` };
    const warm = await renderCaptionPreview(single, capabilities, undefined, scope);
    if (JSON.stringify(warm) !== JSON.stringify(reference)) throw new Error('Warm single-word paint differs from native one-shot reference.');
    const before = persistentPreviewDiagnostics();
    const currentMs: number[] = [];
    const previousBatchMs: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const startCurrent = performance.now();
      const now = await renderCaptionPreview(single, capabilities, undefined, scope);
      currentMs.push(performance.now() - startCurrent);
      const startOldBatch = performance.now();
      const old = await renderCaptionPreview(eight, capabilities, undefined, scope);
      previousBatchMs.push(performance.now() - startOldBatch);
      if (JSON.stringify(old.frames[0]) !== JSON.stringify(now.frames[0])) {
        throw new Error('Current first word differs from the same word in the former eight-paint batch.');
      }
    }
    const after = persistentPreviewDiagnostics();
    if (after.starts !== before.starts || after.fallbacks !== before.fallbacks) throw new Error('Native session restarted or fell back during measurements.');
    console.log(JSON.stringify({ width, height, iterations: currentMs.length, currentPaintMedianMs: +median(currentMs).toFixed(1), previousEightPaintBatchMedianMs: +median(previousBatchMs).toFixed(1), firstWordByteIdentical: true, additionalNativeStarts: after.starts - before.starts, additionalFallbacks: after.fallbacks - before.fallbacks }));
  }
} finally {
  await disposePersistentCaptionPreviews();
  await fs.rm(root, { recursive: true, force: true });
}
