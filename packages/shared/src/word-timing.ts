import type { CaptionProject, CaptionSegment, TimedToken } from './index.js';

export type CaptionWordSource = 'aligned' | 'manual' | 'estimated';

export interface CaptionWord {
  id: string;
  /** Half-open UTF-16 offsets into CaptionWordTiming.text. Both offsets must be grapheme boundaries. */
  startOffset: number;
  endOffset: number;
  /** Absolute media time. Null means no safe word interval is currently available. */
  startMs: number | null;
  endMs: number | null;
  source: CaptionWordSource;
  /** The interval was carried through an edit or otherwise needs a fresh local alignment before highlighting. */
  needsReview?: boolean;
}

export interface CaptionWordTiming {
  version: 1;
  /** Exact caption text snapshot used by every stored offset. */
  text: string;
  words: CaptionWord[];
}

export interface CaptionWordTimingResolution {
  state: 'ready' | 'partial' | 'missing' | 'stale';
  words: CaptionWord[];
  reason?: string;
}

interface SpeechUnit {
  startOffset: number;
  endOffset: number;
  key: string;
}

const KHMER_DIGITS: Record<string, string> = {
  '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4',
  '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9',
};

function normalizeWordKey(value: string) {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('en')
    .replace(/[០-៩]/g, (digit) => KHMER_DIGITS[digit] ?? digit)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function graphemeBoundaries(text: string) {
  if (typeof Intl.Segmenter !== 'function') return null;
  const boundaries = new Set<number>([0, text.length]);
  const segmenter = new Intl.Segmenter('km', { granularity: 'grapheme' });
  for (const item of segmenter.segment(text)) {
    boundaries.add(item.index);
    boundaries.add(item.index + item.segment.length);
  }
  return boundaries;
}

function speechUnits(text: string): SpeechUnit[] | null {
  if (typeof Intl.Segmenter !== 'function') return null;
  const segments = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)];
  const units: SpeechUnit[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.isWordLike) continue;
    const startOffset = segment.index;
    let endOffset = startOffset + segment.segment.length;

    // Keep punctuation/symbol suffixes attached to the spoken unit when they are
    // directly adjacent. Whitespace and the next word remain separate display text.
    for (let nextIndex = index + 1; nextIndex < segments.length; nextIndex += 1) {
      const next = segments[nextIndex];
      if (next.index !== endOffset || next.isWordLike || /\s/u.test(next.segment)) break;
      endOffset += next.segment.length;
      index = nextIndex;
    }

    const key = normalizeWordKey(text.slice(startOffset, endOffset));
    if (key) units.push({ startOffset, endOffset, key });
  }
  return units;
}

function isIgnorableText(value: string) {
  return /^[\s\p{P}\p{S}\p{Cf}]*$/u.test(value);
}

function hasValidInterval(word: CaptionWord) {
  return word.startMs !== null
    && word.endMs !== null
    && Number.isFinite(word.startMs)
    && Number.isFinite(word.endMs)
    && word.endMs > word.startMs;
}

function quantizeMs(value: number) {
  return Math.round(value / 10) * 10;
}

function cloneWord(word: CaptionWord, unit: SpeechUnit): CaptionWord {
  return {
    ...word,
    startOffset: unit.startOffset,
    endOffset: unit.endOffset,
  };
}

function unresolvedWord(captionId: string, unit: SpeechUnit, index: number): CaptionWord {
  return {
    id: `${captionId}:word:${index}:${unit.startOffset}-${unit.endOffset}`,
    startOffset: unit.startOffset,
    endOffset: unit.endOffset,
    startMs: null,
    endMs: null,
    source: 'estimated',
    needsReview: true,
  };
}

function withoutWordTiming(caption: CaptionSegment) {
  if (!('wordTiming' in caption)) return caption;
  const { wordTiming: _wordTiming, ...rest } = caption;
  return rest as CaptionSegment;
}

function tokenNearCaption(token: TimedToken, caption: CaptionSegment, paddingMs: number) {
  return Number.isFinite(token.startMs)
    && Number.isFinite(token.endMs)
    && token.endMs > token.startMs
    && token.endMs >= caption.startMs - paddingMs
    && token.startMs <= caption.endMs + paddingMs;
}

function exactTokenWindow(caption: CaptionSegment, tokens: TimedToken[]) {
  if (!caption.text || !tokens.length) return undefined;
  const cueDuration = Math.max(1, caption.endMs - caption.startMs);
  const paddingMs = Math.min(2_000, Math.max(500, cueDuration));
  const near = tokens.flatMap((token, index) => tokenNearCaption(token, caption, paddingMs) ? [index] : []);
  if (!near.length) return undefined;
  const first = Math.max(0, near[0]);
  const last = Math.min(tokens.length - 1, near[near.length - 1]);
  const matches: Array<{ start: number; end: number }> = [];

  for (let start = first; start <= last; start += 1) {
    let built = '';
    for (let end = start; end <= last; end += 1) {
      const token = tokens[end];
      if (!token || !tokenNearCaption(token, caption, paddingMs) || typeof token.text !== 'string' || !token.text) break;
      if (end > start && token.spaceBefore) built += ' ';
      built += token.text;
      if (!caption.text.startsWith(built)) break;
      if (built === caption.text) {
        matches.push({ start, end });
        break;
      }
    }
  }

  return matches.length === 1 ? matches[0] : undefined;
}

interface TimedTokenSpan {
  token: TimedToken;
  startOffset: number;
  endOffset: number;
}

function tokenSpans(tokens: TimedToken[]) {
  const spans: TimedTokenSpan[] = [];
  let text = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (index > 0 && token.spaceBefore) text += ' ';
    const startOffset = text.length;
    text += token.text;
    spans.push({ token, startOffset, endOffset: text.length });
  }
  return { text, spans };
}

function exactSpacingChar(value: string) {
  return /[\s\u200B]/u.test(value);
}

function skipExactSpacing(text: string, startOffset: number) {
  let offset = startOffset;
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    if (!exactSpacingChar(value)) break;
    offset += value.length;
  }
  return offset;
}

/**
 * Map locally-aligned exact wording back to the user's untouched caption text.
 * `spaceBefore` is intentionally ignored: Khmer spacing normalization may have
 * changed it after alignment even though token lexical text still came from this
 * exact caption. Only original whitespace/ZWSP may be skipped during matching;
 * every other code point (including punctuation, case and spelling) is literal.
 */
function exactTextTokenSpans(caption: CaptionSegment, tokens: TimedToken[]): TimedTokenSpan[] | undefined {
  if (!caption.text || !tokens.length) return undefined;
  const spans: TimedTokenSpan[] = [];
  const ids = new Set<string>();
  let cursor = 0;

  for (const token of tokens) {
    if (!token.id || ids.has(token.id) || typeof token.text !== 'string' || !token.text) return undefined;
    ids.add(token.id);

    let startOffset: number | null = null;
    let endOffset: number | null = null;
    for (const tokenChar of token.text) {
      if (exactSpacingChar(tokenChar)) continue;
      cursor = skipExactSpacing(caption.text, cursor);
      if (!caption.text.startsWith(tokenChar, cursor)) return undefined;
      if (startOffset === null) startOffset = cursor;
      cursor += tokenChar.length;
      endOffset = cursor;
    }
    // Aligned timing tokens should own at least one literal non-spacing code point.
    if (startOffset === null || endOffset === null) return undefined;
    spans.push({ token, startOffset, endOffset });
  }

  cursor = skipExactSpacing(caption.text, cursor);
  return cursor === caption.text.length ? spans : undefined;
}

function groupSource(tokens: TimedToken[]): CaptionWordSource {
  if (tokens.every((token) => token.timingSource === 'manual')) return 'manual';
  if (tokens.every((token) => token.timingSource === 'stt')) return 'aligned';
  return 'estimated';
}

function intervalCollapsesOnTimingGrid(startMs: number | null, endMs: number | null) {
  return startMs !== null && endMs !== null && quantizeMs(endMs) <= quantizeMs(startMs);
}

function hydrationWording(value: string) {
  // Legacy hydration is an identity check, not fuzzy transcript matching. Remove
  // only display spacing (including zero-width spaces) after NFC normalization;
  // case, punctuation, digits, spelling and every lexical code point must agree.
  return value.normalize('NFC').replace(/[\s\u200B]/gu, '');
}

function groupNeedsReview(
  tokens: TimedToken[],
  source: CaptionWordSource,
  intervalValid: boolean,
  startMs: number | null,
  endMs: number | null,
) {
  if (source === 'estimated' || !intervalValid || intervalCollapsesOnTimingGrid(startMs, endMs)) return true;
  return tokens.some((token) => (
    (typeof token.confidence === 'number' && Number.isFinite(token.confidence) && token.confidence < 0.5)
    || (typeof token.alignmentScore === 'number' && Number.isFinite(token.alignmentScore) && token.alignmentScore < 0.55)
  ));
}

function buildCaptionWordTimingFromSpans(caption: CaptionSegment, spans: TimedTokenSpan[]) {
  const boundaries = graphemeBoundaries(caption.text);
  if (!boundaries || !spans.length) return undefined;
  const tokenIds = new Set<string>();
  for (const { token } of spans) {
    if (!token.id || tokenIds.has(token.id)) return undefined;
    tokenIds.add(token.id);
  }

  const words: CaptionWord[] = [];
  for (let index = 0; index < spans.length;) {
    const firstSpan = spans[index];
    if (isIgnorableText(caption.text.slice(firstSpan.startOffset, firstSpan.endOffset))) {
      index += 1;
      continue;
    }
    if (!boundaries.has(firstSpan.startOffset)) return undefined;
    let end = index;
    while (end < spans.length && !boundaries.has(spans[end].endOffset)) end += 1;
    if (end >= spans.length) return undefined;
    const lastSpan = spans[end];
    const groupTokens = spans.slice(index, end + 1).map((span) => span.token);
    const groupText = caption.text.slice(firstSpan.startOffset, lastSpan.endOffset);
    if (isIgnorableText(groupText)) {
      index = end + 1;
      continue;
    }
    const validTiming = groupTokens.every((token) => Number.isFinite(token.startMs) && Number.isFinite(token.endMs) && token.endMs > token.startMs);
    const startMs = validTiming ? groupTokens[0].startMs : null;
    const endMs = validTiming ? groupTokens[groupTokens.length - 1].endMs : null;
    const intervalValid = startMs !== null && endMs !== null && endMs > startMs;
    const source = intervalValid ? groupSource(groupTokens) : 'estimated';
    const needsReview = groupNeedsReview(groupTokens, source, intervalValid, startMs, endMs);
    words.push({
      id: groupTokens.map((token) => token.id).join('~'),
      startOffset: firstSpan.startOffset,
      endOffset: lastSpan.endOffset,
      startMs: intervalValid ? startMs : null,
      endMs: intervalValid ? endMs : null,
      source,
      needsReview: needsReview ? true : undefined,
    });
    index = end + 1;
  }
  if (!words.length) return undefined;
  const timing: CaptionWordTiming = { version: 1, text: caption.text, words };
  return resolveCaptionWordTiming({ ...caption, wordTiming: timing }).state === 'stale' ? undefined : timing;
}

export function buildCaptionWordTiming(caption: CaptionSegment, tokens: TimedToken[]): CaptionWordTiming | undefined {
  if (!tokens.length || typeof Intl.Segmenter !== 'function' || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return undefined;
  const window = exactTokenWindow(caption, tokens);
  if (!window) return undefined;
  const matched = tokens.slice(window.start, window.end + 1);
  const { text, spans } = tokenSpans(matched);
  if (text !== caption.text) return undefined;
  return buildCaptionWordTimingFromSpans(caption, spans);
}

/**
 * Build word timing for a user-owned exact-text local alignment. Unlike legacy
 * hydration, this path owns the selected clip and therefore maps every aligned
 * token literally back onto the original caption string instead of trusting
 * normalized `spaceBefore` metadata. The user's text is never rewritten.
 */
export function buildCaptionWordTimingForExactText(caption: CaptionSegment, tokens: TimedToken[]): CaptionWordTiming | undefined {
  if (!tokens.length || typeof Intl.Segmenter !== 'function' || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return undefined;
  const spans = exactTextTokenSpans(caption, tokens);
  return spans ? buildCaptionWordTimingFromSpans(caption, spans) : undefined;
}

/**
 * Read-only compatibility hydration for projects created before CaptionWordTiming
 * was persisted on each cue. Hydration is allowed only when the complete current
 * caption wording is still exactly the canonical timed transcript wording after
 * NFC + whitespace/ZWSP removal. A single corrected lexical character blocks all
 * inferred legacy tracks so old canonical timing can never reappear after an edit.
 */
export function hydrateCaptionWordTimings(project: CaptionProject): CaptionProject {
  const tokens = project.transcript?.tokens;
  if (project.transcriptNeedsSync || !tokens?.length || !project.captions.length) return project;

  const captionWording = hydrationWording(project.captions.map((caption) => caption.text).join(''));
  const canonicalWording = hydrationWording(tokens.map((token) => token.text).join(''));
  if (!captionWording || captionWording !== canonicalWording) return project;

  let changed = false;
  const captions = project.captions.map((caption) => {
    if (caption.wordTiming) return caption;
    const wordTiming = buildCaptionWordTiming(caption, tokens);
    if (!wordTiming) return caption;
    changed = true;
    return { ...caption, wordTiming };
  });
  return changed ? { ...project, captions } : project;
}

/**
 * Explicit recovery path for captions that have editable text but no trustworthy
 * transcript-token linkage. Nothing is timed until the user supplies intervals.
 */
export function createUntimedCaptionWordTiming(caption: CaptionSegment): CaptionSegment {
  const boundaries = graphemeBoundaries(caption.text);
  const units = speechUnits(caption.text);
  if (!boundaries || !units?.length) return caption;
  if (units.some((unit) => !boundaries.has(unit.startOffset) || !boundaries.has(unit.endOffset))) return caption;
  return {
    ...caption,
    wordTiming: {
      version: 1,
      text: caption.text,
      words: units.map((unit, index) => unresolvedWord(caption.id, unit, index)),
    },
  };
}

export function resolveCaptionWordTiming(caption: CaptionSegment): CaptionWordTimingResolution {
  const raw = (caption as { wordTiming?: unknown }).wordTiming;
  if (raw == null) return { state: 'missing', words: [] };
  if (typeof raw !== 'object') return { state: 'stale', words: [], reason: 'Word timing data is malformed.' };
  const timing = raw as Partial<CaptionWordTiming>;
  if (timing.version !== 1 || typeof timing.text !== 'string' || !Array.isArray(timing.words)) {
    return { state: 'stale', words: [], reason: 'Word timing data is malformed.' };
  }
  if (timing.text !== caption.text) {
    return { state: 'stale', words: [], reason: 'Word timing belongs to different caption text.' };
  }

  const boundaries = graphemeBoundaries(timing.text);
  if (!boundaries) return { state: 'stale', words: [], reason: 'Unicode grapheme segmentation is unavailable.' };
  const words = timing.words as unknown[];

  const ids = new Set<string>();
  let previousTextEnd = 0;
  let previousTimeEnd = Number.NEGATIVE_INFINITY;
  let partialReason = '';

  for (let index = 0; index < words.length; index += 1) {
    const rawWord = words[index];
    if (!rawWord || typeof rawWord !== 'object') {
      return { state: 'stale', words: [], reason: 'Word timing data is malformed.' };
    }
    const word = rawWord as Partial<CaptionWord>;
    if (
      typeof word.id !== 'string'
      || !word.id
      || ids.has(word.id)
      || !Number.isInteger(word.startOffset)
      || !Number.isInteger(word.endOffset)
      || (word.startOffset as number) < 0
      || (word.endOffset as number) <= (word.startOffset as number)
      || (word.endOffset as number) > timing.text.length
      || (word.startOffset as number) < previousTextEnd
      || !boundaries.has(word.startOffset as number)
      || !boundaries.has(word.endOffset as number)
      || typeof word.source !== 'string'
      || !['aligned', 'manual', 'estimated'].includes(word.source)
      || (word.needsReview !== undefined && typeof word.needsReview !== 'boolean')
    ) {
      return { state: 'stale', words: [], reason: 'Word timing offsets are invalid for this caption text.' };
    }
    const startOffset = word.startOffset as number;
    const endOffset = word.endOffset as number;
    if (!isIgnorableText(timing.text.slice(previousTextEnd, startOffset)) || isIgnorableText(timing.text.slice(startOffset, endOffset))) {
      return { state: 'stale', words: [], reason: 'Word timing does not safely cover this caption text.' };
    }
    ids.add(word.id);
    previousTextEnd = endOffset;

    const startMs = word.startMs;
    const endMs = word.endMs;
    const bothNull = startMs === null && endMs === null;
    if (bothNull) {
      partialReason ||= 'At least one word needs timing realignment.';
      continue;
    }
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { state: 'stale', words: [], reason: 'A word timing interval is invalid.' };
    }
    if (startMs < previousTimeEnd) partialReason ||= 'Word timing intervals overlap or are out of order.';
    previousTimeEnd = Math.max(previousTimeEnd, endMs);
    if (intervalCollapsesOnTimingGrid(startMs, endMs)) {
      partialReason ||= 'A word timing interval collapses on the 10 ms timing grid.';
    }
    if (startMs < caption.startMs || endMs > caption.endMs) {
      partialReason ||= 'A word timing interval falls outside the caption timing.';
    }
    if (word.source === 'estimated' || word.needsReview) {
      partialReason ||= 'At least one word needs timing realignment.';
    }
  }

  if (!words.length || !isIgnorableText(timing.text.slice(previousTextEnd))) {
    return { state: 'stale', words: [], reason: 'Word timing does not safely cover this caption text.' };
  }

  return partialReason
    ? { state: 'partial', words: words as CaptionWord[], reason: partialReason }
    : { state: 'ready', words: words as CaptionWord[] };
}

export function reconcileCaptionWordTiming(before: CaptionSegment, after: CaptionSegment): CaptionSegment {
  if (before === after) return after;
  const afterOwnsTrack = Object.prototype.hasOwnProperty.call(after, 'wordTiming');
  if (afterOwnsTrack && after.wordTiming == null && before.wordTiming != null) return after;
  if (
    before.text === after.text
    && before.startMs === after.startMs
    && before.endMs === after.endMs
    && before.wordTiming === after.wordTiming
  ) return after;

  // A caller may have already supplied a freshly built/manual track. Preserve it
  // only when it is structurally valid for the new caption and differs from old data.
  if (afterOwnsTrack && after.wordTiming && after.wordTiming !== before.wordTiming) {
    const explicit = resolveCaptionWordTiming(after);
    if (explicit.state !== 'stale' && explicit.state !== 'missing') return after;
    return withoutWordTiming(after);
  }

  if (!before.wordTiming) return after.wordTiming ? withoutWordTiming(after) : after;
  const beforeResolution = resolveCaptionWordTiming(before);
  if (beforeResolution.state === 'stale' || beforeResolution.state === 'missing') return withoutWordTiming(after);

  const oldTiming = before.wordTiming;

  const deltaStart = after.startMs - before.startMs;
  const deltaEnd = after.endMs - before.endMs;
  const uniformMove = Number.isFinite(deltaStart) && deltaStart === deltaEnd && deltaStart !== 0;

  let words: CaptionWord[];
  if (before.text === after.text) {
    words = oldTiming.words.map((word) => ({ ...word }));
  } else {
    const oldUnits = speechUnits(before.text);
    const newUnits = speechUnits(after.text);
    const oldTrackMatchesIcu = oldUnits
      && oldUnits.length === oldTiming.words.length
      && oldUnits.every((unit, index) => unit.startOffset === oldTiming.words[index].startOffset && unit.endOffset === oldTiming.words[index].endOffset);
    if (!oldUnits || !newUnits || !oldTrackMatchesIcu) return withoutWordTiming(after);
    let prefix = 0;
    while (prefix < oldUnits.length && prefix < newUnits.length && oldUnits[prefix].key === newUnits[prefix].key) prefix += 1;

    let suffix = 0;
    while (
      suffix < oldUnits.length - prefix
      && suffix < newUnits.length - prefix
      && oldUnits[oldUnits.length - 1 - suffix].key === newUnits[newUnits.length - 1 - suffix].key
    ) suffix += 1;

    const oldMiddle = oldUnits.slice(prefix, oldUnits.length - suffix);
    const newMiddle = newUnits.slice(prefix, newUnits.length - suffix);
    const changedKeys = new Set([...oldMiddle, ...newMiddle].map((unit) => unit.key));
    const preserved = new Map<number, number>();

    for (let index = 0; index < prefix; index += 1) {
      if (!changedKeys.has(newUnits[index].key)) preserved.set(index, index);
    }
    for (let offset = 0; offset < suffix; offset += 1) {
      const newIndex = newUnits.length - suffix + offset;
      const oldIndex = oldUnits.length - suffix + offset;
      if (!changedKeys.has(newUnits[newIndex].key)) preserved.set(newIndex, oldIndex);
    }

    const oneToOneChange = oldMiddle.length === 1 && newMiddle.length === 1;
    words = newUnits.map((unit, index) => {
      const oldIndex = preserved.get(index);
      if (oldIndex !== undefined) return cloneWord(oldTiming.words[oldIndex], unit);

      if (oneToOneChange && index === prefix) {
        const oldWord = oldTiming.words[prefix];
        return {
          ...cloneWord(oldWord, unit),
          needsReview: true,
        };
      }
      return unresolvedWord(after.id, unit, index);
    });
  }

  if (uniformMove) {
    words = words.map((word) => hasValidInterval(word) ? {
      ...word,
      startMs: word.startMs! + deltaStart,
      endMs: word.endMs! + deltaStart,
    } : word);
  } else if (after.startMs !== before.startMs || after.endMs !== before.endMs) {
    words = words.map((word) => hasValidInterval(word)
      && (word.startMs! < after.startMs || word.endMs! > after.endMs)
      ? { ...word, needsReview: true }
      : word);
  }

  const reconciled: CaptionSegment = {
    ...after,
    wordTiming: { version: 1, text: after.text, words },
  };
  const resolved = resolveCaptionWordTiming(reconciled);
  return resolved.state === 'stale' ? withoutWordTiming(after) : reconciled;
}

export function editCaptionWord(
  caption: CaptionSegment,
  wordId: string,
  patch: { startMs: number; endMs: number },
): CaptionSegment {
  if (caption.timingLocked || !caption.wordTiming) return caption;
  const resolved = resolveCaptionWordTiming(caption);
  if (resolved.state === 'stale' || resolved.state === 'missing') return caption;
  if (!Number.isFinite(patch.startMs) || !Number.isFinite(patch.endMs) || patch.endMs <= patch.startMs) return caption;
  const startMs = quantizeMs(patch.startMs);
  const endMs = quantizeMs(patch.endMs);
  if (endMs - startMs < 10 || startMs < caption.startMs || endMs > caption.endMs) return caption;

  const index = caption.wordTiming.words.findIndex((word) => word.id === wordId);
  if (index < 0) return caption;
  const current = caption.wordTiming.words[index];
  if (current.startMs === startMs && current.endMs === endMs && current.source === 'manual' && !current.needsReview) return caption;

  const previous = caption.wordTiming.words[index - 1];
  const next = caption.wordTiming.words[index + 1];
  if (previous && hasValidInterval(previous) && previous.endMs! > startMs) return caption;
  if (next && hasValidInterval(next) && next.startMs! < endMs) return caption;

  const words = caption.wordTiming.words.map((word, wordIndex) => wordIndex === index ? {
    ...word,
    startMs,
    endMs,
    source: 'manual' as const,
    needsReview: undefined,
  } : word);
  const edited: CaptionSegment = {
    ...caption,
    timingSource: 'manual',
    timingQuality: 'medium',
    approved: false,
    wordTiming: { ...caption.wordTiming, words },
  };
  return resolveCaptionWordTiming(edited).state === 'stale' ? caption : edited;
}
