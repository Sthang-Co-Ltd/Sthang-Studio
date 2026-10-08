import { resolveCaptionWordTiming, type CaptionSegment } from '@kcs/shared';
import type { CaptionWordTimingCandidate } from './api';
import { sameTimingRevision } from './timing-edit';

export interface WordHighlightBatchProgress {
  completed: number;
  total: number;
  ready: number;
  needsReview: number;
  currentCaptionId?: string;
}

export interface WordHighlightBatchResult {
  ready: CaptionWordTimingCandidate[];
  needsReview: Array<{ id: string; reason: string }>;
  completed: number;
  total: number;
  canceled: boolean;
  interruptedByBusy?: true;
}

export interface WordHighlightBatchApplyResult {
  next: CaptionSegment[];
  applied: Array<{ before: CaptionSegment; after: CaptionSegment }>;
  staleIds: string[];
}

const BLANK_TEXT = /^[\s\u200B-\u200D\u2060\uFEFF]*$/u;

function isCancellation(error: unknown, signal: AbortSignal) {
  return signal.aborted || Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function isTimingBusy(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 429);
}

function candidateCaption(candidate: CaptionWordTimingCandidate) {
  return { ...candidate.basis, wordTiming: candidate.wordTiming };
}

function readyCandidateFor(caption: CaptionSegment, candidate: CaptionWordTimingCandidate) {
  if (caption.timingLocked || !sameTimingRevision(caption, candidate.basis)) return null;
  const proposed = { ...caption, wordTiming: candidate.wordTiming, approved: false };
  return resolveCaptionWordTiming(proposed).state === 'ready' ? proposed : null;
}

export async function prepareWordHighlightBatch(options: {
  captions: CaptionSegment[];
  signal: AbortSignal;
  sync: (caption: CaptionSegment, signal: AbortSignal) => Promise<CaptionWordTimingCandidate>;
  onProgress?: (progress: WordHighlightBatchProgress) => void;
}): Promise<WordHighlightBatchResult> {
  const work = options.captions.filter((caption) => (
    !BLANK_TEXT.test(caption.text)
    && resolveCaptionWordTiming(caption).state !== 'ready'
  ));
  const ready: CaptionWordTimingCandidate[] = [];
  const needsReview: Array<{ id: string; reason: string }> = [];
  let completed = 0;
  let canceled = options.signal.aborted;
  let interruptedByBusy = false;

  const progress = (currentCaptionId?: string) => options.onProgress?.({
    completed,
    total: work.length,
    ready: ready.length,
    needsReview: needsReview.length,
    ...(currentCaptionId ? { currentCaptionId } : {}),
  });

  progress();
  for (const caption of work) {
    if (options.signal.aborted) { canceled = true; break; }

    if (caption.timingLocked) {
      needsReview.push({ id: caption.id, reason: 'Caption timing is locked.' });
      completed += 1;
      progress();
      continue;
    }

    progress(caption.id);
    try {
      const candidate = await options.sync(caption, options.signal);
      if (options.signal.aborted) { canceled = true; break; }
      if (!sameTimingRevision(caption, candidate.basis)) {
        needsReview.push({ id: caption.id, reason: 'Caption changed while word timing was prepared.' });
      } else {
        const resolution = resolveCaptionWordTiming(candidateCaption(candidate));
        if (resolution.state === 'ready') ready.push(candidate);
        else needsReview.push({ id: caption.id, reason: 'Word timing still needs review.' });
      }
      completed += 1;
      progress();
    } catch (error) {
      if (isCancellation(error, options.signal)) {
        canceled = true;
        break;
      }
      if (isTimingBusy(error)) {
        interruptedByBusy = true;
        break;
      }
      needsReview.push({ id: caption.id, reason: 'Word timing could not be prepared.' });
      completed += 1;
      progress();
    }
  }

  return {
    ready,
    needsReview,
    completed,
    total: work.length,
    canceled,
    ...(interruptedByBusy ? { interruptedByBusy: true as const } : {}),
  };
}

export function applyWordHighlightBatch(
  captions: CaptionSegment[],
  candidates: CaptionWordTimingCandidate[],
): WordHighlightBatchApplyResult {
  const currentById = new Map(captions.map((caption) => [caption.id, caption]));
  const accepted = new Map<string, CaptionSegment>();
  const applied: Array<{ before: CaptionSegment; after: CaptionSegment }> = [];
  const staleIds: string[] = [];
  const stale = (id: string) => { if (!staleIds.includes(id)) staleIds.push(id); };

  for (const candidate of candidates) {
    const id = candidate.basis.id;
    const before = currentById.get(id);
    if (!before || accepted.has(id)) { stale(id); continue; }
    const after = readyCandidateFor(before, candidate);
    if (!after) { stale(id); continue; }
    accepted.set(id, after);
    applied.push({ before, after });
  }

  if (!accepted.size) return { next: captions, applied, staleIds };
  return {
    next: captions.map((caption) => accepted.get(caption.id) || caption),
    applied,
    staleIds,
  };
}

export function undoWordHighlightBatch(
  captions: CaptionSegment[],
  applied: Array<{ before: CaptionSegment; after: CaptionSegment }>,
): CaptionSegment[] | null {
  if (!applied.length) return captions;
  const currentById = new Map(captions.map((caption) => [caption.id, caption]));
  const restore = new Map<string, CaptionSegment>();

  for (const change of applied) {
    const current = currentById.get(change.after.id);
    if (restore.has(change.after.id) || !sameTimingRevision(current, change.after)) return null;
    restore.set(change.after.id, change.before);
  }

  return captions.map((caption) => restore.get(caption.id) || caption);
}

export function mergePublishedWordHighlightBatch(
  captions: CaptionSegment[],
  published: CaptionSegment[],
  applied: Array<{ before: CaptionSegment; after: CaptionSegment }>,
): CaptionSegment[] {
  if (!applied.length) return captions;
  const publishedById = new Map(published.map((caption) => [caption.id, caption]));
  const changeById = new Map(applied.map((change) => [change.before.id, change]));
  let changed = false;
  const next = captions.map((caption) => {
    const change = changeById.get(caption.id);
    const serverCaption = publishedById.get(caption.id);
    if (!change || !serverCaption || !sameTimingRevision(caption, change.before)) return caption;

    const merged = { ...caption } as CaptionSegment;
    if (Object.prototype.hasOwnProperty.call(serverCaption, 'wordTiming')) merged.wordTiming = serverCaption.wordTiming;
    else delete merged.wordTiming;
    if (Object.prototype.hasOwnProperty.call(serverCaption, 'approved')) merged.approved = serverCaption.approved;
    else delete merged.approved;
    changed = true;
    return merged;
  });
  return changed ? next : captions;
}
