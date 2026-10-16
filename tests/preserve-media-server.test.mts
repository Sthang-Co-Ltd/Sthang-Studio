import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type CaptionSegment } from '@kcs/shared';

// All media in this suite is generated locally. Never use a user's project or recording.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-preserve-media-adversarial-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { default: jobsRouter } = await import('../apps/server/src/routes/jobs.js');
const { default: videoExportRouter } = await import('../apps/server/src/routes/video-export.js');
const { createMediaReplacementService } = await import('../apps/server/src/services/media-replacement.js');
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api/projects', projectsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/video-export', videoExportRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const projectIds = new Set<string>();

await fs.mkdir(config.uploadDir, { recursive: true });
const sourcePath = path.join(root, 'synthetic-source.mp4');
const replacementPath = path.join(root, 'synthetic-regrade.mp4');
const mismatchPath = path.join(root, 'synthetic-different-audio.mp4');
function ffmpeg(args: string[]) {
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000, stdio: 'pipe' });
}
ffmpeg(['-f', 'lavfi', '-i', 'color=0x204060:s=160x90:r=25:d=4', '-f', 'lavfi', '-i', 'aevalsrc=(0.25*sin(2*PI*(250+37*t)*t)+0.12*sin(2*PI*701*t))*(0.5+0.5*sin(2*PI*3*t)):s=16000:d=4', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-shortest', sourcePath]);
ffmpeg(['-i', sourcePath, '-vf', 'eq=brightness=0.15:saturation=0.5', '-c:v', 'libx264', '-threads', '1', '-c:a', 'copy', replacementPath]);
ffmpeg(['-f', 'lavfi', '-i', 'color=0x706020:s=160x90:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=911:sample_rate=16000:duration=4', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-shortest', mismatchPath]);
const sourceBytes = await fs.readFile(sourcePath);
const replacementBytes = await fs.readFile(replacementPath);
const mismatchBytes = await fs.readFile(mismatchPath);

after(async () => {
  for (const id of projectIds) cancelScheduledProjectPrewarm(id);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function seed(id: string): Promise<CaptionProject> {
  projectIds.add(id);
  const filename = `${id}-original.mp4`;
  await fs.writeFile(path.join(config.uploadDir, filename), sourceBytes);
  const captions: CaptionSegment[] = [
    { id: 'caption-stable-id', text: 'Reviewed words', startMs: 253, endMs: 1467, approved: true, textLocked: true, timingLocked: true,
      timingSource: 'manual', timingQuality: 'high', confidence: 0.92,
      wordTiming: { version: 1, text: 'Reviewed words', words: [
        { id: 'word-stable-1', startOffset: 0, endOffset: 8, startMs: 253, endMs: 803, source: 'manual' },
        { id: 'word-stable-2', startOffset: 9, endOffset: 14, startMs: 861, endMs: 1467, source: 'aligned', needsReview: true },
      ] } },
    { id: 'caption-unapproved', text: 'Second untouched cue', startMs: 2107, endMs: 3723, approved: false, textLocked: false, timingLocked: false, timingQuality: 'low', timingSource: 'interpolated' },
  ];
  const project: CaptionProject = {
    id, title: 'Synthetic preservation regression', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    media: { filename, originalName: filename, mimeType: 'video/mp4', size: sourceBytes.length, url: `/media/${filename}` },
    mode: 'single-line', captions,
    captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#19ABCA', fontSize1080: 89 },
    transcriptionContext: { description: 'Synthetic context must survive', vocabulary: ['BrandName | spoken alias'] },
    transcript: { language: 'km', fullText: 'Original canonical text', segments: structuredClone(captions), tokens: [
      { id: 'token-identity', text: 'Original canonical text', startMs: 253, endMs: 3723, spaceBefore: false, timingSource: 'stt', confidence: 0.7 },
    ], timing: { engine: 'kfa-local', provider: 'local', model: 'synthetic', sttTranscript: 'Original canonical text', audioDurationMs: 4000, totalTokens: 1, anchoredTokens: 1, interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1 } },
    transcriptNeedsSync: true, engineVersion: 'synthetic-established-engine',
    pipelineCache: { mediaFingerprint: 'old-source-cache', normalizedAudioCached: true, normalizedAudioDurationMs: 4000, textStageCachedAt: '2026-01-01T00:00:00.000Z' },
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  await historyStore.checkpoint(project, 'Reviewed synthetic checkpoint', 'manual-save');
  return project;
}

async function readDisk(id: string) {
  return JSON.parse(await fs.readFile(path.join(projectDir, `${id}.json`), 'utf8')) as CaptionProject;
}
async function jsonRequest(id: string, suffix: string, method = 'GET', body?: unknown) {
  return fetch(`${baseUrl}/${id}${suffix}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function kept(project: CaptionProject) {
  return { id: project.id, title: project.title, createdAt: project.createdAt, captions: project.captions, transcript: project.transcript, transcriptNeedsSync: project.transcriptNeedsSync, mode: project.mode, captionAppearance: project.captionAppearance, transcriptionContext: project.transcriptionContext, engineVersion: project.engineVersion };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function replace(project: CaptionProject, bytes: Buffer = replacementBytes, overrides: Record<string, string | undefined> = {}) {
  const form = new FormData();
  const fields: Record<string, string | undefined> = {
    mode: 'preserve', expectedMedia: JSON.stringify({ filename: project.media.filename, size: project.media.size }), expectedUpdatedAt: project.updatedAt, ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), 'synthetic-regrade.mp4');
  try { return await fetch(`${baseUrl}/${project.id}/replace-media`, { method: 'POST', body: form }); }
  finally { cancelScheduledProjectPrewarm(project.id); }
}
async function save(project: CaptionProject, text: string) {
  return jsonRequest(project.id, '/captions', 'PUT', {
    expectedMedia: { filename: project.media.filename, size: project.media.size },
    captions: project.captions.map((caption, index) => index ? { ...caption, text } : caption),
    recordCorrections: false, source: 'manual-save',
  });
}
async function restore(project: CaptionProject, replacementId: string) {
  try { return await jsonRequest(project.id, `/media-replacements/${replacementId}/restore`, 'POST', { expectedMedia: project.media, expectedUpdatedAt: project.updatedAt }); }
  finally { cancelScheduledProjectPrewarm(project.id); }
}

function fileFlushTarget(filename: string, projectId: string) {
  if (filename.startsWith(path.join(projectDir, `${projectId}.json.`)) && filename.endsWith('.tmp')) return 'project';
  if (path.dirname(filename) === projectDir && filename.endsWith('.tmp')) return 'project-index';
  const historyRoot = `${path.join(config.historyDir, projectId)}${path.sep}`;
  if (filename.startsWith(historyRoot) && filename.endsWith('.tmp')) return 'history';
  if (filename.startsWith(historyRoot) && filename.endsWith(`${path.sep}source`)) return 'backup-source';
  if (path.dirname(filename) === config.uploadDir && path.basename(filename).startsWith(`${projectId}-`)
    && path.basename(filename) !== `${projectId}-original.mp4`) return 'staged-media';
  return undefined;
}

async function filesInTree(directory: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assert.equal(entry.name.endsWith('.preparing'), false, 'unfinished backup directory must be removed');
      for (const [relative, bytes] of Object.entries(await filesInTree(filename))) files[path.join(entry.name, relative)] = bytes;
    } else {
      assert.equal(entry.name.endsWith('.tmp'), false, 'unfinished atomic-write file must be removed');
      files[entry.name] = await fs.readFile(filename);
    }
  }
  return files;
}

test('initialization, project, History, staged media and backup files flush through writable nontruncating handles', async (t) => {
  const id = 'writable-file-flush';
  const open = fs.open;
  const flushed = new Map<string, string[]>();
  // Install before the first seed so initialization and ordinary checkpoint
  // writes obey the same Windows handle requirement as replacement staging.
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const filename = String(args[0]);
    const target = fileFlushTarget(filename, id);
    const before = target ? await fs.readFile(filename) : undefined;
    const handle = await open(...args);
    if (target) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        assert.equal(args[1], 'r+', `${target} must reopen an existing file with writable, nontruncating access`);
        assert.ok(before!.length > 0, `${target} must contain data before reopening`);
        await sync();
        assert.deepEqual(await fs.readFile(filename), before, `${target} flush must preserve every byte`);
        flushed.set(target, [...(flushed.get(target) || []), filename]);
      };
    }
    return handle;
  });
  try {
    const project = await seed(id);
    const response = await replace(project);
    assert.equal(response.status, 200, await response.clone().text());
    const replacement = await response.json() as CaptionProject & { mediaReplacement: { id: string } };
    assert.deepEqual(kept(await readDisk(id)), kept(project));
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, replacement.media.filename)), replacementBytes);
    assert.deepEqual(await fs.readFile(path.join(config.historyDir, id, 'media-replacements', replacement.mediaReplacement.id, 'source')), sourceBytes);
    for (const target of ['project-index', 'project', 'history', 'staged-media', 'backup-source']) {
      assert.ok(flushed.get(target)?.length, `${target} must actually reach and complete file.sync()`);
    }
    assert.ok(flushed.get('project-index')!.some((filename) => path.basename(filename).startsWith('.per-project-v1.')), 'initialization marker must be flushed');
    assert.ok(flushed.get('project-index')!.some((filename) => path.basename(filename).startsWith('order.json.')), 'project order index must be flushed');
    assert.ok(flushed.get('history')!.some((filename) => filename.includes(`${path.sep}media-versions${path.sep}`)), 'replacement History archive must be flushed');
    assert.ok(flushed.get('history')!.some((filename) => path.dirname(filename) === path.join(config.historyDir, id)), 'ordinary History checkpoint must be flushed');
  } finally { mock.mock.restore(); }
});

test('preserve replacement retains every reviewed field and rebases existing history without generation', async () => {
  const project = await seed('preserve-all-fields');
  const oldHistory = await historyStore.list(project.id, project.media);
  const jobsBefore = await jobStore.list(project.id);
  const response = await replace(project);
  assert.equal(response.status, 200, await response.clone().text());
  const replaced = await response.json() as CaptionProject & { mediaReplacement: { id: string; mode: string } };
  assert.deepEqual(kept(replaced), kept(project));
  assert.notEqual(replaced.media.filename, project.media.filename);
  assert.equal(replaced.media.originalName, 'synthetic-regrade.mp4');
  assert.equal(replaced.media.size, replacementBytes.length);
  assert.equal(replaced.mediaReplacement.mode, 'preserve');
  assert.ok(replaced.mediaReplacement.id);
  assert.equal(replaced.pipelineCache, undefined, 'derived cache identity must not survive media swap');
  assert.deepEqual(kept(await readDisk(project.id)), kept(project));
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, replaced.media.filename)), replacementBytes);
  const history = await historyStore.list(project.id, replaced.media);
  assert.ok(history.some((entry) => entry.label === oldHistory[0].label), 'old reviewed History stays visible');
  const checkpoint = await historyStore.get(project.id, history.find((entry) => entry.label === oldHistory[0].label)!.id, replaced.media);
  assert.deepEqual(checkpoint?.snapshot.captions, project.captions);
  assert.deepEqual(await jobStore.list(project.id), jobsBefore, 'replacement must not queue generation or timing jobs');
});

test('replacement, rollback and redo survive a fresh process and restore exact review/style/context/History with fresh media identities', async () => {
  const original = await seed('durable-rollback');
  const replacementResponse = await replace(original);
  assert.equal(replacementResponse.status, 200, await replacementResponse.clone().text());
  const replaced = await replacementResponse.json() as CaptionProject & { mediaReplacement: { id: string } };
  const summariesResponse = await jsonRequest(original.id, '/media-replacements');
  assert.equal(summariesResponse.status, 200);
  assert.ok((await summariesResponse.json() as Array<{id: string}>).some((entry) => entry.id === replaced.mediaReplacement.id));
  const childSource = `const {store}=await import('./apps/server/src/services/store.ts'); const {historyStore}=await import('./apps/server/src/services/history-store.ts'); const {listMediaReplacements}=await import('./apps/server/src/services/media-replacement.ts'); const project=await store.get(${JSON.stringify(original.id)}); console.log(JSON.stringify({project,backups:await listMediaReplacements(project.id),history:await historyStore.exportForMedia(project.id,project.media)}));`;
  const readFreshState = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000 }).trim().split('\n').at(-1)!);
  const fresh = readFreshState();
  assert.deepEqual(kept(fresh.project), kept(original));
  assert.ok(fresh.backups.some((entry: {id:string}) => entry.id === replaced.mediaReplacement.id));
  const originalRecoveryDirectory = path.join(config.historyDir, original.id, 'media-replacements', replaced.mediaReplacement.id);
  const originalRecoveryFiles = await filesInTree(originalRecoveryDirectory);
  await store.withProjectWrite(replaced.id, async (current, persist) => {
    assert.ok(current);
    const captions = current.captions.map((caption, index) => index
      ? { ...caption, text: 'Newer reviewed replacement cue', approved: true, textLocked: true, timingLocked: true }
      : { ...caption, approved: false, textLocked: false, timingLocked: false, startMs: caption.startMs + 80, endMs: caption.endMs + 80,
        wordTiming: { ...caption.wordTiming!, words: caption.wordTiming!.words.map((word) => {
          assert.ok(typeof word.startMs === 'number' && Number.isFinite(word.startMs));
          assert.ok(typeof word.endMs === 'number' && Number.isFinite(word.endMs));
          return { ...word, startMs: word.startMs + 80, endMs: word.endMs + 80 };
        }) } });
    assert.ok(current.transcript);
    assert.ok(current.transcript.tokens);
    await persist({ ...current, captions, transcriptNeedsSync: false,
      transcript: { ...current.transcript, fullText: 'Newer canonical replacement text', segments: structuredClone(captions),
        tokens: current.transcript.tokens.map((token) => ({ ...token, text: 'Newer canonical replacement text' })) },
      transcriptionContext: { description: 'Newer replacement context', vocabulary: ['ReplacementName | updated alias'] },
      updatedAt: '2026-08-01T00:00:00.000Z' });
  });
  await store.setCaptionAppearance(replaced.id, { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#FF0099', fontSize1080: 150 });
  const edited = (await store.get(replaced.id))!;
  await historyStore.checkpoint(edited, 'Newer replacement checkpoint', 'manual-save');
  const editedHistory = await historyStore.exportForMedia(edited.id, edited.media);
  const editedHistorySummaries = await historyStore.list(edited.id, edited.media);
  assert.equal(editedHistory.length, 2);
  const restoredResponse = await restore(edited, replaced.mediaReplacement.id);
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
  const restored = await restoredResponse.json() as CaptionProject & { mediaReplacement: { id: string; mode: string } };
  assert.deepEqual(kept(restored), kept(original));
  assert.notEqual(restored.media.filename, original.media.filename, 'rollback must not revive old browser save identity');
  assert.notEqual(restored.media.filename, replaced.media.filename);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, restored.media.filename)), sourceBytes);
  assert.deepEqual(kept(await readDisk(restored.id)), kept(original));
  assert.equal((await save(original, 'DELAYED PRE-REPLACEMENT SAVE')).status, 409);
  assert.equal((await save(replaced, 'DELAYED REPLACEMENT SAVE')).status, 409);
  assert.deepEqual(kept((await store.get(original.id))!), kept(original));
  const history = await historyStore.list(restored.id, restored.media);
  assert.ok(history.some((entry) => entry.label === 'Reviewed synthetic checkpoint'));
  assert.equal(history.some((entry) => entry.label === 'Newer replacement checkpoint'), false, 'undo restores the selected original History');
  assert.equal(restored.mediaReplacement.mode, 'restore');
  assert.notEqual(restored.mediaReplacement.id, replaced.mediaReplacement.id, 'undo creates a separate redo backup');
  const redoDirectory = path.join(config.historyDir, original.id, 'media-replacements', restored.mediaReplacement.id);
  const redoFiles = await filesInTree(redoDirectory);
  const redoSnapshot = JSON.parse(redoFiles['snapshot.json'].toString('utf8'));
  assert.deepEqual(kept(redoSnapshot.project), kept(edited));
  assert.deepEqual(redoSnapshot.history, editedHistory);
  assert.deepEqual(redoFiles.source, replacementBytes);
  assert.deepEqual(await filesInTree(originalRecoveryDirectory), originalRecoveryFiles, 'undo must not consume its selected recovery');

  const redoneResponse = await restore(restored, restored.mediaReplacement.id);
  assert.equal(redoneResponse.status, 200, await redoneResponse.clone().text());
  const redone = await redoneResponse.json() as CaptionProject & { mediaReplacement: { id: string; mode: string } };
  assert.deepEqual(kept(redone), kept(edited));
  assert.deepEqual(kept(await readDisk(redone.id)), kept(edited));
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, redone.media.filename)), replacementBytes);
  assert.equal(new Set([original.media.filename, replaced.media.filename, restored.media.filename, redone.media.filename]).size, 4, 'redo must publish another fresh media identity');
  const rebasedHistory = JSON.parse(JSON.stringify(editedHistory.map((entry) => ({
    ...entry, snapshot: { ...entry.snapshot, media: redone.media, pipelineCache: undefined },
  }))));
  assert.deepEqual(await historyStore.exportForMedia(redone.id, redone.media), rebasedHistory, 'redo restores every newer History snapshot with only the media binding rebased');
  assert.deepEqual(await historyStore.list(redone.id, redone.media), editedHistorySummaries);
  assert.deepEqual(await filesInTree(originalRecoveryDirectory), originalRecoveryFiles, 'redo must keep the original recovery intact');
  assert.deepEqual(await filesInTree(redoDirectory), redoFiles, 'redo must not consume its selected recovery');
  const afterRedo = readFreshState();
  assert.deepEqual(afterRedo.project, await readDisk(redone.id));
  assert.deepEqual(afterRedo.history, rebasedHistory);
  assert.equal(afterRedo.backups.length, 3, 'the full roundtrip stays below the five-backup limit');
  for (const id of [replaced.mediaReplacement.id, restored.mediaReplacement.id, redone.mediaReplacement.id]) {
    assert.ok(afterRedo.backups.some((entry: { id: string }) => entry.id === id));
  }
  for (const retired of [original, replaced, edited, restored]) {
    assert.equal((await save(retired, 'DELAYED SAVE AFTER REDO')).status, 409);
  }
  assert.equal((await restore(restored, replaced.mediaReplacement.id)).status, 409, 'the pre-redo media identity cannot restore over redo');
  assert.equal((await restore({ ...redone, updatedAt: restored.updatedAt }, replaced.mediaReplacement.id)).status, 409, 'the pre-redo revision cannot restore over redo');
  assert.deepEqual(await readDisk(redone.id), afterRedo.project);
  assert.deepEqual(kept((await store.get(redone.id))!), kept(edited));
});

test('same-duration different audio is rejected and project, source and History are unchanged', async () => {
  const project = await seed('different-audio');
  const historyBefore = await historyStore.list(project.id, project.media);
  const uploadsBefore = (await fs.readdir(config.uploadDir)).sort();
  const response = await replace(project, mismatchBytes);
  assert.equal(response.status, 422, await response.clone().text());
  assert.match((await response.json() as any).code, /^MEDIA_(AUDIO_MISMATCH|AUDIO_UNVERIFIABLE|TIMELINE_MISMATCH)$/);
  assert.deepEqual(await store.get(project.id), project);
  assert.deepEqual(await readDisk(project.id), project);
  assert.deepEqual(await historyStore.list(project.id, project.media), historyBefore);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
  assert.deepEqual((await fs.readdir(config.uploadDir)).sort(), uploadsBefore, 'rejected staged upload is removed');
});

test('malformed media rejects without publishing or clearing reviewed work', async () => {
  const project = await seed('invalid-media');
  const response = await replace(project, Buffer.from('This is not video or audio'));
  assert.equal(response.status, 422, await response.clone().text());
  assert.deepEqual(await readDisk(project.id), project);
  assert.equal((await historyStore.list(project.id, project.media)).length, 1);
});

test('wrong media identity, wrong revision, and missing basis fail closed before swapping', async () => {
  const project = await seed('stale-basis');
  for (const overrides of [
    { expectedMedia: JSON.stringify({ filename: 'someone-elses.mp4', size: project.media.size }) },
    { expectedMedia: JSON.stringify({ filename: project.media.filename, size: project.media.size + 1 }) },
    { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
  ]) {
    const response = await replace(project, replacementBytes, overrides);
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await readDisk(project.id), project);
  }
  for (const field of ['expectedMedia', 'expectedUpdatedAt']) {
    const response = await replace(project, replacementBytes, { [field]: undefined });
    assert.equal(response.status, 428, await response.clone().text());
    assert.deepEqual(await readDisk(project.id), project);
  }
});

test('active project jobs reject preservation and leave History intact', async (t) => {
  const project = await seed('active-job');
  const mock = t.mock.method(jobStore, 'hasActiveForProject', (id: string) => id === project.id);
  try {
    const response = await replace(project);
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await readDisk(project.id), project);
    assert.equal((await historyStore.list(project.id, project.media)).length, 1);
  } finally { mock.mock.restore(); }
});

test('reset is an explicit mode and intentionally clears captions while creating a durable recovery', async () => {
  const project = await seed('explicit-reset');
  const response = await replace(project, mismatchBytes, { mode: 'reset' });
  assert.equal(response.status, 200, await response.clone().text());
  const reset = await response.json() as CaptionProject & { mediaReplacement: { id: string; mode: string } };
  assert.deepEqual(reset.captions, []);
  assert.equal(reset.transcript, null);
  assert.equal(reset.transcriptNeedsSync, false);
  assert.equal(reset.mediaReplacement.mode, 'reset');
  const restoredResponse = await restore(reset, reset.mediaReplacement.id);
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
  assert.deepEqual(kept(await restoredResponse.json() as CaptionProject), kept(project));
});

test('atomic project publication failure leaves original media, project and History available', async (t) => {
  const project = await seed('failed-commit');
  const beforeHistory = await historyStore.list(project.id, project.media);
  const beforeUploads = (await fs.readdir(config.uploadDir)).sort();
  const rename = fs.rename;
  let injected = false;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!injected && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      injected = true;
      throw new Error('Synthetic replacement project publication failure');
    }
    return rename(...args);
  });
  try {
    const response = await replace(project);
    assert.equal(response.status, 500, await response.clone().text());
    assert.equal(injected, true);
    assert.deepEqual(await store.get(project.id), project);
    assert.deepEqual(await readDisk(project.id), project);
    assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory);
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
    assert.deepEqual((await fs.readdir(config.uploadDir)).sort(), beforeUploads);
  } finally { mock.mock.restore(); }
  const retry = await replace(project);
  assert.equal(retry.status, 200, await retry.clone().text());
});

test('a save queued behind publication cannot restore retired media or replace reviewed captions', { timeout: 15_000 }, async (t) => {
  const project = await seed('queued-stale-save');
  const publication = deferred();
  const release = deferred();
  const rename = fs.rename;
  let held = false;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!held && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      held = true; publication.resolve(); await release.promise;
    }
    return rename(...args);
  });
  const replacement = replace(project);
  try {
    await publication.promise;
    const staleSave = save(project, 'LATE CONTENT MUST NOT WIN');
    release.resolve();
    assert.equal((await replacement).status, 200);
    assert.equal((await staleSave).status, 409);
    assert.deepEqual(kept((await store.get(project.id))!), kept(project));
  } finally { release.resolve(); mock.mock.restore(); await replacement.catch(() => {}); }
});

test('stale rollback revision and foreign snapshot id never change active media', async () => {
  const original = await seed('rollback-guards');
  const response = await replace(original);
  assert.equal(response.status, 200, await response.clone().text());
  const current = await response.json() as CaptionProject & { mediaReplacement: { id: string } };
  const stale = await restore(original, current.mediaReplacement.id);
  assert.equal(stale.status, 409, await stale.clone().text());
  const foreign = await restore(current, 'not-a-real-snapshot');
  assert.ok([404, 409].includes(foreign.status), await foreign.clone().text());
  assert.deepEqual(await readDisk(current.id), JSON.parse(JSON.stringify(await store.get(current.id))));
  assert.equal((await store.get(current.id))!.media.filename, current.media.filename);
});


test('omitted and invalid replacement modes never silently clear reviewed captions', async () => {
  const project = await seed('mode-required');
  for (const mode of [undefined, '', 'keep', 'RESET', 'false']) {
    const response = await replace(project, replacementBytes, { mode });
    assert.equal(response.status, 400, await response.clone().text());
    assert.deepEqual(await readDisk(project.id), project);
  }
});

test('generation, timing and a second replacement cannot enter while media publication is pending', { timeout: 15_000 }, async (t) => {
  const project = await seed('exclusive-publication');
  const entered = deferred(); const release = deferred();
  const rename = fs.rename;
  let held = false;
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!held && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      held = true; entered.resolve(); await release.promise;
    }
    return rename(...args);
  });
  const replacement = replace(project);
  try {
    await entered.promise;
    await assert.rejects(jobStore.create('transcribe', project.id, {}), /replacing|restoring|finish/i);
    for (const [suffix, body] of [
      ['/transcribe', {}], ['/regenerate-range', { startMs: 0, endMs: 1000 }],
      ['/postprocess-timing', { expectedMedia: project.media, settings: {} }],
    ] as const) {
      const response = await jsonRequest(project.id, suffix, 'POST', body);
      assert.equal(response.status, 409, `${suffix}: ${await response.text()}`);
    }
    const competing = await replace(project);
    assert.equal(competing.status, 409, await competing.clone().text());
    assert.deepEqual(await jobStore.list(project.id), []);
    release.resolve();
    assert.equal((await replacement).status, 200);
  } finally { release.resolve(); mock.mock.restore(); await replacement.catch(() => {}); }
});

test('delete during replacement cannot orphan the newly published source; later deletion removes backups', { timeout: 15_000 }, async (t) => {
  const project = await seed('delete-publication-race');
  const entered = deferred(); const release = deferred(); const deleteEntered = deferred();
  const rename = fs.rename; const get = store.get.bind(store);
  let held = false;
  const mockRename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (!held && path.resolve(String(args[1])) === path.resolve(path.join(projectDir, `${project.id}.json`))) {
      held = true; entered.resolve(); await release.promise;
    }
    return rename(...args);
  });
  const replacement = replace(project);
  let mockGet: ReturnType<typeof t.mock.method> | undefined;
  try {
    await entered.promise;
    mockGet = t.mock.method(store, 'get', async (id: string) => { const result = await get(id); if (id === project.id) deleteEntered.resolve(); return result; });
    const deletion = jsonRequest(project.id, '', 'DELETE');
    await Promise.race([deleteEntered.promise, deletion]);
    // Allow request continuation to reach its synchronous admission guard.
    await new Promise<void>((r) => setImmediate(r));
    release.resolve();
    assert.equal((await deletion).status, 409, 'deletion must not race the media transaction');
    const response = await replacement;
    assert.equal(response.status, 200, await response.clone().text());
    const current = await response.json() as CaptionProject;
    assert.equal((await jsonRequest(project.id, '', 'DELETE')).status, 204);
    assert.equal(await store.get(project.id), null);
    await assert.rejects(fs.stat(path.join(config.uploadDir, current.media.filename)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(config.historyDir, project.id)), { code: 'ENOENT' });
    assert.equal((await fs.readdir(config.uploadDir)).some((file) => file.startsWith(`${project.id}-`)), false);
  } finally { release.resolve(); mockRename.mock.restore(); mockGet?.mock.restore(); await replacement.catch(() => {}); }
});

test('a media selection made before a concurrent saved edit is rejected without losing the new edit', { timeout: 15_000 }, async (t) => {
  const project = await seed('concurrent-revision');
  const gate = deferred(); const entered = deferred();
  const original = store.withProjectWrite.bind(store);
  let held = false;
  const mock = t.mock.method(store, 'withProjectWrite', async (...args: Parameters<typeof store.withProjectWrite>) => {
    if (!held && args[0] === project.id) { held = true; entered.resolve(); await gate.promise; }
    return original(...args);
  });
  const replacement = replace(project);
  try {
    await entered.promise;
    const saveResponse = await save(project, 'NEWER SAVED EDIT');
    assert.equal(saveResponse.status, 200, await saveResponse.clone().text());
    const saved = (await store.get(project.id))!;
    gate.resolve();
    const response = await replacement;
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(await store.get(project.id), saved);
    assert.equal(saved.captions[1].text, 'NEWER SAVED EDIT');
    assert.equal(saved.media.filename, project.media.filename);
  } finally { gate.resolve(); mock.mock.restore(); await replacement.catch(() => {}); }
});

test('backup and History staging failures do not clear old History or leave an advertised recovery', async (t) => {
  for (const failure of ['backup-copy', 'history-stage'] as const) {
    const project = await seed(`fail-${failure}`);
    const beforeHistory = await historyStore.list(project.id, project.media);
    const beforeUploads = (await fs.readdir(config.uploadDir)).sort();
    const copy = fs.copyFile;
    const mock = failure === 'backup-copy'
      ? t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
        if (String(args[1]).endsWith(`${path.sep}source`)) throw new Error('Synthetic backup copy failure');
        return copy(...args);
      })
      : t.mock.method(historyStore, 'prepareMediaVersion', async () => { throw new Error('Synthetic History staging failure'); });
    try {
      const response = await replace(project);
      assert.equal(response.status, 500, await response.clone().text());
      assert.deepEqual(await readDisk(project.id), project);
      assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory);
      assert.deepEqual((await fs.readdir(config.uploadDir)).sort(), beforeUploads);
      const backups = await jsonRequest(project.id, '/media-replacements');
      assert.deepEqual(await backups.json(), []);
    } finally { mock.mock.restore(); }
  }
});

test('corrupted recovery media is rejected before restoring any saved review state', async () => {
  const project = await seed('corrupt-recovery');
  const response = await replace(project);
  assert.equal(response.status, 200, await response.clone().text());
  const current = await response.json() as CaptionProject & { mediaReplacement: { id: string } };
  const backup = path.join(config.historyDir, project.id, 'media-replacements', current.mediaReplacement.id, 'source');
  const bytes = await fs.readFile(backup); bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(backup, bytes);
  const beforeHistory = await historyStore.list(project.id, current.media);
  const restored = await restore(current, current.mediaReplacement.id);
  assert.equal(restored.status, 409, await restored.clone().text());
  assert.equal((await restored.json() as any).code, 'MEDIA_RECOVERY_INVALID');
  assert.equal((await store.get(project.id))!.media.filename, current.media.filename);
  assert.deepEqual(kept((await store.get(project.id))!), kept(current));
  assert.deepEqual(await historyStore.list(project.id, current.media), beforeHistory);
});

test('bounded recovery storage rejects a sixth swap without mutation and explicit deletion frees capacity', async () => {
  let project = await seed('recovery-capacity');
  for (let index = 0; index < 5; index++) {
    const response = await replace(project, replacementBytes, { mode: 'reset' });
    assert.equal(response.status, 200, await response.clone().text());
    project = await response.json() as CaptionProject;
  }
  const before = (await store.get(project.id))!;
  const overflow = await replace(project, replacementBytes, { mode: 'reset' });
  assert.equal(overflow.status, 409, await overflow.clone().text());
  assert.equal((await overflow.json() as any).code, 'MEDIA_RECOVERY_LIMIT');
  assert.deepEqual(await store.get(project.id), before);
  const checkpoints = await (await jsonRequest(project.id, '/media-replacements')).json() as Array<{ id: string }>;
  assert.equal(checkpoints.length, 5);
  const staleDelete = await jsonRequest(project.id, `/media-replacements/${checkpoints[0].id}`, 'DELETE', { expectedMedia: before.media, expectedUpdatedAt: 'stale' });
  assert.equal(staleDelete.status, 409);
  const deleteResponse = await jsonRequest(project.id, `/media-replacements/${checkpoints[0].id}`, 'DELETE', { expectedMedia: before.media, expectedUpdatedAt: before.updatedAt });
  assert.equal(deleteResponse.status, 204);
  assert.deepEqual(await store.get(project.id), before);
  assert.equal((await replace(before, replacementBytes, { mode: 'reset' })).status, 200);
});


test('changed content with an identical incoming timestamp advances revision and rejects the stale replacement', async (t) => {
  const project = await seed('same-timestamp-edit');
  const frozen = t.mock.method(Date, 'now', () => Date.parse(project.updatedAt));
  try {
    await store.withProjectWrite(project.id, async (current, persist) => {
      assert.ok(current);
      await persist({ ...current, title: 'A newer title in the same millisecond', updatedAt: project.updatedAt });
    });
    const changed = (await store.get(project.id))!;
    assert.notEqual(changed.updatedAt, project.updatedAt);
    assert.ok(Date.parse(changed.updatedAt) > Date.parse(project.updatedAt));
    const stale = await replace(project);
    assert.equal(stale.status, 409, await stale.clone().text());
    assert.deepEqual(await store.get(project.id), changed);
    const fresh = await replace(changed);
    assert.equal(fresh.status, 200, await fresh.clone().text());
  } finally { frozen.mock.restore(); }
});

test('unreadable or corrupt indexed History aborts preserve and reset without deleting source or History', async (t) => {
  for (const mode of ['preserve', 'reset'] as const) {
    for (const failure of ['read-eio', 'corrupt-json'] as const) {
      const project = await seed(`history-${mode}-${failure}`);
      const entries = await historyStore.list(project.id, project.media);
      const historyFile = path.join(config.historyDir, project.id, `${entries[0].id}.json`);
      const originalBytes = await fs.readFile(historyFile);
      const corrupt = Buffer.from('{"broken":');
      const read = fs.readFile;
      let injected = false;
      let mock: ReturnType<typeof t.mock.method> | undefined;
      if (failure === 'corrupt-json') await fs.writeFile(historyFile, corrupt);
      else mock = t.mock.method(fs, 'readFile', async (...args: any[]) => {
        if (path.resolve(String(args[0])) === path.resolve(historyFile)) {
          injected = true;
          throw Object.assign(new Error('Synthetic indexed History EIO'), { code: 'EIO' });
        }
        return (read as any)(...args);
      });
      try {
        const response = await replace(project, replacementBytes, { mode });
        assert.ok([409, 500].includes(response.status), `${mode}/${failure}: ${await response.clone().text()}`);
        if (failure === 'read-eio') assert.equal(injected, true);
        assert.deepEqual(await readDisk(project.id), project);
        assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
        assert.deepEqual(await (await jsonRequest(project.id, '/media-replacements')).json(), []);
      } finally { mock?.mock.restore(); }
      assert.deepEqual(await fs.readFile(historyFile), failure === 'corrupt-json' ? corrupt : originalBytes);
      assert.deepEqual(await historyStore.list(project.id, project.media), entries);
    }
  }
});

test('old-tab job creation fails before enqueue after replacement; matching requests retain the authorized path', async (t) => {
  const original = await seed('stale-job-creation');
  const replacement = await replace(original);
  assert.equal(replacement.status, 200, await replacement.clone().text());
  const current = await replacement.json() as CaptionProject;
  let calls = 0;
  const mock = t.mock.method(jobStore, 'create', async (type: Parameters<typeof jobStore.create>[0], projectId: string) => {
    calls++;
    return { id: `synthetic-stub-${calls}`, type, projectId, projectTitle: 'Synthetic test', status: 'queued' as const, stage: 'queued', progress: 0, message: 'Not actually executed', createdAt: current.updatedAt, updatedAt: current.updatedAt, canResume: false };
  });
  try {
    for (const type of ['transcribe', 'regenerate-range', 'refine-proposal']) {
      const body = { projectId: original.id, proposalId: 'synthetic-proposal', startMs: 0, endMs: 1000, strategy: 'standard' };
      const request = (expectedMedia?: CaptionProject['media']) => fetch(`${baseUrl.replace('/api/projects', '/api/jobs')}/${type}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(expectedMedia ? { expectedMedia } : {}) }) });
      assert.equal((await request(original.media)).status, 409, type);
      assert.equal((await request()).status, 428, type);
    }
    assert.equal(calls, 0, 'stale and unbound tabs must not start any paid or local generation');
    for (const type of ['transcribe', 'regenerate-range', 'refine-proposal']) {
      const response = await fetch(`${baseUrl.replace('/api/projects', '/api/jobs')}/${type}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: current.id, expectedMedia: current.media, proposalId: 'synthetic-proposal', startMs: 0, endMs: 1000, strategy: 'standard' }) });
      assert.equal(response.status, 202, await response.clone().text());
    }
    assert.equal(calls, 3);
    assert.deepEqual(kept((await store.get(current.id))!), kept(current));
  } finally { mock.mock.restore(); }
});

test('a second replacement refuses unreadable or corrupt media-version History archives', async (t) => {
  for (const mode of ['preserve', 'reset'] as const) {
    for (const failure of ['read-eio', 'corrupt-json'] as const) {
      const original = await seed(`archive-${mode}-${failure}`);
      const initial = await replace(original);
      assert.equal(initial.status, 200, await initial.clone().text());
      const project = await initial.json() as CaptionProject;
      const archiveRoot = path.join(config.historyDir, project.id, 'media-versions');
      const versions = await fs.readdir(archiveRoot);
      assert.equal(versions.length, 1);
      const archiveFile = path.join(archiveRoot, versions[0], 'entries.json');
      const beforeBytes = await fs.readFile(archiveFile);
      const beforeProject = await readDisk(project.id);
      const beforeBackups = await (await jsonRequest(project.id, '/media-replacements')).json();
      const corrupt = Buffer.from('[{"truncated":');
      const read = fs.readFile;
      let injected = false;
      let mock: ReturnType<typeof t.mock.method> | undefined;
      if (failure === 'corrupt-json') await fs.writeFile(archiveFile, corrupt);
      else mock = t.mock.method(fs, 'readFile', async (...args: any[]) => {
        if (path.resolve(String(args[0])) === path.resolve(archiveFile)) {
          injected = true; throw Object.assign(new Error('Synthetic media archive EIO'), { code: 'EIO' });
        }
        return (read as any)(...args);
      });
      try {
        const response = await replace(project, replacementBytes, { mode });
        assert.ok([409, 500].includes(response.status), `${mode}/${failure}: ${await response.clone().text()}`);
        if (failure === 'read-eio') assert.equal(injected, true);
        assert.deepEqual(await readDisk(project.id), beforeProject);
        assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), replacementBytes);
        assert.deepEqual(await (await jsonRequest(project.id, '/media-replacements')).json(), beforeBackups);
      } finally { mock?.mock.restore(); }
      assert.deepEqual(await fs.readFile(archiveFile), failure === 'corrupt-json' ? corrupt : beforeBytes);
    }
  }
});

test('persisted failed/interrupted jobs cannot resume on replacement media or without source binding', async () => {
  const original = await seed('durable-job-binding');
  const replacement = await replace(original);
  assert.equal(replacement.status, 200, await replacement.clone().text());
  const current = await replacement.json() as CaptionProject;
  const childRoot = path.join(root, 'job-resume-isolated');
  const childData = path.join(childRoot, 'data');
  await fs.mkdir(path.join(childData, 'projects'), { recursive: true });
  await fs.writeFile(path.join(childData, 'projects', `${current.id}.json`), JSON.stringify(current));
  const jobs: any[] = [];
  for (const type of ['transcribe', 'regenerate-range', 'refine-proposal']) {
    for (const status of ['failed', 'interrupted']) {
      for (const binding of ['old-media', 'legacy-unbound']) {
        jobs.push({ id: `${type}-${status}-${binding}`, projectId: current.id, projectTitle: current.title,
          type, status, stage: status, progress: 7, message: 'Synthetic interrupted work', canResume: true,
          createdAt: current.createdAt, updatedAt: current.updatedAt,
          payload: { startMs: 0, endMs: 1000, proposalId: 'synthetic-proposal', strategy: 'standard',
            ...(binding === 'old-media' ? { sourceMediaFilename: original.media.filename, sourceMediaSize: original.media.size } : {}) },
        });
      }
    }
  }
  jobs.push({ id: 'matching-current', projectId: current.id, projectTitle: current.title, type: 'transcribe', status: 'failed', stage: 'failed', progress: 7, message: 'Synthetic matching retry', canResume: true, createdAt: current.createdAt, updatedAt: current.updatedAt, payload: { sourceMediaFilename: current.media.filename, sourceMediaSize: current.media.size } });
  await fs.writeFile(path.join(childData, 'jobs.json'), JSON.stringify(jobs));
  const code = `
    import assert from 'node:assert/strict';
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network in synthetic resume test'); };
    const { store } = await import('./apps/server/src/services/store.ts');
    const { jobStore, assertJobMediaCurrent } = await import('./apps/server/src/services/job-store.ts');
    const ids = ${JSON.stringify(jobs.slice(0, -1).map((job) => job.id))};
    const rejected = [];
    for (const id of ids) {
      const before = await jobStore.get(id);
      await assert.rejects(jobStore.resume(id), /older|unverified media/i);
      assert.deepEqual(await jobStore.get(id), before);
      rejected.push(id);
    }
    await assertJobMediaCurrent(${JSON.stringify(current.id)}, ${JSON.stringify(jobs.at(-1).payload)});
    // Allow admission, but stop at the execution-time identity read. No source
    // decoding, generation, model calls, or actual caption work is performed.
    const getMedia = store.getMedia.bind(store);
    let identityReads = 0; let signalExecution;
    const executionReached = new Promise((resolve) => { signalExecution = resolve; });
    store.getMedia = async (...args) => {
      identityReads++;
      if (identityReads > 1) { signalExecution(); return new Promise(() => {}); }
      return getMedia(...args);
    };
    const accepted = await jobStore.resume('matching-current');
    assert.ok(['queued', 'running'].includes(accepted.status));
    await Promise.race([executionReached, new Promise((_, reject) => setTimeout(() => reject(new Error('Matching resume never reached execution guard')), 3000))]);
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ rejected, accepted: accepted.status, identityReads, networkCalls }));
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, STHANG_STUDIO_STATE_ROOT: childRoot, STHANG_STUDIO_ENV_FILE: path.join(childRoot, 'absent.env') }, encoding: 'utf8', timeout: 15_000 });
  const result = JSON.parse(output.trim().split('\n').at(-1)!);
  assert.equal(result.rejected.length, 12);
  assert.ok(['queued', 'running'].includes(result.accepted));
  assert.equal(result.identityReads, 2);
  assert.equal(result.networkCalls, 0);
});

test('cache invalidation failure leaves the project and recoverable reviewed history unchanged', async () => {
  const project = await seed('cache-invalidation-failure');
  const beforeHistory = await historyStore.list(project.id, project.media);
  const uploadPath = path.join(config.uploadDir, 'synthetic-invalidation-upload');
  await fs.writeFile(uploadPath, replacementBytes);
  const service = createMediaReplacementService({ invalidateCache: async () => { throw new Error('Synthetic cache invalidation failure'); } });
  try {
    await assert.rejects(service.replaceProjectMedia(project.id, { path: uploadPath, originalname: 'replacement.mp4', mimetype: 'video/mp4', size: replacementBytes.length }, { mode: 'preserve', expectedMedia: project.media, expectedUpdatedAt: project.updatedAt }), /Synthetic cache invalidation failure/);
    assert.deepEqual(await readDisk(project.id), project);
    assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory);
    assert.deepEqual(await service.listMediaReplacements(project.id), []);
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
    await assert.rejects(fs.stat(uploadPath), { code: 'ENOENT' });
  } finally { cancelScheduledProjectPrewarm(project.id); }
});

test('retired-media appearance saves and video exports cannot change the preserved replacement', async (t) => {
  const project = await seed('stale-style-export');
  const response = await replace(project);
  assert.equal(response.status, 200, await response.clone().text());
  const replacement = await response.json() as CaptionProject;
  let enqueues = 0;
  const mock = t.mock.method(jobStore, 'create', async () => { enqueues++; throw new Error('Export must not be enqueued'); });
  const base = baseUrl.replace('/api/projects', '/api/video-export');
  try {
    for (const [suffix, method] of [['appearance', 'PUT'], ['jobs', 'POST']] as const) {
      const stale = await fetch(`${base}/${project.id}/${suffix}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedMedia: project.media, appearance: { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#FF0000' }, settings: {} }) });
      assert.equal(stale.status, 409, await stale.clone().text());
      const unbound = await fetch(`${base}/${project.id}/${suffix}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appearance: DEFAULT_CAPTION_APPEARANCE, settings: {} }) });
      assert.equal(unbound.status, 428, await unbound.clone().text());
    }
    assert.equal(enqueues, 0);
    assert.deepEqual(kept((await store.get(project.id))!), kept(replacement));
  } finally { mock.mock.restore(); }
});

test('prepublication file fsync failures propagate and remove all staging while preserving old media, project and History', async (t) => {
  for (const failure of ['project', 'history', 'staged-media', 'backup-source'] as const) {
    await t.test(failure, async () => {
      const project = await seed(`prepublication-fsync-${failure}`);
      const beforeHistory = await historyStore.list(project.id, project.media);
      const beforeHistoryFiles = await filesInTree(path.join(config.historyDir, project.id));
      const beforeProjectFiles = await filesInTree(projectDir);
      const beforeUploads = (await fs.readdir(config.uploadDir)).sort();
      const open = fs.open;
      let injected = false;
      const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (!injected && fileFlushTarget(String(args[0]), project.id) === failure) {
          handle.sync = async () => {
            injected = true;
            throw Object.assign(new Error(`Synthetic prepublication ${failure} fsync failure`), { code: 'EPERM', syscall: 'fsync' });
          };
        }
        return handle;
      });
      try {
        const response = await replace(project);
        assert.equal(response.status, 500, await response.clone().text());
        assert.equal((await response.json() as { code: string }).code, 'MEDIA_REPLACEMENT_FAILED');
        assert.equal(injected, true);
        assert.deepEqual(await readDisk(project.id), project);
        assert.deepEqual(await store.get(project.id), project);
        assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory);
        assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
        assert.deepEqual((await fs.readdir(config.uploadDir)).sort(), beforeUploads);
        assert.deepEqual(await filesInTree(projectDir), beforeProjectFiles);
        assert.deepEqual(await filesInTree(path.join(config.historyDir, project.id)), beforeHistoryFiles);
        assert.deepEqual(await (await jsonRequest(project.id, '/media-replacements')).json(), []);
      } finally { mock.mock.restore(); }
    });
  }
});

test(process.platform === 'win32'
  ? 'Windows publication without directory fsync retains old source, History and recovery until explicit deletion'
  : 'post-publication directory fsync failure retains active media and recovery with a durability warning', async (t) => {
  const project = await seed('postpublication-fsync');
  const beforeHistory = await historyStore.list(project.id, project.media);
  const beforeCheckpoint = await historyStore.get(project.id, beforeHistory[0].id, project.media);
  const open = fs.open;
  let injected = false;
  // Windows takes the real nondurable-publication branch without injection.
  const mock = process.platform === 'win32' ? undefined : t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (path.resolve(String(args[0])) === path.resolve(projectDir)) {
      handle.sync = async () => { injected = true; throw new Error('Synthetic post-publication directory fsync failure'); };
    }
    return handle;
  });
  let replacement: CaptionProject & { mediaReplacement: { id: string }; replacementCleanupWarnings: string[] };
  try {
    const response = await replace(project);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(injected, process.platform !== 'win32');
    replacement = await response.json() as typeof replacement;
    assert.equal(store.latestWriteIsDurable(project.id), false);
    assert.ok(replacement.replacementCleanupWarnings.includes('durability'));
    assert.deepEqual(kept(replacement), kept(project));
    assert.equal((await readDisk(project.id)).media.filename, replacement.media.filename);
    assert.equal((await store.get(project.id))!.media.filename, replacement.media.filename);
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, replacement.media.filename)), replacementBytes);
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes, 'old source retained until directory durability is confirmed');
    const backups = await (await jsonRequest(project.id, '/media-replacements')).json() as Array<{ id: string }>;
    assert.ok(backups.some((entry) => entry.id === replacement.mediaReplacement.id));
    const backupDirectory = path.join(config.historyDir, project.id, 'media-replacements', replacement.mediaReplacement.id);
    assert.deepEqual(await fs.readFile(path.join(backupDirectory, 'source')), sourceBytes);
    const snapshot = JSON.parse(await fs.readFile(path.join(backupDirectory, 'snapshot.json'), 'utf8'));
    assert.deepEqual(snapshot.project, project);
    assert.deepEqual(snapshot.history, [beforeCheckpoint]);
    assert.equal((await historyStore.list(project.id, replacement.media)).length, 1);
    assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory, 'old History remains available until directory durability is confirmed');
    assert.deepEqual(await historyStore.get(project.id, beforeHistory[0].id, project.media), beforeCheckpoint);
  } finally { mock?.mock.restore(); }
  const removed = await jsonRequest(project.id, '', 'DELETE');
  assert.equal(removed.status, 204, await removed.clone().text());
  assert.equal(await store.get(project.id), null);
  await assert.rejects(fs.stat(path.join(projectDir, `${project.id}.json`)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(config.historyDir, project.id)), { code: 'ENOENT' });
  assert.equal((await fs.readdir(config.uploadDir)).some((file) => file.startsWith(`${project.id}-`)), false, 'deleting project also removes retained old sources');
});

test('media-preparation context revision is compared atomically with persistence', async () => {
  const project = await seed('context-preflight-revision');
  const body = (description: string, expectedUpdatedAt: unknown = project.updatedAt) => ({
    expectedMedia: project.media, expectedUpdatedAt,
    transcriptionContext: { description, vocabulary: ['ExactBrand | alias'] },
  });
  const responses = await Promise.all([
    jsonRequest(project.id, '/context', 'PUT', body('Concurrent context A')),
    jsonRequest(project.id, '/context', 'PUT', body('Concurrent context B')),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409], 'one revision may authorize exactly one write');
  const winner = await responses.find((response) => response.status === 200)!.json() as CaptionProject;
  assert.notEqual(winner.updatedAt, project.updatedAt);
  assert.deepEqual(await readDisk(project.id), winner);
  const rejection = await responses.find((response) => response.status === 409)!.json() as { code: string };
  assert.equal(rejection.code, 'CONTEXT_REVISION_CHANGED');
  const stale = await jsonRequest(project.id, '/context', 'PUT', body('Must not overwrite winner'));
  assert.equal(stale.status, 409);
  assert.deepEqual(await readDisk(project.id), winner);
  assert.deepEqual(await (await jsonRequest(project.id, '/media-replacements')).json(), []);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
  for (const invalid of ['', 42, null]) {
    assert.equal((await jsonRequest(project.id, '/context', 'PUT', body('Invalid revision', invalid))).status, 400);
  }
  const savedCaption = await save(winner, 'Other tab caption edit');
  assert.equal(savedCaption.status, 200);
  const afterCaption = await readDisk(project.id);
  const staleAfterCaption = await jsonRequest(project.id, '/context', 'PUT', body('Must not cross newer caption save', winner.updatedAt));
  assert.equal(staleAfterCaption.status, 409);
  assert.deepEqual(await readDisk(project.id), afterCaption);
});
