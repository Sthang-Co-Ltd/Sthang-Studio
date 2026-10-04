export interface PlaybackSettings {
  playbackRate: number;
  volume: number;
  muted: boolean;
}

export function playbackFailureMessage(code?: number) {
  const reason = code === 1 ? 'Playback was interrupted.'
    : code === 2 ? 'The browser could not read the playback file.'
    : code === 3 ? 'The browser could not decode the playback file.'
    : code === 4 ? 'The browser could not open the playback file.'
    : 'Playback could not continue.';
  return `${reason} Retry playback to restart the player. Your source file and captions are unchanged.`;
}

/** A failed decoder can reset currentTime to zero; keep the last healthy clock. */
export function recoveryPosition(element: { error: unknown; currentTime: number }, lastPosition: number) {
  return !element.error && Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : lastPosition;
}

export function restoredPosition(position: number, duration: number) {
  return Number.isFinite(duration) ? Math.min(position, Math.max(0, duration - 0.05)) : position;
}
