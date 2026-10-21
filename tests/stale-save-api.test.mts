import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, CaptionSegment } from '../packages/shared/src/index.js';

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-stale-save-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
process.env.STHANG_STUDIO_ENV_FILE = path.join(stateRoot, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');
const { contributionStore } = await import('../apps/server/src/services/contribution-store.js');
const { analyticsBuckets } = await import('../apps/server/src/services/analytics.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

type SaveEndpoint = 'captions' | 'context';

async function seed(id: string): Promise<CaptionProject> {
  const caption: CaptionSegment = { id: 'c1', startMs: 1_000, endMs: 2_000, text: 'hello', approved: false };
  const project: CaptionProject = {
    id,
    title: `Synthetic stale save ${id}`,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 123, url: `/media/${id}.mp4` },
    transcript: { language: 'en', fullText: 'hello', segments: [caption], tokens: [] },
    transcriptionContext: { description: 'Original context', vocabulary: ['hello'] },
    captions: [caption],
    mode: 'single-line',
    engineVersion: 'test',
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const saved = await store.get(project.id);
  assert.ok(saved);
  return JSON.parse(JSON.stringify(saved)) as CaptionProject;
}

function observeEvidence(t: TestContext) {
  return {
    corrections: t.mock.method(profileStore, 'recordCaptionChanges'),
    contribution: t.mock.method(contributionStore, 'captureApprovedCorrections', async () => []),
    approvals: t.mock.method(analyticsBuckets, 'approvals'),
  };
}

function evidenceCounts(effects: ReturnType<typeof observeEvidence>) {
  return {
    corrections: effects.corrections.mock.callCount(),
    contribution: effects.contribution.mock.callCount(),
    approvals: effects.approvals.mock.callCount(),
  };
}

const noEvidence = { corrections: 0, contribution: 0, approvals: 0 };

async function diskSnapshot(directory = stateRoot): Promise<Record<string, string>> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await diskSnapshot(filename));
    else if (entry.isFile()) result[path.relative(stateRoot, filename)] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  }
  return result;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function readProject(id: string): Promise<CaptionProject> {
  const response = await fetch(`${baseUrl}/api/projects/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

function request(projectId: string, endpoint: SaveEndpoint, body: unknown) {
  return fetch(`${baseUrl}/api/projects/${projectId}/${endpoint}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function saveBody(project: CaptionProject, endpoint: SaveEndpoint, text: string) {
  return {
    expectedMedia: project.media,
    expectedUpdatedAt: project.updatedAt,
    ...(endpoint === 'captions'
      ? { captions: [{ ...project.captions[0], text, approved: true }], source: 'text-edit', recordCorrections: true }
      : { transcriptionContext: { description: text, vocabulary: ['hello'] } }),
  };
}

test('two caption clients keep the winning save and reject a stale edit without changing disk, History, or evidence', { concurrency: false }, async (t) => {
  const project = await seed('caption-clients');
  const [first, second] = await Promise.all([readProject(project.id), readProject(project.id)]);
  assert.equal(first.updatedAt, second.updatedAt);
  const effects = observeEvidence(t);
  const winning = await request(project.id, 'captions', saveBody(first, 'captions', 'hello corrected'));
  assert.equal(winning.status, 200);
  const winner = (await winning.json()).project as CaptionProject;
  assert.notEqual(winner.updatedAt, first.updatedAt);
  const history = await historyStore.list(project.id, project.media);
  assert.equal(history.length, 1);
  assert.deepEqual((await historyStore.get(project.id, history[0].id, project.media))?.snapshot.captions, first.captions);
  const counts = evidenceCounts(effects);
  assert.deepEqual(counts, { corrections: 1, contribution: 1, approvals: 1 });
  const beforeDisk = await diskSnapshot();

  const losing = await request(project.id, 'captions', saveBody(second, 'captions', 'hello stale overwrite'));
  assert.equal(losing.status, 409);
  assert.equal((await losing.json()).code, 'CAPTION_REVISION_CHANGED');
  assert.deepEqual(await readProject(project.id), winner);
  assert.deepEqual(await historyStore.list(project.id, project.media), history);
  assert.deepEqual(evidenceCounts(effects), counts);
  assert.deepEqual(await diskSnapshot(), beforeDisk);
});

test('two Accuracy clients keep the winning save and reject stale context without changing disk or caption evidence', { concurrency: false }, async (t) => {
  const project = await seed('context-clients');
  const [first, second] = await Promise.all([readProject(project.id), readProject(project.id)]);
  const effects = observeEvidence(t);
  const winning = await request(project.id, 'context', saveBody(first, 'context', 'Winning Accuracy context'));
  assert.equal(winning.status, 200);
  const winner = await winning.json() as CaptionProject;
  assert.notEqual(winner.updatedAt, first.updatedAt);
  assert.deepEqual(winner.captions, first.captions);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  const beforeDisk = await diskSnapshot();

  const losing = await request(project.id, 'context', saveBody(second, 'context', 'Stale Accuracy context'));
  assert.equal(losing.status, 409);
  assert.equal((await losing.json()).code, 'CONTEXT_REVISION_CHANGED');
  assert.deepEqual(await readProject(project.id), winner);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  assert.deepEqual(evidenceCounts(effects), noEvidence);
  assert.deepEqual(await diskSnapshot(), beforeDisk);
});

test('caption and Accuracy saves accept consecutive acknowledged revisions and preserve both fields and History order', { concurrency: false }, async (t) => {
  const project = await seed('acknowledged-saves');
  observeEvidence(t);
  const firstResponse = await request(project.id, 'captions', saveBody(project, 'captions', 'hello first edit'));
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()).project as CaptionProject;
  const contextResponse = await request(project.id, 'context', saveBody(first, 'context', 'Updated Accuracy context'));
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json() as CaptionProject;
  assert.deepEqual(context.captions, first.captions);
  const staleCaption = await request(project.id, 'captions', saveBody(first, 'captions', 'hello outdated edit'));
  assert.equal(staleCaption.status, 409);
  assert.equal((await staleCaption.json()).code, 'CAPTION_REVISION_CHANGED');
  const lastResponse = await request(project.id, 'captions', saveBody(context, 'captions', 'hello newest edit'));
  assert.equal(lastResponse.status, 200);
  const last = (await lastResponse.json()).project as CaptionProject;
  assert.deepEqual(last.transcriptionContext, context.transcriptionContext);
  assert.equal(last.captions[0].text, 'hello newest edit');
  assert.notEqual(last.updatedAt, context.updatedAt);
  const history = await historyStore.list(project.id, project.media);
  assert.equal(history.length, 2);
  assert.equal((await historyStore.get(project.id, history[0].id, project.media))?.snapshot.captions[0].text, 'hello first edit');
  assert.equal((await historyStore.get(project.id, history[1].id, project.media))?.snapshot.captions[0].text, 'hello');
});

for (const endpoint of ['captions', 'context'] as const) {
  test(`${endpoint} saves require a nonempty revision and reject malformed values without side effects`, { concurrency: false }, async (t) => {
    const project = await seed(`${endpoint}-validation`);
    const effects = observeEvidence(t);
    const { expectedUpdatedAt: _revision, ...body } = saveBody(project, endpoint, 'Unsaved edit');
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    const beforeDisk = await diskSnapshot();
    const missing = await request(project.id, endpoint, body);
    assert.equal(missing.status, 428);
    assert.match((await missing.json()).error, /revision|saved project timestamp/i);
    for (const invalid of [null, 123, false, {}, [], '', '   ']) {
      const response = await request(project.id, endpoint, { ...body, expectedUpdatedAt: invalid });
      assert.equal(response.status, 400, `invalid guard ${JSON.stringify(invalid)}`);
      assert.match((await response.json()).error, /revision/i);
    }
    assert.deepEqual(await readProject(project.id), project);
    assert.deepEqual(evidenceCounts(effects), noEvidence);
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    assert.deepEqual(await diskSnapshot(), beforeDisk);
  });

  test(`${endpoint} rejects a stale no-op before any persistence, History, or evidence`, { concurrency: false }, async (t) => {
    const project = await seed(`${endpoint}-stale-no-op`);
    const winner = await store.withProjectWrite(project.id, async (current, persist) => {
      assert.ok(current);
      return persist({ ...current, title: 'A newer saved revision', updatedAt: '2026-10-20T01:00:00.000Z' });
    });
    const effects = observeEvidence(t);
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    const beforeDisk = await diskSnapshot();
    const response = await request(project.id, endpoint, {
      expectedMedia: project.media,
      expectedUpdatedAt: project.updatedAt,
      ...(endpoint === 'captions' ? { captions: winner.captions } : { transcriptionContext: winner.transcriptionContext }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, endpoint === 'captions' ? 'CAPTION_REVISION_CHANGED' : 'CONTEXT_REVISION_CHANGED');
    assert.deepEqual(await readProject(project.id), JSON.parse(JSON.stringify(winner)));
    assert.deepEqual(evidenceCounts(effects), noEvidence);
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    assert.deepEqual(await diskSnapshot(), beforeDisk);
  });

  test(`${endpoint} compares its revision after waiting for an earlier project write`, { concurrency: false, timeout: 15_000 }, async (t) => {
    const project = await seed(`${endpoint}-queued`);
    const effects = observeEvidence(t);
    let acquired!: () => void;
    let release!: () => void;
    let queued!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const requestQueued = new Promise<void>((resolve) => { queued = resolve; });
    t.after(() => release());
    const originalWrite = store.withProjectWrite;
    const winningWrite = originalWrite(project.id, async (current, persist) => {
      assert.ok(current);
      acquired();
      await barrier;
      return persist({ ...current, title: 'Winning queued write', updatedAt: '2026-10-20T02:00:00.000Z' });
    });
    await locked;
    const observeQueue: typeof store.withProjectWrite = (id, operation) => {
      if (id === project.id) queued();
      return originalWrite(id, operation);
    };
    t.mock.method(store, 'withProjectWrite', observeQueue);
    const losingRequest = request(project.id, endpoint, saveBody(project, endpoint, 'Stale queued edit'));
    try {
      await requestQueued;
    } finally {
      release();
    }
    const winner = await winningWrite;
    const response = await losingRequest;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, endpoint === 'captions' ? 'CAPTION_REVISION_CHANGED' : 'CONTEXT_REVISION_CHANGED');
    assert.deepEqual(await readProject(project.id), JSON.parse(JSON.stringify(winner)));
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    assert.deepEqual(evidenceCounts(effects), noEvidence);
  });
}

test('caption recovery alias remains valid without learning and rejects contradictory revision guards', { concurrency: false }, async (t) => {
  const project = await seed('recovery-alias');
  const effects = observeEvidence(t);
  const { expectedUpdatedAt: _revision, ...body } = saveBody(project, 'captions', 'hello recovered');
  const mismatch = await request(project.id, 'captions', {
    ...body,
    expectedUpdatedAt: project.updatedAt,
    recoveryExpectedUpdatedAt: '2026-10-19T00:00:00.000Z',
  });
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await readProject(project.id), project);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  assert.deepEqual(evidenceCounts(effects), noEvidence);
  const response = await request(project.id, 'captions', { ...body, recoveryExpectedUpdatedAt: project.updatedAt });
  assert.equal(response.status, 200);
  const saved = (await response.json()).project as CaptionProject;
  assert.equal(saved.captions[0].text, 'hello recovered');
  assert.deepEqual(evidenceCounts(effects), noEvidence);
  const next = await request(project.id, 'captions', {
    ...saveBody(saved, 'captions', 'hello recovered again'),
    recoveryExpectedUpdatedAt: saved.updatedAt,
  });
  assert.equal(next.status, 200);
  assert.deepEqual(evidenceCounts(effects), noEvidence);
  const stale = await request(project.id, 'captions', { ...body, recoveryExpectedUpdatedAt: saved.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'DRAFT_RECOVERY_CHANGED');
  assert.equal((await readProject(project.id)).captions[0].text, 'hello recovered again');
});

const cleanupSettings = {
  id: 'synthetic', name: 'Synthetic cleanup', description: 'Revision guard fixture',
  maxCps: 30, maxCharsPerLine: 42, maxLines: 2, minDurationMs: 300, maxDurationMs: 5000,
  minGapMs: 40, leadInMs: 20, leadOutMs: 20, snapToleranceMs: 80,
};

function cleanupRequest(project: CaptionProject, endpoint: string, expectedUpdatedAt: unknown) {
  return fetch(`${baseUrl}/api/projects/${project.id}/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedMedia: project.media, expectedUpdatedAt, settings: cleanupSettings }),
  });
}

for (const endpoint of ['normalize-khmer-spacing', 'postprocess-timing']) {
  test(`${endpoint} requires a valid saved revision before any History or evidence`, { concurrency: false }, async (t) => {
    const project = await seed(`${endpoint}-required`);
    const effects = observeEvidence(t);
    const beforeDisk = await diskSnapshot();
    for (const value of [undefined, null, '', '   ', 123, {}]) {
      const response = await cleanupRequest(project, endpoint, value);
      assert.equal(response.status, value === undefined ? 428 : 400);
      assert.deepEqual(await diskSnapshot(), beforeDisk);
      assert.deepEqual(evidenceCounts(effects), noEvidence);
    }
  });

  test(`${endpoint} rejects a stale caption basis without changing disk or History`, { concurrency: false }, async (t) => {
    const project = await seed(`${endpoint}-stale`);
    const winner = await store.withProjectWrite(project.id, async (current, persist) => {
      assert.ok(current);
      return persist({ ...current, captions: current.captions.map((cue) => ({ ...cue, text: 'Foreign saved wording' })) });
    });
    const effects = observeEvidence(t);
    const beforeDisk = await diskSnapshot();
    const response = await cleanupRequest(project, endpoint, project.updatedAt);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'CAPTION_REVISION_CHANGED');
    assert.deepEqual(await readProject(project.id), JSON.parse(JSON.stringify(winner)));
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    assert.deepEqual(await diskSnapshot(), beforeDisk);
    assert.deepEqual(evidenceCounts(effects), noEvidence);
  });

  test(`${endpoint} accepts its acknowledged revision with one checkpoint and no learning`, { concurrency: false }, async (t) => {
    const project = await seed(`${endpoint}-current`);
    const effects = observeEvidence(t);
    const response = await cleanupRequest(project, endpoint, project.updatedAt);
    assert.equal(response.status, 200);
    const saved = await response.json() as CaptionProject;
    assert.notEqual(saved.updatedAt, project.updatedAt);
    assert.deepEqual(saved.media, project.media);
    assert.deepEqual(saved.transcriptionContext, project.transcriptionContext);
    assert.equal(saved.captions[0].text, project.captions[0].text);
    assert.deepEqual(await readProject(project.id), saved);
    const entries = await historyStore.list(project.id, project.media);
    assert.equal(entries.length, 1);
    assert.deepEqual((await historyStore.get(project.id, entries[0].id, project.media))?.snapshot.captions, project.captions);
    assert.deepEqual(evidenceCounts(effects), noEvidence);
  });

  test(`${endpoint} checks the revision after a queued competing caption write`, { concurrency: false, timeout: 15_000 }, async (t) => {
    const project = await seed(`${endpoint}-queued`);
    const effects = observeEvidence(t);
    let acquired!: () => void;
    let release!: () => void;
    let queued!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const requestQueued = new Promise<void>((resolve) => { queued = resolve; });
    t.after(() => release());
    const originalWrite = store.withProjectWrite;
    const winningWrite = originalWrite(project.id, async (current, persist) => {
      assert.ok(current);
      acquired();
      await barrier;
      return persist({ ...current, captions: current.captions.map((cue) => ({ ...cue, text: 'Winning queued caption' })) });
    });
    await locked;
    const observeQueue: typeof store.withProjectWrite = (id, operation) => {
      if (id === project.id) queued();
      return originalWrite(id, operation);
    };
    t.mock.method(store, 'withProjectWrite', observeQueue);
    const pending = cleanupRequest(project, endpoint, project.updatedAt);
    try { await requestQueued; } finally { release(); }
    const winner = await winningWrite;
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'CAPTION_REVISION_CHANGED');
    assert.deepEqual(await readProject(project.id), JSON.parse(JSON.stringify(winner)));
    assert.deepEqual(await historyStore.list(project.id, project.media), []);
    assert.deepEqual(evidenceCounts(effects), noEvidence);
  });
}
