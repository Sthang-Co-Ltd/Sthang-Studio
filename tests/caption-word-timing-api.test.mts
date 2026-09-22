import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, CaptionSegment } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-word-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const shared = await import('../packages/shared/src/index.js');
const {
  CaptionWordTimingBusyError,
  syncCaptionWordsLocally,
} = await import('../apps/server/src/services/caption-word-timing.js');
type CaptionWordTimingDependencies = import('../apps/server/src/services/caption-word-timing.js').CaptionWordTimingDependencies;
const { createCaptionWordTimingHandler, default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

function caption(): CaptionSegment {
  const value: CaptionSegment = { id: 'c1', startMs: 1_000, endMs: 2_000, text: 'hello' };
  const timing = shared.buildCaptionWordTiming(value, [
    { id: 'hello', text: 'hello', startMs: 1_050, endMs: 1_500, spaceBefore: false, timingSource: 'stt' },
  ]);
  assert.ok(timing);
  return { ...value, wordTiming: timing };
}

function projectFixture(id: string): CaptionProject {
  const cue = caption();
  return {
    id,
    title: `Fixture ${id}`,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 123, url: `/media/${id}.mp4` },
    transcript: {
      language: 'en', fullText: 'hello', segments: [cue],
      tokens: [{ id: 'hello', text: 'hello', startMs: 1_050, endMs: 1_500, spaceBefore: false, timingSource: 'stt' }],
    },
    captions: [cue],
    mode: 'single-line',
    engineVersion: 'test',
  };
}

let activeCaptionJob = false;
let syncMode: 'success' | 'busy' = 'success';
let syncCalls = 0;
let syncImplementation: typeof syncCaptionWordsLocally = async (_projectId, basis) => {
  syncCalls += 1;
  if (syncMode === 'busy') throw new CaptionWordTimingBusyError();
  return { basis, wordTiming: basis.wordTiming!, sourceRevision: 'fixture-revision' };
};
const handler = createCaptionWordTimingHandler({
  hasActiveCaptionJobForProject: () => activeCaptionJob,
  syncCaptionWords: (...args) => syncImplementation(...args),
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.post('/api/projects/:id/caption-word-timing', handler);
app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function syncRequest(projectId: string, body: unknown) {
  return fetch(`${baseUrl}/api/projects/${projectId}/caption-word-timing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('word timing HTTP boundary enforces media ownership, caption-job exclusion, and 429 busy response', async () => {
  const project = projectFixture('api-boundary');
  const basis = project.captions[0];
  const expectedMedia = { filename: project.media.filename, size: project.media.size };

  const missingMedia = await syncRequest(project.id, { caption: basis });
  assert.equal(missingMedia.status, 428);

  const beforeActiveCalls = syncCalls;
  activeCaptionJob = true;
  const active = await syncRequest(project.id, { caption: basis, expectedMedia });
  activeCaptionJob = false;
  assert.equal(active.status, 409);
  assert.match((await active.json()).error, /caption processing job/i);
  assert.equal(syncCalls, beforeActiveCalls);

  syncMode = 'busy';
  const busy = await syncRequest(project.id, { caption: basis, expectedMedia });
  syncMode = 'success';
  assert.equal(busy.status, 429);
  assert.match((await busy.json()).error, /busy/i);

  const success = await syncRequest(project.id, { caption: basis, expectedMedia });
  assert.equal(success.status, 200);
  const body = await success.json();
  assert.equal(body.sourceRevision, 'fixture-revision');
  assert.equal(shared.resolveCaptionWordTiming({ ...basis, wordTiming: body.wordTiming }).state, 'ready');
});

test('HTTP route exercises real sync bounds, locks, and stale guards with a fake local timing helper', async () => {
  const normal = projectFixture('api-service');
  let current = structuredClone(normal);
  let reads = 0;
  let alignCalls = 0;
  const dependencies: CaptionWordTimingDependencies = {
    getProject: async () => { reads += 1; return structuredClone(current); },
    ensureNormalizedAudio: async (project) => ({
      dir: `cache/${project.id}`,
      outputPath: `cache/${project.id}/normalized.wav`,
      durationMs: 5_000,
      fingerprint: 'fixture-media',
      cacheHit: true,
      cachedAt: '2026-09-19T00:00:00.000Z',
    }),
    makeAudioChunk: async (_source, outputPath, _startMs, durationMs) => ({ outputPath, durationMs, cacheHit: true, directSource: false }),
    alignTimingLocally: async () => {
      alignCalls += 1;
      return {
        transcript: 'hello',
        words: [{ text: 'hello', startMs: 150, endMs: 450, confidence: 0.99 }],
        engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
      };
    },
    removeWorkingDir: async () => {},
  };
  const previous = syncImplementation;
  syncImplementation = (projectId, basis, expectedMedia) => syncCaptionWordsLocally(projectId, basis, expectedMedia, dependencies);
  try {
    const expectedMedia = { filename: normal.media.filename, size: normal.media.size };
    const tooLong = await syncRequest(normal.id, {
      caption: { ...normal.captions[0], endMs: normal.captions[0].startMs + 60_001 },
      expectedMedia,
    });
    assert.equal(tooLong.status, 400);
    assert.equal(reads, 0);
    assert.equal(alignCalls, 0);

    current.captions[0].timingLocked = true;
    const locked = await syncRequest(normal.id, { caption: current.captions[0], expectedMedia });
    assert.equal(locked.status, 409);
    assert.match((await locked.json()).error, /unlock/i);
    assert.equal(alignCalls, 0);

    current = structuredClone(normal);
    reads = 0;
    const changed = structuredClone(normal);
    changed.captions[0].wordTiming!.words[0].startMs = 1_100;
    dependencies.getProject = async () => {
      reads += 1;
      return structuredClone(reads >= 3 ? changed : current);
    };
    const stale = await syncRequest(normal.id, { caption: normal.captions[0], expectedMedia });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /changed|newer/i);
    assert.equal(alignCalls, 1);
  } finally {
    syncImplementation = previous;
  }
});

test('concurrent HTTP word-sync requests hit the real global heavy-work gate and return 429', async () => {
  const project = projectFixture('api-concurrency');
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const dependencies: CaptionWordTimingDependencies = {
    getProject: async () => structuredClone(project),
    ensureNormalizedAudio: async (value) => ({
      dir: `cache/${value.id}`,
      outputPath: `cache/${value.id}/normalized.wav`,
      durationMs: 5_000,
      fingerprint: 'fixture-media',
      cacheHit: true,
      cachedAt: '2026-09-19T00:00:00.000Z',
    }),
    makeAudioChunk: async (_source, outputPath, _startMs, durationMs) => ({ outputPath, durationMs, cacheHit: true, directSource: false }),
    alignTimingLocally: async () => {
      startedResolve();
      await release;
      return {
        transcript: 'hello',
        words: [{ text: 'hello', startMs: 150, endMs: 450, confidence: 0.99 }],
        engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
      };
    },
    removeWorkingDir: async () => {},
  };
  const previous = syncImplementation;
  syncImplementation = (projectId, basis, expectedMedia) => syncCaptionWordsLocally(projectId, basis, expectedMedia, dependencies);
  const expectedMedia = { filename: project.media.filename, size: project.media.size };
  const first = syncRequest(project.id, { caption: project.captions[0], expectedMedia });
  try {
    await started;
    const second = await syncRequest(project.id, { caption: project.captions[0], expectedMedia });
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /busy/i);
  } finally {
    releaseResolve();
    syncImplementation = previous;
  }
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
});

test('wordTiming-only history changes create distinct checkpoints and a real restore keeps the earlier track', async () => {
  const original = projectFixture('word-history');
  await historyStore.clear(original.id);
  const checkpoint = await historyStore.checkpoint(original, 'Original word timing', 'manual-save');

  const changed = structuredClone(original);
  changed.captions[0].wordTiming!.words[0].startMs = 1_120;
  changed.updatedAt = '2026-09-19T00:00:01.000Z';
  const changedCheckpoint = await historyStore.checkpoint(changed, 'Changed word timing', 'manual-save');
  assert.notEqual(changedCheckpoint.id, checkpoint.id);
  const storedChanged = await historyStore.get(changed.id, changedCheckpoint.id, changed.media);
  assert.equal(storedChanged?.snapshot.captions[0].wordTiming?.words[0].startMs, 1_120);

  await store.upsert(changed);
  cancelScheduledProjectPrewarm(changed.id);
  const response = await fetch(`${baseUrl}/api/projects/${changed.id}/history/${checkpoint.id}/restore`, { method: 'POST' });
  assert.equal(response.status, 200);
  const restored = await response.json() as CaptionProject;
  assert.equal(restored.captions[0].wordTiming?.words[0].startMs, 1_050);
  assert.equal(shared.resolveCaptionWordTiming(restored.captions[0]).state, 'ready');
});
