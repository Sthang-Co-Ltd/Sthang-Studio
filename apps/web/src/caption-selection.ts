import type { CaptionSegment } from '@kcs/shared';

export function captionIndices(captions: CaptionSegment[]) {
  const indices = new Map<string, number>();
  captions.forEach((caption, index) => {
    if (!indices.has(caption.id)) indices.set(caption.id, index);
  });
  return indices;
}

/** Preserve the existing first-in-array fallback, including overlaps and gaps. */
export function playbackSelectionIndex(captions: CaptionSegment[], timeMs: number) {
  const index = captions.findIndex((caption) => timeMs < caption.endMs);
  return index >= 0 ? index : captions.length - 1;
}

export function selectedCaptionRange(captions: CaptionSegment[], first: number, last: number) {
  const selected = captions.length ? captions.slice(Math.min(first, last), Math.max(first, last) + 1) : [];
  return {
    ids: selected.map((caption) => caption.id),
    captions: selected,
    startMs: selected[0]?.startMs || 0,
    endMs: selected.at(-1)?.endMs || 0,
  };
}
