import { captionMotionContextIndices, type CaptionAppearance, type CaptionPreviewFrame, type CaptionRenderState, type CaptionSegment } from '@kcs/shared';

/** Only resample already-native pixels. Font/effect/width changes require fresh
 * pixels; there is deliberately no browser text-layout or font-metric fallback.
 */
export function captionPreviewTransform(
  previous: CaptionAppearance, next: CaptionAppearance,
  width: number, height: number, bounds: CaptionPreviewFrame['bounds'],
  displayWidth = width, displayHeight = height,
): string | undefined {
  if (!bounds || ![width, height].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  for (const key of Object.keys(previous) as Array<keyof CaptionAppearance>) {
    if (key !== 'fontSize1080' && key !== 'positionBottomPct' && previous[key] !== next[key]) return undefined;
  }
  if (previous.fontSize1080 === next.fontSize1080 && previous.positionBottomPct === next.positionBottomPct) return undefined;
  const font = (size: number) => Math.round(size * height / 1080 * 10) / 10;
  const scale = font(next.fontSize1080) / font(previous.fontSize1080);
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const bottom = (pct: number) => Math.max(8, Math.round(height * pct / 100));
  const side = Math.max(8, Math.round(width * (100 - previous.maxWidthPct) / 200));
  const x = previous.alignment === 'left' ? side : previous.alignment === 'right' ? width - side : width / 2;
  const y = height - bottom(previous.positionBottomPct);
  const tx = (1 - scale) * x;
  const ty = (1 - scale) * y + bottom(previous.positionBottomPct) - bottom(next.positionBottomPct);
  // Clipped source pixels cannot be recovered by moving/scaling an old bitmap.
  // Keep that frame stationary until the native renderer can reveal the missing ink.
  if (bounds.x <= 0 || bounds.y <= 0 || bounds.x + bounds.width >= width || bounds.y + bounds.height >= height) return undefined;
  if (scale * bounds.x + tx < 0 || scale * bounds.y + ty < 0
    || scale * (bounds.x + bounds.width) + tx > width || scale * (bounds.y + bounds.height) + ty > height) return undefined;
  return `matrix(${scale}, 0, 0, ${scale}, ${tx * displayWidth / width}, ${ty * displayHeight / height})`;
}

/** Send only evidence contributing to the requested states, including overlaps.
 * Original timecodes and original-index cache keys stay intact in the editor.
 */
export function captionPreviewSelection(captions: CaptionSegment[], states: CaptionRenderState[], focusIndices?: number[], appearance?: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'>) {
  const activeIndices = [...new Set(states.flatMap((state) => state.key ? state.key.split(',').map(Number) : []))].sort((a, b) => a - b);
  // A cue that overlapped the entrance may already have ended at the requested
  // frame. Keep that bounded context so a compact native request cannot restart
  // geometry that the full timeline correctly suppressed.
  const indices = captionMotionContextIndices(captions, activeIndices, appearance);
  const selected = new Set(focusIndices);
  return {
    captions: indices.map((index) => {
      const { text, startMs, endMs, wordTiming } = captions[index];
      return { text, startMs, endMs, ...(wordTiming ? { wordTiming } : {}) };
    }),
    focusIndices: focusIndices ? indices.flatMap((index, compact) => selected.has(index) ? [compact] : []) : undefined,
  };
}
