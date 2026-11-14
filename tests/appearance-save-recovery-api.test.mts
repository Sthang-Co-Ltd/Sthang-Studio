import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, normalizeCaptionAppearance, type CaptionAppearance, type CaptionProject } from '@kcs/shared';

// Real HTTP and project persistence, with synthetic state and no cloud credentials.
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-appearance-recovery-'));
process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
process.env.STHANG_STUDIO_ENV_FILE = path.join(stateRoot, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: videoExportRouter } = await import('../apps/server/src/routes/video-export.js');

const app = express();
app.use(express.json());
app.use('/api/video-export', videoExportRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/video-export`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seed(id: string): Promise<CaptionProject> {
  const project: CaptionProject = {
    id, title: `Synthetic ${id}`, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 123, url: `/media/${id}.mp4` },
    captions: [{ id: 'c1', text: 'Private caption fixture', startMs: 100, endMs: 900, approved: true }],
    transcript: null, mode: 'single-line',
    transcriptionContext: { description: 'Private Accuracy fixture', vocabulary: ['fixture'] },
    captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  return (await store.get(id))!;
}

function request(project: CaptionProject, appearance: CaptionAppearance, expectedAppearance?: CaptionAppearance) {
  return fetch(`${baseUrl}/${project.id}/appearance`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appearance, expectedMedia: project.media, ...(expectedAppearance ? { expectedAppearance } : {}) }),
  });
}

function disk(project: CaptionProject) {
  return fs.readFile(path.join(path.dirname(config.dataFile), 'projects', `${project.id}.json`), 'utf8');
}

test('appearance save requires an adopted saved look and leaves the project untouched when it is missing', async () => {
  const project = await seed('missing-appearance-basis');
  const before = await disk(project);
  const response = await request(project, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 90 });
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'APPEARANCE_BASIS_REQUIRED');
  assert.equal(await disk(project), before);
  assert.deepEqual(await store.get(project.id), project);
});

test('appearance recovery accepts unrelated saved caption, Accuracy and title changes without replacing them', async () => {
  const project = await seed('independent-appearance-fields');
  const newer = await store.upsert({ ...project, title: 'Newer project title', updatedAt: '2026-10-20T00:00:00.000Z',
    captions: [{ ...project.captions[0], text: 'Newer caption', approved: false }],
    transcriptionContext: { description: 'Newer Accuracy', vocabulary: ['newer'] },
  });
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 90, textColor: '#EA384F' };
  const response = await request(project, appearance, DEFAULT_CAPTION_APPEARANCE);
  assert.equal(response.status, 200);
  const saved = await response.json() as CaptionProject;
  assert.deepEqual(saved.captionAppearance, appearance);
  assert.deepEqual(saved.captions, newer.captions);
  assert.deepEqual(saved.transcriptionContext, newer.transcriptionContext);
  assert.equal(saved.title, newer.title);
  assert.ok(Date.parse(saved.updatedAt) > Date.parse(newer.updatedAt));
  assert.deepEqual(await store.get(project.id), saved);
});

test('a foreign saved appearance rejects an old recovery basis without changing disk or the newer look', async () => {
  const project = await seed('foreign-appearance');
  const foreign = { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#EA384F' };
  await store.setCaptionAppearance(project.id, foreign);
  const before = await disk(project);
  const response = await request(project, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 }, DEFAULT_CAPTION_APPEARANCE);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'APPEARANCE_REVISION_CHANGED');
  assert.equal(await disk(project), before);
  assert.deepEqual((await store.get(project.id))?.captionAppearance, foreign);
});

test('the appearance comparison runs inside the same transaction as a queued foreign save', { timeout: 10_000 }, async (t) => {
  const project = await seed('atomic-appearance-basis');
  const entered = deferred(); const release = deferred(); const arrived = deferred();
  const foreign = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 110 };
  const mutation = store.withProjectWrite(project.id, async (current, persist) => {
    assert.ok(current); entered.resolve(); await release.promise;
    return persist({ ...current, captionAppearance: foreign }, { restoreAppearance: true });
  });
  await entered.promise;
  const original = store.withProjectWrite;
  t.mock.method(store, 'withProjectWrite', (...args: Parameters<typeof store.withProjectWrite>) => {
    arrived.resolve(); return original(...args);
  });
  const response = request(project, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 }, DEFAULT_CAPTION_APPEARANCE);
  try {
    await arrived.promise;
  } finally { release.resolve(); }
  await mutation;
  assert.equal((await response).status, 409);
  assert.deepEqual((await store.get(project.id))?.captionAppearance, foreign);
});

test('retry after a lost acknowledgement confirms the identical saved look without advancing its revision or rewriting disk', async () => {
  const project = await seed('appearance-lost-ack');
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 94 };
  const accepted = await request(project, appearance, DEFAULT_CAPTION_APPEARANCE);
  assert.equal(accepted.status, 200);
  const saved = await accepted.json() as CaptionProject;
  const before = await disk(project);
  const retry = await request(project, appearance, DEFAULT_CAPTION_APPEARANCE);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), saved);
  assert.equal(await disk(project), before);
  assert.equal((await store.get(project.id))?.updatedAt, saved.updatedAt);
});

test('replaced media cannot reuse an appearance receipt even when the target look already matches', async () => {
  const project = await seed('appearance-replaced-media');
  const replacement = await store.upsert({ ...project, media: { ...project.media, filename: 'replacement.mp4', size: 999 } });
  cancelScheduledProjectPrewarm(project.id);
  const before = await disk(project);
  const response = await request(project, normalizeCaptionAppearance(replacement.captionAppearance), DEFAULT_CAPTION_APPEARANCE);
  assert.equal(response.status, 409);
  assert.equal(await disk(project), before);
  assert.deepEqual(await store.get(project.id), replacement);
});

test('a delayed appearance recovery cannot recreate a deleted project', async () => {
  const project = await seed('appearance-deleted-project');
  await store.remove(project.id);
  const response = await request(project, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 92 }, DEFAULT_CAPTION_APPEARANCE);
  assert.equal(response.status, 404);
  assert.equal(await store.get(project.id), null);
  await assert.rejects(disk(project), { code: 'ENOENT' });
});
