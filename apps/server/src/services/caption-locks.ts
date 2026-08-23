import type { CaptionSegment } from '@kcs/shared';
import { normalizeKhmerDisplayText } from './tokenizer.js';

function overlapMs(a: Pick<CaptionSegment, 'startMs' | 'endMs'>, b: Pick<CaptionSegment, 'startMs' | 'endMs'>) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function center(caption: Pick<CaptionSegment, 'startMs' | 'endMs'>) {
  return (caption.startMs + caption.endMs) / 2;
}

function joinTexts(captions: CaptionSegment[]) {
  return normalizeKhmerDisplayText(captions.map((caption) => caption.text.trim()).filter(Boolean).join(' '));
}

function sameTiming(a: CaptionSegment, startMs: number, endMs: number) {
  return Math.abs(a.startMs - startMs) <= 1 && Math.abs(a.endMs - endMs) <= 1;
}

/**
 * Reinsert reviewed locks after an automatic caption operation.
 *
 * Generated blocks that overlap a lock are assigned exactly once to the most
 * relevant lock. This is intentionally computed against the original generated
 * list—not a progressively-mutated output—so adjacent locked captions can never
 * consume or overwrite one another. When a generated block ambiguously spans
 * multiple locks, the protected caption is kept unchanged rather than guessing.
 */
export function preserveCaptionLocks(existing: CaptionSegment[], generated: CaptionSegment[]) {
  const locks = existing
    .filter((caption) => caption.textLocked || caption.timingLocked)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (!locks.length) return generated;

  const assignments = new Map<string, CaptionSegment[]>();
  const ambiguousLocks = new Set<string>();
  const consumedGeneratedIds = new Set<string>();
  for (const lock of locks) assignments.set(lock.id, []);

  for (const candidate of generated) {
    const overlapping = locks
      .map((lock) => ({ lock, overlap: overlapMs(lock, candidate) }))
      .filter((item) => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || Math.abs(center(a.lock) - center(candidate)) - Math.abs(center(b.lock) - center(candidate)));
    if (!overlapping.length) continue;

    const winner = overlapping[0].lock;
    assignments.get(winner.id)!.push(candidate);
    consumedGeneratedIds.add(candidate.id);

    // A regrouped block can straddle multiple reviewed captions. In that case
    // keeping the reviewed block unchanged is safer than copying combined text
    // or a wide time range into only one of them.
    const meaningful = overlapping.filter((item) => {
      const candidateDuration = Math.max(1, candidate.endMs - candidate.startMs);
      const lockDuration = Math.max(1, item.lock.endMs - item.lock.startMs);
      const threshold = Math.max(40, Math.min(candidateDuration, lockDuration) * 0.12);
      return item.overlap >= threshold;
    });
    if (meaningful.length > 1) {
      for (const item of meaningful) ambiguousLocks.add(item.lock.id);
    }
  }

  const protectedBlocks = locks.map((lock) => {
    const matches = assignments.get(lock.id) || [];
    const ambiguous = ambiguousLocks.has(lock.id);
    const generatedStart = matches.length ? Math.min(...matches.map((caption) => caption.startMs)) : lock.startMs;
    const generatedEnd = matches.length ? Math.max(...matches.map((caption) => caption.endMs)) : lock.endMs;
    const generatedText = matches.length ? joinTexts(matches) : lock.text;

    const nextStart = lock.timingLocked || ambiguous || !matches.length ? lock.startMs : generatedStart;
    const nextEnd = lock.timingLocked || ambiguous || !matches.length ? lock.endMs : generatedEnd;
    const nextText = lock.textLocked || ambiguous || !matches.length ? lock.text : generatedText;
    const textUnchanged = normalizeKhmerDisplayText(nextText) === normalizeKhmerDisplayText(lock.text);
    const timingUnchanged = sameTiming(lock, nextStart, nextEnd);

    return {
      ...lock,
      startMs: nextStart,
      endMs: nextEnd,
      text: nextText,
      timingSource: lock.timingLocked || ambiguous || !matches.length
        ? lock.timingSource || 'manual'
        : matches[0]?.timingSource || lock.timingSource,
      timingQuality: lock.timingLocked || ambiguous || !matches.length
        ? lock.timingQuality || 'medium'
        : matches[0]?.timingQuality || lock.timingQuality,
      approved: Boolean(lock.approved && textUnchanged && timingUnchanged),
    } satisfies CaptionSegment;
  });

  return [
    ...generated.filter((caption) => !consumedGeneratedIds.has(caption.id)),
    ...protectedBlocks,
  ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function lockCounts(captions: CaptionSegment[]) {
  return {
    text: captions.filter((caption) => caption.textLocked).length,
    timing: captions.filter((caption) => caption.timingLocked).length,
    approved: captions.filter((caption) => caption.approved).length,
  };
}

export function captionsInRange(captions: CaptionSegment[], startMs: number, endMs: number) {
  return captions.filter((caption) => caption.endMs > startMs && caption.startMs < endMs);
}
