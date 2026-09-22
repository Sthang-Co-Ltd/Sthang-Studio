import type { CaptionRenderState } from '@kcs/shared';

export function captionPreviewPaintKey(state: CaptionRenderState) {
  return state.paintKey || state.key;
}

export function captionPreviewStateIndex(states: CaptionRenderState[], timeMs: number) {
  let low = 0;
  let high = states.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (timeMs < states[mid].atMs) high = mid - 1;
    else if (timeMs >= states[mid].endMs) low = mid + 1;
    else return mid;
  }
  return -1;
}

/** Collect at most eight missing drawable paint states from a nonnegative state index.
 * An optional cue key bounds spoken-word prefetch to the currently visible block.
 */
export function captionPreviewLookahead(
  states: readonly CaptionRenderState[],
  start: number,
  skipKeys: ReadonlySet<string> = new Set(),
  cueKey?: string,
) {
  const wanted: CaptionRenderState[] = [];
  const seen = new Set(skipKeys);
  for (let index = start; index < states.length && wanted.length < 8; index += 1) {
    const state = states[index];
    if (cueKey !== undefined && state.key !== cueKey) break;
    if (!state.key) continue;
    const paintKey = captionPreviewPaintKey(state);
    if (seen.has(paintKey)) continue;
    seen.add(paintKey);
    wanted.push(state);
  }
  return wanted;
}

/** Prepare just the opening of an explicitly requested replay. The normal eight-
 * frame request and 24-image cache bounds still apply; never preload a whole film.
 */
export function captionPreviewReplayStates(states: readonly CaptionRenderState[], startMs: number, endMs: number) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const selected: CaptionRenderState[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    if (state.atMs >= endMs || selected.length >= 16) break;
    if (!state.key || state.endMs <= startMs) continue;
    const key = captionPreviewPaintKey(state);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(state);
  }
  return selected;
}

/** Pixels occupied by object-fit: contain video, excluding letterbox/pillarbox space. */
export function containedVideoFrame(width: number, height: number, videoWidth: number, videoHeight: number) {
  if (![width, height, videoWidth, videoHeight].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const frameWidth = videoWidth * scale;
  const frameHeight = videoHeight * scale;
  return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
}
