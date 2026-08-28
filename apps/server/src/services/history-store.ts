import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { CaptionProject, HistorySource, ProjectHistoryEntry } from '@kcs/shared';
import { config } from '../config.js';

interface StoredHistoryEntry extends ProjectHistoryEntry {
  fingerprint: string;
  snapshot: CaptionProject;
}

type HistoryIndexEntry = Omit<StoredHistoryEntry, 'snapshot'>;

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
    await fs.rename(temp, filePath);
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

function toIndex(entry: StoredHistoryEntry): HistoryIndexEntry {
  const { snapshot: _snapshot, ...index } = entry;
  return index;
}

function summary(entry: HistoryIndexEntry | StoredHistoryEntry): ProjectHistoryEntry {
  const { fingerprint: _fingerprint, ...rest } = entry;
  if ('snapshot' in rest) {
    const { snapshot: _snapshot, ...publicEntry } = rest;
    return publicEntry;
  }
  return rest;
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
  if (Array.isArray(existing)) return existing.slice(0, MAX_ENTRIES);
  return migrateLegacy(projectId);
}

async function persistIndex(projectId: string, index: HistoryIndexEntry[]) {
  await atomicWrite(indexFile(projectId), JSON.stringify(index.slice(0, MAX_ENTRIES)));
}

function queueCheckpoint<T>(projectId: string, operation: () => Promise<T>) {
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
  const newest = index[0];
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
    index[0] = toIndex(updated);
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

export const historyStore = {
  checkpoint(project: CaptionProject, label: string, source: HistorySource, options?: { dedupeWindowMs?: number }) {
    return queueCheckpoint(project.id, () => checkpointInternal(project, label, source, options));
  },

  async list(projectId: string) {
    const pending = historyQueues.get(projectId);
    if (pending) await pending;
    return (await loadIndex(projectId)).map(summary);
  },

  async get(projectId: string, historyId: string) {
    const pending = historyQueues.get(projectId);
    if (pending) await pending;
    const index = await loadIndex(projectId);
    if (!index.some((entry) => entry.id === historyId)) return null;
    return readJson<StoredHistoryEntry>(entryFile(projectId, historyId));
  },

  async clear(projectId: string) {
    const pending = historyQueues.get(projectId);
    if (pending) await pending;
    await Promise.all([
      fs.rm(projectDir(projectId), { recursive: true, force: true }),
      fs.rm(legacyFile(projectId), { force: true }),
    ]);
  },
};
