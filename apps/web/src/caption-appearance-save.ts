import type { CaptionAppearance, CaptionProject } from '@kcs/shared';
import { api } from './api';

type MediaIdentity = Pick<CaptionProject['media'], 'filename' | 'size'>;
const queues = new Map<string, Promise<boolean>>();
const lastResults = new Map<string, boolean>();
const latestSnapshots = new Map<string, CaptionAppearance>();
const latestMedia = new Map<string, string>();
const mediaKey = (projectId: string, media: MediaIdentity) => JSON.stringify([projectId, media.filename, media.size]);

export function queueCaptionAppearanceSave(projectId: string, appearance: CaptionAppearance, expectedMedia: MediaIdentity): Promise<boolean> {
  const previous = queues.get(projectId) || Promise.resolve();
  const snapshot = { ...appearance };
  const source = { filename: expectedMedia.filename, size: expectedMedia.size };
  const key = mediaKey(projectId, source);
  latestMedia.set(projectId, key);
  latestSnapshots.set(key, snapshot);

  const task = previous.then(async () => {
    try {
      await api.saveCaptionAppearance(projectId, snapshot, source);
      lastResults.set(key, true);
      return true;
    } catch {
      lastResults.set(key, false);
      return false;
    }
  });
  queues.set(projectId, task);
  void task.finally(() => {
    if (queues.get(projectId) === task) queues.delete(projectId);
  });
  return task;
}

export async function waitForCaptionAppearanceSaves(projectId: string, expectedMedia?: MediaIdentity): Promise<boolean> {
  // A debounce/unmount flush may append while the previous save is settling.
  // Wait for the complete project lane, not just its first captured promise.
  let pending: Promise<boolean> | undefined;
  while ((pending = queues.get(projectId))) {
    await pending;
    if (queues.get(projectId) === pending) break;
  }
  const key = expectedMedia ? mediaKey(projectId, expectedMedia) : latestMedia.get(projectId);
  return key ? lastResults.get(key) ?? true : true;
}

export function recoverUnsavedCaptionAppearance(projectId: string, expectedMedia: MediaIdentity): CaptionAppearance | null {
  const key = mediaKey(projectId, expectedMedia);
  if (lastResults.get(key) !== false) return null;
  const snapshot = latestSnapshots.get(key);
  return snapshot ? { ...snapshot } : null;
}
