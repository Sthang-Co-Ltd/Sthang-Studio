import type { CaptionRenderState } from '@kcs/shared';
import { captionPreviewLookahead, captionPreviewPaintKey } from './caption-preview-plan.js';

export interface NativePreviewBatch {
  kind: 'current' | 'prefetch' | 'catchup';
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
  );
  if (!wanted.length) return null;
  // Keep the established low-churn prefetch threshold for ordinary static
  // captions. Temporal highlights warm nearby paints across cue boundaries too;
  // restricting them to the current cue makes every adjacent caption start cold.
  // The nine-state window and four-paint batch still bound speculative work.
  if (!temporalPaint && current?.key && wanted.length < 4) return null;
  return {
    kind: 'prefetch',
    states: temporalPaint ? wanted.slice(0, 4) : wanted,
  };
}

/** One bounded attempt to get ahead after a current paint completed too late.
 * The caller consumes the allowance even when no candidate is available. This
 * never changes the media clock or claims that slow rendering can paint every word.
 */
export function planNativePreviewCatchup(
  states: readonly CaptionRenderState[], index: number,
  cached: ReadonlySet<string>, nowMs: number, renderDurationMs: number, playbackRate: number,
): NativePreviewBatch | null {
  if (index < 0 || !Number.isFinite(nowMs) || !Number.isFinite(renderDurationMs)
    || renderDurationMs <= 0 || !Number.isFinite(playbackRate) || playbackRate <= 0) return null;
  const current = states[index];
  if (!current?.key) return null;
  // A late current render still needs its one recovery attempt when playback
  // lands on an already-cached paint. Keep those exact current pixels while
  // preparing a future interval that can outlive the measured render latency.
  // Include a small scheduling margin, but never chase an arbitrarily distant
  // paint when the renderer is too slow. Both time and state-count bounds apply.
  const leadMs = (renderDurationMs + 25) * playbackRate;
  if (leadMs > 1000) return null;
  const targetMs = nowMs + leadMs;
  // Prepare a complete future interval, not the tail containing the estimate.
  // A few milliseconds of response/commit jitter can consume that entire tail.
  const target = states.slice(index + 1, index + TEMPORAL_PREVIEW_WINDOW).find((state) =>
    Boolean(state.key) && state.atMs >= targetMs && state.atMs <= nowMs + 1000
    && !cached.has(captionPreviewPaintKey(state)));
  return target ? { kind: 'catchup', states: [target] } : null;
}

/** Wall-time budget for a speculative singleton, including a short late grace. */
export function nativePreviewCatchupTimeoutMs(endMs: number, nowMs: number, playbackRate: number) {
  if (![endMs, nowMs, playbackRate].every(Number.isFinite) || playbackRate <= 0) return 100;
  return Math.min(1000, Math.max(100, (endMs - nowMs) / playbackRate + 100));
}

/** Keep useful singleton lookahead through cached paints and real gaps only.
 * Any unrelated missing current paint must still preempt speculative work.
 */
export function retainNativePreviewPrefetch(
  states: readonly CaptionRenderState[], index: number, cached: ReadonlySet<string>,
  pending: ReadonlySet<string>, nowMs: number,
) {
  if (pending.size !== 1 || !Number.isFinite(nowMs)) return false;
  const current = index >= 0 ? states[index] : undefined;
  if (current?.key && !cached.has(captionPreviewPaintKey(current))) return false;
  return states.slice(Math.max(0, index), Math.max(0, index) + TEMPORAL_PREVIEW_WINDOW)
    .some((state) => Boolean(state.key) && state.endMs > nowMs && pending.has(captionPreviewPaintKey(state)));
}
