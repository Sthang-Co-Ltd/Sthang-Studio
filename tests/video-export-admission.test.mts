import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type ProcessingJob, type VideoExportSettings } from '@kcs/shared';

// All state and the short MP4 fixture are synthetic and isolated from creator files.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-export-admission-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { jobAdmission, JobAdmissionError } = await import('../apps/server/src/services/job-admission.js');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: videoExportRouter } = await import('../apps/server/src/routes/video-export.js');

const app = express();
app.use(express.json());
app.use('/api/video-export', videoExportRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/video-export`;

await fs.mkdir(config.uploadDir, { recursive: true });
const filename = 'synthetic-admission.mp4';
execFileSync(config.ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=1',
  '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(config.uploadDir, filename),
], { timeout: 30_000, windowsHide: true });
const size = (await fs.stat(path.join(config.uploadDir, filename))).size;
const font = (await fontCapabilities()).find((entry) => entry.available);
assert.ok(font, 'The native regression fixture needs one locally available caption font');
const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, bold: false };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function settings(quality: VideoExportSettings['quality']): VideoExportSettings {
  return { resolution: 'source', frameRate: 'source', quality, codec: 'h264', encoder: 'auto' };
}

async function project(id: string): Promise<CaptionProject> {
  const value: CaptionProject = {
    id, title: `Synthetic export ${id}`, createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z', mode: 'phrase', transcript: null,
    media: { filename, originalName: filename, mimeType: 'video/mp4', size, url: `/media/${filename}` },
    captionAppearance: appearance,
    captions: [{ id: `${id}-caption`, text: 'Test caption', startMs: 100, endMs: 800, approved: true }],
  };
  await store.upsert(value);
  cancelScheduledProjectPrewarm(id);
  return (await store.get(id))!;
}

function post(id: string, exportSettings: VideoExportSettings, expectedMedia?: CaptionProject['media'], exportAppearance = appearance) {
  return fetch(`${baseUrl}/${id}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      settings: exportSettings, appearance: exportAppearance,
      ...(expectedMedia ? { expectedMedia: { filename: expectedMedia.filename, size: expectedMedia.size } } : {}),
    }),
  });
}

async function holdExportLane(t: TestContext, id: string) {
  const blockerProject = await project(id);
  const entered = deferred();
  const release = deferred();
  const originalGetMedia = store.getMedia;
  const getMedia = t.mock.method(store, 'getMedia', async (projectId: string) => {
    if (projectId === blockerProject.id) {
      entered.resolve();
      await release.promise;
    }
    return originalGetMedia(projectId);
  });
  // The incomplete blocker fails only after release. While suspended in
  // assertJobMediaCurrent it occupies the export lane without rendering media.
  const job = await jobStore.create('export-video', blockerProject.id, {});
  await entered.promise;
  return {
    async stop() {
      try { await jobStore.cancel(job.id); }
      finally { release.resolve(); getMedia.mock.restore(); }
      const deadline = Date.now() + 10_000;
      while (jobStore.hasAnyActive() && Date.now() < deadline) {
        await new Promise<void>((done) => setTimeout(done, 20));
      }
      assert.equal(jobStore.hasAnyActive(), false, 'export lane and terminal persistence must drain before fixture cleanup');
    },
  };
}

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('overlapping HTTP exports create one job, reject the duplicate and retain newer settings from another project', { timeout: 60_000 }, async (t) => {
  const lane = await holdExportLane(t, 'lane-concurrent');
  const firstProject = await project('concurrent-video');
  const newerProject = await project('newer-video');
  const firstEntered = deferred();
  const duplicateEntered = deferred();
  const releaseFirst = deferred();
  const releaseDuplicate = deferred();
  const originalSave = store.setCaptionAppearance;
  let appearanceSaves = 0;
  const appearanceSave = t.mock.method(store, 'setCaptionAppearance', async (...args: Parameters<typeof store.setCaptionAppearance>) => {
    if (args[0] === firstProject.id) {
      const order = ++appearanceSaves;
      if (order === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      if (order === 2) { duplicateEntered.resolve(); await releaseDuplicate.promise; }
    }
    return originalSave(...args);
  });
  const originalProfileSave = profileStore.setLastVideoExportSettings;
  const persistedSettings: unknown[] = [];
  const profileSave = t.mock.method(profileStore, 'setLastVideoExportSettings', async (...args: Parameters<typeof profileStore.setLastVideoExportSettings>) => {
    persistedSettings.push(structuredClone(args[0]));
    return originalProfileSave(...args);
  });
  const originalSettings = settings('recommended');
  const rejectedSettings = settings('smaller');
  const newerSettings = settings('high');
  const rejectedAppearance = { ...appearance, textColor: '#EA384F' };
  let firstRequest: Promise<Response> | undefined;
  let duplicateRequest: Promise<Response> | undefined;
  const queuedIds = new Set<string>();
  try {
    firstRequest = post(firstProject.id, originalSettings, firstProject.media);
    await firstEntered.promise;
    duplicateRequest = post(firstProject.id, rejectedSettings, firstProject.media, rejectedAppearance);
    await duplicateEntered.promise; // Both already passed the route's initial jobStore.list.

    releaseFirst.resolve();
    const first = await firstRequest;
    assert.equal(first.status, 202, await first.clone().text());
    const originalJob = await first.json() as ProcessingJob;
    queuedIds.add(originalJob.id);
    assert.equal(originalJob.lastUsedSettingsSaved, true);

    const newer = await post(newerProject.id, newerSettings, newerProject.media);
    assert.equal(newer.status, 202, await newer.clone().text());
    const newerJob = await newer.json() as ProcessingJob;
    queuedIds.add(newerJob.id);
    assert.equal(newerJob.lastUsedSettingsSaved, true);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, newerSettings);

    releaseDuplicate.resolve();
    const duplicate = await duplicateRequest;
    assert.equal(duplicate.status, 409, `The duplicate must not be accepted: ${await duplicate.clone().text()}`);
    const duplicateBody = await duplicate.json() as { error?: string; lastUsedSettingsSaved?: boolean };
    assert.match(duplicateBody.error || '', /already active/i);
    assert.equal(duplicateBody.lastUsedSettingsSaved, undefined);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, newerSettings,
      'the duplicate must not replace the newer last-used settings from another project');
    assert.deepEqual(persistedSettings, [originalSettings, newerSettings], 'only genuine export acceptances persist last-used choices');

    const jobs = await jobStore.list(firstProject.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, originalJob.id);
    const diskJobs = JSON.parse(await fs.readFile(config.jobsFile, 'utf8')) as Array<{ id: string; payload: { exportSettings?: VideoExportSettings; exportAppearance?: typeof appearance; exportCaptions?: unknown[] } }>;
    const stored = diskJobs.find((job) => job.id === originalJob.id);
    assert.ok(stored);
    assert.deepEqual(stored.payload.exportSettings, originalSettings, 'accepted job payload is immutable');
    assert.deepEqual(stored.payload.exportAppearance, appearance, 'rejected concurrent styling cannot alter the accepted job snapshot');
    assert.equal(stored.payload.exportCaptions?.length, 1);
    assert.equal(appearanceSaves, 2, 'both requests crossed the previously vulnerable asynchronous window');
    assert.equal((await jobStore.create('export-video', firstProject.id, {})).id, originalJob.id,
      'existing jobStore.create callers still receive their original duplicate job');
  } finally {
    releaseFirst.resolve();
    releaseDuplicate.resolve();
    await Promise.allSettled([firstRequest, duplicateRequest].filter((value): value is Promise<Response> => Boolean(value)));
    appearanceSave.mock.restore();
    profileSave.mock.restore();
    for (const id of queuedIds) await jobStore.cancel(id).catch(() => {});
    await lane.stop();
  }
});

test('rejected or cancelled export requests do not save settings; accepted job survives profile storage failure', { timeout: 60_000 }, async (t) => {
  const lane = await holdExportLane(t, 'lane-fail-open');
  const candidate = await project('fail-open-video');
  const before = await profileStore.get();
  const candidateSettings = settings('high');
  let acceptedJob: ProcessingJob | undefined;
  try {
    assert.equal((await post(candidate.id, candidateSettings)).status, 428);
    assert.equal((await post(candidate.id, candidateSettings, { ...candidate.media, size: candidate.media.size + 1 })).status, 409);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, before.lastVideoExportSettings);

    const save = t.mock.method(profileStore, 'setLastVideoExportSettings', async () => {
      throw new Error('PRIVATE synthetic profile storage path and EIO');
    });
    try {
      const response = await post(candidate.id, candidateSettings, candidate.media);
      assert.equal(response.status, 202, await response.clone().text());
      acceptedJob = await response.json() as ProcessingJob;
      assert.equal(acceptedJob.lastUsedSettingsSaved, false);
      assert.equal(JSON.stringify(acceptedJob).includes('PRIVATE synthetic profile'), false);
      assert.equal(save.mock.callCount(), 1);
      assert.deepEqual((await profileStore.get()).lastVideoExportSettings, before.lastVideoExportSettings);
      assert.equal((await jobStore.get(acceptedJob.id))?.status, 'queued');
      await assert.rejects(jobAdmission.changeProjectMedia(candidate.id, () => jobStore.hasActiveForProject(candidate.id), async () => true), JobAdmissionError);
    } finally { save.mock.restore(); }

    const cancelled = await jobStore.cancel(acceptedJob.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await jobAdmission.changeProjectMedia(candidate.id, () => jobStore.hasActiveForProject(candidate.id), async () => true), true,
      'cancelled queued exports no longer block a safe media transaction');
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, before.lastVideoExportSettings);
  } finally {
    if (acceptedJob) await jobStore.cancel(acceptedJob.id).catch(() => {});
    await lane.stop();
  }
});
