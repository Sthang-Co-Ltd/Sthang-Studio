import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, CaptionSegment } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-playback-grouping-server-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { proposalStore } = await import('../apps/server/src/services/proposal-store.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { default: profileRouter } = await import('../apps/server/src/routes/profile.js');

const projectDir = path.join(path.dirname(config.dataFile), 'projects');
await fs.mkdir(projectDir, { recursive: true });
await fs.mkdir(config.uploadDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/projects', projectsRouter);
app.use('/api/profile', profileRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

function caption(text: string): CaptionSegment {
  return {
    id: 'c1',
    startMs: 0,
    endMs: 1000,
    text,
    textLocked: false,
    timingLocked: false,
    approved: false,
  };
}

async function seedProject(id: string, withTranscript = false) {
  const media = {
    filename: `${id}-old.mp4`,
    originalName: `${id}-old.mp4`,
    mimeType: 'video/mp4',
    size: 3,
    url: `/media/${id}-old.mp4`,
  };
  const project: CaptionProject = {
    id,
    title: `Synthetic ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    media,
    mode: 'phrase',
    transcript: withTranscript ? {
      language: 'km',
      fullText: 'ខ្មែរ',
      segments: [],
      tokens: [{ id: 't1', text: 'ខ្មែរ', startMs: 0, endMs: 1000, spaceBefore: false, timingSource: 'stt' }],
    } : null,
    transcriptionContext: { description: '', vocabulary: [] },
    captions: [caption('OLD CAPTION')],
    engineVersion: '0.7.10',
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  await fs.writeFile(path.join(config.uploadDir, media.filename), Buffer.from('old'));
  await historyStore.clear(id);
  return project;
}

async function readDiskProject(id: string) {
  return JSON.parse(await fs.readFile(path.join(projectDir, `${id}.json`), 'utf8')) as CaptionProject;
}

async function replaceMedia(id: string, contents = 'replacement') {
  const form = new FormData();
  form.append('media', new Blob([contents], { type: 'video/mp4' }), 'replacement.mp4');
  return fetch(`${baseUrl}/api/projects/${id}/replace-media`, { method: 'POST', body: form });
}

async function saveCaptions(id: string, captions: CaptionSegment[], expectedMedia: CaptionProject['media']) {
  return fetch(`${baseUrl}/api/projects/${id}/captions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      captions,
      expectedMedia: { filename: expectedMedia.filename, size: expectedMedia.size },
      source: 'manual-save',
      recordCorrections: false,
    }),
  });
}

async function resegment(id: string, expectedMedia: CaptionProject['media'], mode = 'word') {
  return fetch(`${baseUrl}/api/projects/${id}/resegment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode,
      expectedMedia: { filename: expectedMedia.filename, size: expectedMedia.size },
    }),
  });
}

async function normalizeSpacing(id: string, expectedMedia: CaptionProject['media']) {
  return fetch(`${baseUrl}/api/projects/${id}/normalize-khmer-spacing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedMedia: { filename: expectedMedia.filename, size: expectedMedia.size } }),
  });
}

const timingSettings = {
  id: 'synthetic',
  name: 'Synthetic timing profile',
  description: 'Deterministic server regression settings',
  maxCps: 30,
  maxCharsPerLine: 42,
  maxLines: 2,
  minDurationMs: 300,
  maxDurationMs: 5000,
  minGapMs: 40,
  leadInMs: 20,
  leadOutMs: 20,
  snapToleranceMs: 80,
};

async function postprocessTiming(id: string, expectedMedia: CaptionProject['media']) {
  return fetch(`${baseUrl}/api/projects/${id}/postprocess-timing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      settings: timingSettings,
      expectedMedia: { filename: expectedMedia.filename, size: expectedMedia.size },
    }),
  });
}

async function restoreHistory(id: string, historyId: string) {
  return fetch(`${baseUrl}/api/projects/${id}/history/${historyId}/restore`, { method: 'POST' });
}

async function listHistory(id: string) {
  const response = await fetch(`${baseUrl}/api/projects/${id}/history`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Array<{ id: string }>>;
}

async function seedProposal(project: CaptionProject, proposalId = `${project.id}-proposal`) {
  await fs.mkdir(config.proposalDir, { recursive: true });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const stored = {
    summary: {
      id: proposalId,
      projectId: project.id,
      createdAt: new Date().toISOString(),
      expiresAt,
      startMs: 0,
      endMs: 1000,
      currentCaptions: project.captions,
      proposedCaptions: project.captions,
      passNumber: 1,
      strategy: 'standard',
    },
    sourceUpdatedAt: project.updatedAt,
    originalCaptions: project.captions,
    proposedCaptions: project.captions,
    proposedTokens: project.transcript?.tokens || [],
    proposedTranscript: project.transcript,
    proposedTiming: {},
    context: project.transcriptionContext,
  };
  const file = path.join(config.proposalDir, `${proposalId}.json`);
  await fs.writeFile(file, JSON.stringify(stored), 'utf8');
  return { id: proposalId, file };
}

async function applyProposal(id: string, proposalId: string, mode = 'all') {
  return fetch(`${baseUrl}/api/projects/${id}/regeneration-proposals/${proposalId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

async function correctionAction(id: string, action: 'remember-global' | 'add-project' | 'ignore') {
  return fetch(`${baseUrl}/api/profile/corrections/${id}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function installFirstMutationGate() {
  const gate = deferred();
  const entered = deferred();
  const candidate = store as any;
  if (typeof candidate.withProjectWrite === 'function') {
    const original = candidate.withProjectWrite.bind(store);
    let calls = 0;
    candidate.withProjectWrite = async (...args: any[]) => {
      calls += 1;
      if (calls === 1) {
        entered.release();
        await gate.promise;
      }
      return original(...args);
    };
    return { entered: entered.promise, release: gate.release, restore: () => { candidate.withProjectWrite = original; } };
  }
  const original = candidate.upsert.bind(store);
  let calls = 0;
  candidate.upsert = async (...args: any[]) => {
    calls += 1;
    if (calls === 1) {
      entered.release();
      await gate.promise;
    }
    return original(...args);
  };
  return { entered: entered.promise, release: gate.release, restore: () => { candidate.upsert = original; } };
}

async function installSecondMutationSignal() {
  const entered = deferred();
  const candidate = store as any;
  const method = typeof candidate.withProjectWrite === 'function' ? 'withProjectWrite' : 'upsert';
  const original = candidate[method].bind(store);
  let calls = 0;
  candidate[method] = async (...args: any[]) => {
    calls += 1;
    if (calls === 2) entered.release();
    return original(...args);
  };
  return { entered: entered.promise, restore: () => { candidate[method] = original; } };
}

test('a caption save accepted before same-id replacement cannot restore the old media generation', { timeout: 10_000 }, async () => {
  const project = await seedProject('held-save');
  const gate = await installFirstMutationGate();
  const staleSave = saveCaptions(project.id, [caption('STALE CAPTION')], project.media);
  try {
    await gate.entered;
    const replacementResponse = await replaceMedia(project.id);
    assert.equal(replacementResponse.status, 200);
    const replacement = await replacementResponse.json() as CaptionProject;
    assert.notEqual(replacement.media.filename, project.media.filename);
    gate.release();
    const saveResponse = await staleSave;
    assert.equal(saveResponse.status, 409);
    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacement.media.filename);
    assert.deepEqual(disk.captions, []);
    await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(config.uploadDir, replacement.media.filename))).isFile(), true);
    assert.deepEqual(await historyStore.list(project.id), []);
  } finally {
    gate.release();
    gate.restore();
    cancelScheduledProjectPrewarm(project.id);
    await staleSave.catch(() => {});
  }
});

test('a caption save queued behind replacement sees the published media generation and is rejected', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('queued-save');
  const secondMutation = await installSecondMutationSignal();
  const renameGate = deferred();
  const renameEntered = deferred();
  const rename = fs.rename;
  let held = false;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!held && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      held = true;
      renameEntered.release();
      await renameGate.promise;
    }
    return rename(...args);
  });
  const replacement = replaceMedia(project.id);
  try {
    await renameEntered.promise;
    const staleSave = saveCaptions(project.id, [caption('QUEUED STALE CAPTION')], project.media);
    await secondMutation.entered;
    renameGate.release();
    const replacementResponse = await replacement;
    assert.equal(replacementResponse.status, 200);
    const replacementProject = await replacementResponse.json() as CaptionProject;
    const saveResponse = await staleSave;
    assert.equal(saveResponse.status, 409);
    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacementProject.media.filename);
    assert.deepEqual(disk.captions, []);
    await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(config.uploadDir, replacementProject.media.filename))).isFile(), true);
  } finally {
    renameGate.release();
    secondMutation.restore();
    mocked.mock.restore();
    cancelScheduledProjectPrewarm(project.id);
    await replacement.catch(() => {});
  }
});

test('a stale caption request arriving after replacement does not create history or restore old captions', async () => {
  const project = await seedProject('published-replacement');
  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;
  cancelScheduledProjectPrewarm(project.id);
  const saveResponse = await saveCaptions(project.id, [caption('TOO LATE')], project.media);
  assert.equal(saveResponse.status, 409);
  assert.deepEqual(await historyStore.list(project.id), []);
  const disk = await readDiskProject(project.id);
  assert.equal(disk.media.filename, replacement.media.filename);
  assert.deepEqual(disk.captions, []);
});

test('a project glossary correction queued after replacement cannot restore retired media or captions', { timeout: 10_000 }, async () => {
  const project = await seedProject('correction-glossary-race');
  const corrected = [{ ...project.captions[0], text: 'OLD CAPTION CapCut' }];
  const recorded = await profileStore.recordCaptionChanges(project, project.captions, corrected);
  assert.equal(recorded.created.length, 1);
  const event = recorded.created[0];

  const mutationEntered = deferred();
  const mutationRelease = deferred();
  const candidate = store as any;
  const originalWithProjectWrite = candidate.withProjectWrite.bind(store);
  const originalUpsert = candidate.upsert.bind(store);
  let holdCorrectionMutation = true;
  const hold = async (matches: boolean) => {
    if (!holdCorrectionMutation || !matches) return;
    holdCorrectionMutation = false;
    mutationEntered.release();
    await mutationRelease.promise;
  };
  candidate.withProjectWrite = async (...args: any[]) => {
    await hold(args[0] === project.id);
    return originalWithProjectWrite(...args);
  };
  candidate.upsert = async (...args: any[]) => {
    await hold(args[0]?.id === project.id);
    return originalUpsert(...args);
  };

  const actionPromise = correctionAction(event.id, 'add-project');
  try {
    await mutationEntered.promise;
    const replacementResponse = await replaceMedia(project.id);
    assert.equal(replacementResponse.status, 200);
    const replacement = await replacementResponse.json() as CaptionProject;
    mutationRelease.release();

    const actionResponse = await actionPromise;
    assert.equal(actionResponse.status, 200);
    const actionResult = await actionResponse.json() as { project: CaptionProject };
    assert.equal(actionResult.project.media.filename, replacement.media.filename);
    assert.deepEqual(actionResult.project.captions, []);
    assert.ok(actionResult.project.transcriptionContext?.vocabulary?.includes(event.suggestedVocabularyLine));

    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacement.media.filename);
    assert.deepEqual(disk.captions, []);
    assert.ok(disk.transcriptionContext?.vocabulary?.includes(event.suggestedVocabularyLine));
    await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(config.uploadDir, replacement.media.filename))).isFile(), true);
  } finally {
    mutationRelease.release();
    candidate.withProjectWrite = originalWithProjectWrite;
    candidate.upsert = originalUpsert;
    cancelScheduledProjectPrewarm(project.id);
    await actionPromise.catch(() => {});
  }
});

test('a failed caption persistence does not publish partial state and the project write queue recovers', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('save-failure');
  const before = await readDiskProject(project.id);
  const rename = fs.rename;
  let failNext = true;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (failNext && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      failNext = false;
      throw new Error('Synthetic caption persistence failure');
    }
    return rename(...args);
  });
  const failed = await saveCaptions(project.id, before.captions, project.media);
  assert.equal(failed.status, 500);
  assert.match(String((await failed.json() as any).error), /Synthetic caption persistence failure/);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await readDiskProject(project.id), before);
  mocked.mock.restore();
  const recovered = await saveCaptions(project.id, [caption('RECOVERED SAVE')], project.media);
  assert.equal(recovered.status, 200);
  const disk = await readDiskProject(project.id);
  assert.equal(disk.captions[0].text, 'RECOVERED SAVE');
});

test('a regroup queued behind a replacement cannot restore the deleted media generation', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('queued-regroup', true);
  const renameGate = deferred();
  const renameEntered = deferred();
  const rename = fs.rename;
  let held = false;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!held && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      held = true;
      renameEntered.release();
      await renameGate.promise;
    }
    return rename(...args);
  });
  const replacement = replaceMedia(project.id);
  try {
    await renameEntered.promise;
    const staleRegroup = resegment(project.id, project.media);
    renameGate.release();
    const replacementResponse = await replacement;
    assert.equal(replacementResponse.status, 200);
    const replacementProject = await replacementResponse.json() as CaptionProject;
    const regroupResponse = await staleRegroup;
    assert.equal(regroupResponse.status, 409);
    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacementProject.media.filename);
    assert.deepEqual(disk.captions, []);
    await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(config.uploadDir, replacementProject.media.filename))).isFile(), true);
    assert.deepEqual(await listHistory(project.id), []);
  } finally {
    renameGate.release();
    mocked.mock.restore();
    cancelScheduledProjectPrewarm(project.id);
    await replacement.catch(() => {});
  }
});

test('a regroup that owns the project write first may finish, then replacement retires its history', { timeout: 10_000 }, async () => {
  const project = await seedProject('regroup-before-replace', true);
  const gate = deferred();
  const entered = deferred();
  const originalCheckpoint = historyStore.checkpoint.bind(historyStore);
  let held = false;
  historyStore.checkpoint = async (...args: Parameters<typeof historyStore.checkpoint>) => {
    if (!held && args[0].id === project.id && args[2] === 'regroup') {
      held = true;
      entered.release();
      await gate.promise;
    }
    return originalCheckpoint(...args);
  };
  const regroup = resegment(project.id, project.media);
  try {
    await entered.promise;
    const replacement = replaceMedia(project.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.release();
    const regroupResponse = await regroup;
    assert.equal(regroupResponse.status, 200);
    const replacementResponse = await replacement;
    assert.equal(replacementResponse.status, 200);
    const replacementProject = await replacementResponse.json() as CaptionProject;
    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacementProject.media.filename);
    assert.deepEqual(disk.captions, []);
    assert.deepEqual(await listHistory(project.id), []);
  } finally {
    gate.release();
    historyStore.checkpoint = originalCheckpoint;
    cancelScheduledProjectPrewarm(project.id);
    await regroup.catch(() => {});
  }
});

test('a stale regroup arriving after replacement is rejected before history is written', async () => {
  const project = await seedProject('late-regroup', true);
  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;
  const stale = await resegment(project.id, project.media);
  assert.equal(stale.status, 409);
  const disk = await readDiskProject(project.id);
  assert.equal(disk.media.filename, replacement.media.filename);
  assert.deepEqual(disk.captions, []);
  assert.deepEqual(await listHistory(project.id), []);
  cancelScheduledProjectPrewarm(project.id);
});

test('a spacing cleanup queued behind replacement cannot republish the retired media generation', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('queued-spacing', true);
  await historyStore.checkpoint(project, 'Old generation checkpoint', 'manual-save');
  const proposal = await seedProposal(project);
  const renameGate = deferred();
  const renameEntered = deferred();
  const mutationQueued = deferred();
  const rename = fs.rename;
  let heldRename = false;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!heldRename && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      heldRename = true;
      renameEntered.release();
      await renameGate.promise;
    }
    return rename(...args);
  });

  const candidate = store as any;
  const originalWithProjectWrite = candidate.withProjectWrite.bind(store);
  const originalUpsert = candidate.upsert.bind(store);
  let watchStaleMutation = false;
  const signalQueued = () => {
    if (!watchStaleMutation) return;
    watchStaleMutation = false;
    void Promise.resolve().then(() => mutationQueued.release());
  };
  t.mock.method(candidate, 'withProjectWrite', (...args: any[]) => {
    const task = originalWithProjectWrite(...args);
    if (args[0] === project.id) signalQueued();
    return task;
  });
  t.mock.method(candidate, 'upsert', (...args: any[]) => {
    const task = originalUpsert(...args);
    if (args[0]?.id === project.id) signalQueued();
    return task;
  });

  const replacementPromise = replaceMedia(project.id);
  try {
    await renameEntered.promise;
    watchStaleMutation = true;
    const staleSpacingPromise = normalizeSpacing(project.id, project.media);
    await mutationQueued.promise;
    renameGate.release();
    const replacementResponse = await replacementPromise;
    assert.equal(replacementResponse.status, 200);
    const replacement = await replacementResponse.json() as CaptionProject;
    const spacingResponse = await staleSpacingPromise;
    assert.equal(spacingResponse.status, 409);

    const disk = await readDiskProject(project.id);
    assert.equal(disk.media.filename, replacement.media.filename);
    assert.deepEqual(disk.captions, []);
    assert.deepEqual(await listHistory(project.id), []);
    assert.equal((await fetch(`${baseUrl}/api/projects/${project.id}/regeneration-proposals/${proposal.id}`)).status, 404);
    await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(config.uploadDir, replacement.media.filename))).isFile(), true);
  } finally {
    renameGate.release();
    cancelScheduledProjectPrewarm(project.id);
    await replacementPromise.catch(() => {});
  }
});

test('spacing cleanup may finish first and replacement then retires that generation normally', async () => {
  const project = await seedProject('spacing-before-replacement', true);
  project.captions = [{ ...project.captions[0], text: 'ខ្មែរ   កម្ពុជា' }];
  await store.upsert(project);
  const spacing = await normalizeSpacing(project.id, project.media);
  assert.equal(spacing.status, 200);
  const cleaned = await spacing.json() as CaptionProject;
  assert.equal(cleaned.media.filename, project.media.filename);
  assert.equal((await listHistory(project.id)).length, 1);

  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;
  const disk = await readDiskProject(project.id);
  assert.equal(disk.media.filename, replacement.media.filename);
  assert.deepEqual(disk.captions, []);
  assert.deepEqual(await listHistory(project.id), []);
  cancelScheduledProjectPrewarm(project.id);
});

test('timing cleanup rejects an old media version and succeeds for the current generation', async () => {
  const project = await seedProject('timing-generation', true);
  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;

  const stale = await postprocessTiming(project.id, project.media);
  assert.equal(stale.status, 409);
  const saved = await saveCaptions(project.id, [caption('CURRENT TIMING')], replacement.media);
  assert.equal(saved.status, 200);
  const current = await postprocessTiming(project.id, replacement.media);
  assert.equal(current.status, 200);
  const processed = await current.json() as CaptionProject;
  assert.equal(processed.media.filename, replacement.media.filename);
  assert.equal(processed.captions[0].timingSource, 'manual');
  assert.equal((await listHistory(project.id)).length >= 1, true);
  cancelScheduledProjectPrewarm(project.id);
});

test('a current-media regroup succeeds through the queued store path and preserves locks', async () => {
  const project = await seedProject('current-regroup', true);
  project.captions = [{ ...project.captions[0], text: 'LOCKED WORDING', textLocked: true }];
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const response = await resegment(project.id, project.media);
  assert.equal(response.status, 200);
  const regrouped = await response.json() as CaptionProject;
  assert.equal(regrouped.mode, 'word');
  assert.equal(regrouped.captions.length, 1);
  assert.equal(regrouped.captions[0].text, 'LOCKED WORDING');
  assert.equal(regrouped.captions[0].textLocked, true);
  const disk = await readDiskProject(project.id);
  assert.deepEqual(disk.captions, regrouped.captions);
  assert.equal((await listHistory(project.id)).length, 1);
});

test('an in-flight old-generation proposal apply cannot republish replaced media', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('proposal-apply-race', true);
  const proposal = await seedProposal(project);
  const checkpointEntered = deferred();
  const checkpointRelease = deferred();
  const replacementQueued = deferred();

  const historyCandidate = historyStore as any;
  const originalCheckpoint = historyCandidate.checkpoint.bind(historyStore);
  let holdApplyCheckpoint = true;
  t.mock.method(historyCandidate, 'checkpoint', async (...args: any[]) => {
    const [snapshot, label] = args;
    if (holdApplyCheckpoint && snapshot?.id === project.id && String(label).startsWith('Before applying regeneration')) {
      holdApplyCheckpoint = false;
      checkpointEntered.release();
      await checkpointRelease.promise;
    }
    return originalCheckpoint(...args);
  });

  const storeCandidate = store as any;
  const originalWithProjectWrite = storeCandidate.withProjectWrite.bind(store);
  let watchReplacementQueue = false;
  t.mock.method(storeCandidate, 'withProjectWrite', async (...args: any[]) => {
    const task = originalWithProjectWrite(...args);
    if (watchReplacementQueue && args[0] === project.id) {
      // The store is already initialized. Let withProjectWrite finish its await
      // and enqueue the replacement before the held proposal apply continues.
      await Promise.resolve();
      replacementQueued.release();
    }
    return task;
  });

  const applyResponsePromise = applyProposal(project.id, proposal.id);
  await checkpointEntered.promise;
  watchReplacementQueue = true;
  const replacementResponsePromise = replaceMedia(project.id);
  await replacementQueued.promise;
  checkpointRelease.release();

  const [applyResponse, replacementResponse] = await Promise.all([applyResponsePromise, replacementResponsePromise]);
  assert.equal(applyResponse.status, 200);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;
  cancelScheduledProjectPrewarm(project.id);
  const disk = await readDiskProject(project.id);
  assert.equal(disk.media.filename, replacement.media.filename);
  assert.notEqual(disk.media.filename, project.media.filename);
  assert.deepEqual(disk.captions, []);
  await assert.rejects(fs.stat(path.join(config.uploadDir, project.media.filename)), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(config.uploadDir, replacement.media.filename))).isFile(), true);
  assert.deepEqual(await listHistory(project.id), []);
});

test('replacement persistence failure leaves the old project, source and history usable', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('replace-precommit-failure', true);
  await historyStore.checkpoint(project, 'Synthetic old history', 'manual-save');
  const beforeHistory = await listHistory(project.id);
  assert.equal(beforeHistory.length, 1);
  const rename = fs.rename;
  let failNext = true;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (failNext && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      failNext = false;
      throw new Error('Synthetic replacement persistence failure');
    }
    return rename(...args);
  });
  const response = await replaceMedia(project.id);
  assert.equal(response.status, 500);
  assert.match(String((await response.json() as any).error), /Synthetic replacement persistence failure/);
  assert.equal((await readDiskProject(project.id)).media.filename, project.media.filename);
  assert.equal((await fs.stat(path.join(config.uploadDir, project.media.filename))).isFile(), true);
  assert.equal((await listHistory(project.id)).length, 1);
  mocked.mock.restore();
  const recovered = await saveCaptions(project.id, [caption('OLD MEDIA STILL USABLE')], project.media);
  assert.equal(recovered.status, 200);
  assert.equal((await readDiskProject(project.id)).captions[0].text, 'OLD MEDIA STILL USABLE');
});

test('committed replacement reports history cleanup failure while old history stays retired', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('history-cleanup-failure', true);
  await historyStore.checkpoint(project, 'Old generation history', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(historyDir)) throw new Error('Synthetic history cleanup failure');
    return rm(...args);
  });
  const response = await replaceMedia(project.id);
  assert.equal(response.status, 200);
  const replacement = await response.json() as CaptionProject & { replacementCleanupWarnings?: string[] };
  assert.deepEqual(replacement.replacementCleanupWarnings, ['history']);
  assert.notEqual(replacement.media.filename, project.media.filename);
  assert.equal((await readDiskProject(project.id)).media.filename, replacement.media.filename);
  assert.deepEqual(await listHistory(project.id), []);
  const saved = await saveCaptions(project.id, [caption('NEW MEDIA SAVE')], replacement.media);
  assert.equal(saved.status, 200);
  mocked.mock.restore();
  await historyStore.clear(project.id);
  await assert.rejects(fs.stat(historyDir), { code: 'ENOENT' });
});

test('committed replacement reports proposal cleanup failure and stale proposal is no longer visible', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('proposal-cleanup-failure', true);
  const proposal = await seedProposal(project);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(proposal.file)) throw new Error('Synthetic proposal cleanup failure');
    return rm(...args);
  });
  const response = await replaceMedia(project.id);
  assert.equal(response.status, 200);
  const replacement = await response.json() as CaptionProject & { replacementCleanupWarnings?: string[] };
  assert.deepEqual(replacement.replacementCleanupWarnings, ['proposals']);
  assert.equal((await fs.stat(proposal.file)).isFile(), true);
  const proposalResponse = await fetch(`${baseUrl}/api/projects/${project.id}/regeneration-proposals/${proposal.id}`);
  assert.equal(proposalResponse.status, 404);
  const staleApplyResponse = await applyProposal(project.id, proposal.id);
  assert.equal(staleApplyResponse.status, 400);
  assert.match(String((await staleApplyResponse.json() as any).error), /project changed/i);
  assert.equal((await readDiskProject(project.id)).media.filename, replacement.media.filename);
  const saved = await saveCaptions(project.id, [caption('SAVE AFTER PROPOSAL WARNING')], replacement.media);
  assert.equal(saved.status, 200);
  mocked.mock.restore();
  const cleanup = await proposalStore.removeProject(project.id);
  assert.equal(cleanup.failed, 0);
  await assert.rejects(fs.stat(proposal.file), { code: 'ENOENT' });
});

test('committed replacement reports old-media cleanup failure and keeps the replacement usable', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('old-media-cleanup-failure', true);
  const oldPath = path.join(config.uploadDir, project.media.filename);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(oldPath)) throw new Error('Synthetic old-media cleanup failure');
    return rm(...args);
  });
  const response = await replaceMedia(project.id);
  assert.equal(response.status, 200);
  const replacement = await response.json() as CaptionProject & { replacementCleanupWarnings?: string[] };
  assert.deepEqual(replacement.replacementCleanupWarnings, ['old-media']);
  assert.notEqual(replacement.media.filename, project.media.filename);
  assert.equal((await readDiskProject(project.id)).media.filename, replacement.media.filename);
  assert.equal((await fs.stat(oldPath)).isFile(), true);
  const saved = await saveCaptions(project.id, [caption('SAVE AFTER SOURCE WARNING')], replacement.media);
  assert.equal(saved.status, 200);
  mocked.mock.restore();
  await fs.rm(oldPath, { force: true });
  await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });
});

test('replacement waits for every History cleanup sibling before reporting a cleanup warning', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('history-clear-sibling', true);
  await historyStore.checkpoint(project, 'Old history before replacement', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const legacyPath = path.join(config.historyDir, `${project.id}.json`);
  const historyRmEntered = deferred();
  const historyRmRelease = deferred();
  const legacyFailureObserved = deferred();
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    const target = path.resolve(String(args[0]));
    if (target === path.resolve(historyDir)) {
      historyRmEntered.release();
      await historyRmRelease.promise;
      return rm(...args);
    }
    if (target === path.resolve(legacyPath)) {
      legacyFailureObserved.release();
      throw new Error('Synthetic legacy History cleanup failure');
    }
    return rm(...args);
  });

  let proposalCleanupStarted = false;
  const originalRemoveProject = proposalStore.removeProject.bind(proposalStore);
  t.mock.method(proposalStore, 'removeProject', async (...args: Parameters<typeof proposalStore.removeProject>) => {
    proposalCleanupStarted = true;
    return originalRemoveProject(...args);
  });

  let replacementSettled = false;
  const replacementPromise = replaceMedia(project.id);
  void replacementPromise.then(() => { replacementSettled = true; }, () => { replacementSettled = true; });
  try {
    await historyRmEntered.promise;
    await legacyFailureObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(proposalCleanupStarted, false, 'replacement must not begin later cleanup while a History removal sibling is pending');
    assert.equal(replacementSettled, false, 'replacement must remain pending until the sibling History removal settles');
    historyRmRelease.release();
    const response = await replacementPromise;
    assert.equal(response.status, 200);
    const replacement = await response.json() as CaptionProject & { replacementCleanupWarnings?: string[] };
    assert.deepEqual(replacement.replacementCleanupWarnings, ['history']);

    const saved = await saveCaptions(project.id, [caption('NEW GENERATION CHECKPOINT')], replacement.media);
    assert.equal(saved.status, 200);
    const currentHistory = await listHistory(project.id);
    assert.equal(currentHistory.length, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await listHistory(project.id))[0]?.id, currentHistory[0].id);
  } finally {
    historyRmRelease.release();
    cancelScheduledProjectPrewarm(project.id);
    await replacementPromise.catch(() => {});
  }
});

test('an identical old-generation checkpoint cannot suppress the replacement generation first checkpoint or be restored', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('generation-fingerprint');
  const blankOld: CaptionProject = { ...project, captions: [], transcript: null };
  await store.upsert(blankOld);
  const oldEntry = await historyStore.checkpoint(blankOld, 'Old blank generation', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(historyDir)) throw new Error('Keep old generation History for regression coverage');
    return rm(...args);
  });

  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject & { replacementCleanupWarnings?: string[] };
  assert.deepEqual(replacement.replacementCleanupWarnings, ['history']);
  assert.deepEqual(await listHistory(project.id), []);

  const saved = await saveCaptions(project.id, [caption('FIRST NEW GENERATION EDIT')], replacement.media);
  assert.equal(saved.status, 200);
  const currentHistory = await listHistory(project.id);
  assert.equal(currentHistory.length, 1);
  assert.notEqual(currentHistory[0].id, oldEntry.id);

  const staleRestore = await restoreHistory(project.id, oldEntry.id);
  assert.equal(staleRestore.status, 404);
  const restoredResponse = await restoreHistory(project.id, currentHistory[0].id);
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as CaptionProject;
  assert.equal(restored.media.filename, replacement.media.filename);
  assert.deepEqual(restored.captions, []);
  assert.equal((await readDiskProject(project.id)).media.filename, replacement.media.filename);

  mocked.mock.restore();
  await historyStore.clear(project.id);
  cancelScheduledProjectPrewarm(project.id);
});

test('History dedupe and autosave coalescing stay inside one media generation', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('history-generation-coalesce');
  const blankOld: CaptionProject = { ...project, captions: [], transcript: null };
  await store.upsert(blankOld);
  const oldEntry = await historyStore.checkpoint(blankOld, 'Old autosave generation', 'autosave', { dedupeWindowMs: 60_000 });
  const historyDir = path.join(config.historyDir, project.id);
  const rm = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(historyDir)) throw new Error('Retain old History generation');
    return rm(...args);
  });

  const replacementResponse = await replaceMedia(project.id);
  assert.equal(replacementResponse.status, 200);
  const replacement = await replacementResponse.json() as CaptionProject;
  const firstCurrent = await historyStore.checkpoint(replacement, 'Current autosave generation', 'autosave', { dedupeWindowMs: 60_000 });
  assert.notEqual(firstCurrent.id, oldEntry.id);

  const changed: CaptionProject = { ...replacement, captions: [caption('CURRENT AUTOSAVE CHANGE')] };
  const coalesced = await historyStore.checkpoint(changed, 'Current autosave update', 'autosave', { dedupeWindowMs: 60_000 });
  assert.equal(coalesced.id, firstCurrent.id, 'same-generation autosaves inside the window should coalesce');
  const duplicate = await historyStore.checkpoint(changed, 'Same generation duplicate', 'manual-save');
  assert.equal(duplicate.id, firstCurrent.id, 'identical same-generation state should dedupe');
  assert.equal((await historyStore.list(project.id, replacement.media)).length, 1);

  mocked.mock.restore();
  await historyStore.clear(project.id);
  cancelScheduledProjectPrewarm(project.id);
});

test('modern History list uses media metadata without a full-project clone or per-entry snapshot reads', async (t) => {
  const project = await seedProject('history-list-index');
  for (const [index, text] of ['ONE', 'TWO', 'THREE'].entries()) {
    await historyStore.checkpoint({ ...project, captions: [caption(`${text}-${index}`)] }, `Checkpoint ${index}`, 'manual-save');
  }
  const historyDir = path.join(config.historyDir, project.id);
  const indexPath = path.join(historyDir, 'index.json');
  const readFile = fs.readFile.bind(fs);
  let fullProjectReads = 0;
  let indexReads = 0;
  let snapshotReads = 0;
  const storeCandidate = store as any;
  const originalGet = storeCandidate.get.bind(store);
  t.mock.method(storeCandidate, 'get', async (...args: any[]) => {
    fullProjectReads += 1;
    return originalGet(...args);
  });
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const target = path.resolve(String(args[0]));
    if (target === path.resolve(indexPath)) indexReads += 1;
    else if (target.startsWith(`${path.resolve(historyDir)}${path.sep}`) && target.endsWith('.json')) snapshotReads += 1;
    return (readFile as any)(...args);
  });

  const response = await fetch(`${baseUrl}/api/projects/${project.id}/history`);
  assert.equal(response.status, 200);
  const entries = await response.json() as Array<{ id: string }>;
  assert.equal(entries.length, 3);
  assert.equal(fullProjectReads, 0);
  assert.equal(indexReads, 1);
  assert.equal(snapshotReads, 0);
});

test('a pre-metadata History index is enriched once and later lists stay index-only', async (t) => {
  const project = await seedProject('history-index-enrichment');
  await historyStore.checkpoint(project, 'Legacy-style index entry', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const indexPath = path.join(historyDir, 'index.json');
  const rawIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>;
  for (const entry of rawIndex) delete entry.media;
  await fs.writeFile(indexPath, JSON.stringify(rawIndex), 'utf8');

  const readFile = fs.readFile.bind(fs);
  let snapshotReads = 0;
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const target = path.resolve(String(args[0]));
    if (target.startsWith(`${path.resolve(historyDir)}${path.sep}`) && target.endsWith('.json') && target !== path.resolve(indexPath)) snapshotReads += 1;
    return (readFile as any)(...args);
  });

  const first = await fetch(`${baseUrl}/api/projects/${project.id}/history`);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as unknown[]).length, 1);
  assert.equal(snapshotReads, 1);
  snapshotReads = 0;
  const second = await fetch(`${baseUrl}/api/projects/${project.id}/history`);
  assert.equal(second.status, 200);
  assert.equal((await second.json() as unknown[]).length, 1);
  assert.equal(snapshotReads, 0);
  const enriched = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<{ media?: { filename: string; size: number } }>;
  assert.deepEqual(enriched[0].media, { filename: project.media.filename, size: project.media.size });
});

test('legacy History enrichment triggered by list is serialized with checkpoint creation', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('history-list-enrichment-race');
  const legacyEntry = await historyStore.checkpoint(project, 'Legacy list entry', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const indexPath = path.join(historyDir, 'index.json');
  const snapshotPath = path.join(historyDir, `${legacyEntry.id}.json`);
  const rawIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>;
  for (const entry of rawIndex) delete entry.media;
  await fs.writeFile(indexPath, JSON.stringify(rawIndex), 'utf8');

  const snapshotEntered = deferred();
  const snapshotRelease = deferred();
  const readFile = fs.readFile.bind(fs);
  let holdSnapshot = true;
  let enrichmentBlocked = false;
  let checkpointReadWhileEnrichmentBlocked = false;
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const target = path.resolve(String(args[0]));
    if (target === path.resolve(indexPath) && enrichmentBlocked) checkpointReadWhileEnrichmentBlocked = true;
    if (holdSnapshot && target === path.resolve(snapshotPath)) {
      holdSnapshot = false;
      const value = await (readFile as any)(...args);
      enrichmentBlocked = true;
      snapshotEntered.release();
      await snapshotRelease.promise;
      enrichmentBlocked = false;
      return value;
    }
    return (readFile as any)(...args);
  });

  const listPromise = historyStore.list(project.id, project.media);
  try {
    await snapshotEntered.promise;
    const changed: CaptionProject = { ...project, captions: [caption('CHECKPOINT CREATED DURING LIST')] };
    const checkpointPromise = historyStore.checkpoint(changed, 'Concurrent list checkpoint', 'manual-save');
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    const overlapped = checkpointReadWhileEnrichmentBlocked;
    snapshotRelease.release();
    await listPromise;
    const checkpoint = await checkpointPromise;

    assert.equal(overlapped, false, 'checkpoint index I/O must wait until read-triggered enrichment releases the History queue');
    const indexed = await historyStore.list(project.id, project.media);
    assert.ok(indexed.some((entry) => entry.id === checkpoint.id), 'the concurrent checkpoint must remain indexed');
    const stored = await historyStore.get(project.id, checkpoint.id, project.media);
    assert.equal(stored?.snapshot.captions[0]?.text, 'CHECKPOINT CREATED DURING LIST');
  } finally {
    snapshotRelease.release();
    await listPromise.catch(() => {});
  }
});

test('legacy History enrichment triggered by get is serialized with checkpoint creation', { timeout: 10_000 }, async (t) => {
  const project = await seedProject('history-get-enrichment-race');
  const legacyEntry = await historyStore.checkpoint(project, 'Legacy get entry', 'manual-save');
  const historyDir = path.join(config.historyDir, project.id);
  const indexPath = path.join(historyDir, 'index.json');
  const snapshotPath = path.join(historyDir, `${legacyEntry.id}.json`);
  const rawIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>;
  for (const entry of rawIndex) delete entry.media;
  await fs.writeFile(indexPath, JSON.stringify(rawIndex), 'utf8');

  const snapshotEntered = deferred();
  const snapshotRelease = deferred();
  const readFile = fs.readFile.bind(fs);
  let holdSnapshot = true;
  let enrichmentBlocked = false;
  let checkpointReadWhileEnrichmentBlocked = false;
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const target = path.resolve(String(args[0]));
    if (target === path.resolve(indexPath) && enrichmentBlocked) checkpointReadWhileEnrichmentBlocked = true;
    if (holdSnapshot && target === path.resolve(snapshotPath)) {
      holdSnapshot = false;
      const value = await (readFile as any)(...args);
      enrichmentBlocked = true;
      snapshotEntered.release();
      await snapshotRelease.promise;
      enrichmentBlocked = false;
      return value;
    }
    return (readFile as any)(...args);
  });

  const getPromise = historyStore.get(project.id, legacyEntry.id, project.media);
  try {
    await snapshotEntered.promise;
    const changed: CaptionProject = { ...project, captions: [caption('CHECKPOINT CREATED DURING GET')] };
    const checkpointPromise = historyStore.checkpoint(changed, 'Concurrent get checkpoint', 'manual-save');
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    const overlapped = checkpointReadWhileEnrichmentBlocked;
    snapshotRelease.release();
    const legacy = await getPromise;
    const checkpoint = await checkpointPromise;

    assert.equal(legacy?.id, legacyEntry.id);
    assert.equal(overlapped, false, 'checkpoint index I/O must wait until get-triggered enrichment releases the History queue');
    const indexed = await historyStore.list(project.id, project.media);
    assert.ok(indexed.some((entry) => entry.id === checkpoint.id), 'the concurrent checkpoint must remain indexed after get enrichment');
    const stored = await historyStore.get(project.id, checkpoint.id, project.media);
    assert.equal(stored?.snapshot.captions[0]?.text, 'CHECKPOINT CREATED DURING GET');
  } finally {
    snapshotRelease.release();
    await getPromise.catch(() => {});
  }
});
