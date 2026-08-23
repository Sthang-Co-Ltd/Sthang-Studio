import type { TimedToken, TimingDiagnostics } from '@kcs/shared';
import { joinTokens } from './tokenizer.js';

export function offsetTokens(tokens: TimedToken[], offsetMs: number, maxDurationMs: number) {
  return tokens.map((token) => ({
    ...token,
    startMs: Math.max(0, Math.min(maxDurationMs, token.startMs + offsetMs)),
    endMs: Math.max(35, Math.min(maxDurationMs, token.endMs + offsetMs)),
  }));
}

export function replaceTimedRange(
  existing: TimedToken[],
  replacement: TimedToken[],
  startMs: number,
  endMs: number,
) {
  const midpoint = (token: TimedToken) => (token.startMs + token.endMs) / 2;
  const before = existing.filter((token) => midpoint(token) < startMs);
  const after = existing.filter((token) => midpoint(token) > endMs);
  const inside = replacement.filter((token) => midpoint(token) >= startMs && midpoint(token) <= endMs);
  const selected = inside.length ? inside : replacement.filter((token) => token.endMs > startMs && token.startMs < endMs);

  if (!selected.length) throw new Error('The regenerated audio range did not produce any timed words inside the selected region. Expand the selection and try again.');

  if (before.length && selected.length) {
    const oldFirst = existing.find((token) => midpoint(token) >= startMs);
    selected[0] = { ...selected[0], spaceBefore: oldFirst?.spaceBefore ?? selected[0].spaceBefore };
  }

  const merged = [...before, ...selected, ...after].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let i = 1; i < merged.length; i += 1) {
    const prev = merged[i - 1];
    const current = merged[i];
    if (current.startMs < prev.startMs) current.startMs = prev.startMs;
    if (current.endMs <= current.startMs) current.endMs = current.startMs + 35;
  }
  return { tokens: merged, inserted: selected };
}

export function rebuildDiagnostics(tokens: TimedToken[], base: TimingDiagnostics, audioDurationMs: number): TimingDiagnostics {
  const anchored = tokens.filter((token) => token.timingSource !== 'interpolated');
  const interpolatedTokens = tokens.length - anchored.length;
  const lowConfidenceTokens = tokens.filter((token) =>
    token.timingSource === 'interpolated'
    || (token.alignmentScore ?? 0) < 0.55
    || (typeof token.confidence === 'number' && token.confidence < 0.5),
  ).length;
  const meanAlignmentScore = anchored.length
    ? anchored.reduce((sum, token) => sum + (token.alignmentScore ?? 0), 0) / anchored.length
    : 0;
  return {
    ...base,
    audioDurationMs,
    totalTokens: tokens.length,
    anchoredTokens: anchored.length,
    interpolatedTokens,
    lowConfidenceTokens,
    alignmentCoverage: tokens.length ? anchored.length / tokens.length : 0,
    meanAlignmentScore,
  };
}

export function transcriptText(tokens: TimedToken[]) {
  return joinTokens(tokens);
}
