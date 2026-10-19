import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, CaptionSegment } from '../packages/shared/src/index.js';

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-unfinished-recovery-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
process.env.STHANG_STUDIO_ENV_FILE = path.join(stateRoot, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const shared = await import('../packages/shared/src/index.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');
const { contributionStore } = await import('../apps/server/src/services/contribution-store.js');
const { analyticsBuckets } = await import('../apps/server/src/services/analytics.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

function projectFixture(id: string): CaptionProject {
  const caption: CaptionSegment = { id: 'c1', startMs: 1_000, endMs: 2_000, text: 'hello', approved: false };
  const tokens = [{ id: 'hello', text: 'hello', startMs: 1_050, endMs: 1_700, spaceBefore: false, timingSource: 'stt' as const }];
  const wordTiming = shared.buildCaptionWordTiming(caption, tokens);
  assert.ok(wordTiming);
  return {
    id,
    title: `Synthetic recovery ${id}`,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 123, url: `/media/${id}.mp4` },
    transcript: { language: 'en', fullText: 'hello', segments: [caption], tokens },
    transcriptionContext: { description: 'Original context', vocabulary: ['hello'] },
    captions: [{ ...caption, wordTiming }],
    mode: 'single-line',
    engineVersion: 'test',
  };
}

async function seed(id: string) {
  const project = projectFixture(id);
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  return project;
}

function correctedCaption(project: CaptionProject): CaptionSegment {
  const { wordTiming: _oldWordTiming, ...caption } = project.captions[0];
  return { ...caption, text: 'hello corrected', approved: true };
}

function observeEvidence(t: TestContext) {
  return {
    corrections: t.mock.method(profileStore, 'recordCaptionChanges'),
    contribution: t.mock.method(contributionStore, 'captureApprovedCorrections', async () => []),
    approvals: t.mock.method(analyticsBuckets, 'approvals'),
  };
}

function assertNoEvidence(effects: ReturnType<typeof observeEvidence>) {
  assert.equal(effects.corrections.mock.callCount(), 0, 'recovery must not record a correction');
  assert.equal(effects.contribution.mock.callCount(), 0, 'recovery must not create Contributor candidates');
  assert.equal(effects.approvals.mock.callCount(), 0, 'recovery must not emit approval analytics');
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

function request(projectId: string, body: unknown, endpoint = 'captions') {
  return fetch(`${baseUrl}/api/projects/${projectId}/${endpoint}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('ordinary caption saves without a recovery guard keep History and correction behavior', { concurrency: false }, async (t) => {
  const project = await seed('ordinary-save');
  const effects = observeEvidence(t);
  const captions = [correctedCaption(project)];
  const response = await request(project.id, { captions, expectedMedia: project.media, source: 'text-edit' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.correctionsCreated, 1);
  assert.deepEqual(result.project.captions, captions);
  assert.equal(effects.corrections.mock.callCount(), 1);
  assert.equal(effects.contribution.mock.callCount(), 1);
  assert.equal(effects.approvals.mock.callCount(), 1);
  const history = await historyStore.list(project.id, project.media);
  assert.equal(history.length, 1);
  assert.deepEqual((await historyStore.get(project.id, history[0].id, project.media))?.snapshot.captions, JSON.parse(JSON.stringify(project.captions)));
});

test('matching recovery guard persists the draft and History without treating it as correction or approval evidence', { concurrency: false }, async (t) => {
  const project = await seed('recover-save');
  const effects = observeEvidence(t);
  // Even an old saved approval bit or explicit correction flag cannot turn the
  // recovery acknowledgement into a new approval/correction event.
  const captions = [correctedCaption(project)];
  const response = await request(project.id, {
    captions, expectedMedia: project.media,
    recoveryExpectedUpdatedAt: project.updatedAt,
    source: 'manual-save', recordCorrections: true,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.correctionsCreated, 0);
  assert.deepEqual(result.project.captions, captions);
  assertNoEvidence(effects);
  const saved = await store.get(project.id);
  assert.ok(saved);
  assert.deepEqual(saved.captions, captions);
  assert.deepEqual(saved.transcript, project.transcript);
  assert.deepEqual(saved.transcriptionContext, project.transcriptionContext);
  const history = await historyStore.list(project.id, project.media);
  assert.equal(history.length, 1);
  assert.deepEqual((await historyStore.get(project.id, history[0].id, project.media))?.snapshot.captions, JSON.parse(JSON.stringify(project.captions)));
});

test('stale recovery on the same media rejects before History, project persistence, or evidence changes', { concurrency: false }, async (t) => {
  const project = await seed('stale-recovery');
  const effects = observeEvidence(t);
  const before = await store.get(project.id);
  const response = await request(project.id, {
    captions: [correctedCaption(project)], expectedMedia: project.media,
    recoveryExpectedUpdatedAt: '2026-10-18T00:00:00.000Z', recordCorrections: true,
  });
  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.code, 'DRAFT_RECOVERY_CHANGED');
  assert.match(error.error, /project changed/i);
  assert.match(error.error, /draft was kept/i);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  assertNoEvidence(effects);
});

test('recovery guard validation retains existing missing-project and media protection', { concurrency: false }, async (t) => {
  const project = await seed('invalid-recovery');
  const effects = observeEvidence(t);
  const body = { captions: [correctedCaption(project)], expectedMedia: project.media };
  const before = await store.get(project.id);
  for (const invalid of [null, 123, false, {}, [], '', '   ']) {
    const response = await request(project.id, { ...body, recoveryExpectedUpdatedAt: invalid });
    assert.equal(response.status, 400, `invalid guard ${JSON.stringify(invalid)}`);
    assert.match((await response.json()).error, /recovery revision/i);
  }
  const wrongMedia = await request(project.id, {
    ...body, expectedMedia: { ...project.media, filename: 'other-source.mp4' },
    recoveryExpectedUpdatedAt: project.updatedAt,
  });
  assert.equal(wrongMedia.status, 409);
  assert.match((await wrongMedia.json()).error, /older media version/i);
  const missingMedia = await request(project.id, { captions: body.captions, recoveryExpectedUpdatedAt: project.updatedAt });
  assert.equal(missingMedia.status, 428);
  const missingProject = await request('missing-recovery-project', { ...body, recoveryExpectedUpdatedAt: project.updatedAt });
  assert.equal(missingProject.status, 404);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  assertNoEvidence(effects);
});

test('recovery revision is checked after an earlier queued project write acquires and releases the lock', { concurrency: false, timeout: 15_000 }, async (t) => {
  const project = await seed('queued-recovery');
  const effects = observeEvidence(t);
  let acquired!: () => void;
  let release!: () => void;
  let queued!: () => void;
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const recoveryQueued = new Promise<void>((resolve) => { queued = resolve; });
  t.after(() => release());
  const originalWrite = store.withProjectWrite;
  const winningWrite = originalWrite(project.id, async (current, persist) => {
    assert.ok(current);
    acquired();
    await barrier;
    return persist({ ...current, updatedAt: '2026-10-19T01:00:00.000Z', title: 'Newer saved project' });
  });
  await locked;
  const observeQueue: typeof store.withProjectWrite = (id, operation) => {
    if (id === project.id) queued();
    return originalWrite(id, operation);
  };
  t.mock.method(store, 'withProjectWrite', observeQueue);
  const recovery = request(project.id, {
    captions: [correctedCaption(project)], expectedMedia: project.media,
    recoveryExpectedUpdatedAt: project.updatedAt,
  });
  try {
    await recoveryQueued;
  } finally {
    release();
  }
  const winner = await winningWrite;
  const response = await recovery;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'DRAFT_RECOVERY_CHANGED');
  assert.deepEqual(await store.get(project.id), winner);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
  assertNoEvidence(effects);
});

test('recovered caption acknowledgement supplies the exact revision for the following guarded Accuracy save', { concurrency: false }, async (t) => {
  const project = await seed('recovery-context');
  const effects = observeEvidence(t);
  const captionResponse = await request(project.id, {
    captions: [correctedCaption(project)], expectedMedia: project.media,
    recoveryExpectedUpdatedAt: project.updatedAt,
  });
  assert.equal(captionResponse.status, 200);
  const acknowledged = (await captionResponse.json()).project as CaptionProject;
  const transcriptionContext = { description: 'Recovered context', vocabulary: ['hello corrected'] };
  const staleContext = await request(project.id, {
    transcriptionContext, expectedMedia: project.media, expectedUpdatedAt: project.updatedAt,
  }, 'context');
  assert.equal(staleContext.status, 409);
  assert.equal((await staleContext.json()).code, 'CONTEXT_REVISION_CHANGED');
  assert.deepEqual((await store.get(project.id))?.transcriptionContext, project.transcriptionContext);
  const contextResponse = await request(project.id, {
    transcriptionContext, expectedMedia: project.media, expectedUpdatedAt: acknowledged.updatedAt,
  }, 'context');
  assert.equal(contextResponse.status, 200);
  const saved = await contextResponse.json();
  assert.deepEqual(saved.transcriptionContext, transcriptionContext);
  assert.deepEqual(saved.captions, acknowledged.captions);
  assertNoEvidence(effects);
});
