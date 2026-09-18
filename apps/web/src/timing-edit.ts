import type { CaptionSegment } from '@kcs/shared';

export type TimingEditKind = 'start' | 'end' | 'move';
export interface TimingEdit { before: CaptionSegment; after: CaptionSegment }
export const MIN_CAPTION_MS = 40;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Only timing and its review metadata belong to a timing transaction. */
export function timingFields(caption: CaptionSegment) {
  return {
    startMs: caption.startMs, endMs: caption.endMs,
    timingSource: caption.timingSource, timingQuality: caption.timingQuality,
    approved: caption.approved,
  };
}

/** Do not undo across a text edit, new lock, approval, or another timing edit. */
export function sameTimingRevision(current: CaptionSegment | undefined, expected: CaptionSegment) {
  return Boolean(current && current.id === expected.id && current.text === expected.text
    && current.startMs === expected.startMs && current.endMs === expected.endMs
    && current.timingSource === expected.timingSource && current.timingQuality === expected.timingQuality
    && Boolean(current.approved) === Boolean(expected.approved)
    && Boolean(current.timingLocked) === Boolean(expected.timingLocked)
    && Boolean(current.textLocked) === Boolean(expected.textLocked));
}

/** Move preserves duration; edge edits preserve the other edge. Never mutate a neighbour. */
export function editCaptionTiming(caption: CaptionSegment, kind: TimingEditKind, value: number, durationMs: number): CaptionSegment {
  if (caption.timingLocked || !Number.isFinite(value) || !Number.isFinite(durationMs)
    || durationMs < MIN_CAPTION_MS || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return caption;
  const limit = Math.floor(durationMs);
  let { startMs, endMs } = caption;
  if (kind === 'move') {
    const duration = endMs - startMs;
    if (duration < MIN_CAPTION_MS || duration > limit) return caption;
    startMs = clamp(Math.round(startMs + value), 0, limit - duration);
    endMs = startMs + duration;
  } else if (kind === 'start') {
    if (endMs < MIN_CAPTION_MS || endMs > limit) return caption;
    startMs = clamp(Math.round(value), 0, endMs - MIN_CAPTION_MS);
  } else {
    if (startMs < 0 || startMs > limit - MIN_CAPTION_MS) return caption;
    endMs = clamp(Math.round(value), startMs + MIN_CAPTION_MS, limit);
  }
  if (startMs === caption.startMs && endMs === caption.endMs) return caption;
  return { ...caption, startMs, endMs, timingSource: 'manual', timingQuality: 'medium', approved: false };
}

export function focusedTimingViewport(caption: Pick<CaptionSegment, 'startMs' | 'endMs'>, durationMs: number) {
  const spanMs = Math.min(durationMs, Math.max(2500, caption.endMs - caption.startMs + 1600));
  const startMs = clamp((caption.startMs + caption.endMs - spanMs) / 2, 0, Math.max(0, durationMs - spanMs));
  return { startMs, spanMs };
}

export function timingPreviewWindow(caption: Pick<CaptionSegment, 'startMs' | 'endMs'>, part: 'caption' | 'start' | 'end', durationMs: number) {
  const edge = part === 'start' ? caption.startMs : caption.endMs;
  return part === 'caption'
    ? { startMs: Math.max(0, caption.startMs - 120), endMs: Math.min(durationMs, caption.endMs + 120) }
    : { startMs: Math.max(0, edge - 500), endMs: Math.min(durationMs, edge + 500) };
}
