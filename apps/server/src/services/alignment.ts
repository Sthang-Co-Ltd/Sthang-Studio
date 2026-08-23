import { nanoid } from 'nanoid';
import type { TimedToken, TimingDiagnostics } from '@kcs/shared';
import type { TimingResult, TimingWord } from './timing-types.js';
import { levenshteinSimilarity, normalizeForMatch, normalizeKhmerTokenSpacing, tokenizeText } from './tokenizer.js';
import type { VocabularyEntry } from './vocabulary.js';

interface MatchGroup {
  gStart: number;
  gLen: number;
  sStart: number;
  sLen: number;
  score: number;
}

type Assigned = Omit<TimedToken, 'id' | 'text' | 'spaceBefore'> | undefined;

function buildEquivalenceMap(entries: VocabularyEntry[] | undefined) {
  const map = new Map<string, string>();
  for (const entry of entries || []) {
    const canonical = normalizeForMatch(entry.canonical);
    if (!canonical) continue;
    map.set(canonical, canonical);
    for (const alias of entry.aliases) {
      const normalized = normalizeForMatch(alias);
      if (normalized) map.set(normalized, canonical);
    }
  }
  return map;
}

function similarity(a: string, b: string, equivalents: Map<string, string>) {
  if (!a || !b) return 0;
  const aa = equivalents.get(a) || a;
  const bb = equivalents.get(b) || b;
  if (aa === bb) return 1;
  return levenshteinSimilarity(aa, bb);
}

function concatNormalized<T>(items: T[], start: number, len: number, get: (x: T) => string) {
  let value = '';
  for (let i = start; i < start + len; i++) value += get(items[i]);
  return value;
}

/**
 * Sequence alignment with 1..3 token merges on either side. Khmer token boundaries
 * can differ between Gemini/Intl.Segmenter and the timing ASR, so strict 1:1 matching is
 * intentionally not assumed.
 */
function alignSequences(gemini: ReturnType<typeof tokenizeText>, timingWords: TimingWord[], equivalents: Map<string, string>): MatchGroup[] {
  const n = gemini.length;
  const m = timingWords.length;
  const width = m + 1;
  const size = (n + 1) * (m + 1);
  const costs = new Float64Array(size);
  costs.fill(Number.POSITIVE_INFINITY);
  const back = new Uint8Array(size);
  costs[0] = 0;

  const idx = (i: number, j: number) => i * width + j;
  const relax = (ni: number, nj: number, cost: number, code: number) => {
    const k = idx(ni, nj);
    if (cost < costs[k]) {
      costs[k] = cost;
      back[k] = code;
    }
  };

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const current = costs[idx(i, j)];
      if (!Number.isFinite(current)) continue;
      if (i < n) relax(i + 1, j, current + 0.74, 1); // Gemini token absent from STT.
      if (j < m) relax(i, j + 1, current + 0.68, 2); // Extra/misrecognized STT token.

      for (let gl = 1; gl <= 3 && i + gl <= n; gl++) {
        const ga = concatNormalized(gemini, i, gl, (x) => x.normalized);
        for (let sl = 1; sl <= 3 && j + sl <= m; sl++) {
          const sb = concatNormalized(timingWords, j, sl, (x) => normalizeForMatch(x.text));
          const sim = similarity(ga, sb, equivalents);
          // Merges are allowed for Khmer tokenizer-boundary differences, but they carry a
          // meaningful cost so a truly missing Gemini/STT token is left for interpolation
          // instead of being silently swallowed into a neighboring anchor.
          const groupingPenalty = (gl + sl - 2) * 0.34;
          const mismatchCost = 1 - sim;
          // Very weak matches should usually lose to gaps instead of forcing nonsense anchors.
          const weakPenalty = sim < 0.28 ? 0.55 : 0;
          const code = 16 + gl * 4 + sl;
          relax(i + gl, j + sl, current + mismatchCost + groupingPenalty + weakPenalty, code);
        }
      }
    }
  }

  const groups: MatchGroup[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = back[idx(i, j)];
    if (code === 1) { i--; continue; }
    if (code === 2) { j--; continue; }
    if (code >= 16) {
      const x = code - 16;
      const gl = Math.floor(x / 4);
      const sl = x % 4;
      if (!gl || !sl) break;
      const gs = i - gl;
      const ss = j - sl;
      const ga = concatNormalized(gemini, gs, gl, (t) => t.normalized);
      const sb = concatNormalized(timingWords, ss, sl, (t) => normalizeForMatch(t.text));
      const score = similarity(ga, sb, equivalents);
      // Don't treat very poor forced matches as anchors; interpolation is safer.
      if (score >= 0.34) groups.push({ gStart: gs, gLen: gl, sStart: ss, sLen: sl, score });
      i = gs;
      j = ss;
      continue;
    }
    // Defensive fallback if a malformed backpointer somehow occurs.
    if (i > 0) i--; else if (j > 0) j--;
  }
  return groups.reverse();
}

function splitRange(startMs: number, endMs: number, weights: number[]) {
  const span = Math.max(weights.length * 35, endMs - startMs);
  const total = weights.reduce((a, b) => a + Math.max(1, b), 0);
  let cursor = startMs;
  return weights.map((w, index) => {
    const end = index === weights.length - 1
      ? endMs
      : Math.round(cursor + span * Math.max(1, w) / total);
    const range = { startMs: cursor, endMs: Math.max(cursor + 35, end) };
    cursor = range.endMs;
    return range;
  });
}

function median(values: number[]) {
  if (!values.length) return 220;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function interpolateMissing(assigned: Assigned[], tokenLengths: number[], audioDurationMs: number) {
  const observedPerUnit: number[] = [];
  assigned.forEach((a, i) => {
    if (a) observedPerUnit.push(Math.max(35, a.endMs - a.startMs) / Math.max(1, tokenLengths[i]));
  });
  const msPerUnit = Math.min(300, Math.max(35, median(observedPerUnit)));

  let i = 0;
  while (i < assigned.length) {
    if (assigned[i]) { i++; continue; }
    const start = i;
    while (i < assigned.length && !assigned[i]) i++;
    const end = i - 1;
    const prev = start > 0 ? assigned[start - 1] : undefined;
    const next = i < assigned.length ? assigned[i] : undefined;
    const weights = tokenLengths.slice(start, end + 1).map((x) => Math.max(1, x));
    const wanted = weights.reduce((a, b) => a + b, 0) * msPerUnit;

    let rangeStart: number;
    let rangeEnd: number;
    if (prev && next) {
      rangeStart = prev.endMs;
      rangeEnd = next.startMs;
      if (rangeEnd - rangeStart < weights.length * 35) {
        const center = (prev.endMs + next.startMs) / 2;
        rangeStart = Math.max(prev.startMs, Math.round(center - wanted / 2));
        rangeEnd = Math.min(next.endMs, Math.round(center + wanted / 2));
      }
    } else if (prev) {
      rangeStart = prev.endMs;
      rangeEnd = Math.min(audioDurationMs, Math.round(rangeStart + wanted));
    } else if (next) {
      rangeEnd = next.startMs;
      rangeStart = Math.max(0, Math.round(rangeEnd - wanted));
    } else {
      rangeStart = 0;
      rangeEnd = audioDurationMs;
    }
    if (rangeEnd <= rangeStart) rangeEnd = rangeStart + weights.length * 60;

    const ranges = splitRange(rangeStart, rangeEnd, weights);
    ranges.forEach((r, offset) => {
      assigned[start + offset] = {
        ...r,
        confidence: 0.35,
        alignmentScore: 0,
        timingSource: 'interpolated',
      };
    });
  }
}

export function alignGeminiToTiming(fullText: string, timing: TimingResult, audioDurationMs: number, vocabularyEntries?: VocabularyEntry[]) {
  const sttWords = timing.words;
  const sttTranscript = timing.transcript;
  const gemini = tokenizeText(fullText);
  if (!gemini.length) throw new Error('Gemini transcript could not be tokenized for timing alignment.');
  if (!sttWords.length) throw new Error('The timing engine returned no timing words.');

  const groups = alignSequences(gemini, sttWords, buildEquivalenceMap(vocabularyEntries));
  const assigned: Assigned[] = Array(gemini.length).fill(undefined);

  for (const group of groups) {
    const words = sttWords.slice(group.sStart, group.sStart + group.sLen);
    if (!words.length) continue;
    const startMs = words[0].startMs;
    const endMs = words[words.length - 1].endMs;
    const confidenceValues = words.map((w) => w.confidence).filter((x): x is number => typeof x === 'number');
    const sttConfidence = confidenceValues.length ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length : undefined;
    const weights = gemini.slice(group.gStart, group.gStart + group.gLen).map((t) => Math.max(1, [...t.normalized].length));
    const ranges = splitRange(startMs, endMs, weights);
    ranges.forEach((range, offset) => {
      assigned[group.gStart + offset] = {
        ...range,
        confidence: sttConfidence,
        alignmentScore: group.score,
        timingSource: group.gLen === 1 && group.sLen === 1 && !words.some((w) => w.derived) ? 'stt' : 'stt-split',
      };
    });
  }

  interpolateMissing(assigned, gemini.map((t) => Math.max(1, [...t.normalized].length)), audioDurationMs);

  let tokens: TimedToken[] = gemini.map((token, index) => {
    const timing = assigned[index]!;
    return {
      id: nanoid(8),
      text: token.text,
      spaceBefore: token.spaceBefore,
      startMs: Math.max(0, Math.round(timing.startMs)),
      endMs: Math.min(audioDurationMs, Math.max(Math.round(timing.startMs) + 35, Math.round(timing.endMs))),
      confidence: timing.confidence,
      alignmentScore: timing.alignmentScore,
      timingSource: timing.timingSource,
    };
  });

  // Remove English-style word spacing from over-spaced Khmer runs while
  // retaining phrase boundaries that have a real acoustic pause.
  tokens = normalizeKhmerTokenSpacing(tokens);

  // Keep interpolated ranges monotonic without moving trusted STT anchors.
  for (let k = 1; k < tokens.length; k++) {
    const prev = tokens[k - 1];
    const cur = tokens[k];
    if (cur.startMs < prev.startMs && cur.timingSource === 'interpolated') cur.startMs = prev.startMs;
    if (cur.endMs <= cur.startMs) cur.endMs = Math.min(audioDurationMs, cur.startMs + 50);
  }

  const anchored = tokens.filter((t) => t.timingSource !== 'interpolated');
  const interpolated = tokens.length - anchored.length;
  const meanAlignment = anchored.length
    ? anchored.reduce((sum, t) => sum + (t.alignmentScore ?? 0), 0) / anchored.length
    : 0;
  const lowConfidence = tokens.filter((t) => t.timingSource === 'interpolated' || (t.alignmentScore ?? 0) < 0.55 || (typeof t.confidence === 'number' && t.confidence < 0.5)).length;
  const coverage = anchored.length / tokens.length;

  if (coverage < 0.22) {
    throw new Error(`Timing alignment was too weak (${Math.round(coverage * 100)}% anchored). The local timing transcript and Gemini disagreed too much on this audio; no misleading SRT was generated.`);
  }

  const diagnostics: TimingDiagnostics = {
    engine: timing.engine,
    provider: timing.provider,
    model: timing.model,
    location: timing.location,
    device: timing.device,
    computeType: timing.computeType,
    sttTranscript,
    audioDurationMs,
    totalTokens: tokens.length,
    anchoredTokens: anchored.length,
    interpolatedTokens: interpolated,
    lowConfidenceTokens: lowConfidence,
    alignmentCoverage: coverage,
    meanAlignmentScore: meanAlignment,
    directAlignment: timing.directAlignment,
    fallbackReason: timing.fallbackReason,
  };

  return { tokens, diagnostics };
}
