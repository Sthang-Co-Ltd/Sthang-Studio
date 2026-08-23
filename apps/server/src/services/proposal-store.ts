import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject, CaptionSegment, RegenerationProposal, TimedToken, TimingDiagnostics, TranscriptResult } from '@kcs/shared';
import { config } from '../config.js';

export interface StoredRegenerationProposal {
  summary: RegenerationProposal;
  sourceUpdatedAt: string;
  originalCaptions: CaptionSegment[];
  proposedCaptions: CaptionSegment[];
  proposedTokens: TimedToken[];
  proposedTranscript: TranscriptResult;
  proposedTiming: TimingDiagnostics;
  context: CaptionProject['transcriptionContext'];
}

function fileFor(id: string) {
  return path.join(config.proposalDir, `${id}.json`);
}

/**
 * v0.7.3 added live A/B preview metadata to the public proposal summary.
 * Proposals are intentionally persisted so a user can reopen them from Jobs,
 * therefore older v0.7.x proposal files must remain readable after upgrade.
 */
function normalizeStoredProposal(value: StoredRegenerationProposal): StoredRegenerationProposal {
  const summary = value.summary as RegenerationProposal & Partial<Pick<
    RegenerationProposal,
    'currentCaptions' | 'proposedCaptions' | 'passNumber' | 'strategy'
  >>;
  const startMs = Number.isFinite(summary.startMs) ? summary.startMs : 0;
  const endMs = Number.isFinite(summary.endMs) ? summary.endMs : Number.POSITIVE_INFINITY;
  const inRange = (caption: CaptionSegment) => caption.endMs > startMs && caption.startMs < endMs;

  summary.currentCaptions = Array.isArray(summary.currentCaptions)
    ? summary.currentCaptions
    : (value.originalCaptions || []).filter(inRange);
  summary.proposedCaptions = Array.isArray(summary.proposedCaptions)
    ? summary.proposedCaptions
    : (value.proposedCaptions || []).filter(inRange);
  summary.passNumber = Number.isFinite(summary.passNumber) && summary.passNumber > 0
    ? Math.round(summary.passNumber)
    : 1;
  summary.strategy = summary.strategy || 'standard';
  value.summary = summary as RegenerationProposal;
  return value;
}

export const proposalStore = {
  async save(value: StoredRegenerationProposal) {
    await fs.mkdir(config.proposalDir, { recursive: true });
    const normalized = normalizeStoredProposal(value);
    await fs.writeFile(fileFor(normalized.summary.id), JSON.stringify(normalized, null, 2), 'utf8');
    return normalized.summary;
  },

  async get(id: string): Promise<StoredRegenerationProposal | null> {
    try {
      const value = normalizeStoredProposal(JSON.parse(await fs.readFile(fileFor(id), 'utf8')) as StoredRegenerationProposal);
      if (Date.parse(value.summary.expiresAt) < Date.now()) {
        await fs.rm(fileFor(id), { force: true });
        return null;
      }
      return value;
    } catch {
      return null;
    }
  },

  async remove(id: string) {
    await fs.rm(fileFor(id), { force: true });
  },


  async removeProject(projectId: string) {
    try {
      const files = await fs.readdir(config.proposalDir);
      await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
        try {
          const full = path.join(config.proposalDir, file);
          const value = JSON.parse(await fs.readFile(full, 'utf8')) as StoredRegenerationProposal;
          if (value.summary.projectId === projectId) await fs.rm(full, { force: true });
        } catch { /* ignore malformed/vanished proposal */ }
      }));
    } catch { /* directory optional */ }
  },

  async cleanup() {
    try {
      const files = await fs.readdir(config.proposalDir);
      await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
        try {
          const full = path.join(config.proposalDir, file);
          const value = JSON.parse(await fs.readFile(full, 'utf8')) as StoredRegenerationProposal;
          if (Date.parse(value.summary.expiresAt) < Date.now()) await fs.rm(full, { force: true });
        } catch { /* ignore malformed/vanished proposal */ }
      }));
    } catch { /* directory optional */ }
  },
};
