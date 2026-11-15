/** Review decisions repeat frequently; only move the list when the target needs space. */
export interface ReviewViewportAnchor {
  id: string;
  offset: number;
}

export function survivingReviewAnchorShift(
  anchors: readonly ReviewViewportAnchor[],
  currentOffset: (id: string) => number | null,
  preferredId?: string,
): number | null {
  // Keep the next decision at the same visual position when its old row survives.
  const preferred = anchors.find((anchor) => anchor.id === preferredId);
  if (preferred) {
    const offset = currentOffset(preferred.id);
    if (offset !== null) return offset - preferred.offset;
  }
  for (const anchor of anchors) {
    const offset = currentOffset(anchor.id);
    if (offset !== null) return offset - anchor.offset;
  }
  return null;
}

interface ReviewScrollInput {
  viewportTop: number;
  viewportBottom: number;
  rowTop: number;
  rowBottom: number;
  scrollTop: number;
  requestedBehavior: ScrollBehavior;
  reducedMotion: boolean;
}

export function planReviewScroll(input: ReviewScrollInput): ScrollToOptions | null {
  const { viewportTop, viewportBottom, rowTop, rowBottom, scrollTop, requestedBehavior, reducedMotion } = input;
  const height = viewportBottom - viewportTop;
  if (height <= 0) return null;
  const inset = Math.min(48, Math.max(12, height * 0.1));
  const safeTop = viewportTop + Math.min(inset, height / 4);
  const safeBottom = viewportBottom - Math.min(inset, height / 4);
  if (rowTop >= safeTop && rowBottom <= safeBottom) return null;

  // Keep nearby rows at their current visual location; never recenter on every approval.
  const delta = rowBottom - rowTop > safeBottom - safeTop || rowTop < safeTop
    ? rowTop - safeTop
    : rowBottom - safeBottom;
  const top = Math.max(0, scrollTop + delta);
  if (Math.abs(top - scrollTop) < 0.5) return null;

  const distanceOutside = rowBottom < viewportTop ? viewportTop - rowBottom
    : rowTop > viewportBottom ? rowTop - viewportBottom : 0;
  const smooth = requestedBehavior === 'smooth' && !reducedMotion && distanceOutside > height * 0.5;
  return { top, behavior: smooth ? 'smooth' : 'instant' };
}
