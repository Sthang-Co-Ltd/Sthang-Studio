import {
  resolveCaptionWordTiming,
  type CaptionSegment,
  type CaptionWord,
  type CaptionWordTiming,
} from '@kcs/shared';
import { MIN_CAPTION_MS } from './timing-edit';

const KHMER_WORD_START = /^[\u1780-\u17D3\u17DD]/u;
const KHMER_WORD_END = /[\u1780-\u17D3\u17DD]$/u;
const NO_SPACE_BEFORE = /^[,.;:!?%…។៕៘៙៚\)\]\}»”’]/u;
const NO_SPACE_AFTER = /[\(\[\{«“‘]$/u;

function joinCaptionText(leftValue: string, rightValue: string) {
  const left = leftValue.trimEnd();
  const right = rightValue.trimStart();
  if (!left) return { text: right, left, right, separator: '' };
  if (!right) return { text: left, left, right, separator: '' };
  const separator = NO_SPACE_BEFORE.test(right)
    || NO_SPACE_AFTER.test(left)
    || (KHMER_WORD_END.test(left) && KHMER_WORD_START.test(right))
    ? ''
    : ' ';
  return { text: `${left}${separator}${right}`, left, right, separator };
}

function withoutWordTiming(caption: CaptionSegment): CaptionSegment {
  if (!Object.prototype.hasOwnProperty.call(caption, 'wordTiming')) return caption;
  const { wordTiming: _wordTiming, ...rest } = caption;
  return rest as CaptionSegment;
}

function validWords(caption: CaptionSegment) {
  const resolved = resolveCaptionWordTiming(caption);
  return resolved.state === 'ready' || resolved.state === 'partial' ? resolved.words : null;
}

function nearestBoundary(candidates: number[], text: string) {
  const middle = text.length / 2;
  return candidates
    .filter((offset) => offset > 0 && offset < text.length && text.slice(0, offset).trim() && text.slice(offset).trim())
    .sort((left, right) => Math.abs(left - middle) - Math.abs(right - middle) || right - left)[0];
}

function trackedSplitBoundary(text: string, words: CaptionWord[]) {
  return nearestBoundary(words.slice(1).map((word) => word.startOffset), text);
}

function intlWordSplitBoundary(text: string) {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  const words = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)]
    .filter((part) => part.isWordLike);
  if (words.length < 2) return undefined;
  return nearestBoundary(words.slice(1).map((part) => part.index), text);
}

function graphemeSplitBoundary(text: string) {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  const segments = [...new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(text)];
  return nearestBoundary(segments.slice(1).map((part) => part.index), text);
}

function trimmedRange(text: string, startOffset: number, endOffset: number) {
  const value = text.slice(startOffset, endOffset);
  const leading = value.length - value.trimStart().length;
  const trailingLength = value.trimEnd().length;
  return {
    startOffset: startOffset + leading,
    endOffset: startOffset + trailingLength,
    text: value.trim(),
  };
}

function rebasedWords(words: CaptionWord[], originalStart: number, originalEnd: number) {
  return words
    .filter((word) => word.startOffset >= originalStart && word.endOffset <= originalEnd)
    .map((word) => ({
      ...word,
      startOffset: word.startOffset - originalStart,
      endOffset: word.endOffset - originalStart,
    }));
}

function attachTrack(caption: CaptionSegment, words: CaptionWord[]) {
  if (!words.length) return withoutWordTiming(caption);
  const candidate: CaptionSegment = {
    ...caption,
    wordTiming: { version: 1, text: caption.text, words },
  };
  const resolved = resolveCaptionWordTiming(candidate);
  return resolved.state === 'stale' || resolved.state === 'missing' ? withoutWordTiming(caption) : candidate;
}

function finiteEnd(word: CaptionWord) {
  return typeof word.endMs === 'number' && Number.isFinite(word.endMs) ? word.endMs : null;
}

function finiteStart(word: CaptionWord) {
  return typeof word.startMs === 'number' && Number.isFinite(word.startMs) ? word.startMs : null;
}

function splitTime(caption: CaptionSegment, boundary: number, words: CaptionWord[] | null) {
  const floor = Math.ceil(caption.startMs + MIN_CAPTION_MS);
  const ceiling = Math.floor(caption.endMs - MIN_CAPTION_MS);
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || floor > ceiling) return null;
  const middle = Math.round((caption.startMs + caption.endMs) / 2);
  if (!words) return Math.max(floor, Math.min(ceiling, middle));

  const leftEnds = words.filter((word) => word.endOffset <= boundary).map(finiteEnd).filter((value): value is number => value !== null);
  const rightStarts = words.filter((word) => word.startOffset >= boundary).map(finiteStart).filter((value): value is number => value !== null);
  const lower = Math.max(floor, leftEnds.length ? Math.max(...leftEnds) : floor);
  const upper = Math.min(ceiling, rightStarts.length ? Math.min(...rightStarts) : ceiling);
  return lower <= upper ? Math.max(lower, Math.min(upper, middle)) : Math.max(floor, Math.min(ceiling, middle));
}

/** Split an editable cue without cutting a word when a safe word boundary exists. */
export function splitCaptionForEditing(
  caption: CaptionSegment,
  leftId: string,
  rightId: string,
): [CaptionSegment, CaptionSegment] | null {
  if (caption.textLocked || caption.timingLocked || !leftId || !rightId || leftId === rightId) return null;
  if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs) || caption.endMs - caption.startMs < MIN_CAPTION_MS * 2) return null;

  const words = validWords(caption);
  const trackedBoundary = words ? trackedSplitBoundary(caption.text, words) : undefined;
  const intlBoundary = trackedBoundary === undefined ? intlWordSplitBoundary(caption.text) : undefined;
  const boundary = trackedBoundary ?? intlBoundary ?? graphemeSplitBoundary(caption.text);
  if (boundary === undefined) return null;

  const leftRange = trimmedRange(caption.text, 0, boundary);
  const rightRange = trimmedRange(caption.text, boundary, caption.text.length);
  if (!leftRange.text || !rightRange.text) return null;
  const atMs = splitTime(caption, boundary, trackedBoundary !== undefined ? words : null);
  if (atMs === null) return null;

  const base = withoutWordTiming(caption);
  let left: CaptionSegment = {
    ...base,
    id: leftId,
    endMs: atMs,
    text: leftRange.text,
    timingSource: 'manual',
    timingQuality: 'medium',
    approved: false,
  };
  let right: CaptionSegment = {
    ...base,
    id: rightId,
    startMs: atMs,
    text: rightRange.text,
    timingSource: 'manual',
    timingQuality: 'medium',
    approved: false,
  };

  // Only a boundary owned by a structurally valid stored track proves that no
  // stored word was cut. ICU/grapheme fallbacks intentionally clear timing maps.
  if (trackedBoundary !== undefined && words) {
    left = attachTrack(left, rebasedWords(words, leftRange.startOffset, leftRange.endOffset));
    right = attachTrack(right, rebasedWords(words, rightRange.startOffset, rightRange.endOffset));
  }
  return [left, right];
}

function uniqueWordId(id: string, used: Set<string>, mergedId: string, side: 'left' | 'right', index: number) {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let candidate = `${id}:${mergedId}:${side}:${index}`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${id}:${mergedId}:${side}:${index}:${suffix++}`;
  used.add(candidate);
  return candidate;
}

function mergedTrack(
  merged: CaptionSegment,
  left: CaptionSegment,
  right: CaptionSegment,
  leftText: string,
  rightText: string,
  separator: string,
) {
  const leftResolution = resolveCaptionWordTiming(left);
  const rightResolution = resolveCaptionWordTiming(right);
  if (leftResolution.state === 'stale' || rightResolution.state === 'stale') return undefined;

  const leftWords = leftResolution.state === 'ready' || leftResolution.state === 'partial' ? leftResolution.words : [];
  const rightWords = rightResolution.state === 'ready' || rightResolution.state === 'partial' ? rightResolution.words : [];
  if (!leftWords.length && !rightWords.length) return undefined;

  const rightTrimmedPrefix = right.text.length - rightText.length;
  const rightBase = leftText.length + separator.length;
  const used = new Set<string>();
  const words: CaptionWord[] = [];
  leftWords.forEach((word, index) => {
    if (word.endOffset > leftText.length) return;
    words.push({
      ...word,
      id: uniqueWordId(word.id, used, merged.id, 'left', index),
      needsReview: leftResolution.state === 'partial' && index === 0 ? true : word.needsReview,
    });
  });
  rightWords.forEach((word, index) => {
    if (word.startOffset < rightTrimmedPrefix) return;
    words.push({
      ...word,
      id: uniqueWordId(word.id, used, merged.id, 'right', index),
      startOffset: rightBase + word.startOffset - rightTrimmedPrefix,
      endOffset: rightBase + word.endOffset - rightTrimmedPrefix,
      needsReview: rightResolution.state === 'partial' && index === 0 ? true : word.needsReview,
    });
  });
  if (!words.length) return undefined;

  const timing: CaptionWordTiming = { version: 1, text: merged.text, words };
  const candidate = { ...merged, wordTiming: timing };
  const resolution = resolveCaptionWordTiming(candidate);
  return resolution.state === 'ready' || resolution.state === 'partial' ? timing : undefined;
}

/** Merge adjacent editable cues using CaptionEditor's established Khmer/punctuation spacing rules. */
export function mergeCaptionsForEditing(left: CaptionSegment, right: CaptionSegment, id: string): CaptionSegment | null {
  if (left.textLocked || left.timingLocked || right.textLocked || right.timingLocked || !id) return null;
  if (![left.startMs, left.endMs, right.startMs, right.endMs].every(Number.isFinite)
    || left.endMs <= left.startMs || right.endMs <= right.startMs) return null;

  const joined = joinCaptionText(left.text, right.text);
  const base = withoutWordTiming(left);
  let merged: CaptionSegment = {
    ...base,
    id,
    // Intentional overlaps can nest one cue inside another. Preserve the full
    // combined interval without shifting any of the retained word timings.
    startMs: Math.min(left.startMs, right.startMs),
    endMs: Math.max(left.endMs, right.endMs),
    text: joined.text,
    timingSource: 'manual',
    timingQuality: 'medium',
    approved: false,
  };
  const timing = mergedTrack(merged, left, right, joined.left, joined.right, joined.separator);
  if (timing) merged = { ...merged, wordTiming: timing };
  return merged;
}
