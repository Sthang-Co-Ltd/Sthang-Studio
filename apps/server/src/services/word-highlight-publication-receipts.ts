import type { PreparedWordHighlightApplyResult, WordHighlightPublicationIntent } from './caption-word-batch.js';

export interface WordHighlightPublicationReceipt {
  requestId: string;
  projectId: string;
  mediaFingerprint: string;
  intent: WordHighlightPublicationIntent;
  epoch: string;
  applied: PreparedWordHighlightApplyResult['applied'];
  committedAt: number;
}

const TTL_MS = 30 * 60 * 1_000;
const MAX_ENTRIES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const entries = new Map<string, { receipt: WordHighlightPublicationReceipt; bytes: number }>();
let totalBytes = 0;

function remove(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  entries.delete(key);
}

function expire(now: number) {
  for (const [key, { receipt }] of entries) if (now - receipt.committedAt >= TTL_MS) remove(key);
}

function key(projectId: string, fingerprint: string, requestId: string) {
  return JSON.stringify([projectId, fingerprint, requestId]);
}

export const wordHighlightPublicationReceipts = {
  put(receipt: WordHighlightPublicationReceipt) {
    expire(receipt.committedAt);
    const bytes = JSON.stringify(receipt).length * 4 + 256;
    if (bytes > MAX_BYTES) return;
    const id = key(receipt.projectId, receipt.mediaFingerprint, receipt.requestId);
    remove(id);
    for (const oldest of entries.keys()) {
      if (entries.size < MAX_ENTRIES && totalBytes + bytes <= MAX_BYTES) break;
      remove(oldest);
    }
    entries.set(id, { receipt: structuredClone(receipt), bytes });
    totalBytes += bytes;
  },

  get(projectId: string, fingerprint: string, requestId: string) {
    expire(Date.now());
    const entry = entries.get(key(projectId, fingerprint, requestId));
    return entry && structuredClone(entry.receipt);
  },

  invalidateProject(projectId: string) {
    for (const [key, { receipt }] of entries) if (receipt.projectId === projectId) remove(key);
  },
};
