import type { CaptionAppearance } from '@kcs/shared';
import { api } from './api';

const queues = new Map<string, Promise<boolean>>();
const lastResults = new Map<string, boolean>();
const latestSnapshots = new Map<string, CaptionAppearance>();

export function queueCaptionAppearanceSave(projectId: string, appearance: CaptionAppearance): Promise<boolean> {
  const previous = queues.get(projectId) || Promise.resolve(lastResults.get(projectId) ?? true);
  const snapshot = { ...appearance };
  latestSnapshots.set(projectId, snapshot);

  const execute = async () => {
    try {
      await api.saveCaptionAppearance(projectId, snapshot);
      lastResults.set(projectId, true);
      return true;
    } catch {
      lastResults.set(projectId, false);
      return false;
    }
  };

  const task = previous.then(execute, execute);
  queues.set(projectId, task);
  void task.finally(() => {
    if (queues.get(projectId) === task) queues.delete(projectId);
  });
  return task;
}

export async function waitForCaptionAppearanceSaves(projectId: string): Promise<boolean> {
  const pending = queues.get(projectId);
  if (pending) return pending;
  return lastResults.get(projectId) ?? true;
}

export function recoverUnsavedCaptionAppearance(projectId: string): CaptionAppearance | null {
  if (lastResults.get(projectId) !== false) return null;
  const snapshot = latestSnapshots.get(projectId);
  return snapshot ? { ...snapshot } : null;
}
