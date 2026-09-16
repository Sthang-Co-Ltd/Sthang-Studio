import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DEFAULT_CAPTION_APPEARANCE, type VideoExportCapabilities } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-warm-preview-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { disposePersistentCaptionPreviews, persistentPreviewDiagnostics, trackCaptionPreviewRequest } = await import('../apps/server/src/services/persistent-caption-preview.js');
const { config } = await import('../apps/server/src/config.js');
after(async () => { await disposePersistentCaptionPreviews(); await fs.rm(root, { recursive: true, force: true }); });
const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'A local Khmer regular/bold font is required.');
const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name };
const capabilities: VideoExportCapabilities = {
  supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
  source: { width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0, durationMs: 4000, frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0 },
};

test('a real FFmpeg process survives appearance changes with byte-identical native PNGs and bounds', async () => {
  const base = { captions: [{ id: 'a', text: 'កម្ពុជា CapCut\nខ្មែរជាភាសារបស់យើង', startMs: 100, endMs: 1800 }], timesMs: [200], resolution: 'source' };
  const styles = [appearance, { ...appearance, fontSize1080: 82, positionBottomPct: 28 }, { ...appearance, backgroundEnabled: true, backgroundOpacity: 0.58, outlineWidth1080: 5.5, shadowWidth1080: 8.5 }];
  const inputs = styles.map((style) => parseCaptionPreviewInput({ ...base, appearance: style }));
  // Generate one-shot references before keeping the worker warm.
  const references = [];
  for (const input of inputs) references.push(await renderCaptionPreview(input, capabilities));
  const before = persistentPreviewDiagnostics();
  for (let i = 0; i < inputs.length; i++) {
    const start = performance.now();
    const result = await renderCaptionPreview(inputs[i], capabilities, undefined, { projectId: 'synthetic', mediaIdentity: 'v1' });
    console.log(`native sample ${i}: ${(performance.now() - start).toFixed(1)} ms`);
    assert.deepEqual(result, references[i]);
  }
  const after = persistentPreviewDiagnostics();
  assert.equal(after.starts - before.starts, 1);
  assert.equal(after.fallbacks - before.fallbacks, 0);
  assert.equal(after.frames - before.frames, 3);
});

test('persistent native frames preserve gaps, overlaps, focus, wrapping and transparent effects at portrait, square and 4K sizes', async () => {
  for (const [width, height] of [[360, 640], [720, 720], [3840, 2160]]) {
    await disposePersistentCaptionPreviews();
    const caps = { ...capabilities, source: { ...capabilities.source, displayWidth: width, displayHeight: height } };
    const input = parseCaptionPreviewInput({
      captions: [{ text: 'កម្ពុជា \\N {\\bord50} CapCut', startMs: 104, endMs: 800 }, { text: 'ខ្មែរជាភាសារបស់យើង\nSecond line', startMs: 500, endMs: 1100 }],
      timesMs: [0, 100, 500, 900, 1200], resolution: 'source', focusIndices: [1],
      appearance: { ...appearance, backgroundEnabled: true, backgroundOpacity: 0.58, fontSize1080: 71.3, shadowWidth1080: 8.5, maxWidthPct: 65 },
    });
    const expected = await renderCaptionPreview(input, caps);
    const before = persistentPreviewDiagnostics();
    const actual = await renderCaptionPreview(input, caps, undefined, { projectId: 'geometry', mediaIdentity: `${width}x${height}` });
    assert.deepEqual(actual, expected, `${width}x${height}: pixels and caption/focus bounds`);
    assert.equal(persistentPreviewDiagnostics().starts - before.starts, 1);
    assert.equal(persistentPreviewDiagnostics().fallbacks - before.fallbacks, 0);
  }
});

test('running persistent work cancels without fallback, frees admission slots and removes caption scratch', async () => {
  await disposePersistentCaptionPreviews();
  const input = parseCaptionPreviewInput({ captions: [{ text: 'កម្ពុជា CapCut', startMs: 0, endMs: 1000 }], timesMs: [200], appearance, resolution: '2160p' });
  const before = persistentPreviewDiagnostics();
  const controller = new AbortController();
  const timer = setInterval(() => { if (persistentPreviewDiagnostics().starts > before.starts) controller.abort(); }, 1);
  try {
    await assert.rejects(renderCaptionPreview(input, capabilities, controller.signal, { projectId: 'cancel', mediaIdentity: 'v1' }), /cancelled|abort/i);
  } finally { clearInterval(timer); }
  assert.equal(persistentPreviewDiagnostics().fallbacks, before.fallbacks);
  assert.equal(persistentPreviewDiagnostics().workers, 0);
  const remaining = await fs.readdir(path.join(config.exportDir, '.working'));
  assert.ok(remaining.every((name) => name.startsWith('preview-fonts-')));
  const retried = await renderCaptionPreview({ ...input, resolution: 'source' }, capabilities, undefined, { projectId: 'cancel', mediaIdentity: 'v1' });
  assert.ok(retried.frames[0].bounds);
  await disposePersistentCaptionPreviews('cancel');
  assert.equal(persistentPreviewDiagnostics().workers, 0);
});

test('persistent workers are bounded across projects and rebuild after source identity changes', async () => {
  await disposePersistentCaptionPreviews();
  const input = parseCaptionPreviewInput({ captions: [{ text: 'កម្ពុជា CapCut', startMs: 0, endMs: 1000 }], timesMs: [200], appearance, resolution: 'source' });
  for (const projectId of ['one', 'two', 'three']) {
    await renderCaptionPreview(input, capabilities, undefined, { projectId, mediaIdentity: 'v1' });
    assert.ok(persistentPreviewDiagnostics().workers <= 2);
  }
  const starts = persistentPreviewDiagnostics().starts;
  await renderCaptionPreview(input, capabilities, undefined, { projectId: 'three', mediaIdentity: 'replacement' });
  assert.equal(persistentPreviewDiagnostics().starts, starts + 1);
  await disposePersistentCaptionPreviews();
});

test('persistent transport also preserves exact pixels on the reviewed FFmpeg 7.1 build when installed', async (t) => {
  const binary = path.join(os.tmpdir(), 'ffmpeg-7.1-essentials_build', 'bin', 'ffmpeg.exe');
  if (!(await fs.stat(binary).catch(() => null))) return t.skip('FFmpeg 7.1 fixture is not installed on this machine.');
  await disposePersistentCaptionPreviews();
  const previous = config.ffmpegPath;
  config.ffmpegPath = binary;
  try {
    const input = parseCaptionPreviewInput({ captions: [{ text: 'កម្ពុជា CapCut', startMs: 0, endMs: 1000 }], timesMs: [0, 200, 1000], appearance, resolution: 'source' });
    const reference = await renderCaptionPreview(input, capabilities);
    const before = persistentPreviewDiagnostics();
    const result = await renderCaptionPreview(input, capabilities, undefined, { projectId: 'ffmpeg71', mediaIdentity: 'v1' });
    assert.deepEqual(result, reference);
    assert.equal(persistentPreviewDiagnostics().fallbacks, before.fallbacks);
    assert.equal(persistentPreviewDiagnostics().frames - before.frames, 3);
  } finally { await disposePersistentCaptionPreviews(); config.ffmpegPath = previous; }
});

test('a crashed persistent transport falls back to exact native rendering and does not respawn on every edit', async (t) => {
  await disposePersistentCaptionPreviews();
  const input = parseCaptionPreviewInput({ captions: [{ text: 'កម្ពុជា CapCut', startMs: 0, endMs: 1000 }], timesMs: [200], appearance, resolution: 'source' });
  const expected = await renderCaptionPreview(input, capabilities);
  const before = persistentPreviewDiagnostics();
  const originalSpawn = childProcess.spawn;
  const replacement = ((executable: string, args: string[], options: any) => args.includes('-reinit_filter')
    ? originalSpawn(process.execPath, ['-e', 'process.exit(7)'], options)
    : originalSpawn(executable, args, options)) as typeof childProcess.spawn;
  const mocked = t.mock.method(childProcess, 'spawn', replacement);
  syncBuiltinESMExports();
  try {
    const first = await renderCaptionPreview(input, capabilities, undefined, { projectId: 'crash', mediaIdentity: 'v1' });
    assert.deepEqual(first, expected);
    const second = await renderCaptionPreview(input, capabilities, undefined, { projectId: 'crash', mediaIdentity: 'v1' });
    assert.deepEqual(second, expected);
    const after = persistentPreviewDiagnostics();
    assert.equal(after.fallbacks - before.fallbacks, 1);
    assert.equal(after.starts - before.starts, 1);
    assert.equal(after.workers, 0);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); await disposePersistentCaptionPreviews(); }
});

test('project invalidation rejects a request still awaiting capability discovery without affecting another project', async () => {
  const a = trackCaptionPreviewRequest('deleted-project');
  const b = trackCaptionPreviewRequest('other-project');
  try {
    await disposePersistentCaptionPreviews('deleted-project');
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
    const before = persistentPreviewDiagnostics();
    const input = parseCaptionPreviewInput({ captions: [{ text: 'កម្ពុជា', startMs: 0, endMs: 1000 }], timesMs: [0], appearance, resolution: 'source' });
    await assert.rejects(renderCaptionPreview(input, capabilities, a.signal, { projectId: 'deleted-project', mediaIdentity: 'old' }), /abort|cancel/i);
    assert.equal(persistentPreviewDiagnostics().starts, before.starts);
  } finally { a.release(); b.release(); }
});
