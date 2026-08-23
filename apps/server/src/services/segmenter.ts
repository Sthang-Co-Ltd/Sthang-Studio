import { nanoid } from 'nanoid';
import type { CaptionSegment, SegmentOptions, TimedToken, TimingQuality, TimingSource } from '@kcs/shared';
import { joinTokens, normalizeKhmerTokenSpacing, tokenizeText } from './tokenizer.js';

const STRONG_END = /[។៕!?…]$/u;

function quality(tokens: TimedToken[]): TimingQuality {
  if (tokens.some((t) => t.timingSource === 'interpolated' || (t.alignmentScore ?? 1) < 0.48)) return 'low';
  if (tokens.some((t) => t.timingSource === 'stt-split' || (t.alignmentScore ?? 1) < 0.7 || (typeof t.confidence === 'number' && t.confidence < 0.6))) return 'medium';
  return 'high';
}

function dominantSource(tokens: TimedToken[]): TimingSource {
  if (tokens.some((t) => t.timingSource === 'interpolated')) return 'interpolated';
  if (tokens.some((t) => t.timingSource === 'stt-split')) return 'stt-split';
  return 'stt';
}

function makeCaption(tokens: TimedToken[]): CaptionSegment {
  const confidenceValues = tokens.map((x) => x.confidence).filter((x): x is number => typeof x === 'number');
  return {
    id: nanoid(8),
    startMs: tokens[0].startMs,
    endMs: tokens[tokens.length - 1].endMs,
    text: joinTokens(tokens),
    confidence: confidenceValues.length ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : undefined,
    timingQuality: quality(tokens),
    timingSource: dominantSource(tokens),
  };
}

function visibleLength(tokens: TimedToken[]) {
  return [...joinTokens(tokens)].length;
}

/** Boundary index N means: do not split between tokens[N-1] and tokens[N]. */
function protectedBoundaries(tokens: TimedToken[], phrases: string[] | undefined) {
  const blocked = new Set<number>();
  const norms = tokens.map((t) => tokenizeText(t.text)[0]?.normalized || '');
  for (const phrase of phrases || []) {
    const parts = tokenizeText(phrase).map((x) => x.normalized).filter(Boolean);
    if (parts.length < 2) continue;
    for (let start = 0; start <= norms.length - parts.length; start += 1) {
      let match = true;
      for (let j = 0; j < parts.length; j += 1) {
        if (norms[start + j] !== parts[j]) { match = false; break; }
      }
      if (!match) continue;
      for (let boundary = start + 1; boundary < start + parts.length; boundary += 1) blocked.add(boundary);
    }
  }
  return blocked;
}

export function segmentTimedTokens(tokens: TimedToken[], options: SegmentOptions): CaptionSegment[] {
  if (!tokens.length) return [];
  // Normalize over-spaced Khmer once across the full timed transcript before
  // forming short caption groups. Doing this at the full-run level lets pause
  // timing distinguish genuine phrase spaces from artificial word spacing.
  const normalizedTokens = normalizeKhmerTokenSpacing(tokens);
  if (options.mode === 'word') return normalizedTokens.map((t) => makeCaption([t]));

  const config = options.mode === 'dynamic'
    ? { maxChars: options.maxChars ?? 18, maxDuration: options.maxDurationMs ?? 1450, pauseMs: 320, targetTokens: 3 }
    : options.mode === 'phrase'
      ? { maxChars: options.maxChars ?? 30, maxDuration: options.maxDurationMs ?? 2700, pauseMs: 620, targetTokens: 6 }
      : { maxChars: options.maxChars ?? 42, maxDuration: options.maxDurationMs ?? 3800, pauseMs: 780, targetTokens: 10 };

  const blocked = protectedBoundaries(normalizedTokens, options.protectedPhrases);
  const out: CaptionSegment[] = [];
  let current: TimedToken[] = [];

  const flush = () => {
    if (current.length) out.push(makeCaption(current));
    current = [];
  };

  for (let index = 0; index < normalizedTokens.length; index += 1) {
    const token = normalizedTokens[index];
    if (!current.length) {
      current = [token];
      continue;
    }
    const prev = current[current.length - 1];
    const proposed = [...current, token];
    const duration = token.endMs - current[0].startMs;
    const pause = Math.max(0, token.startMs - prev.endMs);
    const charLimit = visibleLength(proposed) > config.maxChars;
    const timeLimit = duration > config.maxDuration;
    const pauseBreak = pause >= config.pauseMs;
    const sentenceBreak = STRONG_END.test(prev.text) && current.length >= 2;
    const rhythmBreak = options.mode === 'dynamic' && current.length >= config.targetTokens && (pause >= 150 || token.spaceBefore || STRONG_END.test(prev.text));
    const protectEntity = blocked.has(index);

    // Vocabulary entities such as "GPT 5.6 Luna" stay together even when the
    // ordinary TikTok rhythm/character rules would split the entity in half.
    // An exceptionally large pause still wins because it likely indicates the
    // phrase was not actually spoken as one entity.
    if (!protectEntity && (charLimit || timeLimit || pauseBreak || sentenceBreak || rhythmBreak)) flush();
    else if (protectEntity && pause >= 1100) flush();
    current.push(token);
  }
  flush();
  return out;
}

/** Legacy v0.1 projects cannot be safely resegmented because their timestamps were invented. */
export function requireTimedTokens(tokens: TimedToken[] | undefined) {
  if (!tokens?.length) throw new Error('This is a legacy v0.1 transcript. Click Rebuild timing to generate local forced-alignment anchors with the local timing engine.');
  return tokens;
}
