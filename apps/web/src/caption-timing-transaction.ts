import type { CaptionSegment } from '@kcs/shared';
import { editCaptionTiming, MIN_CAPTION_MS, type TimingEditKind } from './timing-edit';

export interface CaptionTimingTransaction {
  before: CaptionSegment[];
  after: CaptionSegment[];
  limited?: string;
}

export interface CaptionTimingOptions {
  allowOverlap?: boolean;
  sharedBoundary?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A pre-existing overlap can be repaired gradually; it must not trap the caption
 * or cause an unexpected jump to the far side of an enclosing caption. */
export function captionNeighborLimits(captions: readonly CaptionSegment[], id: string, durationMs: number) {
  return captionNeighborLimitMap(captions, durationMs).get(id)
    || { lower: 0, upper: durationMs, previous: undefined, next: undefined };
}

export function captionNeighborLimitMap(captions: readonly CaptionSegment[], durationMs: number) {
  const ordered = [...captions].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let previousEnd = 0;
  const limits = new Map<string, { lower: number; upper: number; previous: CaptionSegment | undefined; next: CaptionSegment | undefined }>();
  for (let index = 0; index < ordered.length; index++) {
    const caption = ordered[index];
    const next = ordered[index + 1];
    limits.set(caption.id, {
      lower: Math.max(0, Math.min(caption.startMs, previousEnd)),
      upper: Math.min(durationMs, Math.max(caption.endMs, next?.startMs ?? durationMs)),
      previous: ordered[index - 1], next,
    });
    previousEnd = Math.max(previousEnd, caption.endMs);
  }
  return limits;
}

function overlap(a: CaptionSegment, b: CaptionSegment) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/** Plan the complete edit before mutating the draft. A shared boundary is a
 * two-caption transaction; normal movement never ripples through other speech. */
export function planCaptionTimingEdit(
  captions: readonly CaptionSegment[],
  id: string,
  kind: TimingEditKind,
  value: number,
  durationMs: number,
  options: CaptionTimingOptions = {},
): CaptionTimingTransaction {
  const caption = captions.find((item) => item.id === id);
  const empty = (limited?: string): CaptionTimingTransaction => ({ before: [], after: [], limited });
  if (!caption || !Number.isFinite(value) || !Number.isFinite(durationMs) || durationMs < MIN_CAPTION_MS) return empty();
  if (caption.timingLocked) return empty('Unlock this caption’s timing before changing it.');
  const limits = captionNeighborLimits(captions, id, durationMs);
  if (options.sharedBoundary && kind !== 'move') {
    const neighbour = kind === 'start' ? limits.previous : limits.next;
    if (!neighbour) return empty(`There is no ${kind === 'start' ? 'previous' : 'next'} caption to share this edge.`);
    if (neighbour.timingLocked) return empty('The neighboring caption’s timing is locked. Both edges were kept.');
    const left = kind === 'start' ? neighbour : caption;
    const right = kind === 'start' ? caption : neighbour;
    const lower = Math.max(0, left.startMs + MIN_CAPTION_MS);
    const upper = Math.min(durationMs, right.endMs - MIN_CAPTION_MS);
    if (lower > upper) return empty('These captions do not have enough time for a shared boundary.');
    const boundary = clamp(Math.round(value), lower, upper);
    const nextLeft = editCaptionTiming(left, 'end', boundary, durationMs);
    const nextRight = editCaptionTiming(right, 'start', boundary, durationMs);
    if (nextLeft.endMs !== boundary || nextRight.startMs !== boundary) return empty('This boundary cannot be moved without invalidating a caption.');
    if (!options.allowOverlap) {
      const others = captions.filter((item) => item.id !== left.id && item.id !== right.id);
      if (others.some((item) => overlap(nextLeft, item) > overlap(left, item) || overlap(nextRight, item) > overlap(right, item))) {
        return empty('Another caption blocks this shared boundary. Its timing was kept.');
      }
    }
    const changes = [{ before: left, after: nextLeft }, { before: right, after: nextRight }].filter((item) => item.before !== item.after);
    return {
      before: changes.map((item) => item.before), after: changes.map((item) => item.after),
      ...(boundary !== Math.round(value) ? { limited: 'Reached the minimum caption duration.' } : {}),
    };
  }

  let requested = value;
  if (!options.allowOverlap) {
    if (kind === 'move') requested = clamp(value, limits.lower - caption.startMs, limits.upper - caption.endMs);
    else if (kind === 'start') requested = Math.max(value, limits.lower);
    else requested = Math.min(value, limits.upper);
  }
  const after = editCaptionTiming(caption, kind, requested, durationMs);
  const limited = requested !== value ? 'Reached the neighboring caption. Adjust the shared boundary or enable Allow overlaps to continue.' : undefined;
  return after === caption ? empty(limited) : { before: [caption], after: [after], limited };
}
