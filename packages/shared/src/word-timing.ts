import type { CaptionProject, CaptionSegment, TimedToken } from './index.js';
import { captionRenderTime } from './caption-settings.js';
import { segmentKhmerWords } from './khmer-word-segmentation.js';
import { highlightDisplayUnits } from './highlight-display-units.js';

export type CaptionWordSource = 'aligned' | 'manual' | 'estimated';
export type WordMethod = 'kfa' | 'kfa-group' | 'legacy' | 'manual';
export type WordIssue = 'missing' | 'text-mismatch' | 'no-fit' | 'budget'
  | 'edited' | 'outside-cue' | 'grid-collapse' | 'time-conflict'
  | 'ambiguous-occurrence' | 'discontinuous' | 'manual-conflict';
export type DisplaySpan = [startOffset: number, endOffset: number];

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
  method?: WordMethod;
  issue?: WordIssue;
  members?: DisplaySpan[];
}

export interface CaptionWordTiming {
  version: 1;
  evidence?: 2;
  /** Exact caption text snapshot used by every stored offset. */
  text: string;
  words: CaptionWord[];
  basis?: string;
}

export type CaptionDataWord = Omit<CaptionWord, 'id'>;
export type CaptionDataWordTiming =
  Omit<CaptionWordTiming, 'words' | 'basis'> & { words: CaptionDataWord[] };
export type WordHighlightFollow = {
  version: 1; mediaFingerprint: string; epoch: string; enabled: boolean;
};

export type Coverage = 'full-individual' | 'full-with-groups' | 'partial' | 'none';
export type PaintSpan = {
  startOffset: number; endOffset: number; startMs: number; endMs: number;
};
export type HighlightProblem = {
  offsets: DisplaySpan | null; code: WordIssue | 'stale' | 'locked';
};
export interface HighlightPlan {
  coverage: Coverage;
  spokenUnits: number;
  paintedUnits: number;
  spans: PaintSpan[];
  issues: HighlightProblem[];
}
export type HighlightPolicy = 'measured-and-manual';
export type WordExport = { ready: true; words: CaptionWord[] }
  | { ready: false; reason: string };
export type HighlightAttention = 'ok' | 'needs-attention' | 'not-applicable';

export const CAPTION_DATA_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxCaptions: 20_000,
  maxWordsPerCaption: 5_000,
  maxTotalWords: 100_000,
  maxGraphemesPerCaption: 10_000,
  maxTotalGraphemes: 500_000,
  maxTimelineMs: 7 * 24 * 60 * 60 * 1_000,
});

const WORD_ISSUES = new Set<unknown>([
  'missing', 'text-mismatch', 'no-fit', 'budget', 'edited', 'outside-cue',
  'grid-collapse', 'time-conflict', 'ambiguous-occurrence', 'discontinuous', 'manual-conflict',
] satisfies WordIssue[]);

export interface CaptionEdgeRepair {
  before: CaptionSegment[];
  after: CaptionSegment[];
  guards: CaptionSegment[];
}

export interface CaptionWordTimingResolution {
  state: 'ready' | 'partial' | 'missing' | 'stale';
  words: CaptionWord[];
  reason?: string;
}

export interface CaptionWordTimingBuildOptions {
  /** Direct forced-alignment path scores are not calibrated ASR confidence. */
  ignoreConfidenceForReview?: boolean;
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
  const segments = segmentKhmerWords(text);
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
  options?: CaptionWordTimingBuildOptions,
) {
  if (source === 'estimated' || !intervalValid || intervalCollapsesOnTimingGrid(startMs, endMs)) return true;
  return tokens.some((token) => (
    (!options?.ignoreConfidenceForReview && typeof token.confidence === 'number' && Number.isFinite(token.confidence) && token.confidence < 0.5)
    || (typeof token.alignmentScore === 'number' && Number.isFinite(token.alignmentScore) && token.alignmentScore < 0.55)
  ));
}

function buildCaptionWordTimingFromSpans(caption: CaptionSegment, spans: TimedTokenSpan[], options?: CaptionWordTimingBuildOptions) {
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
    const needsReview = groupNeedsReview(groupTokens, source, intervalValid, startMs, endMs, options);
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
export function buildCaptionWordTimingForExactText(
  caption: CaptionSegment,
  tokens: TimedToken[],
  options?: CaptionWordTimingBuildOptions,
): CaptionWordTiming | undefined {
  if (!tokens.length || typeof Intl.Segmenter !== 'function' || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return undefined;
  const spans = exactTextTokenSpans(caption, tokens);
  return spans ? buildCaptionWordTimingFromSpans(caption, spans, options) : undefined;
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

/** Marker presence selects the marked path, including unsupported marker values. */
export function hasWordTimingEvidence(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'evidence');
}

type MarkedWordTimingValidation = { ok: true; timing: CaptionWordTiming & { evidence: 2 } }
  | { ok: false; reason: string };

export function validateMarkedWordTiming(text: string, raw: unknown, durationMs?: number): MarkedWordTimingValidation {
  const invalid = (reason: string) => ({ ok: false as const, reason });
  if (!hasWordTimingEvidence(raw) || Array.isArray(raw)) return invalid('Word timing evidence is absent.');
  const timing = raw as Partial<CaptionWordTiming>;
  if (timing.version !== 1 || timing.evidence !== 2 || !Array.isArray(timing.words)) {
    return invalid('Word timing evidence has an unsupported version or shape.');
  }
  if (typeof text !== 'string' || timing.text !== text) return invalid('Word timing belongs to different caption text.');
  if (timing.basis !== undefined && typeof timing.basis !== 'string') return invalid('Word timing basis is invalid.');
  const { maxWordsPerCaption, maxGraphemesPerCaption, maxTimelineMs } = CAPTION_DATA_LIMITS;
  if (timing.words.length > maxWordsPerCaption || text.length > CAPTION_DATA_LIMITS.maxBytes) {
    return invalid('Word timing exceeds the caption data limits.');
  }
  const boundaries = graphemeBoundaries(text);
  if (!boundaries) return invalid('Unicode grapheme segmentation is unavailable.');
  if (boundaries.size - 1 > maxGraphemesPerCaption) return invalid('Word timing exceeds the caption data limits.');
  const validOffsets = (start: number, end: number, previous: number) =>
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= previous && end > start
    && boundaries.has(start) && boundaries.has(end)
    && isIgnorableText(text.slice(previous, start)) && !isIgnorableText(text.slice(start, end));
  const ids = new Set<string>();
  const words: CaptionWord[] = [];
  let previousEnd = 0;
  let units = 0;
  for (const word of timing.words) {
    if (!word || typeof word !== 'object' || Array.isArray(word)
      || typeof word.id !== 'string' || !word.id || word.id.length > 128 || ids.has(word.id)
      || !validOffsets(word.startOffset, word.endOffset, previousEnd)) {
      return invalid('Word timing offsets or identifiers are invalid for this caption text.');
    }
    const { id, startOffset, endOffset, startMs, endMs, source, needsReview, method, issue } = word;
    if ((needsReview !== undefined && typeof needsReview !== 'boolean') || (issue !== undefined && !WORD_ISSUES.has(issue))) {
      return invalid('A word timing review flag or issue is invalid.');
    }
    if (startMs === null && endMs === null) {
      if (source !== 'estimated' || needsReview !== true || issue === undefined || method !== undefined) {
        return invalid('An untimed word must carry a review issue.');
      }
    } else {
      if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isFinite(startMs)
        || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > maxTimelineMs
        || (durationMs !== undefined && endMs > durationMs)) {
        return invalid('A word timing interval is invalid.');
      }
      const aligned = source === 'aligned' && (method === 'kfa' || method === 'kfa-group' || method === 'legacy');
      if (!aligned && !(source === 'manual' && method === 'manual')) {
        return invalid('A word timing source and method do not agree.');
      }
    }
    let members: DisplaySpan[] | undefined;
    if (word.members !== undefined) {
      if (method === undefined || method === 'kfa' || !Array.isArray(word.members) || word.members.length < 2
        || units + word.members.length > maxWordsPerCaption) return invalid('The word timing group is invalid.');
      members = [];
      let previousMemberEnd = startOffset;
      for (const member of word.members) {
        if (!Array.isArray(member) || member.length !== 2
          || !validOffsets(member[0], member[1], previousMemberEnd) || member[1] > endOffset) {
          return invalid('The word timing group does not cover its word span.');
        }
        members.push([member[0], member[1]]);
        previousMemberEnd = member[1];
      }
      if (members[0][0] !== startOffset || previousMemberEnd !== endOffset) {
        return invalid('The word timing group does not cover its word span.');
      }
    } else if (method === 'kfa-group') {
      return invalid('The word timing group has no member spans.');
    }
    ids.add(id);
    previousEnd = endOffset;
    units += members?.length ?? 1;
    if (units > maxWordsPerCaption) return invalid('Word timing exceeds the caption data limits.');
    words.push({
      id, startOffset, endOffset, startMs, endMs, source,
      ...(needsReview !== undefined ? { needsReview } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(members !== undefined ? { members } : {}),
    });
  }
  if (!isIgnorableText(text.slice(previousEnd))) return invalid('Word timing does not safely cover this caption text.');
  return { ok: true, timing: {
    version: 1, evidence: 2, text, words, ...(timing.basis !== undefined ? { basis: timing.basis } : {}),
  } };
}

function eligibleWord(word: CaptionWord): word is CaptionWord & { startMs: number; endMs: number } {
  // Source and method have already been checked by the marked validator.
  return word.startMs !== null && word.endMs !== null && !word.needsReview && word.issue === undefined;
}

interface PaintCandidate {
  span: PaintSpan;
  rawStart: number;
  rawEnd: number;
  manual: boolean;
  units: number;
  index: number;
}

/** Compare each automatic candidate with all peers and each manual candidate with manual peers.
 * Use the original candidates so a suppressed interval cannot hide a conflict.
 */
function paintConflicts(candidates: PaintCandidate[]) {
  const conflicts = new Set<number>();
  let rawEnd = -Infinity;
  let gridEnd = -Infinity;
  let manualRawEnd = -Infinity;
  let manualGridEnd = -Infinity;
  for (const entry of candidates) {
    if (entry.rawStart < (entry.manual ? manualRawEnd : rawEnd)
      || entry.span.startMs < (entry.manual ? manualGridEnd : gridEnd)) conflicts.add(entry.index);
    rawEnd = Math.max(rawEnd, entry.rawEnd);
    gridEnd = Math.max(gridEnd, entry.span.endMs);
    if (entry.manual) {
      manualRawEnd = Math.max(manualRawEnd, entry.rawEnd);
      manualGridEnd = Math.max(manualGridEnd, entry.span.endMs);
    }
  }
  let rawStart = Infinity;
  let gridStart = Infinity;
  let manualRawStart = Infinity;
  let manualGridStart = Infinity;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    if (entry.rawEnd > (entry.manual ? manualRawStart : rawStart)
      || entry.span.endMs > (entry.manual ? manualGridStart : gridStart)) conflicts.add(entry.index);
    rawStart = Math.min(rawStart, entry.rawStart);
    gridStart = Math.min(gridStart, entry.span.startMs);
    if (entry.manual) {
      manualRawStart = Math.min(manualRawStart, entry.rawStart);
      manualGridStart = Math.min(manualGridStart, entry.span.startMs);
    }
  }
  return conflicts;
}

export function compileHighlightPlan(caption: CaptionSegment, _policy: HighlightPolicy): HighlightPlan {
  if (!hasWordTimingEvidence(caption.wordTiming)) {
    const resolved = resolveCaptionWordTiming(caption);
    if (resolved.state === 'ready') {
      const spans = resolved.words.map(({ startOffset, endOffset, startMs, endMs }) => ({
        startOffset, endOffset, startMs: captionRenderTime(startMs!), endMs: captionRenderTime(endMs!),
      }));
      return { coverage: 'full-individual', spokenUnits: spans.length, paintedUnits: spans.length, spans, issues: [] };
    }
    const code = resolved.state === 'stale' ? 'stale' : 'missing';
    const issues: HighlightProblem[] = [{ offsets: null, code }];
    if (caption.timingLocked) issues.push({ offsets: null, code: 'locked' });
    return { coverage: 'none', spokenUnits: speechUnits(caption.text)?.length ?? 0, paintedUnits: 0, spans: [], issues };
  }

  const validation = validateMarkedWordTiming(caption.text, caption.wordTiming);
  if (!validation.ok) {
    return {
      coverage: 'none', spokenUnits: speechUnits(caption.text)?.length ?? 0, paintedUnits: 0,
      spans: [], issues: [{ offsets: null, code: 'stale' }],
    };
  }
  const candidates: PaintCandidate[] = [];
  const problems: Array<HighlightProblem | undefined> = [];
  let spokenUnits = 0;
  validation.timing.words.forEach((word, index) => {
    const { startOffset, endOffset } = word;
    const offsets: DisplaySpan = [startOffset, endOffset];
    const units = word.members?.length ?? 1;
    spokenUnits += units;
    if (!eligibleWord(word)) {
      problems[index] = { offsets, code: word.issue ?? 'missing' };
      return;
    }
    const rawStart = Math.max(word.startMs, caption.startMs);
    const rawEnd = Math.min(word.endMs, caption.endMs);
    if (!(rawEnd > rawStart)) {
      problems[index] = { offsets, code: 'outside-cue' };
      return;
    }
    const startMs = captionRenderTime(rawStart);
    const endMs = captionRenderTime(rawEnd);
    if (endMs <= startMs) {
      problems[index] = { offsets, code: 'grid-collapse' };
      return;
    }
    candidates.push({ span: { startOffset, endOffset, startMs, endMs }, rawStart, rawEnd, units, index, manual: word.source === 'manual' });
  });

  const conflicts = paintConflicts(candidates);
  const spans: PaintSpan[] = [];
  let paintedUnits = 0;
  for (const { span, units, index } of candidates) {
    if (conflicts.has(index)) problems[index] = { offsets: [span.startOffset, span.endOffset], code: 'time-conflict' };
    else {
      spans.push(span);
      paintedUnits += units;
    }
  }
  let coverage: Coverage = 'none';
  if (paintedUnits > 0) {
    if (paintedUnits < spokenUnits) coverage = 'partial';
    else coverage = paintedUnits > spans.length ? 'full-with-groups' : 'full-individual';
  }
  return { coverage, spokenUnits, paintedUnits, spans, issues: problems.filter((issue) => issue !== undefined) };
}

export function highlightAttention(caption: CaptionSegment): HighlightAttention {
  if (!hasWordTimingEvidence(caption.wordTiming)) {
    return resolveCaptionWordTiming(caption).state === 'ready' ? 'ok' : 'needs-attention';
  }
  const plan = compileHighlightPlan(caption, 'measured-and-manual');
  if (plan.spokenUnits === 0) return 'not-applicable';
  return plan.coverage === 'full-individual' || plan.coverage === 'full-with-groups' ? 'ok' : 'needs-attention';
}

export function resolveWordExport(caption: CaptionSegment): WordExport {
  if (!hasWordTimingEvidence(caption.wordTiming)) {
    const resolved = resolveCaptionWordTiming(caption);
    return resolved.state === 'ready' ? { ready: true, words: resolved.words }
      : { ready: false, reason: resolved.reason || 'This caption has no saved word timing.' };
  }
  const validation = validateMarkedWordTiming(caption.text, caption.wordTiming);
  if (!validation.ok) return { ready: false, reason: validation.reason };
  if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs) || caption.endMs <= caption.startMs) {
    return { ready: false, reason: 'Caption timing is invalid.' };
  }
  const { words } = validation.timing;
  if (!words.length) return { ready: false, reason: 'This caption has no word timing spans.' };
  let previousEnd = caption.startMs;
  for (const word of words) {
    if (word.members) return { ready: false, reason: 'Word-timed files require separate timing for each word in a group.' };
    if (!eligibleWord(word)) return { ready: false, reason: 'At least one word needs usable timing.' };
    if (word.startMs < caption.startMs || word.endMs > caption.endMs) {
      return { ready: false, reason: 'A word timing interval falls outside the caption timing.' };
    }
    if (word.startMs < previousEnd) return { ready: false, reason: 'Word timing intervals overlap or are out of order.' };
    if (captionRenderTime(word.endMs) <= captionRenderTime(word.startMs)) {
      return { ready: false, reason: 'A word timing interval collapses on the 10 ms timing grid.' };
    }
    previousEnd = word.endMs;
  }
  return { ready: true, words };
}

const MAX_AUTO_WORD_TRIM_MS = 50;

/** Trim small conflicts in measured intervals. Keep word onsets when both words
 * are aligned, and keep either edge of a manually timed word. */
export function repairSmallWordTimingBoundaries(caption: CaptionSegment): CaptionWordTiming | undefined {
  const resolved = resolveCaptionWordTiming(caption);
  if (caption.timingLocked || !caption.wordTiming || resolved.state !== 'partial'
    || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)) return undefined;
  if (resolved.words.some((word) => word.needsReview || word.source === 'estimated' || !hasValidInterval(word))) return undefined;

  const words = resolved.words.map((word) => ({
    ...word,
    startMs: Math.max(word.startMs!, caption.startMs),
    endMs: Math.min(word.endMs!, caption.endMs),
  }));
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (previous.endMs <= current.startMs) continue;
    if (previous.startMs >= current.startMs || previous.endMs >= current.endMs) return undefined;
    if (previous.source === 'manual') current.startMs = previous.endMs;
    else previous.endMs = current.startMs;
  }

  const safe = words.every((word, index) => {
    const original = resolved.words[index];
    const trim = (word.startMs - original.startMs!) + (original.endMs! - word.endMs);
    const limit = Math.min(MAX_AUTO_WORD_TRIM_MS, (original.endMs! - original.startMs!) / 4);
    return trim === 0 || (word.source === 'aligned' && trim <= limit && word.endMs - word.startMs >= 10);
  });
  if (!safe) return undefined;
  const timing = { ...caption.wordTiming, words };
  return resolveCaptionWordTiming({ ...caption, wordTiming: timing }).state === 'ready' ? timing : undefined;
}

/** Match existing manual anchors by exact text span, even if alignment chose
 * different IDs. Reject a candidate that cannot carry every manual anchor. */
export function preserveManualCaptionWords(caption: CaptionSegment, timing: CaptionWordTiming): CaptionWordTiming | undefined {
  const existing = caption.wordTiming?.words;
  const manual = Array.isArray(existing) ? existing.filter((word) => word?.source === 'manual') : [];
  if (!manual.length) return timing;
  if (caption.wordTiming?.text !== timing.text) return undefined;
  const anchors = new Map(manual.map((word) => [`${word.startOffset}:${word.endOffset}`, word]));
  const words = timing.words.map((word) => {
    const key = `${word.startOffset}:${word.endOffset}`;
    const anchor = anchors.get(key);
    anchors.delete(key);
    return anchor ?? word;
  });
  return anchors.size ? undefined : { ...timing, words };
}

/** Rebase a stored component without changing its acoustic interval or members. */
export function rebaseMarkedWord(word: CaptionWord, delta: number): CaptionWord {
  return {
    ...word, startOffset: word.startOffset + delta, endOffset: word.endOffset + delta,
    ...(word.members ? { members: word.members.map(([start, end]): DisplaySpan => [start + delta, end + delta]) } : {}),
  };
}

function editedMarkedWord(id: string, startOffset: number, endOffset: number): CaptionWord {
  return { id, startOffset, endOffset, startMs: null, endMs: null, source: 'estimated', needsReview: true, issue: 'edited' };
}

function editedMarkedWordId(used: Set<string>, startOffset: number, endOffset: number) {
  const base = `edited:${startOffset}-${endOffset}`;
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}:${suffix}`;
  used.add(id);
  return id;
}

function demoteAlignedMarkedWords(words: CaptionWord[]): CaptionWord[] {
  const used = new Set(words.map(({ id }) => id));
  return words.flatMap((word) => {
    if (word.source !== 'aligned') return [word];
    const units = word.members ?? [[word.startOffset, word.endOffset]];
    return units.map(([start, end], index) =>
      editedMarkedWord(index === 0 ? word.id : editedMarkedWordId(used, start, end), start, end));
  });
}

/** Build a marked track from surviving components. Uncovered text has no acoustic evidence. */
export function fillEditedMarkedWordTiming(text: string, preserved: CaptionWord[]): CaptionWordTiming | undefined {
  const used = new Set(preserved.map(({ id }) => id));
  const words: CaptionWord[] = [];
  function editedGap(start: number, end: number) {
    for (const unit of highlightDisplayUnits(text.slice(start, end))) {
      const startOffset = start + unit.startOffset;
      const endOffset = start + unit.endOffset;
      words.push(editedMarkedWord(editedMarkedWordId(used, startOffset, endOffset), startOffset, endOffset));
    }
  }
  let previousEnd = 0;
  for (const word of preserved) {
    editedGap(previousEnd, word.startOffset);
    words.push(word);
    previousEnd = word.endOffset;
  }
  editedGap(previousEnd, text.length);
  const verified = validateMarkedWordTiming(text, { version: 1, evidence: 2, text, words });
  return verified.ok ? verified.timing : undefined;
}

/** Saved manual anchors may survive draft recovery. Automatic measurements cannot. */
export function demoteRecoveredMarkedWordTiming(caption: CaptionSegment): CaptionSegment {
  if (!hasWordTimingEvidence(caption.wordTiming)) return caption;
  const validated = validateMarkedWordTiming(caption.text, caption.wordTiming);
  if (!validated.ok) return withoutWordTiming(caption);
  if (!validated.timing.words.some(({ source }) => source === 'aligned')) return caption;
  return {
    ...caption,
    wordTiming: fillEditedMarkedWordTiming(caption.text, demoteAlignedMarkedWords(validated.timing.words)),
  };
}

function preservedMarkedWords(before: CaptionSegment, after: CaptionSegment, words: CaptionWord[]): CaptionWord[] {
  if (before.text === after.text) return words;
  const segmenter = new Intl.Segmenter('km', { granularity: 'grapheme' });
  const oldParts = [...segmenter.segment(before.text)];
  const newParts = [...segmenter.segment(after.text)];
  let prefix = 0;
  while (prefix < oldParts.length && prefix < newParts.length && oldParts[prefix].segment === newParts[prefix].segment) prefix += 1;
  let suffix = 0;
  while (suffix < oldParts.length - prefix && suffix < newParts.length - prefix
    && oldParts[oldParts.length - 1 - suffix].segment === newParts[newParts.length - 1 - suffix].segment) suffix += 1;

  const prefixEnd = newParts[prefix]?.index ?? after.text.length;
  const oldSuffixStart = oldParts[oldParts.length - suffix]?.index ?? before.text.length;
  const newSuffixStart = newParts[newParts.length - suffix]?.index ?? after.text.length;
  const oldUnits = highlightDisplayUnits(before.text);
  const newUnits = highlightDisplayUnits(after.text);
  const oldMiddle = oldUnits.filter((unit) => unit.endOffset > prefixEnd && unit.startOffset < oldSuffixStart);
  const newMiddle = newUnits.filter((unit) => unit.endOffset > prefixEnd && unit.startOffset < newSuffixStart);
  const changedKeys = new Set([
    ...oldMiddle.map((unit) => normalizeWordKey(before.text.slice(unit.startOffset, unit.endOffset))),
    ...newMiddle.map((unit) => normalizeWordKey(after.text.slice(unit.startOffset, unit.endOffset))),
  ]);
  const suffixDelta = after.text.length - before.text.length;
  return words.flatMap((word) => {
    const rebased = word.endOffset <= prefixEnd ? word
      : word.startOffset >= oldSuffixStart ? rebaseMarkedWord(word, suffixDelta) : undefined;
    if (!rebased || newMiddle.some((unit) => unit.endOffset > rebased.startOffset && unit.startOffset < rebased.endOffset)) return [];
    const members = word.members ?? [[word.startOffset, word.endOffset]];
    return members.some(([start, end]) => changedKeys.has(normalizeWordKey(before.text.slice(start, end)))) ? [] : [rebased];
  });
}

function reconcileMarkedWordTiming(before: CaptionSegment, after: CaptionSegment): CaptionSegment {
  const oldTiming = before.wordTiming!;
  const explicit = Object.hasOwn(after, 'wordTiming') && after.wordTiming !== oldTiming
    && JSON.stringify(after.wordTiming) !== JSON.stringify(oldTiming);
  if (explicit) {
    return validateMarkedWordTiming(after.text, after.wordTiming).ok ? after : withoutWordTiming(after);
  }
  const validated = validateMarkedWordTiming(before.text, oldTiming);
  if (!validated.ok) return withoutWordTiming(after);
  const delta = after.startMs - before.startMs;
  const moved = Number.isFinite(delta) && delta !== 0 && delta === after.endMs - before.endMs;
  if (before.text === after.text && !moved) return { ...after, wordTiming: oldTiming };

  let preserved = preservedMarkedWords(before, after, validated.timing.words);
  if (moved) {
    preserved = demoteAlignedMarkedWords(preserved).flatMap((word) => {
      if (word.source !== 'manual') return [word];
      const startMs = word.startMs! + delta;
      const endMs = word.endMs! + delta;
      return startMs >= 0 && endMs <= CAPTION_DATA_LIMITS.maxTimelineMs ? [{ ...word, startMs, endMs }] : [];
    });
  }
  const timing = fillEditedMarkedWordTiming(after.text, preserved);
  return timing ? { ...after, wordTiming: timing } : withoutWordTiming(after);
}

export function reconcileCaptionWordTiming(before: CaptionSegment, after: CaptionSegment): CaptionSegment {
  if (hasWordTimingEvidence(before.wordTiming)) return reconcileMarkedWordTiming(before, after);
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
  const marked = hasWordTimingEvidence(caption.wordTiming);
  if (marked && !validateMarkedWordTiming(caption.text, caption.wordTiming).ok) return caption;
  const resolved = resolveCaptionWordTiming(caption);
  if (resolved.state === 'stale' || resolved.state === 'missing') return caption;
  if (!Number.isFinite(patch.startMs) || !Number.isFinite(patch.endMs) || patch.endMs <= patch.startMs) return caption;
  const startMs = quantizeMs(patch.startMs);
  const endMs = quantizeMs(patch.endMs);
  if (endMs - startMs < 10 || startMs < caption.startMs || endMs > caption.endMs) return caption;

  const index = caption.wordTiming.words.findIndex((word) => word.id === wordId);
  if (index < 0) return caption;
  const current = caption.wordTiming.words[index];
  if (current.startMs === startMs && current.endMs === endMs && current.source === 'manual' && !current.needsReview
    && (!marked || current.issue === undefined)) return caption;

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
    ...(marked ? { method: 'manual' as const, issue: undefined } : {}),
  } : word);
  const edited: CaptionSegment = {
    ...caption,
    timingSource: 'manual',
    timingQuality: 'medium',
    wordTiming: { ...caption.wordTiming, words },
  };
  if (marked) {
    const { basis: _basis, ...timing } = edited.wordTiming!;
    const verified = validateMarkedWordTiming(caption.text, timing);
    return verified.ok ? { ...edited, wordTiming: verified.timing } : caption;
  }
  return resolveCaptionWordTiming(edited).state === 'stale' ? caption : edited;
}
