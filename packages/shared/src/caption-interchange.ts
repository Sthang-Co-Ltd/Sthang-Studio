import { DEFAULT_CAPTION_APPEARANCE, type CaptionAppearance } from './caption-settings.js';
import type { CaptionSegment, TimingQuality, TimingSource } from './index.js';
import { resolveCaptionWordTiming, type CaptionWordSource } from './word-timing.js';

export type CaptionFileFormat = 'srt' | 'word-srt' | 'vtt' | 'word-vtt' | 'ttml' | 'ass' | 'data' | 'bundle';
export type SharedCaptionFileFormat = Exclude<CaptionFileFormat, 'ass' | 'bundle'>;

export interface CaptionInterchangeInput {
  captions: CaptionSegment[];
  appearance?: Partial<CaptionAppearance>;
  durationMs?: number;
}

export type CaptionInterchangeWarningCode =
  | 'cue-order-normalized'
  | 'text-line-endings-normalized'
  | 'timing-rounded-to-millisecond'
  | 'appearance-not-transferred'
  | 'word-file-presentation-differs'
  | 'word-vtt-no-highlight-guarantee';

export interface CaptionInterchangeWarning {
  code: CaptionInterchangeWarningCode;
  message: string;
}

export interface CaptionSerializationResult {
  text: string;
  mimeType: string;
  extension: string;
  warnings: CaptionInterchangeWarning[];
}

export interface CaptionInterchangeIssue {
  captionIndex: number;
  code: 'invalid-cue' | 'empty-text' | 'word-timing-missing' | 'word-timing-partial' | 'word-timing-stale';
  severity: 'error' | 'warning';
  message: string;
}

export interface CaptionInterchangeAnalysis {
  captionCount: number;
  nonemptyCaptionCount: number;
  readyWordCaptionCount: number;
  partialWordCaptionCount: number;
  missingWordCaptionCount: number;
  staleWordCaptionCount: number;
  totalWordCount: number;
  issues: CaptionInterchangeIssue[];
}

export interface CaptionDataWord {
  startOffset: number;
  endOffset: number;
  startMs: number | null;
  endMs: number | null;
  source: CaptionWordSource;
  needsReview?: boolean;
}

export interface CaptionDataWordTiming {
  version: 1;
  text: string;
  words: CaptionDataWord[];
}

export interface CaptionDataCue {
  text: string;
  startMs: number;
  endMs: number;
  wordTiming?: CaptionDataWordTiming;
  confidence?: number;
  timingQuality?: TimingQuality;
  timingSource?: TimingSource;
  approved?: boolean;
  textLocked?: boolean;
  timingLocked?: boolean;
}

export interface CaptionDataDocument {
  kind: 'sthang-caption-data';
  version: 1 | 2;
  captions: CaptionDataCue[];
  appearance?: Partial<CaptionAppearance>;
  durationMs?: number;
}

export const CAPTION_DATA_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxCaptions: 20_000,
  maxWordsPerCaption: 5_000,
  maxTotalWords: 100_000,
  maxGraphemesPerCaption: 10_000,
  maxTotalGraphemes: 500_000,
  maxTimelineMs: 7 * 24 * 60 * 60 * 1_000,
});

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const TIMING_QUALITY: readonly TimingQuality[] = ['high', 'medium', 'low'];
const TIMING_SOURCE: readonly TimingSource[] = ['stt', 'stt-split', 'interpolated', 'manual'];
const WORD_SOURCE: readonly CaptionWordSource[] = ['aligned', 'manual', 'estimated'];
const V1_APPEARANCE_KEYS = [
  'fontFamily', 'fontSize1080', 'bold', 'textColor', 'outlineColor', 'outlineWidth1080', 'shadowWidth1080',
  'backgroundEnabled', 'backgroundColor', 'backgroundOpacity', 'backgroundPadding1080', 'alignment',
  'positionBottomPct', 'maxWidthPct', 'highlightMode', 'highlightColor',
] as const satisfies readonly (keyof CaptionAppearance)[];
const EFFECT_APPEARANCE_KEYS = [
  'glowEnabled', 'glowColor', 'glowWidth1080', 'glowOpacity', 'motionPreset', 'motionDurationMs',
] as const satisfies readonly (keyof CaptionAppearance)[];
const V2_APPEARANCE_KEYS = [
  ...V1_APPEARANCE_KEYS,
  ...EFFECT_APPEARANCE_KEYS,
] as const satisfies readonly (keyof CaptionAppearance)[];

function fail(message: string): never {
  throw new Error(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${path} contains unsupported field "${key}".`);
}

function graphemeCount(value: string) {
  if (typeof Intl.Segmenter === 'function') return Array.from(new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(value)).length;
  return Array.from(value).length;
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function validMs(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= CAPTION_DATA_LIMITS.maxTimelineMs;
}

function normalizedCrlf(value: string) {
  return value.replace(/\r\n|\r|\n/g, '\r\n');
}

function hasNonCrlfLineEnding(value: string) {
  return /(^|[^\r])\n|\r(?!\n)/u.test(value);
}

function hasBlankLine(value: string) {
  const lines = value.replace(/\r\n|\r/g, '\n').split('\n');
  return lines.length > 1 && lines.some((line) => !line.trim());
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function validateText(text: unknown, captionIndex: number) {
  if (typeof text !== 'string') fail(`Caption ${captionIndex + 1} text must be a string.`);
  if (!text.trim()) fail(`Caption ${captionIndex + 1} has no text. Remove it or add wording before export.`);
  if (CONTROL.test(text)) fail(`Caption ${captionIndex + 1} contains unsupported control characters.`);
  if (hasUnpairedSurrogate(text)) fail(`Caption ${captionIndex + 1} contains invalid Unicode surrogate data.`);
  const count = graphemeCount(text);
  if (count > CAPTION_DATA_LIMITS.maxGraphemesPerCaption) fail(`Caption ${captionIndex + 1} is too long to interchange safely.`);
  return count;
}

function validateDuration(durationMs: unknown): number | undefined {
  if (durationMs === undefined) return undefined;
  if (!validMs(durationMs)) fail('Caption interchange duration is invalid or outside the supported timeline bound.');
  return durationMs as number;
}

function validateCaption(caption: CaptionSegment, captionIndex: number, durationMs?: number) {
  if (!plainObject(caption)) fail(`Caption ${captionIndex + 1} is invalid.`);
  const graphemes = validateText(caption.text, captionIndex);
  if (!validMs(caption.startMs) || !validMs(caption.endMs) || caption.endMs <= caption.startMs) {
    fail(`Caption ${captionIndex + 1} has invalid timing.`);
  }
  if (durationMs !== undefined && caption.endMs > durationMs) fail(`Caption ${captionIndex + 1} ends after the supplied media duration.`);
  if (caption.confidence !== undefined && (typeof caption.confidence !== 'number' || !Number.isFinite(caption.confidence) || caption.confidence < 0 || caption.confidence > 1)) {
    fail(`Caption ${captionIndex + 1} confidence is invalid.`);
  }
  if (caption.timingQuality !== undefined && !TIMING_QUALITY.includes(caption.timingQuality)) fail(`Caption ${captionIndex + 1} timing quality is invalid.`);
  if (caption.timingSource !== undefined && !TIMING_SOURCE.includes(caption.timingSource)) fail(`Caption ${captionIndex + 1} timing source is invalid.`);
  for (const field of ['approved', 'textLocked', 'timingLocked'] as const) {
    if (caption[field] !== undefined && typeof caption[field] !== 'boolean') fail(`Caption ${captionIndex + 1} ${field} must be boolean.`);
  }
  return graphemes;
}

function sortedCaptions(input: CaptionInterchangeInput) {
  if (!Array.isArray(input.captions)) fail('Caption interchange input must contain a captions array.');
  if (input.captions.length > CAPTION_DATA_LIMITS.maxCaptions) fail(`Caption count exceeds ${CAPTION_DATA_LIMITS.maxCaptions}.`);
  const durationMs = validateDuration(input.durationMs);
  let totalGraphemes = 0;
  const indexed = input.captions.map((caption, index) => {
    totalGraphemes += validateCaption(caption, index, durationMs);
    return { caption, index };
  });
  if (totalGraphemes > CAPTION_DATA_LIMITS.maxTotalGraphemes) fail('Caption text exceeds the total interchange grapheme limit.');
  const sorted = [...indexed].sort((left, right) => left.caption.startMs - right.caption.startMs || left.caption.endMs - right.caption.endMs || left.index - right.index);
  const reordered = sorted.some((item, index) => item.index !== indexed[index]?.index);
  return { sorted, reordered, durationMs };
}

function baseWarnings(input: CaptionInterchangeInput, reordered: boolean) {
  const warnings: CaptionInterchangeWarning[] = [];
  if (reordered) warnings.push({ code: 'cue-order-normalized', message: 'Cues were ordered by start time for interchange.' });
  if (input.captions.some((caption) => hasNonCrlfLineEnding(caption.text))) {
    warnings.push({ code: 'text-line-endings-normalized', message: 'Caption line endings were normalized for interchange serialization.' });
  }
  if (input.appearance && Object.keys(input.appearance).length) {
    warnings.push({ code: 'appearance-not-transferred', message: 'This plain subtitle format carries text and timing only; visual appearance remains editor-specific.' });
  }
  return warnings;
}

function stamp(ms: number, separator: ',' | '.') {
  if (!Number.isSafeInteger(ms) || ms < 0) fail('Subtitle timestamp was not rounded to a valid millisecond value.');
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1_000) % 60;
  const millis = ms % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

interface SerializedCue {
  startMs: number;
  endMs: number;
  text: string;
}

function roundSubtitleCues(cues: readonly SerializedCue[], warnings: CaptionInterchangeWarning[]) {
  let roundedAny = false;
  const rounded = cues.map((cue, index) => {
    const startMs = Math.round(cue.startMs);
    const endMs = Math.round(cue.endMs);
    roundedAny ||= startMs !== cue.startMs || endMs !== cue.endMs;
    if (endMs <= startMs) {
      fail(`Subtitle cue ${index + 1} collapses after rounding to 1 ms. Adjust its timing before export.`);
    }
    return { ...cue, startMs, endMs };
  });
  if (roundedAny) warnings.push({
    code: 'timing-rounded-to-millisecond',
    message: 'Fractional timing was rounded to the nearest millisecond for subtitle-file timestamps; Caption data keeps the exact values.',
  });
  return rounded;
}

function escapeVtt(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ttmlText(value: string) {
  return normalizedCrlf(value).split('\r\n').map(escapeXml).join('<br/>');
}

interface WordPiece {
  captionIndex: number;
  wordIndex: number;
  startMs: number;
  endMs: number;
  text: string;
}

function readyWordPieces(sorted: Array<{ caption: CaptionSegment; index: number }>) {
  const pieces: WordPiece[] = [];
  for (const { caption, index: captionIndex } of sorted) {
    const resolved = resolveCaptionWordTiming(caption);
    if (resolved.state !== 'ready') fail(`Caption ${captionIndex + 1} does not have complete reviewed word timing; word-level export requires every caption to be ready.`);
    const words = resolved.words;
    if (!words.length) fail(`Caption ${captionIndex + 1} has no word timing spans.`);
    let reconstructed = '';
    for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
      const word = words[wordIndex];
      if (word.startMs === null || word.endMs === null) fail(`Caption ${captionIndex + 1} has an untimed word.`);
      const pieceStart = wordIndex === 0 ? 0 : word.startOffset;
      const pieceEnd = wordIndex === words.length - 1 ? caption.text.length : words[wordIndex + 1].startOffset;
      if (pieceStart > word.startOffset || pieceEnd < word.endOffset || pieceEnd <= pieceStart) fail(`Caption ${captionIndex + 1} word spans cannot preserve exact text coverage.`);
      const text = caption.text.slice(pieceStart, pieceEnd);
      reconstructed += text;
      pieces.push({ captionIndex, wordIndex, startMs: word.startMs, endMs: word.endMs, text });
    }
    if (reconstructed !== caption.text) fail(`Caption ${captionIndex + 1} word spans do not preserve the exact caption text.`);
  }
  return pieces.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.captionIndex - right.captionIndex || left.wordIndex - right.wordIndex);
}

function ensureNoBlankCueLines(texts: readonly string[], format: 'SRT' | 'WebVTT') {
  const index = texts.findIndex(hasBlankLine);
  if (index >= 0) fail(`${format} cannot safely preserve a blank line inside cue text. Remove the blank line or use Caption data/TTML.`);
}

function asSrt(cues: SerializedCue[], warnings: CaptionInterchangeWarning[]): CaptionSerializationResult {
  ensureNoBlankCueLines(cues.map((cue) => cue.text), 'SRT');
  const rounded = roundSubtitleCues(cues, warnings);
  const blocks = rounded.map((cue, index) => `${index + 1}\r\n${stamp(cue.startMs, ',')} --> ${stamp(cue.endMs, ',')}\r\n${normalizedCrlf(cue.text)}`);
  return { text: `\ufeff${blocks.join('\r\n\r\n')}${blocks.length ? '\r\n' : ''}`, mimeType: 'application/x-subrip; charset=utf-8', extension: '.srt', warnings };
}

function asVtt(cues: SerializedCue[], warnings: CaptionInterchangeWarning[]): CaptionSerializationResult {
  ensureNoBlankCueLines(cues.map((cue) => cue.text), 'WebVTT');
  const rounded = roundSubtitleCues(cues, warnings);
  const blocks = rounded.map((cue) => `${stamp(cue.startMs, '.')} --> ${stamp(cue.endMs, '.')}\r\n${escapeVtt(normalizedCrlf(cue.text))}`);
  return { text: `WEBVTT\r\n${blocks.length ? `\r\n${blocks.join('\r\n\r\n')}\r\n` : ''}`, mimeType: 'text/vtt; charset=utf-8', extension: '.vtt', warnings };
}

export function serializeSrt(input: CaptionInterchangeInput): CaptionSerializationResult {
  const { sorted, reordered } = sortedCaptions(input);
  const warnings = baseWarnings(input, reordered);
  return asSrt(sorted.map(({ caption }) => ({ startMs: caption.startMs, endMs: caption.endMs, text: caption.text })), warnings);
}

export function serializeWordSrt(input: CaptionInterchangeInput): CaptionSerializationResult {
  const { sorted, reordered } = sortedCaptions(input);
  const warnings = baseWarnings(input, reordered);
  warnings.push({ code: 'word-file-presentation-differs', message: 'Word-level subtitle files contain individually timed text fragments; destination editors may present them differently from full caption blocks.' });
  return asSrt(readyWordPieces(sorted), warnings);
}

export function serializeVtt(input: CaptionInterchangeInput): CaptionSerializationResult {
  const { sorted, reordered } = sortedCaptions(input);
  const warnings = baseWarnings(input, reordered);
  return asVtt(sorted.map(({ caption }) => ({ startMs: caption.startMs, endMs: caption.endMs, text: caption.text })), warnings);
}

export function serializeWordVtt(input: CaptionInterchangeInput): CaptionSerializationResult {
  const { sorted, reordered } = sortedCaptions(input);
  const warnings = baseWarnings(input, reordered);
  warnings.push(
    { code: 'word-file-presentation-differs', message: 'Word-level subtitle files contain individually timed text fragments; destination editors may present them differently from full caption blocks.' },
    { code: 'word-vtt-no-highlight-guarantee', message: 'Word-timed WebVTT preserves word timing evidence but does not guarantee spoken-word highlighting in destination software.' },
  );
  return asVtt(readyWordPieces(sorted), warnings);
}

export function serializeTtml(input: CaptionInterchangeInput): CaptionSerializationResult {
  const { sorted, reordered } = sortedCaptions(input);
  const warnings = baseWarnings(input, reordered);
  const rounded = roundSubtitleCues(sorted.map(({ caption }) => ({ startMs: caption.startMs, endMs: caption.endMs, text: caption.text })), warnings);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="und">',
    '  <body xml:space="preserve">',
    '    <div>',
    ...rounded.map((caption) => `      <p begin="${stamp(caption.startMs, '.')}" end="${stamp(caption.endMs, '.')}">${ttmlText(caption.text)}</p>`),
    '    </div>',
    '  </body>',
    '</tt>',
    '',
  ];
  return { text: lines.join('\r\n'), mimeType: 'application/ttml+xml; charset=utf-8', extension: '.ttml', warnings };
}

function projectAppearance(
  value: Partial<CaptionAppearance> | undefined,
  keys: readonly (keyof CaptionAppearance)[] = V2_APPEARANCE_KEYS,
): Partial<CaptionAppearance> | undefined {
  if (!value || !plainObject(value)) return undefined;
  const out: Partial<CaptionAppearance> = {};
  for (const key of keys) {
    const item = value[key];
    if (item !== undefined) (out as Record<string, unknown>)[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function validateAppearance(value: unknown, version: 1 | 2, path = 'appearance'): Partial<CaptionAppearance> | undefined {
  if (value === undefined) return undefined;
  if (!plainObject(value)) fail(`${path} must be an object.`);
  const keys = version === 1 ? V1_APPEARANCE_KEYS : V2_APPEARANCE_KEYS;
  assertAllowedKeys(value, keys, path);
  const stringColor = (key: keyof CaptionAppearance) => {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value[key] as string))) fail(`${path}.${String(key)} must be a six-digit hex color.`);
  };
  if (value.fontFamily !== undefined && (typeof value.fontFamily !== 'string' || !value.fontFamily.trim() || value.fontFamily.length > 80 || CONTROL.test(value.fontFamily))) fail(`${path}.fontFamily is invalid.`);
  const ranges: Array<[keyof CaptionAppearance, number, number]> = [
    ['fontSize1080', 22, 120], ['outlineWidth1080', 0, 12], ['shadowWidth1080', 0, 12],
    ['backgroundOpacity', 0.05, 1], ['backgroundPadding1080', 0, 28], ['positionBottomPct', 3, 82], ['maxWidthPct', 45, 96],
    ['glowWidth1080', 0, 16], ['glowOpacity', 0, 1], ['motionDurationMs', 80, 400],
  ];
  for (const [key, min, max] of ranges) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) < min || (value[key] as number) > max)) fail(`${path}.${String(key)} is outside the supported range.`);
  }
  for (const key of ['bold', 'backgroundEnabled', 'glowEnabled'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${path}.${key} must be boolean.`);
  if (value.alignment !== undefined && !['left', 'center', 'right'].includes(String(value.alignment))) fail(`${path}.alignment is invalid.`);
  if (value.highlightMode !== undefined && !['off', 'word'].includes(String(value.highlightMode))) fail(`${path}.highlightMode is invalid.`);
  if (value.motionPreset !== undefined && !['none', 'fade'].includes(String(value.motionPreset))) fail(`${path}.motionPreset is invalid.`);
  if (value.motionDurationMs !== undefined && (value.motionDurationMs as number) % 10 !== 0) fail(`${path}.motionDurationMs must use a 10 ms step.`);
  stringColor('textColor'); stringColor('outlineColor'); stringColor('backgroundColor'); stringColor('highlightColor'); stringColor('glowColor');
  return projectAppearance(value as Partial<CaptionAppearance>, keys);
}

function effectStateNeedsV2(appearance: Partial<CaptionAppearance> | undefined) {
  if (!appearance) return false;
  const glowColor = String(appearance.glowColor ?? DEFAULT_CAPTION_APPEARANCE.glowColor).toUpperCase();
  const defaultGlowColor = String(DEFAULT_CAPTION_APPEARANCE.glowColor).toUpperCase();
  return (appearance.glowEnabled ?? DEFAULT_CAPTION_APPEARANCE.glowEnabled) !== DEFAULT_CAPTION_APPEARANCE.glowEnabled
    || glowColor !== defaultGlowColor
    || (appearance.glowWidth1080 ?? DEFAULT_CAPTION_APPEARANCE.glowWidth1080) !== DEFAULT_CAPTION_APPEARANCE.glowWidth1080
    || (appearance.glowOpacity ?? DEFAULT_CAPTION_APPEARANCE.glowOpacity) !== DEFAULT_CAPTION_APPEARANCE.glowOpacity
    || (appearance.motionPreset ?? DEFAULT_CAPTION_APPEARANCE.motionPreset) !== DEFAULT_CAPTION_APPEARANCE.motionPreset
    || (appearance.motionDurationMs ?? DEFAULT_CAPTION_APPEARANCE.motionDurationMs) !== DEFAULT_CAPTION_APPEARANCE.motionDurationMs;
}

function projectWordTiming(caption: CaptionSegment, captionIndex: number): CaptionDataWordTiming | undefined {
  if (caption.wordTiming === undefined) return undefined;
  const resolved = resolveCaptionWordTiming(caption);
  if (resolved.state === 'stale' || resolved.state === 'missing') fail(`Caption ${captionIndex + 1} has stale or malformed word timing and cannot be archived safely.`);
  if (resolved.words.length > CAPTION_DATA_LIMITS.maxWordsPerCaption) fail(`Caption ${captionIndex + 1} has too many word timing spans.`);
  return {
    version: 1,
    text: caption.wordTiming!.text,
    words: resolved.words.map((word) => ({
      startOffset: word.startOffset,
      endOffset: word.endOffset,
      startMs: word.startMs,
      endMs: word.endMs,
      source: word.source,
      ...(word.needsReview !== undefined ? { needsReview: word.needsReview } : {}),
    })),
  };
}

export function createCaptionData(input: CaptionInterchangeInput): CaptionDataDocument {
  if (!Array.isArray(input.captions)) fail('Caption interchange input must contain a captions array.');
  if (input.captions.length > CAPTION_DATA_LIMITS.maxCaptions) fail(`Caption count exceeds ${CAPTION_DATA_LIMITS.maxCaptions}.`);
  const durationMs = validateDuration(input.durationMs);
  const projectedAppearance = projectAppearance(input.appearance);
  const validatedAppearance = validateAppearance(projectedAppearance, 2);
  const version: 1 | 2 = effectStateNeedsV2(validatedAppearance) ? 2 : 1;
  const appearance = version === 2 ? validatedAppearance : projectAppearance(validatedAppearance, V1_APPEARANCE_KEYS);
  let totalWords = 0;
  let totalGraphemes = 0;
  const captions: CaptionDataCue[] = input.captions.map((caption, index) => {
    totalGraphemes += validateCaption(caption, index, durationMs);
    const wordTiming = projectWordTiming(caption, index);
    totalWords += wordTiming?.words.length || 0;
    const out: CaptionDataCue = { text: caption.text, startMs: caption.startMs, endMs: caption.endMs };
    if (wordTiming) out.wordTiming = wordTiming;
    if (caption.confidence !== undefined) out.confidence = caption.confidence;
    if (caption.timingQuality !== undefined) out.timingQuality = caption.timingQuality;
    if (caption.timingSource !== undefined) out.timingSource = caption.timingSource;
    if (caption.approved !== undefined) out.approved = caption.approved;
    if (caption.textLocked !== undefined) out.textLocked = caption.textLocked;
    if (caption.timingLocked !== undefined) out.timingLocked = caption.timingLocked;
    return out;
  });
  if (totalGraphemes > CAPTION_DATA_LIMITS.maxTotalGraphemes) fail('Caption text exceeds the total interchange grapheme limit.');
  if (totalWords > CAPTION_DATA_LIMITS.maxTotalWords) fail('Word timing data exceeds the total interchange word limit.');
  return {
    kind: 'sthang-caption-data',
    version,
    captions,
    ...(appearance ? { appearance } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function serializeCaptionData(input: CaptionInterchangeInput): CaptionSerializationResult {
  const document = createCaptionData(input);
  const text = `${JSON.stringify(document, null, 2).replace(/\n/g, '\r\n')}\r\n`;
  if (utf8Bytes(text) > CAPTION_DATA_LIMITS.maxBytes) fail(`Caption data exceeds the ${CAPTION_DATA_LIMITS.maxBytes}-byte export limit.`);
  return { text, mimeType: 'application/json; charset=utf-8', extension: '.sthang-captions.json', warnings: [] };
}

function parseBoolean(value: unknown, path: string) {
  if (typeof value !== 'boolean') fail(`${path} must be boolean.`);
  return value;
}

function parseOptionalNumber(value: unknown, path: string, min: number, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${path} is invalid.`);
  return value;
}

function parseDataWordTiming(value: unknown, caption: CaptionDataCue, captionIndex: number, total: { words: number }) {
  if (!plainObject(value)) fail(`Caption ${captionIndex + 1} wordTiming must be an object.`);
  assertAllowedKeys(value, ['version', 'text', 'words'], `captions[${captionIndex}].wordTiming`);
  if (value.version !== 1 || typeof value.text !== 'string' || !Array.isArray(value.words)) fail(`Caption ${captionIndex + 1} wordTiming has an unsupported version or shape.`);
  if (value.text !== caption.text) fail(`Caption ${captionIndex + 1} wordTiming text snapshot is stale.`);
  if (value.words.length > CAPTION_DATA_LIMITS.maxWordsPerCaption) fail(`Caption ${captionIndex + 1} has too many word timing spans.`);
  total.words += value.words.length;
  if (total.words > CAPTION_DATA_LIMITS.maxTotalWords) fail('Word timing data exceeds the total interchange word limit.');
  const words: CaptionDataWord[] = value.words.map((raw, wordIndex) => {
    const path = `captions[${captionIndex}].wordTiming.words[${wordIndex}]`;
    if (!plainObject(raw)) fail(`${path} must be an object.`);
    assertAllowedKeys(raw, ['startOffset', 'endOffset', 'startMs', 'endMs', 'source', 'needsReview'], path);
    if (!Number.isSafeInteger(raw.startOffset) || !Number.isSafeInteger(raw.endOffset)) fail(`${path} offsets must be safe integers.`);
    if (raw.startMs !== null && !validMs(raw.startMs)) fail(`${path}.startMs is invalid.`);
    if (raw.endMs !== null && !validMs(raw.endMs)) fail(`${path}.endMs is invalid.`);
    if (typeof raw.source !== 'string' || !WORD_SOURCE.includes(raw.source as CaptionWordSource)) fail(`${path}.source is invalid.`);
    if (raw.needsReview !== undefined && typeof raw.needsReview !== 'boolean') fail(`${path}.needsReview must be boolean.`);
    return {
      startOffset: raw.startOffset as number,
      endOffset: raw.endOffset as number,
      startMs: raw.startMs as number | null,
      endMs: raw.endMs as number | null,
      source: raw.source as CaptionWordSource,
      ...(raw.needsReview !== undefined ? { needsReview: raw.needsReview as boolean } : {}),
    };
  });
  const timing: CaptionDataWordTiming = { version: 1, text: value.text, words };
  const temporary: CaptionSegment = {
    id: `import-${captionIndex}`,
    text: caption.text,
    startMs: caption.startMs,
    endMs: caption.endMs,
    wordTiming: {
      version: 1,
      text: timing.text,
      words: timing.words.map((word, wordIndex) => ({ id: `w-${wordIndex}`, ...word })),
    },
  };
  const resolved = resolveCaptionWordTiming(temporary);
  if (resolved.state === 'stale' || resolved.state === 'missing') fail(`Caption ${captionIndex + 1} wordTiming is stale or malformed.`);
  return timing;
}

function parseDataCue(value: unknown, index: number, durationMs: number | undefined, total: { graphemes: number; words: number }): CaptionDataCue {
  if (!plainObject(value)) fail(`captions[${index}] must be an object.`);
  assertAllowedKeys(value, ['text', 'startMs', 'endMs', 'wordTiming', 'confidence', 'timingQuality', 'timingSource', 'approved', 'textLocked', 'timingLocked'], `captions[${index}]`);
  const temp: CaptionSegment = { id: `import-${index}`, text: value.text as string, startMs: value.startMs as number, endMs: value.endMs as number };
  total.graphemes += validateCaption(temp, index, durationMs);
  if (total.graphemes > CAPTION_DATA_LIMITS.maxTotalGraphemes) fail('Caption text exceeds the total interchange grapheme limit.');
  const cue: CaptionDataCue = { text: temp.text, startMs: temp.startMs, endMs: temp.endMs };
  const confidence = parseOptionalNumber(value.confidence, `captions[${index}].confidence`, 0, 1);
  if (confidence !== undefined) cue.confidence = confidence;
  if (value.timingQuality !== undefined) {
    if (typeof value.timingQuality !== 'string' || !TIMING_QUALITY.includes(value.timingQuality as TimingQuality)) fail(`captions[${index}].timingQuality is invalid.`);
    cue.timingQuality = value.timingQuality as TimingQuality;
  }
  if (value.timingSource !== undefined) {
    if (typeof value.timingSource !== 'string' || !TIMING_SOURCE.includes(value.timingSource as TimingSource)) fail(`captions[${index}].timingSource is invalid.`);
    cue.timingSource = value.timingSource as TimingSource;
  }
  for (const field of ['approved', 'textLocked', 'timingLocked'] as const) if (value[field] !== undefined) cue[field] = parseBoolean(value[field], `captions[${index}].${field}`);
  if (value.wordTiming !== undefined) cue.wordTiming = parseDataWordTiming(value.wordTiming, cue, index, total);
  return cue;
}

export function parseCaptionData(text: string): CaptionDataDocument {
  if (typeof text !== 'string') fail('Caption data must be text.');
  if (utf8Bytes(text) > CAPTION_DATA_LIMITS.maxBytes) fail(`Caption data exceeds the ${CAPTION_DATA_LIMITS.maxBytes}-byte import limit.`);
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { fail('Caption data is not valid JSON.'); }
  if (!plainObject(raw)) fail('Caption data must be a JSON object.');
  assertAllowedKeys(raw, ['kind', 'version', 'captions', 'appearance', 'durationMs'], 'caption data');
  if (raw.kind !== 'sthang-caption-data') fail('Unknown caption data file kind.');
  if (raw.version !== 1 && raw.version !== 2) fail('Unsupported caption data version.');
  const version = raw.version as 1 | 2;
  if (!Array.isArray(raw.captions)) fail('Caption data captions must be an array.');
  if (raw.captions.length > CAPTION_DATA_LIMITS.maxCaptions) fail(`Caption count exceeds ${CAPTION_DATA_LIMITS.maxCaptions}.`);
  const durationMs = validateDuration(raw.durationMs);
  const appearance = validateAppearance(raw.appearance, version);
  const total = { graphemes: 0, words: 0 };
  const captions = raw.captions.map((cue, index) => parseDataCue(cue, index, durationMs, total));
  return {
    kind: 'sthang-caption-data', version, captions,
    ...(appearance ? { appearance } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function analyzeCaptionInterchange(captions: CaptionSegment[]): CaptionInterchangeAnalysis {
  const issues: CaptionInterchangeIssue[] = [];
  let nonemptyCaptionCount = 0;
  let readyWordCaptionCount = 0;
  let partialWordCaptionCount = 0;
  let missingWordCaptionCount = 0;
  let staleWordCaptionCount = 0;
  let totalWordCount = 0;
  captions.forEach((caption, index) => {
    if (typeof caption.text === 'string' && caption.text.trim()) nonemptyCaptionCount += 1;
    else issues.push({ captionIndex: index, code: 'empty-text', severity: 'error', message: 'Caption has no text.' });
    if (!validMs(caption.startMs) || !validMs(caption.endMs) || caption.endMs <= caption.startMs) issues.push({ captionIndex: index, code: 'invalid-cue', severity: 'error', message: 'Caption timing is invalid.' });
    const resolved = resolveCaptionWordTiming(caption);
    totalWordCount += resolved.words.length;
    if (resolved.state === 'ready') readyWordCaptionCount += 1;
    else if (resolved.state === 'partial') {
      partialWordCaptionCount += 1;
      issues.push({ captionIndex: index, code: 'word-timing-partial', severity: 'warning', message: resolved.reason || 'Word timing needs review.' });
    } else if (resolved.state === 'missing') {
      missingWordCaptionCount += 1;
      issues.push({ captionIndex: index, code: 'word-timing-missing', severity: 'warning', message: 'Word timing is not available.' });
    } else {
      staleWordCaptionCount += 1;
      issues.push({ captionIndex: index, code: 'word-timing-stale', severity: 'error', message: resolved.reason || 'Word timing is stale or malformed.' });
    }
  });
  return { captionCount: captions.length, nonemptyCaptionCount, readyWordCaptionCount, partialWordCaptionCount, missingWordCaptionCount, staleWordCaptionCount, totalWordCount, issues };
}

export function serializeCaptionFile(input: CaptionInterchangeInput, format: SharedCaptionFileFormat): CaptionSerializationResult {
  switch (format) {
    case 'srt': return serializeSrt(input);
    case 'word-srt': return serializeWordSrt(input);
    case 'vtt': return serializeVtt(input);
    case 'word-vtt': return serializeWordVtt(input);
    case 'ttml': return serializeTtml(input);
    case 'data': return serializeCaptionData(input);
    default: return fail(`Unsupported shared caption interchange format: ${String(format)}.`);
  }
}
