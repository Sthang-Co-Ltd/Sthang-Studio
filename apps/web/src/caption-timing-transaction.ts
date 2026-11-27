import type { CaptionSegment } from '@kcs/shared';
import type { MessageKey, MessageParams } from './i18n/types';
import { editCaptionTiming, MIN_CAPTION_MS, sameTimingRevision, type TimingEditKind } from './timing-edit';

export interface CaptionTimingTransaction {
  before: CaptionSegment[];
  after: CaptionSegment[];
  guards?: CaptionSegment[];
  limited?: string;
  limitedMessage?: { key: MessageKey; params?: MessageParams };
  /** Only held pointer gestures carry this admission basis; Undo keeps its existing policy. */
  gestureBasis?: CaptionTimingGestureBasis;
}

export interface CaptionTimingOptions {
  allowOverlap?: boolean;
  sharedBoundary?: boolean;
}

export interface CaptionNeighborLimit {
  lower: number;
  upper: number;
  previous: CaptionSegment | undefined;
  next: CaptionSegment | undefined;
}

export interface CaptionTimingGestureBasis {
  readonly captions: readonly CaptionSegment[];
  readonly durationMs: number;
}

/** Explicitly owned by an immutable render/gesture basis; never cache mutable callers globally. */
export interface PreparedCaptionTiming extends CaptionTimingGestureBasis {
  readonly limits: ReadonlyMap<string, CaptionNeighborLimit>;
}

const timingLimits = {
  locked: { limited: "Unlock this caption’s timing before changing it.", limitedMessage: { key: 'notices.timing.locked' } },
  noPrevious: { limited: "There is no previous caption to share this edge.", limitedMessage: { key: 'notices.timing.noPrevious' } },
  noNext: { limited: "There is no next caption to share this edge.", limitedMessage: { key: 'notices.timing.noNext' } },
  neighborLocked: { limited: "The neighboring caption’s timing is locked. Both edges were kept.", limitedMessage: { key: 'notices.timing.neighborLocked' } },
  tooShort: { limited: "These captions do not have enough time for a shared boundary.", limitedMessage: { key: 'notices.timing.tooShort' } },
  invalidBoundary: { limited: "This boundary cannot be moved without invalidating a caption.", limitedMessage: { key: 'notices.timing.invalidBoundary' } },
  blockedBoundary: { limited: "Another caption blocks this shared boundary. Its timing was kept.", limitedMessage: { key: 'notices.timing.blockedBoundary' } },
  minimumDuration: { limited: "Reached the minimum caption duration.", limitedMessage: { key: 'notices.timing.minimumDuration' } },
  start: { limited: "Reached the start of the media.", limitedMessage: { key: 'editor.captions.timingStart' } },
  end: { limited: "Reached the end of the media.", limitedMessage: { key: 'editor.captions.timingEnd' } },
  neighbor: { limited: "Reached the neighboring caption. Adjust the shared boundary or enable Allow overlaps to continue.", limitedMessage: { key: 'editor.captions.timingNeighbor' } },
} as const satisfies Record<string, Pick<CaptionTimingTransaction, 'limited' | 'limitedMessage'>>;

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
  const limits = new Map<string, CaptionNeighborLimit>();
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

export function prepareCaptionTiming(captions: readonly CaptionSegment[], durationMs: number): PreparedCaptionTiming {
  return { captions, durationMs, limits: captionNeighborLimitMap(captions, durationMs) };
}

/** A pointer preview owns its collision geometry, not later saved timing.
 * Ignore unrelated wording/approval changes and same-value save clones. Preserve
 * array order because it decides neighbor identity for equal-time captions.
 * This comparison grants no zero-overlap requirement to existing overlaps.
 */
export function captionTimingBasisMatches(
  current: readonly CaptionSegment[], basis: readonly CaptionSegment[], owners: readonly CaptionSegment[],
): boolean {
  if (current !== basis && (current.length !== basis.length || current.some((caption, index) => {
    const before = basis[index];
    return caption.id !== before.id || caption.startMs !== before.startMs || caption.endMs !== before.endMs
      || Boolean(caption.timingLocked) !== Boolean(before.timingLocked);
  }))) return false;
  return owners.every((owner) => sameTimingRevision(current.find((caption) => caption.id === owner.id), owner));
}

/** Match each old [...outsiders, target] query, sorting outsiders only once.
 * Equal-time outsiders precede the appended target, including exact interval ties.
 * Prefix maxima retain the protection from an earlier enclosing caption.
 */
export function limitCaptionSelectionDelta(
  captions: readonly CaptionSegment[], selectedIds: ReadonlySet<string>, delta: number, durationMs: number,
): number {
  const targets = captions.filter((caption) => selectedIds.has(caption.id));
  if (!targets.length) return 0;
  const outsiders = captions.filter((caption) => !selectedIds.has(caption.id))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const previousEnds = [0];
  for (const caption of outsiders) previousEnds.push(Math.max(previousEnds[previousEnds.length - 1], caption.endMs));
  let lower = -Math.min(...targets.map((caption) => caption.startMs));
  let upper = durationMs - Math.max(...targets.map((caption) => caption.endMs));
  for (const caption of targets) {
    let low = 0;
    let high = outsiders.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = outsiders[middle];
      const order = other.startMs - caption.startMs || other.endMs - caption.endMs;
      if (order <= 0) low = middle + 1;
      else high = middle;
    }
    const minimum = Math.max(0, Math.min(caption.startMs, previousEnds[low]));
    const maximum = Math.min(durationMs, Math.max(caption.endMs, outsiders[low]?.startMs ?? durationMs));
    lower = Math.max(lower, minimum - caption.startMs);
    upper = Math.min(upper, maximum - caption.endMs);
  }
  return Math.max(lower, Math.min(delta, upper));
}

function overlap(a: CaptionSegment, b: CaptionSegment) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

export function timingTransactionMatches(captions: readonly CaptionSegment[], { before, after, guards }: CaptionTimingTransaction) {
  if (![...before, ...(guards ?? [])].every((cue) => sameTimingRevision(captions.find((item) => item.id === cue.id), cue))) return false;
  if (!guards) return true;
  const replacements = new Map(after.map((cue) => [cue.id, cue]));
  return after.every((cue) => captions.every((item) => item.id === cue.id || overlap(cue, replacements.get(item.id) ?? item) === 0));
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
  prepared?: PreparedCaptionTiming,
): CaptionTimingTransaction {
  const caption = captions.find((item) => item.id === id);
  const empty = (limit: Pick<CaptionTimingTransaction, 'limited' | 'limitedMessage'> = { limited: undefined }): CaptionTimingTransaction => ({ before: [], after: [], ...limit });
  if (!caption || !Number.isFinite(value) || !Number.isFinite(durationMs) || durationMs < MIN_CAPTION_MS) return empty();
  if (caption.timingLocked) return empty(timingLimits.locked);
  const limits = prepared?.captions === captions && prepared.durationMs === durationMs
    ? prepared.limits.get(id) || { lower: 0, upper: durationMs, previous: undefined, next: undefined }
    : captionNeighborLimits(captions, id, durationMs);
  if (options.sharedBoundary && kind !== 'move') {
    const neighbour = kind === 'start' ? limits.previous : limits.next;
    if (!neighbour) return empty(kind === 'start' ? timingLimits.noPrevious : timingLimits.noNext);
    if (neighbour.timingLocked) return empty(timingLimits.neighborLocked);
    const left = kind === 'start' ? neighbour : caption;
    const right = kind === 'start' ? caption : neighbour;
    const lower = Math.max(0, left.startMs + MIN_CAPTION_MS);
    const upper = Math.min(durationMs, right.endMs - MIN_CAPTION_MS);
    if (lower > upper) return empty(timingLimits.tooShort);
    const boundary = clamp(Math.round(value), lower, upper);
    const nextLeft = editCaptionTiming(left, 'end', boundary, durationMs);
    const nextRight = editCaptionTiming(right, 'start', boundary, durationMs);
    if (nextLeft.endMs !== boundary || nextRight.startMs !== boundary) return empty(timingLimits.invalidBoundary);
    if (!options.allowOverlap) {
      const others = captions.filter((item) => item.id !== left.id && item.id !== right.id);
      if (others.some((item) => overlap(nextLeft, item) > overlap(left, item) || overlap(nextRight, item) > overlap(right, item))) {
        return empty(timingLimits.blockedBoundary);
      }
    }
    const changes = [{ before: left, after: nextLeft }, { before: right, after: nextRight }].filter((item) => item.before !== item.after);
    return {
      before: changes.map((item) => item.before), after: changes.map((item) => item.after),
      ...(boundary !== Math.round(value) ? timingLimits.minimumDuration : {}),
    };
  }

  let requested = value;
  if (!options.allowOverlap) {
    if (kind === 'move') requested = clamp(value, limits.lower - caption.startMs, limits.upper - caption.endMs);
    else if (kind === 'start') requested = Math.max(value, limits.lower);
    else requested = Math.min(value, limits.upper);
  }
  const after = editCaptionTiming(caption, kind, requested, durationMs);
  const start = kind === 'move' ? caption.startMs + value : value;
  const end = kind === 'move' ? caption.endMs + value : value;
  const limited = kind !== 'end' && start < 0 && after.startMs === 0 ? timingLimits.start
    : kind !== 'start' && end > durationMs && after.endMs === durationMs ? timingLimits.end
    : requested !== value ? timingLimits.neighbor
    : { limited: undefined };
  return after === caption ? empty(limited) : { before: [caption], after: [after], ...limited };
}
