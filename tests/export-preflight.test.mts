import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type VideoExportCapabilities } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-export-preflight-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { parseCaptionLayoutCheckInput, checkCaptionLayout, CaptionLayoutCheckError } = await import('../apps/server/src/services/export-preflight.js');
const { createCaptionLayoutCheckHandler } = await import('../apps/server/src/routes/export-preflight.js');
const { disposePersistentCaptionPreviews } = await import('../apps/server/src/services/persistent-caption-preview.js');

const fixture = (): CaptionProject => ({
  id: 'layout', title: 'Layout fixture', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  media: { filename: 'fixture.mp4', originalName: 'fixture.mp4', mimeType: 'video/mp4', size: 123, url: '/media/fixture.mp4' },
  captions: [{ id: 'khmer-a', text: 'ខ្មែរកម្ពុជា', startMs: 200, endMs: 1000 }],
  transcript: null, mode: 'phrase', captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
});
const source = { width: 640, height: 360, displayWidth: 640, displayHeight: 360, rotation: 0, durationMs: 4000,
  frameRate: 25, variableFrameRate: false, videoCodec: 'h264', pixelFormat: 'yuv420p', bitDepth: 8, hdr: 'sdr' as const, audioCodecs: [], audioStreams: 0 };
const capabilities: VideoExportCapabilities = { supported: true, source, subtitlesFilter: true, fonts: [], warnings: [], encoders: [],
  availableDiskBytes: 10_000_000_000, resolutions: [{ id: 'source', label: 'Original', width: 640, height: 360, upscaled: false }] };
function input() {
  const project = fixture();
  return { captions: project.captions, appearance: project.captionAppearance, resolution: 'source', expectedMedia: { filename: project.media.filename, size: project.media.size } };
}

test('layout input preserves exact caption identity and strips unrelated project evidence', () => {
  const value = input();
  Object.assign(value.captions[0], { approved: true, confidence: 0.9, privateContext: 'not needed' });
  const parsed = parseCaptionLayoutCheckInput(value);
  assert.deepEqual(parsed.captions, [{ id: 'khmer-a', text: 'ខ្មែរកម្ពុជា', startMs: 200, endMs: 1000 }]);
  assert.deepEqual(parsed.expectedMedia, value.expectedMedia);
  assert.equal(parsed.appearance.fontFamily, DEFAULT_CAPTION_APPEARANCE.fontFamily);
});

test('layout input rejects ambiguous IDs, invalid times, unsafe sizes and malformed word evidence', () => {
  const valid = input();
  for (const patch of [
    { expectedMedia: undefined }, { expectedMedia: { filename: 'fixture.mp4', size: -1 } },
    { captions: [] }, { captions: Array(10_001).fill(valid.captions[0]) },
    { captions: [valid.captions[0], valid.captions[0]] },
    { captions: [{ ...valid.captions[0], id: '' }] },
    { captions: [{ ...valid.captions[0], text: 'a'.repeat(4097) }] },
    { captions: [{ ...valid.captions[0], startMs: NaN }] },
    { captions: [{ ...valid.captions[0], endMs: -1 }] },
    { captions: [{ ...valid.captions[0], wordTiming: { version: 1, text: 'x', words: Array(4097).fill({}) } }] },
    { captions: [{ ...valid.captions[0], wordTiming: { version: 1, text: 'x', words: [{}] } }] },
    { resolution: 'arbitrary-filter' },
  ]) assert.throws(() => parseCaptionLayoutCheckInput({ ...valid, ...patch }), CaptionLayoutCheckError);
});

test('unsupported renderer, missing font and cancelled checks never report a fit', async () => {
  const parsed = parseCaptionLayoutCheckInput(input());
  assert.equal((await checkCaptionLayout(parsed, { ...capabilities, subtitlesFilter: false }, 'layout')).status, 'unavailable');
  const missingFont = await checkCaptionLayout(parsed, capabilities, 'layout');
  assert.equal(missingFont.status, 'blocked');
  assert.deepEqual(missingFont.issues[0].captionIds, []);
  assert.equal(missingFont.issues[0].code, 'font-unavailable');
  assert.equal((await checkCaptionLayout({ ...parsed, captions: [{ ...parsed.captions[0], text: '' }] }, capabilities, 'layout')).status, 'unavailable');
  const cancelled = AbortSignal.abort(new Error('fixture cancellation'));
  await assert.rejects(checkCaptionLayout(parsed, capabilities, 'layout', cancelled), /fixture cancellation/);
});

let current = fixture();
let capabilityGate: (() => Promise<void>) | undefined;
let checkGate: (() => Promise<void>) | undefined;
let failure = false;
let checkCalls = 0;
let trackedReleased = 0;
let lastInput: unknown;
let lastSignal: AbortSignal | undefined;
const trackedControllers = new Set<AbortController>();
const app = express();
app.use(express.json({ limit: '8mb' }));
app.post('/:projectId/check-layout', createCaptionLayoutCheckHandler({
  getProject: async () => structuredClone(current),
  capabilities: async () => { await capabilityGate?.(); return capabilities; },
  check: async (snapshot, _capabilities, _id, signal) => {
    checkCalls += 1; lastInput = snapshot; lastSignal = signal;
    await checkGate?.();
    if (failure) throw new Error('private path C:/secret/ffmpeg plus provider diagnostics');
    return { status: 'passed', width: 640, height: 360, issues: [] };
  },
  track: () => {
    const controller = new AbortController(); trackedControllers.add(controller);
    return { signal: controller.signal, release: () => { trackedReleased += 1; trackedControllers.delete(controller); } };
  },
}));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/layout/check-layout`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disposePersistentCaptionPreviews();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
function request(body: unknown = input(), signal?: AbortSignal) {
  return fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('HTTP layout check is read-only and rejects stale media before native work', async () => {
  current = fixture();
  const before = structuredClone(current);
  const body = input(); body.captions[0].text = 'unsaved draft';
  const response = await request(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'passed');
  assert.deepEqual(current, before);
  assert.equal((lastInput as any).captions[0].text, 'unsaved draft');
  const calls = checkCalls;
  const stale = await request({ ...body, expectedMedia: { filename: 'older.mp4', size: 123 } });
  assert.equal(stale.status, 409);
  assert.equal(checkCalls, calls);
  assert.equal(trackedControllers.size, 0);
});

test('media replacement and font invalidation during awaited work cannot publish a clean result', async () => {
  for (const stage of ['capabilities', 'native', 'media'] as const) {
    current = fixture();
    const entered = deferred(); const finish = deferred();
    const gate = async () => { entered.resolve(); await finish.promise; };
    capabilityGate = stage === 'capabilities' ? gate : undefined;
    checkGate = stage === 'capabilities' ? undefined : gate;
    const pending = request();
    try {
      await entered.promise;
      if (stage === 'media') current.media.filename = 'replaced.mp4';
      else for (const controller of trackedControllers) controller.abort();
    } finally { finish.resolve(); }
    const response = await pending;
    assert.equal(response.status, 409, stage);
    assert.match((await response.json()).error, /source|fonts/i);
    assert.equal(trackedControllers.size, 0);
    capabilityGate = undefined; checkGate = undefined;
  }
  current = fixture();
});

test('native failures are sanitized and every request releases its registration', async () => {
  const released = trackedReleased;
  failure = true;
  try {
    const response = await request();
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.match(json.error, /could not finish/i);
    assert.doesNotMatch(json.error, /secret|ffmpeg|provider/i);
  } finally { failure = false; }
  assert.equal(trackedReleased, released + 1);
});

test('disconnect aborts native work and cannot return a saved result', async () => {
  const entered = deferred(); const finish = deferred(); const aborted = deferred();
  checkGate = async () => { lastSignal!.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await finish.promise; };
  const controller = new AbortController();
  const pending = request(input(), controller.signal);
  try {
    await entered.promise; controller.abort();
    await assert.rejects(pending, /abort/i);
    await aborted.promise;
    assert.equal(lastSignal?.aborted, true);
  } finally { finish.resolve(); checkGate = undefined; }
});
