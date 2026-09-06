import type { CaptionRenderState } from '@kcs/shared';

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

/** Pixels occupied by object-fit: contain video, excluding letterbox/pillarbox space. */
export function containedVideoFrame(width: number, height: number, videoWidth: number, videoHeight: number) {
  if (![width, height, videoWidth, videoHeight].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const frameWidth = videoWidth * scale;
  const frameHeight = videoHeight * scale;
  return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
}
