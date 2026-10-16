import type { CaptionSegment } from '@kcs/shared';

export interface CaptionSelectionEndpoints {
  anchor: string | null;
  end: string | null;
}

/** Keep valid endpoints, including range direction; repair only missing IDs. */
export function reconcileCaptionSelection(
  captions: readonly CaptionSegment[],
  current: CaptionSelectionEndpoints,
  playheadMs: number,
): CaptionSelectionEndpoints {
  if (!captions.length) return { anchor: null, end: null };
  const anchorValid = Boolean(current.anchor && captions.some((caption) => caption.id === current.anchor));
  const endValid = Boolean(current.end && captions.some((caption) => caption.id === current.end));
  if (anchorValid && endValid) return current;
  const active = captions.find((caption) => playheadMs >= caption.startMs && playheadMs < caption.endMs);
  const fallback = active || captions.find((caption) => playheadMs < caption.endMs) || captions.at(-1)!;
  return { anchor: fallback.id, end: fallback.id };
}
