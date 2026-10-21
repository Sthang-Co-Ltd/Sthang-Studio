import { editCaptionWord, resolveCaptionWordTiming, type CaptionSegment } from '@kcs/shared';
import type { TimingEditKind } from './timing-edit';

export const MIN_WORD_MS = 10;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function wordTimingLimits(caption: CaptionSegment, wordId: string) {
  const resolved = resolveCaptionWordTiming(caption);
  const words = resolved.state === 'stale' ? [] : resolved.words;
  const index = words.findIndex((word) => word.id === wordId);
  const previous = words.slice(0, index).filter((word) => word.endMs !== null);
  const following = words.slice(index + 1).filter((word) => word.startMs !== null);
  const min = Math.ceil(previous.reduce((value, word) => Math.max(value, word.endMs!), caption.startMs) / 10) * 10;
  const max = Math.floor(following.reduce((value, word) => Math.min(value, word.startMs!), caption.endMs) / 10) * 10;
  const word = index >= 0 ? words[index] : undefined;
  // An opposite edge outside the available gap cannot anchor a trim. Use the
  // gap boundary so one explicit edit can repair both edges atomically.
  const end = word?.endMs != null && word.endMs >= min + MIN_WORD_MS ? Math.min(word.endMs, max) : max;
  const start = word?.startMs != null && word.startMs <= max - MIN_WORD_MS ? Math.max(word.startMs, min) : min;
  return {
    min, max, word,
    maxStart: end - MIN_WORD_MS,
    minEnd: start + MIN_WORD_MS,
  };
}

/** Fit edits into the available gap, repairing stranded words without retiming neighbours. */
export function changeWordTiming(caption: CaptionSegment, wordId: string, kind: TimingEditKind, value: number) {
  if (!Number.isFinite(value)) return caption;
  const { min, max, maxStart, minEnd, word } = wordTimingLimits(caption, wordId);
  if (!word || word.startMs === null || word.endMs === null || min + MIN_WORD_MS > max) return caption;
  let startMs = word.startMs;
  let endMs = word.endMs;
  if (kind === 'move') {
    const length = Math.min(endMs - startMs, max - min);
    if (length < MIN_WORD_MS) return caption;
    startMs = clamp(startMs + value, min, max - length);
    endMs = startMs + length;
  } else if (kind === 'start') {
    endMs = maxStart + MIN_WORD_MS;
    startMs = clamp(value, min, maxStart);
  } else {
    startMs = minEnd - MIN_WORD_MS;
    endMs = clamp(value, minEnd, max);
  }
  if (startMs === word.startMs && endMs === word.endMs) return caption;
  return editCaptionWord(caption, wordId, { startMs, endMs });
}
