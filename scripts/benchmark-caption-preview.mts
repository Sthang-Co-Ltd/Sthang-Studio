import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CAPTION_APPEARANCE, type VideoExportCapabilities } from '@kcs/shared';

// Synthetic local-only benchmark. Never loads a project, API key or source media.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-preview-benchmark-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { disposePersistentCaptionPreviews, persistentPreviewDiagnostics } = await import('../apps/server/src/services/persistent-caption-preview.js');
try {
  const fonts = await fontCapabilities();
  const font = fonts.find((item) => item.available && item.boldAvailable);
  if (!font) throw new Error('Install a compatible Khmer regular/bold font before benchmarking.');
  console.log(JSON.stringify({ platform: process.platform, node: process.version, cpu: os.cpus()[0]?.model, font: font.name, ffmpeg: execFileSync(config.ffmpegPath, ['-version'], { windowsHide: true }).toString().split(/\r?\n/)[0] }));
  for (const [width, height] of [[640, 360], [1080, 1920], [3840, 2160]]) {
    const caps: VideoExportCapabilities = {
      supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
      source: { width, height, displayWidth: width, displayHeight: height, rotation: 0, durationMs: 2000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
    };
    const inputs = Array.from({ length: 12 }, (_, index) => parseCaptionPreviewInput({
      captions: [{ text: 'កម្ពុជា CapCut\nខ្មែរជាភាសារបស់យើង', startMs: 0, endMs: 1000 }],
      appearance: { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, fontSize1080: 50 + index, positionBottomPct: 10 + index },
      resolution: 'source', timesMs: [200],
    }));
    const cold: number[] = [], warm: number[] = [];
    const references = [];
    await disposePersistentCaptionPreviews();
    // Warm runtime capability/font discovery; timings below compare rendering,
    // not first-launch inventory work. Both paths use the same installed fonts.
    await renderCaptionPreview(inputs[0], caps);
    for (const input of inputs) {
      const start = performance.now();
      references.push(await renderCaptionPreview(input, caps));
      cold.push(performance.now() - start);
    }
    const before = persistentPreviewDiagnostics();
    for (const [index, input] of inputs.entries()) {
      const start = performance.now();
      const result = await renderCaptionPreview(input, caps, undefined, { projectId: 'synthetic-benchmark', mediaIdentity: `${width}x${height}` });
      warm.push(performance.now() - start);
      if (JSON.stringify(result) !== JSON.stringify(references[index])) throw new Error('Native pixel parity failed; timings are not acceptable evidence.');
    }
    const sortedMedian = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const after = persistentPreviewDiagnostics();
    if (after.starts - before.starts !== 1 || after.fallbacks !== before.fallbacks) throw new Error('Persistent benchmark fell back or restarted; do not report warm results.');
    console.log(JSON.stringify({ width, height, samples: inputs.length, oneShotMedianMs: +sortedMedian(cold).toFixed(1), persistentFirstMs: +warm[0].toFixed(1), persistentWarmMedianMs: +sortedMedian(warm.slice(1)).toFixed(1), nativeProcesses: after.starts - before.starts, byteIdentical: true }));
  }
} finally {
  await disposePersistentCaptionPreviews();
  await fs.rm(root, { recursive: true, force: true });
}
