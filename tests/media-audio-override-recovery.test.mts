import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject } from '@kcs/shared';

// Every source and project is synthetic and isolated from installed Studio state.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audio-override-recovery-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { createMediaReplacementService } = await import('../apps/server/src/services/media-replacement.js');
const service = createMediaReplacementService();
const ids = new Set<string>();
let nextUpload = 0;
await fs.mkdir(config.uploadDir, { recursive: true });
await fs.mkdir(config.historyDir, { recursive: true });
after(async () => {
  for (const id of ids) cancelScheduledProjectPrewarm(id);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function wav(gain: number) {
  const rate = 48_000;
  const samples = rate * 4;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const t = index / rate;
    const value = gain * (0.14 * Math.sin(2 * Math.PI * (220 + 19 * t) * t) + 0.07 * Math.sin(2 * Math.PI * 701 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    bytes.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return bytes;
}
const sourceBytes = wav(1);
const changedBytes = wav(1.5);
const quieterBytes = wav(0.5);
async function seed(id: string) {
  ids.add(id);
  const filename = `${id}-original.wav`;
  await fs.writeFile(path.join(config.uploadDir, filename), sourceBytes);
  const project: CaptionProject = {
    id, title: 'Synthetic accepted-audio recovery', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    media: { filename, originalName: filename, size: sourceBytes.length, mimeType: 'audio/wav', url: `/media/${filename}` },
    mode: 'single-line', captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
    captions: [{ id: 'reviewed-cue', text: 'Reviewed words', startMs: 230, endMs: 3710, approved: true, textLocked: true, timingLocked: true,
      wordTiming: { version: 1, text: 'Reviewed words', words: [
        { id: 'first-word', startOffset: 0, endOffset: 8, startMs: 230, endMs: 1560, source: 'manual' },
        { id: 'second-word', startOffset: 9, endOffset: 14, startMs: 1680, endMs: 3710, source: 'aligned' },
      ] } }],
    transcript: { language: 'km', fullText: 'Reviewed words', segments: [], tokens: [{ id: 'original-token', text: 'Reviewed words', startMs: 230, endMs: 3710, spaceBefore: false, timingSource: 'stt' }] },
    transcriptNeedsSync: true, engineVersion: 'synthetic-review',
    transcriptionContext: { description: 'Retain all reviewed data', vocabulary: ['SyntheticBrand | alias'] },
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  await historyStore.checkpoint(project, 'Original reviewed checkpoint', 'manual-save');
  return project;
}
function expected(project: CaptionProject, token?: string, signal?: AbortSignal) {
  return { mode: 'preserve' as const, expectedMedia: project.media, expectedUpdatedAt: project.updatedAt,
    ...(token ? { audioChangeConfirmation: token } : {}), ...(signal ? { signal } : {}) };
}
async function upload(bytes = changedBytes) {
  const file = path.join(config.uploadDir, `synthetic-override-upload-${++nextUpload}.wav`);
  await fs.writeFile(file, bytes);
  return { path: file, originalname: 'synthetic-mixed.wav', mimetype: 'audio/wav', size: bytes.length };
}
async function replace(project: CaptionProject, token?: string, bytes = changedBytes, targetService = service, signal?: AbortSignal) {
  try { return await targetService.replaceProjectMedia(project.id, await upload(bytes), expected(project, token, signal)); }
  finally { cancelScheduledProjectPrewarm(project.id); }
}
async function confirmation(project: CaptionProject, bytes = changedBytes) {
  let token = '';
  await assert.rejects(replace(project, undefined, bytes), (error: any) => {
    assert.equal(error.code, 'MEDIA_AUDIO_MISMATCH');
    assert.equal(typeof error.preserveAudioConfirmation?.token, 'string');
    assert.ok(Number.isFinite(Date.parse(error.preserveAudioConfirmation.expiresAt)));
    token = error.preserveAudioConfirmation.token;
    return true;
  });
  assert.ok(token);
  return token;
}
function kept(project: CaptionProject) {
  return { id: project.id, title: project.title, createdAt: project.createdAt,
    captions: project.captions, transcript: project.transcript, transcriptNeedsSync: project.transcriptNeedsSync,
    mode: project.mode, captionAppearance: project.captionAppearance, transcriptionContext: project.transcriptionContext,
    engineVersion: project.engineVersion, ...(project.mediaAlignment ? { mediaAlignment: project.mediaAlignment } : {}) };
}
async function disk(project: CaptionProject) {
  return JSON.parse(await fs.readFile(path.join(path.dirname(config.dataFile), 'projects', `${project.id}.json`), 'utf8')) as CaptionProject;
}
async function allFiles(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assert.equal(entry.name.endsWith('.preparing'), false, 'incomplete recovery staging must be removed');
      for (const [relative, bytes] of Object.entries(await allFiles(filename))) result[path.join(entry.name, relative)] = bytes;
    } else {
      assert.equal(entry.name.endsWith('.tmp'), false, 'incomplete atomic files must be removed');
      result[entry.name] = (await fs.readFile(filename)).toString('base64');
    }
  }
  return result;
}
function freshProcess(source: string) {
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
  });
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

test('accepted audio marker, reviewed word data and History survive restart, rollback and redo', async () => {
  const original = await seed('override-restart-rollback');
  const beforeHistory = await historyStore.exportForMedia(original.id, original.media);
  const token = await confirmation(original);
  assert.deepEqual(await store.get(original.id), original, 'unaccepted warning must not publish a project');
  assert.deepEqual(await service.listMediaReplacements(original.id), [], 'unaccepted warning must not consume a backup slot');
  const accepted = await replace(original, token);
  const marker = accepted.mediaAlignment;
  assert.equal(marker?.state, 'unverified-audio-change');
  assert.equal(marker?.sourceRevision, original.updatedAt);
  assert.ok(Number.isFinite(Date.parse(marker!.acceptedAt)));
  assert.deepEqual(kept(accepted), { ...kept(original), mediaAlignment: marker });
  const backup = path.join(config.historyDir, original.id, 'media-replacements', accepted.mediaReplacement.id);
  const snapshot = JSON.parse(await fs.readFile(path.join(backup, 'snapshot.json'), 'utf8'));
  assert.deepEqual(snapshot.project, original);
  assert.deepEqual(snapshot.history, beforeHistory);
  assert.equal(snapshot.verification?.audioMatches, false, 'accepted changed audio must never be certified as matching PCM');
  assert.deepEqual(await fs.readFile(path.join(backup, 'source')), sourceBytes);
  const reboundHistory = await historyStore.exportForMedia(original.id, accepted.media);
  assert.equal(reboundHistory.length, beforeHistory.length);
  assert.deepEqual(reboundHistory[0].snapshot.mediaAlignment, marker, 'rebased History cannot lose the audio warning');
  assert.deepEqual(reboundHistory[0].snapshot.captions, original.captions);
  const fresh = freshProcess(`const {store}=await import('./apps/server/src/services/store.ts'); const {historyStore}=await import('./apps/server/src/services/history-store.ts'); const {listMediaReplacements}=await import('./apps/server/src/services/media-replacement.ts'); const p=await store.get(${JSON.stringify(original.id)}); console.log(JSON.stringify({project:p,history:await historyStore.exportForMedia(p.id,p.media),backups:await listMediaReplacements(p.id)}));`);
  assert.deepEqual(fresh.project, await disk(accepted));
  assert.deepEqual(fresh.project.mediaAlignment, marker);
  assert.deepEqual(fresh.history, reboundHistory);
  assert.ok(fresh.backups.some((entry: { id: string }) => entry.id === accepted.mediaReplacement.id));
  const restored = await service.restoreProjectMedia(accepted.id, accepted.mediaReplacement.id, expected(accepted));
  cancelScheduledProjectPrewarm(original.id);
  assert.deepEqual(kept(restored), kept(original));
  assert.equal(restored.mediaAlignment, undefined, 'restoring original media restores its verified/legacy state');
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, restored.media.filename)), sourceBytes);
  const redo = await service.restoreProjectMedia(restored.id, restored.mediaReplacement.id, expected(restored));
  cancelScheduledProjectPrewarm(original.id);
  assert.deepEqual(kept(redo), kept(accepted));
  assert.deepEqual(redo.mediaAlignment, marker);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, redo.media.filename)), changedBytes);
  assert.deepEqual((await historyStore.exportForMedia(redo.id, redo.media))[0].snapshot.mediaAlignment, marker);
});

test('accepted retry cancellation before publication preserves all source, project and History bytes', async () => {
  const project = await seed('override-cancel-rollback');
  const token = await confirmation(project);
  const historyBefore = await allFiles(path.join(config.historyDir, project.id));
  const uploadsBefore = await allFiles(config.uploadDir);
  const controller = new AbortController();
  const aborting = createMediaReplacementService({ invalidateCache: async () => { controller.abort(); } });
  await assert.rejects(replace(project, token, changedBytes, aborting, controller.signal), (error: any) => error.code === 'MEDIA_REPLACEMENT_CANCELLED');
  assert.deepEqual(await store.get(project.id), project);
  assert.deepEqual(await disk(project), project);
  assert.deepEqual(await allFiles(path.join(config.historyDir, project.id)), historyBefore);
  assert.deepEqual(await allFiles(config.uploadDir), uploadsBefore);
  assert.deepEqual(await service.listMediaReplacements(project.id), []);
});

test('accepted retry backup fsync failure removes staging and leaves the reviewed project intact', async (t) => {
  const project = await seed('override-backup-fsync');
  const token = await confirmation(project);
  const historyBefore = await allFiles(path.join(config.historyDir, project.id));
  const uploadsBefore = await allFiles(config.uploadDir);
  const open = fs.open;
  let injected = false;
  const hook = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const file = String(args[0]);
    if (file.startsWith(path.join(config.historyDir, project.id, 'media-replacements')) && file.endsWith(`${path.sep}source`)) {
      handle.sync = async () => { injected = true; throw Object.assign(new Error('Synthetic backup flush failed'), { code: 'ENOSPC' }); };
    }
    return handle;
  });
  try { await assert.rejects(replace(project, token), /Synthetic backup flush failed/); }
  finally { hook.mock.restore(); }
  assert.equal(injected, true);
  assert.deepEqual(await store.get(project.id), project);
  assert.deepEqual(await disk(project), project);
  assert.deepEqual(await allFiles(path.join(config.historyDir, project.id)), historyBefore);
  assert.deepEqual(await allFiles(config.uploadDir), uploadsBefore);
});

test('same-size source or selected-file mutation invalidates the pending audio confirmation', async () => {
  for (const kind of ['selected-file', 'old-source'] as const) {
    const project = await seed(`override-mutated-${kind}`);
    const token = await confirmation(project);
    if (kind === 'old-source') await fs.writeFile(path.join(config.uploadDir, project.media.filename), quieterBytes);
    await assert.rejects(replace(project, token, kind === 'selected-file' ? quieterBytes : changedBytes), (error: any) => {
      assert.ok(['MEDIA_AUDIO_CONFIRMATION_STALE', 'MEDIA_SOURCE_UNAVAILABLE'].includes(error.code));
      return true;
    });
    assert.deepEqual(await store.get(project.id), project);
    assert.deepEqual(await service.listMediaReplacements(project.id), []);
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), kind === 'old-source' ? quieterBytes : sourceBytes);
  }
});

test('replacement mutation between completed verification and staging cannot publish unconfirmed bytes', async (t) => {
  const project = await seed('override-staging-mutation');
  const token = await confirmation(project);
  const historyBefore = await allFiles(path.join(config.historyDir, project.id));
  const uploadsBefore = await allFiles(config.uploadDir);
  const rename = fs.rename;
  let injected = false;
  const hook = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (path.basename(String(args[0])).startsWith('synthetic-override-upload-')) {
      injected = true;
      await fs.writeFile(args[0], quieterBytes);
    }
    return rename(...args);
  });
  try { await assert.rejects(replace(project, token), (error: any) => error.code === 'MEDIA_SOURCE_UNAVAILABLE'); }
  finally { hook.mock.restore(); }
  assert.equal(injected, true);
  assert.deepEqual(await store.get(project.id), project);
  assert.deepEqual(await disk(project), project);
  assert.deepEqual(await allFiles(path.join(config.historyDir, project.id)), historyBefore);
  assert.deepEqual(await allFiles(config.uploadDir), uploadsBefore);
});

test('one confirmed revision permits at most one winner for concurrent replacement and replay', async () => {
  const project = await seed('override-double-click');
  const token = await confirmation(project);
  const outcomes = await Promise.allSettled([replace(project, token), replace(project, token)]);
  const winners = outcomes.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const loser = outcomes.find((result) => result.status === 'rejected');
  assert.ok(loser?.status === 'rejected');
  assert.equal(loser.reason.httpStatus, 409);
  assert.equal((await service.listMediaReplacements(project.id)).length, 1);
  const current = (await store.get(project.id))!;
  assert.equal(current.mediaAlignment?.state, 'unverified-audio-change');
  await assert.rejects(replace(project, token), (error: any) => error.code === 'MEDIA_REPLACEMENT_STALE');
  assert.deepEqual(await store.get(project.id), current);
  assert.deepEqual(current.captions, project.captions);
});

test('pending confirmation is not persisted and cannot be replayed after a fresh process', async () => {
  const project = await seed('override-restart-token');
  const token = await confirmation(project);
  const pending = await upload();
  const result = freshProcess(`const {replaceProjectMedia}=await import('./apps/server/src/services/media-replacement.ts'); try { await replaceProjectMedia(${JSON.stringify(project.id)},${JSON.stringify(pending)},${JSON.stringify(expected(project, token))}); console.log(JSON.stringify({unexpected:true})); } catch(e) { console.log(JSON.stringify({code:e.code,status:e.httpStatus})); }`);
  assert.deepEqual(result, { code: 'MEDIA_AUDIO_CONFIRMATION_STALE', status: 409 });
  assert.deepEqual(await disk(project), project);
  const serialized = Object.values(await allFiles(path.join(config.historyDir, project.id))).map((bytes) => Buffer.from(bytes, 'base64').toString('utf8')).join('\n');
  assert.equal(serialized.includes(token), false);
  assert.deepEqual(await service.listMediaReplacements(project.id), []);
});

test('corrupt recovery source rejects without losing accepted media or its alignment marker', async () => {
  const project = await seed('override-corrupt-backup');
  const accepted = await replace(project, await confirmation(project));
  const backupSource = path.join(config.historyDir, project.id, 'media-replacements', accepted.mediaReplacement.id, 'source');
  const corrupt = Buffer.from(sourceBytes); corrupt[corrupt.length - 2] ^= 0xff;
  await fs.writeFile(backupSource, corrupt);
  const beforeProject = await store.get(project.id);
  const beforeDisk = await disk(accepted);
  await assert.rejects(service.restoreProjectMedia(accepted.id, accepted.mediaReplacement.id, expected(accepted)), (error: any) => error.code === 'MEDIA_RECOVERY_INVALID');
  cancelScheduledProjectPrewarm(project.id);
  assert.deepEqual(await store.get(project.id), beforeProject);
  assert.deepEqual(await disk(accepted), beforeDisk);
  assert.deepEqual((await store.get(project.id))!.mediaAlignment, accepted.mediaAlignment);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, accepted.media.filename)), changedBytes);
  assert.equal((await service.listMediaReplacements(project.id)).length, 1);
});

test('verified replacement of accepted media retains its warning, while explicit reset clears it', async () => {
  const project = await seed('override-verified-then-reset');
  const accepted = await replace(project, await confirmation(project));
  const verified = await replace(accepted, undefined, changedBytes);
  assert.equal(verified.mediaCompatibility?.method, 'full-timeline-pcm-v1');
  assert.deepEqual(verified.mediaAlignment, accepted.mediaAlignment);
  assert.deepEqual(verified.captions, project.captions);
  assert.deepEqual((await historyStore.exportForMedia(project.id, verified.media))[0].snapshot.mediaAlignment, accepted.mediaAlignment);
  const reset = await service.replaceProjectMedia(verified.id, await upload(quieterBytes), { ...expected(verified), mode: 'reset' });
  cancelScheduledProjectPrewarm(project.id);
  assert.equal(reset.mediaAlignment, undefined);
  assert.deepEqual(reset.captions, []);
  assert.equal(reset.transcript, null);
});
