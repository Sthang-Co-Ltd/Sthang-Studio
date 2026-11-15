export type ReviewPlaybackOwner = ReturnType<typeof ownReviewPlayback>;

/** A Review/Comparison pass yields to native pause or seeking without changing
 * the saved loop preference, the selected caption, or the creator's playback. */
export function ownReviewPlayback(
  media: HTMLMediaElement,
  kind: 'review' | 'proposal',
  startMs: number,
  pauseBeforeSeek: boolean,
  onYield: () => void,
) {
  let active = true;
  let ownSeekTarget: number | null = Math.max(0, startMs) / 1000;
  let ownPausePending = pauseBeforeSeek && !media.paused;
  const release = () => {
    if (!active) return;
    active = false;
    media.removeEventListener('pause', paused);
    media.removeEventListener('seeking', seeking);
    media.removeEventListener('seeked', seeked);
    ownSeekTarget = null;
  };
  const yieldPlayback = () => { if (active) { release(); onYield(); } };
  const paused = () => {
    if (ownPausePending) { ownPausePending = false; return; }
    // A queued old pause event may arrive after a new playback has started.
    if (media.paused) yieldPlayback();
  };
  const seeking = () => {
    if (ownSeekTarget !== null && Math.abs(media.currentTime - ownSeekTarget) < 0.05) return;
    yieldPlayback();
  };
  const seeked = () => { ownSeekTarget = null; };
  media.addEventListener('pause', paused);
  media.addEventListener('seeking', seeking);
  media.addEventListener('seeked', seeked);
  if (pauseBeforeSeek) media.pause();
  media.currentTime = ownSeekTarget;
  return { media, kind, get active() { return active; }, release };
}
