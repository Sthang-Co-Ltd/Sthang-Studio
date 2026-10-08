import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPTION_APPEARANCE, type VideoExportCapabilities } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-native-preview-phase3-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');

const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { renderCaptionPreview, parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
const { persistentPreviewDiagnostics, disposePersistentCaptionPreviews } = await import('../apps/server/src/services/persistent-caption-preview.js');
const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'The native preview regression requires a local Khmer font.');

const capabilities: VideoExportCapabilities = {
  supported: true, fonts, subtitlesFilter: true, encoders: [], resolutions: [], availableDiskBytes: 0, warnings: [],
  source: {
    width: 640, height: 360, displayWidth: 640, displayHeight: 360,
    rotation: 0, durationMs: 4_000, frameRate: 25, variableFrameRate: false,
    videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr', audioCodecs: [], audioStreams: 0,
  },
};
const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, highlightMode: 'word' as const };
const source = [{ id: 'word', text: 'ខ្មែរ AI', startMs: 0, endMs: 1_000 }];
const input = (text = source[0].text, focus = false) => parseCaptionPreviewInput({
  captions: [{ ...source[0], text }],
  appearance,
  resolution: 'source',
  timesMs: [200],
  ...(focus ? { focusIndices: [0] } : {}),
});

after(async () => {
  await disposePersistentCaptionPreviews();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('repeated exact native paint reuses its FFmpeg session, scratch path and unchanged ASS bytes', async () => {
  await disposePersistentCaptionPreviews();
  const original = input();
  const expected = await renderCaptionPreview(original, capabilities);
  const changed = input('ខ្មែរ AI!');
  // The one-shot reference intentionally retires idle native workers. Prepare
  // every golden before the warm worker is created so this test verifies reuse.
  const changedExpected = await renderCaptionPreview(changed, capabilities);
  const before = persistentPreviewDiagnostics();
  const scope = { projectId: 'repeat', mediaIdentity: 'v1' };
  const first = await renderCaptionPreview(original, capabilities, undefined, scope);
  const afterFirst = persistentPreviewDiagnostics();
  const repeated = await renderCaptionPreview(original, capabilities, undefined, scope);
  const afterRepeat = persistentPreviewDiagnostics();

  assert.deepEqual(first, expected);
  assert.deepEqual(repeated, expected);
  assert.equal(afterFirst.starts - before.starts, 1);
  assert.equal(afterFirst.sessionDirectories - before.sessionDirectories, 1);
  assert.equal(afterFirst.assWrites - before.assWrites, 1);
  assert.equal(afterRepeat.starts, afterFirst.starts);
  assert.equal(afterRepeat.sessionDirectories, afterFirst.sessionDirectories);
  assert.equal(afterRepeat.assWrites, afterFirst.assWrites, 'unchanged ASS bytes must not be rewritten');
  assert.equal(afterRepeat.frames - before.frames, 2);
  assert.equal(afterRepeat.fallbacks, before.fallbacks);

  const changedActual = await renderCaptionPreview(changed, capabilities, undefined, scope);
  const afterChange = persistentPreviewDiagnostics();
  assert.deepEqual(changedActual, changedExpected, 'changed text must never reuse obsolete native pixels');
  assert.equal(afterChange.assWrites, afterFirst.assWrites + 1);
  assert.equal(afterChange.starts, afterFirst.starts);
  await disposePersistentCaptionPreviews(scope.projectId);
  assert.equal(persistentPreviewDiagnostics().workers, 0);
});

test('review-focus mask files also remain exact when a focus state repeats', async () => {
  await disposePersistentCaptionPreviews();
  const focused = input('ខ្មែរ AI', true);
  const expected = await renderCaptionPreview(focused, capabilities);
  const scope = { projectId: 'focus-repeat', mediaIdentity: 'v1' };
  const before = persistentPreviewDiagnostics();
  const first = await renderCaptionPreview(focused, capabilities, undefined, scope);
  const second = await renderCaptionPreview(focused, capabilities, undefined, scope);
  const after = persistentPreviewDiagnostics();
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(after.assWrites - before.assWrites, 2, 'caption and focus ASS are each written once');
  assert.equal(after.sessionDirectories - before.sessionDirectories, 1);
  assert.equal(after.starts - before.starts, 1);
  assert.equal(after.fallbacks, before.fallbacks);
});
