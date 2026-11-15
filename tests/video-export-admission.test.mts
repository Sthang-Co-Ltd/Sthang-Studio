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
const { exportFingerprint } = await import('../apps/server/src/services/export-evidence.js');
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

async function post(id: string, exportSettings: VideoExportSettings, expectedMedia?: CaptionProject['media'], exportAppearance = appearance, reviewedFingerprint?: string | null) {
  const saved = await store.get(id);
  const expectedContentFingerprint = reviewedFingerprint === null ? undefined : reviewedFingerprint
    ?? (saved ? exportFingerprint({ ...saved, captionAppearance: exportAppearance }, 'video') : undefined);
  return fetch(`${baseUrl}/${id}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      settings: exportSettings, appearance: exportAppearance,
      expectedContentFingerprint,
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
  const originalCreate = jobStore.createWithDisposition;
  let admissions = 0;
  const admission = t.mock.method(jobStore, 'createWithDisposition', async (...args: Parameters<typeof jobStore.createWithDisposition>) => {
    if (args[1] === firstProject.id) {
      const order = ++admissions;
      if (order === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      if (order === 2) { duplicateEntered.resolve(); await releaseDuplicate.promise; }
    }
    return originalCreate.apply(jobStore, args);
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
  let firstRequest: Promise<Response> | undefined;
  let duplicateRequest: Promise<Response> | undefined;
  const queuedIds = new Set<string>();
  try {
    firstRequest = post(firstProject.id, originalSettings, firstProject.media);
    await firstEntered.promise;
    duplicateRequest = post(firstProject.id, rejectedSettings, firstProject.media);
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
    assert.deepEqual(stored.payload.exportAppearance, appearance, 'the accepted job keeps the reviewed saved appearance');
    assert.equal(stored.payload.exportCaptions?.length, 1);
    assert.equal(admissions, 2, 'both requests crossed the asynchronous preparation window before durable admission');
    assert.deepEqual(await store.get(firstProject.id), firstProject, 'export preparation and duplicate rejection never rewrite project appearance or its revision');
    assert.equal((await jobStore.create('export-video', firstProject.id, {})).id, originalJob.id,
      'existing jobStore.create callers still receive their original duplicate job');
  } finally {
    releaseFirst.resolve();
    releaseDuplicate.resolve();
    await Promise.allSettled([firstRequest, duplicateRequest].filter((value): value is Promise<Response> => Boolean(value)));
    admission.mock.restore();
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

test('delayed export preparation cannot overwrite a newer saved look or create an unreviewed export', { timeout: 60_000 }, async (t) => {
  const candidate = await project('newer-appearance-during-export');
  const entered = deferred(); const release = deferred();
  const original = store.withProjectWrite;
  const transaction = t.mock.method(store, 'withProjectWrite', async (...args: Parameters<typeof store.withProjectWrite>) => {
    if (args[0] === candidate.id) { entered.resolve(); await release.promise; }
    return original(...args);
  });
  const beforeProfile = await profileStore.get();
  const pending = post(candidate.id, settings('high'), candidate.media);
  try {
    await entered.promise;
    const newerLook = { ...appearance, textColor: '#EA384F', fontSize1080: 95 };
    const newer = await store.setCaptionAppearance(candidate.id, newerLook);
    assert.ok(newer);
    const projectFile = path.join(path.dirname(config.dataFile), 'projects', `${candidate.id}.json`);
    const bytes = await fs.readFile(projectFile, 'utf8');
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, 'APPEARANCE_REVISION_CHANGED');
    assert.deepEqual(await store.get(candidate.id), newer);
    assert.equal(await fs.readFile(projectFile, 'utf8'), bytes);
    assert.deepEqual(await jobStore.list(candidate.id), []);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, beforeProfile.lastVideoExportSettings);
  } finally {
    release.resolve();
    await pending;
    transaction.mock.restore();
  }
});

test('video admission requires reviewed content and rejects stale captions without changing jobs or profile', { timeout: 60_000 }, async () => {
  const candidate = await project('stale-reviewed-captions');
  const beforeProfile = await profileStore.get();
  const reviewed = exportFingerprint(candidate, 'video');
  const missing = await post(candidate.id, settings('high'), candidate.media, appearance, null);
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).code, 'VIDEO_CONTENT_BASIS_REQUIRED');
  const updated = { ...candidate, captions: candidate.captions.map((cue) => ({ ...cue, text: 'Saved in the other tab', startMs: 150 })) };
  const savedUpdated = await store.upsert(updated);
  cancelScheduledProjectPrewarm(candidate.id);
  const stale = await post(candidate.id, settings('high'), candidate.media, appearance, reviewed);
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.equal((await stale.json()).code, 'VIDEO_CONTENT_REVISION_CHANGED');
  assert.deepEqual(await jobStore.list(candidate.id), []);
  assert.deepEqual(await store.get(candidate.id), savedUpdated);
  assert.deepEqual((await profileStore.get()).lastVideoExportSettings, beforeProfile.lastVideoExportSettings);
});

test('reviewed caption content is compared inside the final export snapshot transaction', { timeout: 60_000 }, async (t) => {
  const candidate = await project('captions-during-export-probe');
  const entered = deferred(); const release = deferred();
  const original = store.withProjectWrite;
  const transaction = t.mock.method(store, 'withProjectWrite', async (...args: Parameters<typeof store.withProjectWrite>) => {
    if (args[0] === candidate.id) { entered.resolve(); await release.promise; }
    return original(...args);
  });
  const beforeProfile = await profileStore.get();
  const pending = post(candidate.id, settings('high'), candidate.media);
  try {
    await entered.promise;
    const newer = { ...candidate, captions: candidate.captions.map((cue) => ({ ...cue, endMs: 900 })) };
    const savedNewer = await store.upsert(newer);
    cancelScheduledProjectPrewarm(candidate.id);
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, 'VIDEO_CONTENT_REVISION_CHANGED');
    assert.deepEqual(await store.get(candidate.id), savedNewer);
    assert.deepEqual(await jobStore.list(candidate.id), []);
    assert.deepEqual((await profileStore.get()).lastVideoExportSettings, beforeProfile.lastVideoExportSettings);
  } finally { release.resolve(); await pending; transaction.mock.restore(); }
});

test('unrelated project metadata and review flags do not invalidate reviewed video content', { timeout: 60_000 }, async (t) => {
  const lane = await holdExportLane(t, 'metadata-export-lane');
  const candidate = await project('video-metadata-only-change');
  const reviewed = exportFingerprint(candidate, 'video');
  let accepted: ProcessingJob | undefined;
  try {
    const changed = { ...candidate, title: 'A newer project name', updatedAt: new Date().toISOString(),
      captions: candidate.captions.map((cue) => ({ ...cue, approved: false, textLocked: true })) };
    await store.upsert(changed); cancelScheduledProjectPrewarm(candidate.id);
    const response = await post(candidate.id, settings('recommended'), candidate.media, appearance, reviewed);
    assert.equal(response.status, 202, await response.clone().text());
    accepted = await response.json() as ProcessingJob;
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.projectTitle, changed.title);
  } finally {
    if (accepted) await jobStore.cancel(accepted.id);
    await lane.stop();
  }
});

test('completed video keeps its verified result when saving Activity completion fails', { timeout: 60_000 }, async (t) => {
  const candidate = await project('completed-result-write-failure');
  const originalRename = fs.rename;
  let completionWrites = 0;
  const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === config.jobsFile) {
      const snapshot = JSON.parse(await fs.readFile(args[0], 'utf8'));
      if (snapshot.some((job: ProcessingJob) => job.projectId === candidate.id && job.status === 'completed')) {
        completionWrites++;
        throw new Error('Synthetic completion storage failure');
      }
    }
    return originalRename(...args);
  });
  try {
    const accepted = await jobStore.createWithDisposition('export-video', candidate.id, {
      exportSettings: settings('recommended'), exportAppearance: appearance, exportCaptions: candidate.captions,
      exportMediaFilename: candidate.media.filename, exportMediaSize: candidate.media.size,
    });
    const deadline = Date.now() + 45_000;
    while (jobStore.hasAnyActive() && Date.now() < deadline) await new Promise<void>((done) => setTimeout(done, 20));
    assert.equal(jobStore.hasAnyActive(), false);
    const completed = (await jobStore.get(accepted.job.id))!;
    assert.equal(completionWrites, 1);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.canResume, false);
    assert.match(completed.message, /Activity could not save this completion/);
    assert.ok(completed.resultExport);
    assert.equal((await fs.stat(path.join(config.exportDir, completed.resultExport.filename))).size, completed.resultExport.sizeBytes);
    const durable = JSON.parse(await fs.readFile(config.jobsFile, 'utf8')).find((job: ProcessingJob) => job.id === accepted.job.id);
    assert.equal(durable.status, 'running');
    assert.equal(durable.payload.exportPublication.jobId, accepted.job.id);
    assert.deepEqual(durable.payload.exportPublication.result, completed.resultExport);
    await assert.rejects(jobStore.resume(accepted.job.id), /Only failed or interrupted/);
  } finally { fault.mock.restore(); }
});

test('failed durable publication intent never publishes the verified video', { timeout: 60_000 }, async (t) => {
  const candidate = await project('publication-intent-write-failure');
  const filesBefore = await fs.readdir(config.exportDir).catch(() => [] as string[]);
  const originalRename = fs.rename;
  let intentWrites = 0;
  const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === config.jobsFile) {
      const snapshot = JSON.parse(await fs.readFile(args[0], 'utf8'));
      if (snapshot.some((job: any) => job.projectId === candidate.id && job.payload.exportPublication)) {
        intentWrites++;
        throw new Error('Synthetic publication intent storage failure');
      }
    }
    return originalRename(...args);
  });
  try {
    const accepted = await jobStore.createWithDisposition('export-video', candidate.id, {
      exportSettings: settings('recommended'), exportAppearance: appearance, exportCaptions: candidate.captions,
      exportMediaFilename: candidate.media.filename, exportMediaSize: candidate.media.size,
    });
    const deadline = Date.now() + 45_000;
    while (jobStore.hasAnyActive() && Date.now() < deadline) await new Promise<void>((done) => setTimeout(done, 20));
    assert.equal(jobStore.hasAnyActive(), false);
    const failed = (await jobStore.get(accepted.job.id))!;
    assert.equal(intentWrites, 1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.resultExport, undefined);
    assert.equal(failed.canResume, true);
    assert.deepEqual((await fs.readdir(config.exportDir)).filter((name) => name !== '.working'), filesBefore.filter((name) => name !== '.working'));
  } finally { fault.mock.restore(); }
});
