import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { invalidateProjectCache } from './cache.js';
import { contributionStore } from './contribution-store.js';
import { historyStore } from './history-store.js';
import { jobAdmission, JobAdmissionError } from './job-admission.js';
import { jobStore } from './job-store.js';
import { MediaPreviewError, withMediaPreviewDrain } from './media-preview.js';
import { clearRetiredMediaSources } from './media-replacement.js';
import { profileStore } from './profile-store.js';
import { proposalStore } from './proposal-store.js';
import { ProjectBinError, store } from './store.js';

export class ProjectPurgeIncompleteError extends Error {
  constructor() {
    super('Studio could not finish permanent removal. It will retry automatically.');
  }
}

export function withProjectBinAdmission<T>(id: string, operation: () => Promise<T>) {
  return jobAdmission.changeProjectMedia(id, () => jobStore.hasActiveForProject(id), operation);
}

export async function moveProjectToBin(id: string) {
  return withProjectBinAdmission(id, () => store.moveToBin(id, undefined, async () => {
    jobStore.notifyProjectVisibilityChanged();
    await contributionStore.removeProject(id);
  }));
}

export async function restoreProjectFromBin(id: string, instanceId: string) {
  return withProjectBinAdmission(id, async () => {
    // Also settle discarded clips after a crash or storage failure during the move.
    const project = await store.restoreFromBin(id, instanceId, undefined, () => contributionStore.removeProject(id));
    jobStore.notifyProjectVisibilityChanged();
    return project;
  });
}

export async function purgeProject(id: string, options: { instanceId?: string; expiredBy?: number }) {
  try {
    await store.initialize();
    if (store.migrationBlocksDeletion() || !jobStore.historyIsAvailable()) throw new ProjectBinError('storage_blocked');
    await withProjectBinAdmission(id, () => store.purgeBinnedProject(id, options,
      (operation) => withMediaPreviewDrain(id, operation),
      async ({ filename, ownsUpload }) => {
        const removeUpload = async (name: string) => {
          if (ownsUpload(name)) await fs.rm(path.join(config.uploadDir, name), { force: true });
          else console.warn('[project bin] Kept a shared or unverified source file.');
        };
        await removeUpload(filename);
        await invalidateProjectCache(id);
        await clearRetiredMediaSources(id, removeUpload);
        await historyStore.clear(id);
        if ((await proposalStore.removeProject(id, { strict: true })).failed) throw new ProjectPurgeIncompleteError();
        await jobStore.removeProject(id);
        await contributionStore.removeProject(id);
        await profileStore.removeProjectCorrectionEvents(id);
      },
    ));
  } catch (error) {
    if (error instanceof ProjectBinError || error instanceof JobAdmissionError || error instanceof MediaPreviewError) throw error;
    throw new ProjectPurgeIncompleteError();
  }
}

let sweeping = false;
let sweepInterval: NodeJS.Timeout | undefined;

export async function sweepProjectBin(now = Date.now()) {
  if (sweeping) return;
  sweeping = true;
  try {
    await store.initialize();
    if (store.migrationBlocksDeletion()) return;
    for (const { id, instanceId, started } of await store.listPurgeCandidates(now)) {
      try { await purgeProject(id, { instanceId, expiredBy: started ? undefined : now }); }
      catch (error) {
        const code = error instanceof ProjectBinError ? error.code : error instanceof JobAdmissionError ? 'job_active' : 'purge_incomplete';
        console.warn(`[project bin] Sweep could not remove a project (${code}).`);
      }
    }
  } catch {
    console.warn('[project bin] Sweep could not read saved projects. Files were kept.');
  } finally {
    sweeping = false;
  }
}

export function startProjectBinSweep() {
  if (sweepInterval) return;
  void sweepProjectBin();
  sweepInterval = setInterval(() => void sweepProjectBin(), 6 * 60 * 60 * 1000).unref();
}
