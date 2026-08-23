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

const MAX_ENTRIES = 36;

function fileFor(projectId: string) {
  return path.join(config.historyDir, `${projectId}.json`);
}

function fingerprint(project: CaptionProject) {
  return crypto.createHash('sha1').update(JSON.stringify({
    captions: project.captions,
    transcript: project.transcript,
    mode: project.mode,
    context: project.transcriptionContext,
  })).digest('hex');
}

async function load(projectId: string): Promise<StoredHistoryEntry[]> {
  try {
    const value = JSON.parse(await fs.readFile(fileFor(projectId), 'utf8')) as StoredHistoryEntry[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function save(projectId: string, entries: StoredHistoryEntry[]) {
  await fs.mkdir(config.historyDir, { recursive: true });
  await fs.writeFile(fileFor(projectId), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), 'utf8');
}

function summary(entry: StoredHistoryEntry): ProjectHistoryEntry {
  const { snapshot: _snapshot, fingerprint: _fingerprint, ...publicEntry } = entry;
  return publicEntry;
}

export const historyStore = {
  async checkpoint(project: CaptionProject, label: string, source: HistorySource, options?: { dedupeWindowMs?: number }) {
    const entries = await load(project.id);
    const hash = fingerprint(project);
    const newest = entries[0];
    const dedupeWindowMs = options?.dedupeWindowMs ?? 0;
    if (newest?.fingerprint === hash) return summary(newest);
    if (dedupeWindowMs > 0 && newest?.source === source && Date.now() - Date.parse(newest.createdAt) < dedupeWindowMs) {
      entries[0] = {
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
      await save(project.id, entries);
      return summary(entries[0]);
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
    entries.unshift(entry);
    await save(project.id, entries);
    return summary(entry);
  },

  async list(projectId: string) {
    return (await load(projectId)).map(summary);
  },

  async get(projectId: string, historyId: string) {
    return (await load(projectId)).find((entry) => entry.id === historyId) ?? null;
  },

  async clear(projectId: string) {
    await fs.rm(fileFor(projectId), { force: true });
  },
};
