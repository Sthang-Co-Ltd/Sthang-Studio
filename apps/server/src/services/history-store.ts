import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { CaptionProject, HistorySource, ProjectHistoryEntry } from '@kcs/shared';
import { config } from '../config.js';

export interface StoredHistoryEntry extends ProjectHistoryEntry {
  fingerprint: string;
  snapshot: CaptionProject;
}

type ExpectedMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;
type HistoryIndexEntry = Omit<StoredHistoryEntry, 'snapshot'> & { media?: ExpectedMedia };

const MAX_ENTRIES = 36;
const historyQueues = new Map<string, Promise<void>>();

function safe(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!cleaned) throw new Error('Invalid history id');
  return cleaned;
}

function legacyFile(projectId: string) {
  return path.join(config.historyDir, `${safe(projectId)}.json`);
}

function projectDir(projectId: string) {
  return path.join(config.historyDir, safe(projectId));
}

function indexFile(projectId: string) {
  return path.join(projectDir(projectId), 'index.json');
}

function entryFile(projectId: string, historyId: string) {
  return path.join(projectDir(projectId), `${safe(historyId)}.json`);
}

async function atomicWrite(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, value, 'utf8');
    const file = await fs.open(temp, 'r+');
    try { await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, filePath);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function fingerprint(project: CaptionProject) {
  return crypto.createHash('sha1').update(JSON.stringify({
    captions: project.captions,
    transcript: project.transcript,
    mode: project.mode,
    context: project.transcriptionContext,
  })).digest('hex');
}

function mediaVersion(media: CaptionProject['media']): ExpectedMedia {
  return { filename: media.filename, size: media.size };
}

function toIndex(entry: StoredHistoryEntry): HistoryIndexEntry {
  const { snapshot: _snapshot, ...index } = entry;
  return { ...index, media: mediaVersion(entry.snapshot.media) };
}

function summary(entry: HistoryIndexEntry | StoredHistoryEntry): ProjectHistoryEntry {
  const { fingerprint: _fingerprint, media: _media, ...rest } = entry as HistoryIndexEntry & Partial<StoredHistoryEntry>;
  if ('snapshot' in rest) {
    const { snapshot: _snapshot, ...publicEntry } = rest;
    return publicEntry as ProjectHistoryEntry;
  }
  return rest as ProjectHistoryEntry;
}

function sameMedia(actual: ExpectedMedia, expected: ExpectedMedia) {
  return actual.filename === expected.filename && actual.size === expected.size;
}

function matchesMedia(entry: StoredHistoryEntry, expectedMedia?: ExpectedMedia) {
  return !expectedMedia
    || sameMedia(mediaVersion(entry.snapshot.media), expectedMedia);
}

function matchesIndexMedia(entry: HistoryIndexEntry, expectedMedia?: ExpectedMedia) {
  return !expectedMedia || Boolean(entry.media && sameMedia(entry.media, expectedMedia));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function migrateLegacy(projectId: string) {
  const legacy = await readJson<StoredHistoryEntry[]>(legacyFile(projectId));
  if (!Array.isArray(legacy) || !legacy.length) return [] as HistoryIndexEntry[];
  const entries = legacy.slice(0, MAX_ENTRIES);
  await fs.mkdir(projectDir(projectId), { recursive: true });
  for (const entry of entries) {
    if (!entry?.id || !entry.snapshot) continue;
    await atomicWrite(entryFile(projectId, entry.id), JSON.stringify(entry));
  }
  const index = entries.filter((entry) => entry?.id && entry.snapshot).map(toIndex);
  await atomicWrite(indexFile(projectId), JSON.stringify(index));
  console.log(`[history] Migrated ${index.length} checkpoint(s) for project ${projectId}; legacy history file preserved.`);
  return index;
}

async function loadIndex(projectId: string): Promise<HistoryIndexEntry[]> {
  const existing = await readJson<HistoryIndexEntry[]>(indexFile(projectId));
  if (Array.isArray(existing)) {
    const index = existing.slice(0, MAX_ENTRIES);
    const missing = index.filter((entry) => !entry.media);
    if (!missing.length) return index;

    // v0.7.10 indexes did not record media ownership. Enrich only those legacy
    // summaries once, then future current-generation lists remain index-only.
    const byId = new Map(index.map((entry) => [entry.id, entry]));
    let changed = false;
    await Promise.all(missing.map(async (entry) => {
      const stored = await readJson<StoredHistoryEntry>(entryFile(projectId, entry.id));
      if (!stored?.snapshot?.media) return;
      byId.set(entry.id, { ...entry, media: mediaVersion(stored.snapshot.media) });
      changed = true;
    }));
    const enriched = index.map((entry) => byId.get(entry.id) || entry);
    if (changed) await persistIndex(projectId, enriched);
    return enriched;
  }
  return migrateLegacy(projectId);
}

async function persistIndex(projectId: string, index: HistoryIndexEntry[]) {
  await atomicWrite(indexFile(projectId), JSON.stringify(index.slice(0, MAX_ENTRIES)));
}

function queueHistory<T>(projectId: string, operation: () => Promise<T>) {
  const previous = historyQueues.get(projectId) || Promise.resolve();
  const task = previous.then(operation);
  const tracked = task.then(() => undefined, () => undefined);
  historyQueues.set(projectId, tracked);
  tracked.finally(() => {
    if (historyQueues.get(projectId) === tracked) historyQueues.delete(projectId);
  });
  return task;
}

async function checkpointInternal(project: CaptionProject, label: string, source: HistorySource, options?: { dedupeWindowMs?: number }) {
  const index = await loadIndex(project.id);
  const hash = fingerprint(project);
  const newestIndex = index.findIndex((entry) => matchesIndexMedia(entry, project.media));
  const newest = newestIndex >= 0 ? index[newestIndex] : undefined;
  const dedupeWindowMs = options?.dedupeWindowMs ?? 0;
  if (newest?.fingerprint === hash) return summary(newest);

  if (dedupeWindowMs > 0 && newest?.source === source && Date.now() - Date.parse(newest.createdAt) < dedupeWindowMs) {
    const updated: StoredHistoryEntry = {
      ...newest,
      createdAt: new Date().toISOString(),
      label,
      fingerprint: hash,
      snapshot: structuredClone(project),
      captionCount: project.captions.length,
      approvedCount: project.captions.filter((caption) => caption.approved).length,
      textLockedCount: project.captions.filter((caption) => caption.textLocked).length,
      timingLockedCount: project.captions.filter((caption) => caption.timingLocked).length,
    };
    index[newestIndex] = toIndex(updated);
    await atomicWrite(entryFile(project.id, updated.id), JSON.stringify(updated));
    await persistIndex(project.id, index);
    return summary(updated);
  }

  const entry: StoredHistoryEntry = {
    id: nanoid(12),
    projectId: project.id,
    createdAt: new Date().toISOString(),
    label: label.slice(0, 120),
    source,
    captionCount: project.captions.length,
    approvedCount: project.captions.filter((caption) => caption.approved).length,
    textLockedCount: project.captions.filter((caption) => caption.textLocked).length,
    timingLockedCount: project.captions.filter((caption) => caption.timingLocked).length,
    fingerprint: hash,
    snapshot: structuredClone(project),
  };
  index.unshift(toIndex(entry));
  const removed = index.splice(MAX_ENTRIES);
  await atomicWrite(entryFile(project.id, entry.id), JSON.stringify(entry));
  await persistIndex(project.id, index);
  await Promise.all(removed.map((old) => fs.rm(entryFile(project.id, old.id), { force: true })));
  return summary(entry);
}

// Recovery and preserved replacement histories live in immutable media namespaces.
// Preparing one before the project swap never hides or prunes the active history.
function mediaArchiveDir(projectId: string, media: ExpectedMedia) {
  const version = crypto.createHash('sha256').update(JSON.stringify(mediaVersion(media as CaptionProject['media']))).digest('hex');
  return path.join(projectDir(projectId), 'media-versions', version);
}

async function archivedIndex(projectId: string, media: ExpectedMedia): Promise<HistoryIndexEntry[]> {
  const file = path.join(mediaArchiveDir(projectId, media), 'index.json');
  // Ordinary projects retain the index-only fast path without probing snapshot
  // JSON files; replacement archives also expose summaries separately.
  if (!await fs.stat(file).then((stat) => stat.isFile()).catch(() => false)) return [];
  const index = await readJson<HistoryIndexEntry[]>(file);
  return Array.isArray(index) ? index.filter((entry) => matchesIndexMedia(entry, media)) : [];
}

async function archivedEntries(projectId: string, media: ExpectedMedia): Promise<StoredHistoryEntry[]> {
  const entries = await readJson<StoredHistoryEntry[]>(path.join(mediaArchiveDir(projectId, media), 'entries.json'));
  return Array.isArray(entries) ? entries.filter((entry) => entry?.snapshot?.id === projectId && matchesMedia(entry, media)) : [];
}

async function strictJson<T>(file: string, optional = false): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Project history could not be backed up safely. The existing project was kept.');
  }
}

function validateHistorySnapshot(entry: StoredHistoryEntry, projectId: string) {
  if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.id)
    || entry.projectId !== projectId || entry.snapshot?.id !== projectId || !entry.snapshot.media
    || typeof entry.snapshot.media.filename !== 'string' || !Number.isFinite(entry.snapshot.media.size)
    || !Array.isArray(entry.snapshot.captions)) throw new Error('A saved history checkpoint is unavailable or damaged. The existing project was kept.');
}

async function entriesForMedia(projectId: string, media: ExpectedMedia): Promise<StoredHistoryEntry[]> {
  // This is a transaction backup, unlike the fail-open browsing projection.
  // Never silently discard a checkpoint on an I/O or parse error then retire it.
  const byId = new Map<string, StoredHistoryEntry>();
  const archiveDirectory = mediaArchiveDir(projectId, media);
  const archiveExists = await fs.stat(archiveDirectory).then((stat) => stat.isDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (archiveExists) {
    const archived = await strictJson<StoredHistoryEntry[]>(path.join(archiveDirectory, 'entries.json'));
    if (!Array.isArray(archived)) throw new Error('Saved media history could not be backed up safely.');
    for (const entry of archived) {
      validateHistorySnapshot(entry, projectId);
      if (!matchesMedia(entry, media)) throw new Error('Saved media history does not match its media version.');
      byId.set(entry.id, entry);
    }
  }
  const index = await strictJson<HistoryIndexEntry[]>(indexFile(projectId), true);
  if (index !== null) {
    if (!Array.isArray(index)) throw new Error('Project history could not be backed up safely.');
    for (const metadata of index) {
      if (!metadata || typeof metadata.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(metadata.id)) throw new Error('Project history contains an invalid checkpoint.');
      if (metadata.media && !sameMedia(metadata.media, media)) continue;
      const entry = await strictJson<StoredHistoryEntry>(entryFile(projectId, metadata.id));
      validateHistorySnapshot(entry!, projectId);
      if (matchesMedia(entry!, media)) byId.set(entry!.id, entry!);
    }
  } else {
    const legacy = await strictJson<StoredHistoryEntry[]>(legacyFile(projectId), true);
    if (legacy !== null && !Array.isArray(legacy)) throw new Error('Legacy project history could not be backed up safely.');
    for (const entry of legacy || []) {
      validateHistorySnapshot(entry, projectId);
      if (matchesMedia(entry, media)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_ENTRIES);
}

export const historyStore = {
  checkpoint(project: CaptionProject, label: string, source: HistorySource, options?: { dedupeWindowMs?: number }) {
    return queueHistory(project.id, () => checkpointInternal(project, label, source, options));
  },

  list(projectId: string, expectedMedia?: ExpectedMedia) {
    return queueHistory(projectId, async () => {
      const index = await loadIndex(projectId);
      if (!expectedMedia) return index.map(summary);
      const archived = await archivedIndex(projectId, expectedMedia);
      const byId = new Map(archived.map((entry) => [entry.id, summary(entry)]));
      for (const entry of index.filter((item) => matchesIndexMedia(item, expectedMedia))) byId.set(entry.id, summary(entry));
      return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_ENTRIES);
    });
  },

  get(projectId: string, historyId: string, expectedMedia?: ExpectedMedia) {
    return queueHistory(projectId, async () => {
      const index = await loadIndex(projectId);
      const indexed = index.find((entry) => entry.id === historyId);
      if (indexed && (!expectedMedia || !indexed.media || matchesIndexMedia(indexed, expectedMedia))) {
        const entry = await readJson<StoredHistoryEntry>(entryFile(projectId, historyId));
        if (entry && matchesMedia(entry, expectedMedia)) return entry;
      }
      return expectedMedia ? (await archivedEntries(projectId, expectedMedia)).find((entry) => entry.id === historyId) || null : null;
    });
  },

  exportForMedia(projectId: string, media: ExpectedMedia) {
    return queueHistory(projectId, () => entriesForMedia(projectId, media));
  },

  prepareMediaVersion(projectId: string, media: CaptionProject['media'], entries: StoredHistoryEntry[]) {
    return queueHistory(projectId, async () => {
      const rebased = entries.filter((entry) => entry?.snapshot?.id === projectId).map((entry) => ({
        ...structuredClone(entry),
        snapshot: { ...structuredClone(entry.snapshot), media: structuredClone(media), pipelineCache: undefined },
      }));
      await atomicWrite(path.join(mediaArchiveDir(projectId, media), 'entries.json'), JSON.stringify(rebased));
      await atomicWrite(path.join(mediaArchiveDir(projectId, media), 'index.json'), JSON.stringify(rebased.map(toIndex)));
      // The namespace can be new. Flush its ancestors before publishing a
      // project pointer that depends on this history; failures are still precommit.
      if (process.platform !== 'win32') {
        for (const directoryPath of [path.dirname(mediaArchiveDir(projectId, media)), projectDir(projectId), config.historyDir]) {
          const directory = await fs.open(directoryPath, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      }
    });
  },

  removeMediaVersion(projectId: string, media: ExpectedMedia) {
    return queueHistory(projectId, async () => {
      const index = await loadIndex(projectId);
      const retired = index.filter((entry) => matchesIndexMedia(entry, media));
      await persistIndex(projectId, index.filter((entry) => !matchesIndexMedia(entry, media)));
      const settled = await Promise.allSettled([
        ...retired.map((entry) => fs.rm(entryFile(projectId, entry.id), { force: true })),
        fs.rm(mediaArchiveDir(projectId, media), { recursive: true, force: true }),
      ]);
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  },

  clear(projectId: string) {
    return queueHistory(projectId, async () => {
      const settled = await Promise.allSettled([
        fs.rm(projectDir(projectId), { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
        fs.rm(legacyFile(projectId), { force: true }),
      ]);
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  },
};
