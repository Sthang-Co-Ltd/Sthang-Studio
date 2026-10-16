import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { store } from './store.js';
import { historyStore, type StoredHistoryEntry } from './history-store.js';
import { jobStore } from './job-store.js';
import { jobAdmission } from './job-admission.js';
import { invalidateProjectCache } from './cache.js';
import { cancelScheduledProjectPrewarm } from './prewarm.js';
import { proposalStore } from './proposal-store.js';
import { verifyReplacementAudio, type MediaCompatibilityEvidence } from './media-compatibility.js';

export type MediaReplacementMode = 'preserve' | 'reset';
type ExpectedMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;
export interface MediaReplacementOptions {
  mode?: MediaReplacementMode;
  expectedMedia?: ExpectedMedia;
  expectedUpdatedAt?: string;
  signal?: AbortSignal;
}
export interface ReplacementUpload { path: string; originalname: string; mimetype: string; size: number }
export interface MediaReplacementSummary {
  id: string;
  mode: MediaReplacementMode | 'restore';
  createdAt: string;
  previousOriginalName: string;
  retainedBytes: number;
}
interface RecoverySnapshot extends MediaReplacementSummary {
  version: 1;
  project: CaptionProject;
  history: StoredHistoryEntry[];
  sourceFile: string;
  sourceSha256: string;
  verification?: MediaCompatibilityEvidence;
}
export class MediaReplacementError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string) {
    super(message); this.name = 'MediaReplacementError';
  }
}
const MAX_RECOVERIES = 5;
const dependencies = {
  store, historyStore, jobAdmission,
  hasActiveJobs: (id: string) => jobStore.hasActiveForProject(id),
  verifyAudio: verifyReplacementAudio,
  invalidateCache: invalidateProjectCache,
  cancelPrewarm: cancelScheduledProjectPrewarm,
  removeProposals: (id: string) => proposalStore.removeProject(id),
};
export type MediaReplacementDependencies = typeof dependencies;

function safeId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new MediaReplacementError('Invalid project or recovery id.', 400, 'MEDIA_REPLACEMENT_INPUT');
  return value;
}
function recoveryRoot(projectId: string) { return path.join(config.historyDir, safeId(projectId), 'media-replacements'); }
function recoveryPath(projectId: string, id: string) { return path.join(recoveryRoot(projectId), safeId(id)); }
function sourcePath(filename: string) {
  if (!filename || path.basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename)) {
    throw new MediaReplacementError('The source media is unavailable.', 409, 'MEDIA_SOURCE_UNAVAILABLE');
  }
  return path.join(config.uploadDir, filename);
}
function extension(name: string) {
  const value = path.extname(name);
  return /^\.[a-z0-9]{1,10}$/i.test(value) ? value.toLowerCase() : '.media';
}
function summary(snapshot: RecoverySnapshot): MediaReplacementSummary {
  return { id: snapshot.id, mode: snapshot.mode, createdAt: snapshot.createdAt,
    previousOriginalName: snapshot.previousOriginalName, retainedBytes: snapshot.retainedBytes };
}
function abortIfRequested(signal?: AbortSignal) {
  if (signal?.aborted) throw new MediaReplacementError('Media replacement was cancelled. Your project was kept.', 409, 'MEDIA_REPLACEMENT_CANCELLED');
}
function checkExpected(current: CaptionProject, options: MediaReplacementOptions) {
  if (!options.expectedMedia || typeof options.expectedMedia.filename !== 'string'
    || !Number.isFinite(options.expectedMedia.size) || typeof options.expectedUpdatedAt !== 'string' || !options.expectedUpdatedAt) {
    throw new MediaReplacementError('Reload the project before replacing or restoring media. Its saved media version and revision are required.', 428, 'MEDIA_REPLACEMENT_PRECONDITION');
  }
  if (current.media.filename !== options.expectedMedia.filename || current.media.size !== options.expectedMedia.size
    || current.updatedAt !== options.expectedUpdatedAt) {
    throw new MediaReplacementError('This project changed in another tab or while the file was selected. Reload it and review your changes before trying again.', 409, 'MEDIA_REPLACEMENT_STALE');
  }
}
function nextRevision(current: CaptionProject) {
  return new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
}
async function hashFile(file: string, signal?: AbortSignal) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) { abortIfRequested(signal); hash.update(bytes); }
  return hash.digest('hex');
}
async function regularFile(file: string, expectedSize?: number) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (expectedSize !== undefined && stat.size !== expectedSize)) {
    throw new MediaReplacementError('The source or replacement file is missing or changed. Your project was kept.', 409, 'MEDIA_SOURCE_UNAVAILABLE');
  }
  return stat;
}
async function syncFile(file: string) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string) {
  // Windows does not support opening directories for fsync. File data is still
  // flushed before each atomic rename; POSIX also flushes the directory entry.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readSnapshot(projectId: string, id: string) {
  const directory = recoveryPath(projectId, id);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  const snapshot = await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8').then((value) => JSON.parse(value) as RecoverySnapshot).catch(() => null);
  if (!snapshot || snapshot.version !== 1 || snapshot.id !== id || snapshot.project?.id !== projectId
    || !Array.isArray(snapshot.history) || snapshot.sourceFile !== 'source' || !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256)) return null;
  return snapshot;
}
async function snapshots(projectId: string) {
  const names = await fs.readdir(recoveryRoot(projectId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const values = await Promise.all(names.filter((name) => /^[A-Za-z0-9_-]{1,100}$/.test(name)).map((id) => readSnapshot(projectId, id)));
  return values.filter((value): value is RecoverySnapshot => Boolean(value)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
async function ensureRecoveryCapacity(projectId: string) {
  if ((await snapshots(projectId)).length >= MAX_RECOVERIES) {
    throw new MediaReplacementError('This project has five saved media backups. Delete one backup from Media recovery before replacing or restoring media.', 409, 'MEDIA_RECOVERY_LIMIT');
  }
}

export function createMediaReplacementService(overrides: Partial<MediaReplacementDependencies> = {}) {
  const deps = { ...dependencies, ...overrides };
  async function capture(project: CaptionProject, mode: MediaReplacementSummary['mode'], verification?: MediaCompatibilityEvidence, signal?: AbortSignal) {
    await ensureRecoveryCapacity(project.id);
    const id = nanoid(18);
    const directory = recoveryPath(project.id, id);
    const temporary = `${directory}.preparing`;
    const currentSource = sourcePath(project.media.filename);
    const stat = await regularFile(currentSource, project.media.size);
    try {
      await fs.mkdir(temporary, { recursive: true });
      const beforeHash = await hashFile(currentSource, signal);
      await fs.copyFile(currentSource, path.join(temporary, 'source'), constants.COPYFILE_EXCL);
      await syncFile(path.join(temporary, 'source'));
      const copiedHash = await hashFile(path.join(temporary, 'source'), signal);
      const after = await regularFile(currentSource, stat.size);
      if (copiedHash !== beforeHash || stat.mtimeMs !== after.mtimeMs) {
        throw new MediaReplacementError('The source changed while its recovery backup was being prepared. Your project was kept.', 409, 'MEDIA_SOURCE_UNAVAILABLE');
      }
      const snapshot: RecoverySnapshot = {
        version: 1, id, mode, createdAt: new Date().toISOString(), previousOriginalName: project.media.originalName,
        retainedBytes: stat.size, project: structuredClone(project), history: await deps.historyStore.exportForMedia(project.id, project.media),
        sourceFile: 'source', sourceSha256: copiedHash, ...(verification ? { verification } : {}),
      };
      const handle = await fs.open(path.join(temporary, 'snapshot.json'), 'wx');
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(temporary);
      await fs.rename(temporary, directory);
      await syncDirectory(recoveryRoot(project.id));
      await syncDirectory(path.dirname(recoveryRoot(project.id)));
      await syncDirectory(config.historyDir);
      return snapshot;
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function swap(projectId: string, options: MediaReplacementOptions, uploaded?: ReplacementUpload, restoreId?: string) {
    let stagedPath: string | undefined;
    let stagedMedia: CaptionProject['media'] | undefined;
    let recovery: RecoverySnapshot | undefined;
    let published = false;
    try {
      return await deps.jobAdmission.changeProjectMedia(projectId, () => deps.hasActiveJobs(projectId), () => deps.store.withProjectWrite(projectId, async (current, persist) => {
        if (!current) throw new MediaReplacementError('Project not found', 404, 'MEDIA_PROJECT_NOT_FOUND');
        checkExpected(current, options);
        abortIfRequested(options.signal);
        if (deps.hasActiveJobs(projectId)) throw new MediaReplacementError('Finish or cancel the active processing job before replacing the media.', 409, 'MEDIA_PROJECT_BUSY');
        await ensureRecoveryCapacity(projectId);
        deps.cancelPrewarm(projectId);
        let target: CaptionProject;
        let history: StoredHistoryEntry[];
        let evidence: MediaCompatibilityEvidence | undefined;
        const recovered = restoreId ? await readSnapshot(projectId, restoreId) : null;
        if (restoreId && !recovered) throw new MediaReplacementError('Saved media backup not found.', 404, 'MEDIA_RECOVERY_NOT_FOUND');
        if (recovered) {
          const backupPath = path.join(recoveryPath(projectId, recovered.id), recovered.sourceFile);
          await regularFile(backupPath, recovered.retainedBytes);
          if (await hashFile(backupPath, options.signal) !== recovered.sourceSha256) throw new MediaReplacementError('This saved media backup could not be verified. Your current project was kept.', 409, 'MEDIA_RECOVERY_INVALID');
          const filename = `${projectId}-${nanoid(16)}${extension(recovered.project.media.originalName)}`;
          stagedPath = sourcePath(filename);
          await fs.copyFile(backupPath, stagedPath, constants.COPYFILE_EXCL);
          await syncFile(stagedPath);
          if (await hashFile(stagedPath, options.signal) !== recovered.sourceSha256) throw new MediaReplacementError('The restored media could not be verified. Your current project was kept.', 409, 'MEDIA_RECOVERY_INVALID');
          stagedMedia = { ...recovered.project.media, filename, url: `/media/${encodeURIComponent(filename)}` };
          target = { ...structuredClone(recovered.project), id: current.id, createdAt: current.createdAt, media: stagedMedia, pipelineCache: undefined, updatedAt: nextRevision(current) };
          history = recovered.history;
        } else {
          if (!uploaded) throw new MediaReplacementError('Choose a replacement video or audio file.', 400, 'MEDIA_REPLACEMENT_INPUT');
          await regularFile(uploaded.path, uploaded.size);
          if (options.mode === 'preserve') {
            evidence = await deps.verifyAudio(sourcePath(current.media.filename), uploaded.path, {
              captions: current.captions, expectedDurationMs: current.pipelineCache?.normalizedAudioDurationMs || current.transcript?.timing?.audioDurationMs, signal: options.signal,
            });
          }
          abortIfRequested(options.signal);
          const filename = `${projectId}-${nanoid(16)}${extension(uploaded.originalname)}`;
          stagedPath = sourcePath(filename);
          await fs.rename(uploaded.path, stagedPath);
          await syncFile(stagedPath);
          stagedMedia = { filename, originalName: uploaded.originalname, mimeType: uploaded.mimetype || 'application/octet-stream', size: uploaded.size,
            url: `/media/${encodeURIComponent(filename)}`, ...(evidence ? { durationMs: evidence.durationMs } : {}) };
          target = { ...current, media: stagedMedia, pipelineCache: undefined, updatedAt: nextRevision(current),
            ...(options.mode === 'reset' ? { transcript: null, captions: [], transcriptNeedsSync: false, engineVersion: '0.7.10' } : {}) };
          history = options.mode === 'preserve' ? await deps.historyStore.exportForMedia(projectId, current.media) : [];
        }
        await syncDirectory(config.uploadDir);
        recovery = await capture(current, restoreId ? 'restore' : options.mode!, evidence, options.signal);
        await deps.historyStore.prepareMediaVersion(projectId, target.media, history);
        abortIfRequested(options.signal);
        // Every operation capable of rejecting is staged before the single atomic
        // project publication. Invalidation also drains in-flight normalization.
        await deps.invalidateCache(projectId);
        abortIfRequested(options.signal);
        const saved = await persist(target, { restoreAppearance: Boolean(restoreId) });
        published = true;
        const warnings: string[] = [];
        try { if ((await deps.removeProposals(projectId)).failed) warnings.push('proposals'); } catch { warnings.push('proposals'); }
        if (!deps.store.latestWriteIsDurable(projectId)) warnings.push('durability');
        else {
          try { await fs.rm(sourcePath(current.media.filename), { force: true }); } catch { warnings.push('old-media'); }
          try { await deps.historyStore.removeMediaVersion(projectId, current.media); } catch { warnings.push('history'); }
        }
        return { ...saved, mediaReplacement: summary(recovery), replacementCleanupWarnings: warnings, ...(evidence ? { mediaCompatibility: evidence } : {}) };
      }));
    } finally {
      if (uploaded) await fs.rm(uploaded.path, { force: true }).catch(() => {});
      if (!published) {
        if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => {});
        if (stagedMedia) await deps.historyStore.removeMediaVersion(projectId, stagedMedia).catch(() => {});
        if (recovery) await fs.rm(recoveryPath(projectId, recovery.id), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return {
    async replaceProjectMedia(projectId: string, uploaded: ReplacementUpload, options: MediaReplacementOptions) {
      if (options.mode !== 'preserve' && options.mode !== 'reset') {
        await fs.rm(uploaded.path, { force: true }).catch(() => {});
        throw new MediaReplacementError('Choose whether to keep captions or reset the project before replacing media.', 400, 'MEDIA_REPLACEMENT_MODE');
      }
      return swap(projectId, options, uploaded);
    },
    restoreProjectMedia(projectId: string, id: string, options: MediaReplacementOptions) { return swap(projectId, options, undefined, safeId(id)); },
    async listMediaReplacements(projectId: string) {
      if (!await deps.store.has(projectId)) throw new MediaReplacementError('Project not found', 404, 'MEDIA_PROJECT_NOT_FOUND');
      return (await snapshots(projectId)).map(summary);
    },
    async clearRetiredMediaSources(projectId: string) {
      for (const recovery of await snapshots(projectId)) await fs.rm(sourcePath(recovery.project.media.filename), { force: true });
    },
    async discardMediaReplacement(projectId: string, id: string, options: MediaReplacementOptions) {
      return deps.jobAdmission.changeProjectMedia(projectId, () => deps.hasActiveJobs(projectId), () => deps.store.withProjectWrite(projectId, async (current) => {
        if (!current) throw new MediaReplacementError('Project not found', 404, 'MEDIA_PROJECT_NOT_FOUND');
        checkExpected(current, options);
        const recovery = await readSnapshot(projectId, id);
        if (!recovery) throw new MediaReplacementError('Saved media backup not found.', 404, 'MEDIA_RECOVERY_NOT_FOUND');
        if (recovery.project.media.filename !== current.media.filename) await fs.rm(sourcePath(recovery.project.media.filename), { force: true });
        await fs.rm(recoveryPath(projectId, id), { recursive: true, force: true });
      }));
    },
  };
}
export const { replaceProjectMedia, restoreProjectMedia, listMediaReplacements, discardMediaReplacement, clearRetiredMediaSources } = createMediaReplacementService();
