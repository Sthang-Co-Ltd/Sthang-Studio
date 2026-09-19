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
  return {
    min: Math.ceil(previous.reduce((value, word) => Math.max(value, word.endMs!), caption.startMs) / 10) * 10,
    max: Math.floor(following.reduce((value, word) => Math.min(value, word.startMs!), caption.endMs) / 10) * 10,
    word: index >= 0 ? words[index] : undefined,
  };
}

/** A word moves only in its available gap. No proportional retiming of its neighbours. */
export function changeWordTiming(caption: CaptionSegment, wordId: string, kind: TimingEditKind, value: number) {
  if (!Number.isFinite(value)) return caption;
  const { min, max, word } = wordTimingLimits(caption, wordId);
  if (!word || word.startMs === null || word.endMs === null || min + MIN_WORD_MS > max) return caption;
  let startMs = word.startMs;
  let endMs = word.endMs;
  if (kind === 'move') {
    const length = endMs - startMs;
    if (length < MIN_WORD_MS || length > max - min) return caption;
    startMs = clamp(startMs + value, min, max - length);
    endMs = startMs + length;
  } else if (kind === 'start') {
    if (endMs > max || endMs - MIN_WORD_MS < min) return caption;
    startMs = clamp(value, min, endMs - MIN_WORD_MS);
  } else {
    if (startMs < min || startMs + MIN_WORD_MS > max) return caption;
    endMs = clamp(value, startMs + MIN_WORD_MS, max);
  }
  if (startMs === word.startMs && endMs === word.endMs) return caption;
  return editCaptionWord(caption, wordId, { startMs, endMs });
}
