import {
  resolveCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
} from '@kcs/shared';
import { captionWordTimingRevision, hydrateProjectWordTimings } from './caption-word-timing.js';
import { historyStore } from './history-store.js';
import { store } from './store.js';

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
    textLocked: caption.textLocked ?? null,
    timingLocked: caption.timingLocked ?? null,
  };
}

function sameNonBatchFields(before: CaptionSegment, after: CaptionSegment) {
  return JSON.stringify(stableNonBatchFields(before)) === JSON.stringify(stableNonBatchFields(after));
}

function parseChanges(value: unknown): CaptionWordBatchChange[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new CaptionWordBatchInputError('Prepared word timing changes are required.');
  }
  if (value.length > MAX_BATCH_CHANGES) {
    throw new CaptionWordBatchInputError(`Prepared word timing changes are limited to ${MAX_BATCH_CHANGES} captions at a time.`);
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
      throw new CaptionWordBatchInputError(`Change ${index + 1} may change only word timing and approval state.`);
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
  if (Object.prototype.hasOwnProperty.call(after, 'approved') && after.approved !== undefined) {
    next.approved = after.approved;
  } else {
    delete next.approved;
  }
  return next;
}

/**
 * Validate a prepared word-timing batch against one exact persisted project snapshot.
 * The returned project changes only targeted caption wordTiming/approved fields.
 */
export function planCaptionWordBatchApply(
  project: CaptionProject,
  expectedMediaInput: ExpectedMedia,
  changesInput: unknown,
  actionInput: unknown = 'apply',
): { project: CaptionProject; appliedCount: number } {
  const expectedMedia = parseExpectedMedia(expectedMediaInput);
  const changes = parseChanges(changesInput);
  const action = parseAction(actionInput);
  if (action === 'apply') {
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
    // project schema. This operation owns only wordTiming and approved.
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
): Promise<CaptionWordBatchApplyResult> {
  // Validate request shape before entering the per-project write queue. The same
  // validation runs again against the exact queued project snapshot below.
  parseExpectedMedia(expectedMedia);
  parseChanges(changes);
  const action = parseAction(actionInput);

  return dependencies.store.withProjectWrite(projectId, async (current, persist) => {
    if (!current) throw new CaptionWordBatchNotFoundError();
    const planned = planCaptionWordBatchApply(current, expectedMedia, changes, action);
    await dependencies.checkpoint(
      current,
      action === 'undo' ? 'Before undoing prepared word timings' : 'Before applying prepared word timings',
      'timing-fix',
    );
    return {
      project: await persist(planned.project),
      appliedCount: planned.appliedCount,
    };
  });
}
