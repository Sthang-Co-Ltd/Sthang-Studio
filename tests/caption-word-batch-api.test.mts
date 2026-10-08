import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, CaptionSegment } from '../packages/shared/src/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-word-batch-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const shared = await import('../packages/shared/src/index.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

function cue(): CaptionSegment {
  const caption: CaptionSegment = { id: 'c1', startMs: 1_000, endMs: 2_000, text: 'ខ្មែរ AI' };
  const timing = shared.buildCaptionWordTiming(caption, [
    { id: 'khmer', text: 'ខ្មែរ', startMs: 1_050, endMs: 1_350, spaceBefore: false, timingSource: 'stt' },
    { id: 'ai', text: 'AI', startMs: 1_450, endMs: 1_700, spaceBefore: true, timingSource: 'stt' },
  ]);
  assert.ok(timing);
  return { ...caption, wordTiming: timing, approved: true };
}

function projectFixture(id: string): CaptionProject {
  const caption = cue();
  return {
    id,
    title: `Fixture ${id}`,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 123, url: `/media/${id}.mp4` },
    transcript: null,
    captions: [caption],
    mode: 'single-line',
    engineVersion: 'test',
  };
}

function preparedChange(before: CaptionSegment) {
  const afterCaption = structuredClone(before);
  afterCaption.wordTiming!.words[0].startMs! += 10;
  afterCaption.approved = false;
  assert.equal(shared.resolveCaptionWordTiming(afterCaption).state, 'ready');
  return { before: structuredClone(before), after: afterCaption };
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
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function request(projectId: string, body: unknown) {
  return fetch(`${baseUrl}/api/projects/${projectId}/caption-word-timing/batch-apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('batch-apply HTTP boundary validates media, payload, action, job gate and atomic stale revisions', async () => {
  const project = projectFixture('batch-api');
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const expectedMedia = { filename: project.media.filename, size: project.media.size };
  const change = preparedChange(project.captions[0]);

  assert.equal((await request(project.id, { changes: [change] })).status, 428);
  assert.equal((await request(project.id, { expectedMedia, changes: [] })).status, 400);
  assert.equal((await request(project.id, { expectedMedia, changes: [change], action: 'later' })).status, 400);
  assert.equal((await request(project.id, { expectedMedia: { ...expectedMedia, filename: 'replacement.mp4' }, changes: [change] })).status, 409);

  const originalActiveCheck = jobStore.hasActiveCaptionJobForProject;
  (jobStore as unknown as { hasActiveCaptionJobForProject(id: string): boolean }).hasActiveCaptionJobForProject = () => true;
  try {
    const active = await request(project.id, { expectedMedia, changes: [change], action: 'apply' });
    assert.equal(active.status, 409);
    assert.match((await active.json()).error, /caption processing job/i);
  } finally {
    (jobStore as unknown as { hasActiveCaptionJobForProject: typeof originalActiveCheck }).hasActiveCaptionJobForProject = originalActiveCheck;
  }

  const appliedResponse = await request(project.id, { expectedMedia, changes: [change], action: 'apply' });
  assert.equal(appliedResponse.status, 200);
  const applied = await appliedResponse.json();
  assert.equal(applied.appliedCount, 1);
  assert.equal(shared.resolveCaptionWordTiming(applied.project.captions[0]).state, 'ready');
  assert.equal(applied.project.captions[0].approved, false);

  const stale = await request(project.id, { expectedMedia, changes: [change], action: 'apply' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed|newer edits/i);

  const undo = await request(project.id, {
    expectedMedia,
    action: 'undo',
    changes: [{ before: change.after, after: change.before }],
  });
  assert.equal(undo.status, 200);
  const undone = await undo.json();
  assert.equal(undone.appliedCount, 1);
  assert.equal(undone.project.captions[0].approved, true);
  assert.deepEqual(
    undone.project.captions[0].wordTiming,
    JSON.parse(JSON.stringify(change.before.wordTiming)),
  );
});

test('batch-apply rejects non-ready apply tracks and missing projects with bounded JSON errors', async () => {
  const project = projectFixture('batch-api-errors');
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const expectedMedia = { filename: project.media.filename, size: project.media.size };
  const partial = structuredClone(project.captions[0]);
  partial.wordTiming!.words[0].needsReview = true;
  const invalid = await request(project.id, { expectedMedia, action: 'apply', changes: [{ before: project.captions[0], after: partial }] });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /ready word timing/i);

  const missing = await request('missing-project', { expectedMedia, action: 'apply', changes: [preparedChange(project.captions[0])] });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Project not found' });
});
