import type { CaptionAppearance } from '@kcs/shared';
import { api } from './api';

const queues = new Map<string, Promise<boolean>>();
const lastResults = new Map<string, boolean>();

export function queueCaptionAppearanceSave(projectId: string, appearance: CaptionAppearance): Promise<boolean> {
  const previous = queues.get(projectId) || Promise.resolve(lastResults.get(projectId) ?? true);
  const snapshot = { ...appearance };
  const task = previous.then(async () => {
    try {
      await api.saveCaptionAppearance(projectId, snapshot);
      lastResults.set(projectId, true);
      return true;
    } catch {
      lastResults.set(projectId, false);
      return false;
    }
  }, async () => {
    try {
      await api.saveCaptionAppearance(projectId, snapshot);
      lastResults.set(projectId, true);
      return true;
    } catch {
      lastResults.set(projectId, false);
      return false;
    }
  });
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
