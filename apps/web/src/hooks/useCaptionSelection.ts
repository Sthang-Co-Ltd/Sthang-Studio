import { useMemo } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { captionIndices, playbackSelectionIndex, selectedCaptionRange } from '../caption-selection';

/** A clock tick must not allocate a new explicit selection or invalidate its consumers. */
export function useCaptionSelection(captions: CaptionSegment[], anchor: string | null, end: string | null, timeMs: number) {
  const indices = useMemo(() => captionIndices(captions), [captions]);
  const anchorIndex = anchor === null ? undefined : indices.get(anchor);
  const first = anchorIndex ?? playbackSelectionIndex(captions, timeMs);
  const last = (end === null ? undefined : indices.get(end)) ?? first;
  return useMemo(() => selectedCaptionRange(captions, first, last), [captions, first, last]);
}
