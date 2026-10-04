import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-admission-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'missing.env');
process.env.STHANG_STUDIO_DISABLE_UPDATE_EXIT = '1';
const { jobAdmission, JobAdmissionError } = await import('../apps/server/src/services/job-admission.js');
const { store } = await import('../apps/server/src/services/store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { default: updates } = await import('../apps/server/src/routes/updates.js');
const { default: jobs } = await import('../apps/server/src/routes/jobs.js');
const app = express(); app.use(express.json()); app.use('/updates', updates); app.use('/jobs', jobs);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await fs.rm(root, { recursive: true, force: true }); });
const post = (url: string, body = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('every actual job creation and resume path rejects while update owns gate', async () => {
  const release = jobAdmission.beginUpdate(() => false);
  try {
    for (const type of ['transcribe', 'regenerate-range', 'refine-proposal', 'export-video'] as const) await assert.rejects(jobStore.create(type, 'unknown', {}), JobAdmissionError);
    await assert.rejects(jobStore.resume('unknown'), JobAdmissionError);
    assert.equal((await post('/jobs/transcribe', { projectId: 'unknown' })).status, 409);
    assert.equal((await post('/jobs/unknown/resume')).status, 409);
  } finally { release(); }
});

test('install cannot enter while create is waiting on asynchronous project lookup', async () => {
  const oldGet = store.get; let finish!: () => void;
  const blocked = new Promise<void>((r) => { finish = r; });
  store.get = async () => { await blocked; return null; };
  const creation = jobStore.create('transcribe', 'unknown', {});
  const failed = assert.rejects(creation, /Project not found/);
  try { assert.equal((await post('/updates/install')).status, 409); }
  finally { finish(); await failed; store.get = oldGet; }
});

test('unsafe client and disabled preparation failure release the real install-route gate', async () => {
  assert.equal((await post('/updates/install', { safety: { dirty: true } })).status, 409);
  await assert.rejects(jobStore.create('transcribe', 'unknown', {}), /Project not found/);
  const response = await post('/updates/install', { safety: {} });
  assert.ok(response.status >= 400);
  await assert.rejects(jobStore.create('transcribe', 'unknown', {}), /Project not found/);
  jobAdmission.beginUpdate(() => false)();
});

test('terminal status does not permit update before durable job persistence completes', async () => {
  const { config } = await import('../apps/server/src/config.js');
  const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
  const project = { id: 'tail', title: 'Synthetic terminal race', createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'phrase' as const, media: { filename: 'missing.mp4', originalName: 'missing.mp4', mimeType: 'video/mp4', size: 1, url: '/media/missing.mp4' }, transcript: null, captions: [] };
  await store.upsert(project); cancelScheduledProjectPrewarm(project.id);
  const originalRename = fs.rename;
  let entered!: () => void; let release!: () => void;
  const terminalWrite = new Promise<void>((r) => { entered = r; });
  const barrier = new Promise<void>((r) => { release = r; });
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === config.jobsFile) {
      const snapshot = JSON.parse(await fs.readFile(String(args[0]), 'utf8'));
      if (snapshot.some((job: any) => job.projectId === project.id && job.status === 'failed')) { entered(); await barrier; }
    }
    return originalRename(...args);
  };
  try {
    const job = await jobStore.create('export-video', project.id, {});
    await terminalWrite;
    assert.equal((await jobStore.get(job.id))?.status, 'failed');
    assert.equal((await post('/updates/install')).status, 409);
  } finally { release(); fs.rename = originalRename; }
  const deadline = Date.now() + 3000;
  while (jobStore.hasAnyActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobStore.hasAnyActive(), false);
  jobAdmission.beginUpdate(() => jobStore.hasAnyActive())();
});
