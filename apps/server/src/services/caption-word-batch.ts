import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  compileHighlightPlan,
  hasWordTimingEvidence,
  resolveCaptionWordTiming,
  validateMarkedWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type WordHighlightFollow,
} from '@kcs/shared';
import { mediaFingerprint } from './cache.js';
import { captionWordTimingRevision, hydrateProjectWordTimings } from './caption-word-timing.js';
import { historyStore } from './history-store.js';
import { store } from './store.js';
import { wordHighlightCandidateStore, type PreparedWordHighlightCandidate } from './word-highlight-candidate-store.js';
import {
  guardPreparedHighlightTracks, highlightInputRevision, orderHighlightCaptions, overlappingHighlightCues, planHighlightWindows,
  sameSavedHighlightTrack,
} from './word-highlight-engine.js';

type ExpectedMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;

export interface CaptionWordBatchChange {
  before: CaptionSegment;
  after: CaptionSegment;
}

export interface CaptionWordBatchApplyResult {
  project: CaptionProject;
  appliedCount: number;
}

export type CaptionWordBatchAction = 'apply' | 'undo';
export type WordHighlightPublicationIntent = 'apply' | 'follow';
export interface PreparedWordHighlightApplyResult extends CaptionWordBatchApplyResult {
  applied: Array<CaptionWordBatchChange & { id: string }>;
  unchanged: string[];
  kept: string[];
}

type PreparedConflict =
  | { code: 'WORD_HIGHLIGHT_INTENT_CHANGED' }
  | { code: 'WORD_HIGHLIGHT_PREPARED_EXPIRED'; expiredKeys: string[] }
  | { code: 'WORD_HIGHLIGHT_CONTEXT_CHANGED'; changedIds: string[] };

export class PreparedWordHighlightConflictError extends Error {
  constructor(readonly details: PreparedConflict) {
    super({
      WORD_HIGHLIGHT_INTENT_CHANGED: 'The source media or word highlight setting changed.',
      WORD_HIGHLIGHT_PREPARED_EXPIRED: 'Some prepared word timings expired. Prepare those captions again.',
      WORD_HIGHLIGHT_CONTEXT_CHANGED: 'Some captions or nearby timings changed. Prepare those captions again.',
    }[details.code]);
    this.name = 'PreparedWordHighlightConflictError';
  }
}

export class CaptionWordBatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionWordBatchInputError';
  }
}

export class CaptionWordBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionWordBatchConflictError';
  }
}

export class CaptionWordBatchNotFoundError extends Error {
  constructor(message = 'Project not found') {
    super(message);
    this.name = 'CaptionWordBatchNotFoundError';
  }
}

const MAX_BATCH_CHANGES = 1_000;
const MAX_PREPARED_KEYS = 5_000;
const CAPTION_KEYS = new Set([
  'id', 'startMs', 'endMs', 'text', 'wordTiming', 'confidence', 'timingQuality',
  'timingSource', 'approved', 'textLocked', 'timingLocked',
]);

interface CaptionWordBatchDependencies {
  store: Pick<typeof store, 'withProjectWrite'>;
  checkpoint: typeof historyStore.checkpoint;
}

const defaultDependencies: CaptionWordBatchDependencies = {
  store,
  checkpoint: historyStore.checkpoint.bind(historyStore),
};

function hasOnlyCaptionKeys(value: Record<string, unknown>) {
  return Object.keys(value).every((key) => CAPTION_KEYS.has(key));
}

function validOptionalBoolean(value: unknown) {
  return value === undefined || typeof value === 'boolean';
}

function parseCaption(value: unknown, label: string): CaptionSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptionWordBatchInputError(`${label} must be a caption.`);
  }
  const caption = value as Record<string, unknown>;
  if (!hasOnlyCaptionKeys(caption)) throw new CaptionWordBatchInputError(`${label} contains unsupported caption fields.`);
  if (typeof caption.id !== 'string' || !caption.id.trim()) throw new CaptionWordBatchInputError(`${label} needs a caption id.`);
  if (typeof caption.text !== 'string') throw new CaptionWordBatchInputError(`${label} caption text is invalid.`);
  if (typeof caption.startMs !== 'number' || !Number.isFinite(caption.startMs)
    || typeof caption.endMs !== 'number' || !Number.isFinite(caption.endMs)
    || caption.endMs <= caption.startMs) {
    throw new CaptionWordBatchInputError(`${label} caption timing is invalid.`);
  }
  if (!validOptionalBoolean(caption.approved)
    || !validOptionalBoolean(caption.textLocked)
    || !validOptionalBoolean(caption.timingLocked)) {
    throw new CaptionWordBatchInputError(`${label} caption flags are invalid.`);
  }
  if (caption.wordTiming === null || (caption.wordTiming !== undefined && typeof caption.wordTiming !== 'object')) {
    throw new CaptionWordBatchInputError(`${label} word timing is malformed.`);
  }
  return value as CaptionSegment;
}

function stableNonBatchFields(caption: CaptionSegment) {
  return {
    id: caption.id,
    startMs: caption.startMs,
    endMs: caption.endMs,
    text: caption.text,
    confidence: caption.confidence ?? null,
    timingQuality: caption.timingQuality ?? null,
    timingSource: caption.timingSource ?? null,
    approved: caption.approved ?? null,
    textLocked: caption.textLocked ?? null,
    timingLocked: caption.timingLocked ?? null,
  };
}

function sameNonBatchFields(before: CaptionSegment, after: CaptionSegment) {
  return JSON.stringify(stableNonBatchFields(before)) === JSON.stringify(stableNonBatchFields(after));
}

function parseChanges(value: unknown, limit = MAX_BATCH_CHANGES): CaptionWordBatchChange[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new CaptionWordBatchInputError('Prepared word timing changes are required.');
  }
  if (value.length > limit) {
    throw new CaptionWordBatchInputError(`Prepared word timing changes are limited to ${limit} captions at a time.`);
  }

  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CaptionWordBatchInputError(`Change ${index + 1} is invalid.`);
    }
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'before' && key !== 'after')) {
      throw new CaptionWordBatchInputError(`Change ${index + 1} contains unsupported fields.`);
    }
    const before = parseCaption(record.before, `Change ${index + 1} before`);
    const after = parseCaption(record.after, `Change ${index + 1} after`);
    if (before.id !== after.id) throw new CaptionWordBatchInputError(`Change ${index + 1} cannot replace a different caption.`);
    if (ids.has(before.id)) throw new CaptionWordBatchInputError('Each caption may appear only once in a word timing batch.');
    ids.add(before.id);
    if (!sameNonBatchFields(before, after)) {
      throw new CaptionWordBatchInputError(`Change ${index + 1} may change only word timing.`);
    }
    if (resolveCaptionWordTiming(after).state === 'stale') {
      throw new CaptionWordBatchInputError(`Change ${index + 1} has invalid word timing for its caption text.`);
    }
    return { before, after };
  });
}

function parseExpectedMedia(value: ExpectedMedia): ExpectedMedia {
  if (!value || typeof value.filename !== 'string' || !value.filename
    || typeof value.size !== 'number' || !Number.isFinite(value.size)) {
    throw new CaptionWordBatchInputError('Word timing batch apply requires the media version it was prepared against.');
  }
  return { filename: value.filename, size: Number(value.size) };
}

function parseAction(value: unknown): CaptionWordBatchAction {
  if (value === undefined || value === 'apply') return 'apply';
  if (value === 'undo') return 'undo';
  throw new CaptionWordBatchInputError('Word timing batch action must be apply or undo.');
}

function replaceBatchFields(current: CaptionSegment, after: CaptionSegment): CaptionSegment {
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(after, 'wordTiming') && after.wordTiming !== undefined) {
    next.wordTiming = structuredClone(after.wordTiming);
  } else {
    delete next.wordTiming;
  }
  return next;
}

function matchesMedia(project: CaptionProject, expected: ExpectedMedia) {
  return project.media.filename === expected.filename && project.media.size === expected.size;
}

type SelectedPreparedTrack = Parameters<typeof guardPreparedHighlightTracks>[0][number] & { entry: PreparedWordHighlightCandidate };

function finalPreparedTracks(selected: SelectedPreparedTrack[], order: CaptionSegment[]) {
  const guarded = guardPreparedHighlightTracks(selected, order);
  let hasStronger = false;
  const alternatives = selected.map(({ caption, consulted, entry, track }, index) => {
    const original = { caption, consulted, track };
    // A shared basis is necessary for reuse, but the stronger track also has
    // to support the new candidate's paint and pass the current occurrence guard.
    if (!entry.beforeTrack || entry.beforeTrack.basis !== track.basis) return original;
    const prior = validateMarkedWordTiming(caption.text, entry.beforeTrack, entry.evidenceDurationMs);
    if (!prior.ok) return original;
    const currentPlan = compileHighlightPlan({ ...caption, wordTiming: prior.timing }, 'measured-and-manual');
    const nextPlan = compileHighlightPlan({ ...caption, wordTiming: guarded[index] }, 'measured-and-manual');
    if (currentPlan.paintedUnits <= nextPlan.paintedUnits
      || !nextPlan.spans.every((span) => currentPlan.spans.some((before) => isDeepStrictEqual(before, span)))) return original;
    hasStronger = true;
    return { caption, consulted, track: prior.timing };
  });
  if (!hasStronger) return guarded;
  const checked = guardPreparedHighlightTracks(alternatives, order);
  // The retained measurements must remain eligible without suppressing evidence
  // that survived the original publication pass for any selected owner.
  return checked.every((track, index) => isDeepStrictEqual(track,
    alternatives[index].track === selected[index].track ? guarded[index] : alternatives[index].track))
    ? checked : guarded;
}

export async function updateWordHighlightFollow(
  projectId: string,
  expectedMedia: ExpectedMedia,
  action: unknown,
  epoch: unknown,
  projectStore: CaptionWordBatchDependencies['store'] = store,
): Promise<{ wordHighlightFollow: WordHighlightFollow | null; updatedAt: string }> {
  parseExpectedMedia(expectedMedia);
  if ((action !== 'arm' && action !== 'revoke') || (epoch !== undefined && typeof epoch !== 'string')) {
    throw new CaptionWordBatchInputError('Choose whether to arm or revoke word highlighting.');
  }
  return projectStore.withProjectWrite(projectId, async (current, persist) => {
    if (!current) throw new CaptionWordBatchNotFoundError();
    if (!matchesMedia(current, expectedMedia)) {
      throw new PreparedWordHighlightConflictError({ code: 'WORD_HIGHLIGHT_INTENT_CHANGED' });
    }
    const previous = current.wordHighlightFollow;
    if (action === 'revoke' && !previous?.enabled) {
      return { wordHighlightFollow: previous ?? null, updatedAt: current.updatedAt };
    }
    const wordHighlightFollow: WordHighlightFollow = action === 'arm'
      ? { version: 1, enabled: true, mediaFingerprint: mediaFingerprint(current), epoch: randomUUID() }
      : { ...previous!, enabled: false };
    const saved = await persist({ ...current, wordHighlightFollow, updatedAt: new Date().toISOString() });
    return { wordHighlightFollow, updatedAt: saved.updatedAt };
  });
}

export async function applyPreparedWordHighlightBatch(
  projectId: string,
  expectedMedia: ExpectedMedia,
  request: { intent?: unknown; epoch?: unknown; preparedKeys?: unknown },
  dependencies: CaptionWordBatchDependencies & { candidateStore: Pick<typeof wordHighlightCandidateStore, 'get'> } =
    { ...defaultDependencies, candidateStore: wordHighlightCandidateStore },
): Promise<PreparedWordHighlightApplyResult> {
  parseExpectedMedia(expectedMedia);
  const { intent, epoch, preparedKeys } = request;
  if ((intent !== 'apply' && intent !== 'follow') || typeof epoch !== 'string' || !epoch
    || !Array.isArray(preparedKeys) || !preparedKeys.length || preparedKeys.length > MAX_PREPARED_KEYS
    || !preparedKeys.every((key: unknown) => typeof key === 'string' && key.length > 0 && key.length <= 128)
    || new Set(preparedKeys).size !== preparedKeys.length) {
    throw new CaptionWordBatchInputError('Provide a word highlight intent and between 1 and 5,000 distinct prepared keys.');
  }
  return dependencies.store.withProjectWrite(projectId, async (current, persist) => {
    if (!current) throw new CaptionWordBatchNotFoundError();
    const fingerprint = mediaFingerprint(current);
    const follow = current.wordHighlightFollow;
    if (!matchesMedia(current, expectedMedia) || !follow?.enabled || follow.epoch !== epoch || follow.mediaFingerprint !== fingerprint) {
      throw new PreparedWordHighlightConflictError({ code: 'WORD_HIGHLIGHT_INTENT_CHANGED' });
    }

    const expiredKeys: string[] = [];
    const candidates = preparedKeys.flatMap((key: string) => {
      const entry = dependencies.candidateStore.get(key);
      if (entry?.projectId === projectId && entry.mediaFingerprint === fingerprint) return [entry];
      expiredKeys.push(key);
      return [];
    });
    if (expiredKeys.length) throw new PreparedWordHighlightConflictError({ code: 'WORD_HIGHLIGHT_PREPARED_EXPIRED', expiredKeys });
    if (new Set(candidates.map(({ captionId }) => captionId)).size !== candidates.length) {
      throw new CaptionWordBatchInputError('Each caption may appear only once in a word timing batch.');
    }

    const order = orderHighlightCaptions(current.captions);
    const allCues = orderHighlightCaptions(current.captions, true);
    const indices = new Map(order.map(({ id }, index) => [id, index]));
    const inputRevisions = new Map(current.captions.map((caption) => [caption.id, highlightInputRevision(caption)]));
    const changedIds = new Set<string>();
    const kept: string[] = [];
    const selected = candidates.flatMap((entry) => {
      const index = indices.get(entry.captionId);
      if (index === undefined) {
        changedIds.add(entry.captionId);
        return [];
      }
      const caption = order[index];
      const { consulted } = planHighlightWindows(order, index, entry.planDurationMs);
      if (caption.timingLocked || !isDeepStrictEqual(consulted.map(({ id }) => id), entry.consulted)
        || !isDeepStrictEqual(overlappingHighlightCues(caption, allCues), entry.overlapping)
        || Object.entries(entry.inputRevisions).some(([id, revision]) => inputRevisions.get(id) !== revision)) {
        changedIds.add(caption.id);
        return [];
      }
      if (!hasWordTimingEvidence(caption.wordTiming) && resolveCaptionWordTiming(caption).state === 'ready') {
        kept.push(caption.id);
        return [];
      }
      return [{ caption, consulted, track: entry.track, entry }];
    });
    if (changedIds.size) {
      throw new PreparedWordHighlightConflictError({ code: 'WORD_HIGHLIGHT_CONTEXT_CHANGED', changedIds: [...changedIds] });
    }

    const finalTracks = finalPreparedTracks(selected, order);
    const unchanged: string[] = [];
    const applied: PreparedWordHighlightApplyResult['applied'] = [];
    for (const [index, { caption, entry }] of selected.entries()) {
      const verified = validateMarkedWordTiming(caption.text, finalTracks[index], entry.evidenceDurationMs);
      if (!verified.ok) throw new Error('Prepared word highlight track failed validation.');
      const currentTrack = caption.wordTiming ?? null;
      if (sameSavedHighlightTrack(currentTrack, verified.timing)) unchanged.push(caption.id);
      else if (!sameSavedHighlightTrack(currentTrack, entry.beforeTrack)) changedIds.add(caption.id);
      else applied.push({ id: caption.id, before: caption, after: replaceBatchFields(caption, { ...caption, wordTiming: verified.timing }) });
    }
    if (changedIds.size) {
      throw new PreparedWordHighlightConflictError({ code: 'WORD_HIGHLIGHT_CONTEXT_CHANGED', changedIds: [...changedIds] });
    }
    if (!applied.length) return { project: current, appliedCount: 0, applied, unchanged, kept };

    const replacements = new Map(applied.map(({ id, after }) => [id, after]));
    if (intent === 'apply') {
      await dependencies.checkpoint(current, 'Before applying word highlights', 'word-highlight');
    } else {
      await dependencies.checkpoint(current, 'Before updating word highlights after edits', 'word-highlight-auto', {
        coalesceKey: JSON.stringify([projectId, fingerprint, epoch]), coalesceWindowMs: 15_000,
      });
    }
    const project = await persist({
      ...current,
      captions: current.captions.map((caption) => replacements.get(caption.id) ?? caption),
      updatedAt: new Date().toISOString(),
    });
    return { project, appliedCount: applied.length, applied, unchanged, kept };
  });
}

/**
 * Validate a prepared word-timing batch against one exact persisted project snapshot.
 * The returned project changes only targeted caption word timing.
 */
export function planCaptionWordBatchApply(
  project: CaptionProject,
  expectedMediaInput: ExpectedMedia,
  changesInput: unknown,
  actionInput: unknown = 'apply',
  preparedUndo = false,
): { project: CaptionProject; appliedCount: number } {
  const expectedMedia = parseExpectedMedia(expectedMediaInput);
  const action = parseAction(actionInput);
  const changes = parseChanges(changesInput, preparedUndo ? MAX_PREPARED_KEYS : MAX_BATCH_CHANGES);
  if (action === 'apply') {
    if (changes.some(({ after }) => hasWordTimingEvidence(after.wordTiming))) {
      throw new CaptionWordBatchInputError('Publish marked word timing by prepared reference.');
    }
    const incomplete = changes.find(({ after }) => resolveCaptionWordTiming(after).state !== 'ready');
    if (incomplete) {
      throw new CaptionWordBatchInputError('Applying prepared word timings requires every changed caption to have ready word timing.');
    }
  }
  if (project.media.filename !== expectedMedia.filename || project.media.size !== expectedMedia.size) {
    throw new CaptionWordBatchConflictError('These prepared word timings belong to an older media version. Reload the project and prepare them again.');
  }

  const currentById = new Map(project.captions.map((caption) => [caption.id, caption]));
  const effectiveById = new Map(hydrateProjectWordTimings(project).captions.map((caption) => [caption.id, caption]));
  const replacements = new Map<string, CaptionSegment>();
  for (const { before, after } of changes) {
    const current = currentById.get(before.id);
    if (!current) {
      throw new CaptionWordBatchConflictError('A prepared caption was removed. Reload the project and prepare word timing again.');
    }
    const effective = effectiveById.get(before.id) || current;
    if (effective.timingLocked) {
      throw new CaptionWordBatchConflictError('Unlock all prepared caption timing before applying this word timing batch.');
    }
    if (captionWordTimingRevision(effective) !== captionWordTimingRevision(before)) {
      throw new CaptionWordBatchConflictError('A prepared caption changed. Its newer edits were kept; prepare word timing again.');
    }
    // Preserve any unrelated persisted fields, including fields added by a newer
    // project schema. This operation owns only wordTiming.
    replacements.set(current.id, replaceBatchFields(current, after));
  }

  return {
    project: {
      ...project,
      captions: project.captions.map((caption) => replacements.get(caption.id) || caption),
      updatedAt: new Date().toISOString(),
    },
    appliedCount: changes.length,
  };
}

export async function applyCaptionWordBatch(
  projectId: string,
  expectedMedia: ExpectedMedia,
  changes: unknown,
  actionInput: unknown = 'apply',
  dependencies: CaptionWordBatchDependencies = defaultDependencies,
  intent?: unknown,
): Promise<CaptionWordBatchApplyResult> {
  // Validate request shape before entering the per-project write queue. The same
  // validation runs again against the exact queued project snapshot below.
  parseExpectedMedia(expectedMedia);
  const action = parseAction(actionInput);
  if (intent !== undefined && (action !== 'undo' || (intent !== 'apply' && intent !== 'follow'))) {
    throw new CaptionWordBatchInputError('This word highlight intent is only valid when undoing a prepared publication.');
  }
  const preparedUndo = intent !== undefined;
  parseChanges(changes, preparedUndo ? MAX_PREPARED_KEYS : MAX_BATCH_CHANGES);

  return dependencies.store.withProjectWrite(projectId, async (current, persist) => {
    if (!current) throw new CaptionWordBatchNotFoundError();
    const planned = planCaptionWordBatchApply(current, expectedMedia, changes, action, preparedUndo);
    if (preparedUndo && planned.project.wordHighlightFollow?.enabled) {
      planned.project.wordHighlightFollow = { ...planned.project.wordHighlightFollow, enabled: false };
    }
    await dependencies.checkpoint(
      current,
      preparedUndo ? 'Before undoing word highlights'
        : action === 'undo' ? 'Before undoing prepared word timings' : 'Before applying prepared word timings',
      preparedUndo ? 'word-highlight' : 'timing-fix',
    );
    return {
      project: await persist(planned.project),
      appliedCount: planned.appliedCount,
    };
  });
}
