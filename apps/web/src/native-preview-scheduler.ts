import type { CaptionRenderState } from '@kcs/shared';
import { captionPreviewLookahead, captionPreviewPaintKey } from './caption-preview-plan.js';

export interface NativePreviewBatch {
  kind: 'current' | 'prefetch';
  states: CaptionRenderState[];
}

// Bound the searched window as well as each HTTP batch. Otherwise, after an
// old frame is evicted, a paused playhead can keep fetching distant or evicted
// paints instead of warming only the next few visible transitions.
export const TEMPORAL_PREVIEW_WINDOW = 9;

/**
 * The first visible native paint is latency-sensitive. The persistent FFmpeg
 * worker returns a batch only after rendering EVERY sample, so a batch of eight
 * uncached spoken-word states needlessly holds the current word behind seven
 * future paints. Prepare that exact current state alone, then warm a small,
 * bounded lookahead when its decoded image is already available.
 *
 * This only schedules authentic server-rendered paint states. Never synthesize
 * browser text, alter word timing, or mark a retained bitmap as exact.
 */
export function planNativePreviewBatch(
  states: readonly CaptionRenderState[],
  index: number,
  cached: ReadonlySet<string>,
  temporalPaint: boolean,
): NativePreviewBatch | null {
  const current = index >= 0 ? states[index] : undefined;
  if (current?.key && !cached.has(captionPreviewPaintKey(current))) {
    return { kind: 'current', states: [current] };
  }

  const start = Math.max(0, index);
  const window = temporalPaint ? states.slice(start, start + TEMPORAL_PREVIEW_WINDOW) : states;
  const wanted = captionPreviewLookahead(
    window,
    temporalPaint ? 0 : start,
    cached,
    temporalPaint && current?.key ? current.key : undefined,
  );
  if (!wanted.length) return null;
  // Keep the established low-churn prefetch threshold for ordinary static
  // captions. Temporal highlights instead prefer a short same-cue lookahead;
  // it should never monopolize the native worker at the next word transition.
  if (!temporalPaint && current?.key && wanted.length < 4) return null;
  return {
    kind: 'prefetch',
    states: temporalPaint ? wanted.slice(0, 4) : wanted,
  };
}
