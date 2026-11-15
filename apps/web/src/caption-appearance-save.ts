import { normalizeCaptionAppearance, type CaptionAppearance, type CaptionProject } from '@kcs/shared';
import { api, ApiRequestError } from './api';

type MediaIdentity = Pick<CaptionProject['media'], 'filename' | 'size'>;
export interface CaptionAppearanceSaveState {
  readonly revision: number;
  readonly status: 'saved' | 'pending' | 'saving' | 'error';
  readonly appearance: Readonly<CaptionAppearance> | null;
  /** The saved look this editor actually adopted, advanced only by its own ACK. */
  readonly basis: Readonly<CaptionAppearance> | null;
  readonly conflict: boolean;
}
const EMPTY_STATE: CaptionAppearanceSaveState = Object.freeze({ revision: 0, status: 'saved', appearance: null, basis: null, conflict: false });
const queues = new Map<string, Promise<boolean>>();
const states = new Map<string, CaptionAppearanceSaveState>();
const writes = new Map<string, { revision: number; task: Promise<boolean> }>();
const latestMedia = new Map<string, string>();
const listeners = new Set<() => void>();
const mediaKey = (projectId: string, media: MediaIdentity) => JSON.stringify([projectId, media.filename, media.size]);

function publish(key: string, state: CaptionAppearanceSaveState) {
  states.set(key, Object.freeze(state));
  for (const listener of listeners) listener();
}

export function subscribeCaptionAppearanceSaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCaptionAppearanceSaveState(projectId: string | null, media?: MediaIdentity): CaptionAppearanceSaveState {
  if (!projectId) return EMPTY_STATE;
  const key = media ? mediaKey(projectId, media) : latestMedia.get(projectId);
  return key ? states.get(key) ?? EMPTY_STATE : EMPTY_STATE;
}

/** Only a look actually adopted by the editor may authorize its next write.
 * Reading another project field cannot rebase an outstanding appearance draft. */
export function observeSavedCaptionAppearance(projectId: string, appearance: CaptionAppearance, media: MediaIdentity): void {
  const key = mediaKey(projectId, media);
  const previous = states.get(key) ?? EMPTY_STATE;
  if (previous.status !== 'saved') return;
  const basis = Object.freeze(normalizeCaptionAppearance(appearance));
  if (JSON.stringify(previous.basis) === JSON.stringify(basis)) return;
  latestMedia.set(projectId, key);
  publish(key, { ...previous, appearance: basis, basis, conflict: false });
}

/** Record the actual edit immediately, including its debounce window. Save ACKs
 * may settle later, but only the matching revision can declare this draft saved. */
export function markCaptionAppearanceDraft(projectId: string, appearance: CaptionAppearance, media: MediaIdentity, adoptedBasis?: CaptionAppearance): CaptionAppearanceSaveState {
  const key = mediaKey(projectId, media);
  latestMedia.set(projectId, key);
  const previous = states.get(key) ?? EMPTY_STATE;
  // A previously saved value may have been replaced by another tab. Only an
  // outstanding local draft proves that an identical new request is redundant.
  if (previous.status !== 'saved' && JSON.stringify(previous.appearance) === JSON.stringify(appearance)) return previous;
  const basis = previous.status === 'saved' && adoptedBasis
    ? Object.freeze(normalizeCaptionAppearance(adoptedBasis)) : previous.basis;
  const next: CaptionAppearanceSaveState = {
    revision: previous.revision + 1, status: previous.conflict ? 'error' : 'pending',
    appearance: Object.freeze({ ...appearance }), basis, conflict: previous.conflict,
  };
  publish(key, next);
  return states.get(key)!;
}

/** Reserve the appearance lane while a caption/context save checks and writes
 * its revision. A local appearance save must not invalidate that check between
 * GET and PUT. Failures here do not change appearance's own save/recovery state. */
export function withCaptionAppearanceBarrier<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) || Promise.resolve(true);
  const task = previous.then(operation);
  const barrier = task.then(() => true, () => true);
  queues.set(projectId, barrier);
  void barrier.then(() => { if (queues.get(projectId) === barrier) queues.delete(projectId); });
  return task;
}

export function queueCaptionAppearanceSave(projectId: string, appearance: CaptionAppearance, expectedMedia: MediaIdentity): Promise<boolean> {
  const snapshot = { ...appearance };
  const source = { filename: expectedMedia.filename, size: expectedMedia.size };
  const key = mediaKey(projectId, source);
  const draft = markCaptionAppearanceDraft(projectId, snapshot, source);
  const existing = writes.get(key);
  if (existing?.revision === draft.revision) return existing.task;
  const previous = queues.get(projectId) || Promise.resolve();
  publish(key, { ...draft, status: draft.conflict ? 'error' : 'saving' });
  const task = previous.then(async () => {
    let saved = false;
    let conflict = states.get(key)?.conflict ?? false;
    try {
      // A preceding acknowledged write may advance the basis for this queued
      // edit. A failed comparison must never authorize later queued overwrites.
      const basis = states.get(key)?.basis;
      if (!conflict && basis) {
        await api.saveCaptionAppearance(projectId, snapshot, source, { ...basis });
        saved = true;
      }
    } catch (error) {
      conflict = error instanceof ApiRequestError && error.status === 409;
      // Keep the newest draft and its comparison basis for explicit recovery.
    }
    const current = states.get(key);
    if (current) {
      const basis = saved ? Object.freeze(normalizeCaptionAppearance(snapshot)) : current.basis;
      if (current.revision === draft.revision || conflict) {
        publish(key, { ...current, basis, conflict, status: saved && !conflict ? 'saved' : 'error' });
      } else if (saved) {
        // Persist newer drafts against the value that this lane just saved.
        publish(key, { ...current, basis });
      }
    }
    return saved;
  });
  writes.set(key, { revision: draft.revision, task });
  queues.set(projectId, task);
  void task.finally(() => {
    if (queues.get(projectId) === task) queues.delete(projectId);
    if (writes.get(key)?.task === task) writes.delete(key);
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
  return getCaptionAppearanceSaveState(projectId, expectedMedia).status === 'saved';
}

export function recoverUnsavedCaptionAppearance(projectId: string, expectedMedia: MediaIdentity): CaptionAppearance | null {
  const state = getCaptionAppearanceSaveState(projectId, expectedMedia);
  return state.status !== 'saved' && state.appearance ? { ...state.appearance } : null;
}

/** Header Save and safe navigation work even after the Appearance tool closes. */
export async function flushCaptionAppearanceSaves(projectId: string, expectedMedia: MediaIdentity): Promise<boolean> {
  const state = getCaptionAppearanceSaveState(projectId, expectedMedia);
  if (state.status !== 'saved' && state.appearance) {
    await queueCaptionAppearanceSave(projectId, { ...state.appearance }, expectedMedia);
  }
  return waitForCaptionAppearanceSaves(projectId, expectedMedia);
}
