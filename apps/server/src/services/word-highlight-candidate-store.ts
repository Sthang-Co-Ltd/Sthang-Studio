import { randomUUID } from 'node:crypto';
import type { CaptionWordTiming } from '@kcs/shared';
import type { HighlightCueBounds } from './word-highlight-engine.js';

export interface PreparedWordHighlightCandidate {
  projectId: string;
  mediaFingerprint: string;
  captionId: string;
  basis: string;
  dependencies: Record<string, string>;
  inputRevisions: Record<string, string>;
  consulted: string[];
  overlapping: HighlightCueBounds[];
  planDurationMs: number;
  evidenceDurationMs: number;
  beforeTrack: CaptionWordTiming | null;
  track: CaptionWordTiming & { evidence: 2 };
  createdAt: number;
}

export function createWordHighlightCandidateStore(options: {
  maxEntries?: number;
  maxProjectEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  clock?: () => number;
} = {}) {
  const {
    maxEntries = 5_000, maxProjectEntries = 5_000, maxBytes = 32 * 1024 * 1024,
    ttlMs = 30 * 60 * 1_000, clock = Date.now,
  } = options;
  const entries = new Map<string, { value: PreparedWordHighlightCandidate; bytes: number }>();
  let totalBytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    totalBytes -= entry.bytes;
    entries.delete(key);
  }
  function expire(now: number) {
    for (const [key, entry] of entries) if (now - entry.value.createdAt >= ttlMs) remove(key);
  }
  return {
    put(input: Omit<PreparedWordHighlightCandidate, 'createdAt'>): string | undefined {
      const now = clock();
      expire(now);
      const value = { ...input, createdAt: now };
      const json = JSON.stringify(value);
      // Estimate both string storage and retained object/entry overhead.
      const bytes = json.length * 4 + 256;
      if (bytes > maxBytes || maxEntries < 1 || maxProjectEntries < 1) return undefined;
      const projectKeys = [...entries].filter(([, entry]) => entry.value.projectId === input.projectId).map(([key]) => key);
      for (const key of projectKeys.slice(0, Math.max(0, projectKeys.length - maxProjectEntries + 1))) remove(key);
      for (const key of entries.keys()) {
        if (entries.size < maxEntries && totalBytes + bytes <= maxBytes) break;
        remove(key);
      }
      const key = randomUUID();
      entries.set(key, { value: structuredClone(value), bytes });
      totalBytes += bytes;
      return key;
    },
    get(key: string): PreparedWordHighlightCandidate | undefined {
      expire(clock());
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.value);
    },
    invalidateProject(projectId: string): void {
      for (const [key, { value }] of entries) if (value.projectId === projectId) remove(key);
    },
  };
}

export const wordHighlightCandidateStore = createWordHighlightCandidateStore();
