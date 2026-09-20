export interface TimingPlaybackRange { startMs: number; endMs: number; loop: boolean }

/** A bounded audition owns its listeners/animation only until stopped or paused. */
export function playTimingRange(
  media: HTMLMediaElement,
  range: TimingPlaybackRange,
  onError: () => void,
  onFinish?: () => void,
): (pause?: boolean) => void {
  const durationMs = Number.isFinite(media.duration) ? media.duration * 1000 : range.endMs;
  const start = Math.max(0, range.startMs) / 1000;
  const end = Math.min(durationMs, range.endMs) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return () => {};
  let active = true;
  let frame = 0;
  let restarting = false;
  const cleanup = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    media.removeEventListener('pause', paused);
    media.removeEventListener('ended', ended);
    onFinish?.();
  };
  const stop = () => { cleanup(); media.pause(); };
  const play = () => { void media.play().catch(() => { if (active) { stop(); onError(); } }); };
  const restart = () => {
    if (!active) return;
    restarting = true;
    media.currentTime = start;
    play();
    restarting = false;
  };
  const paused = () => {
    // A pause event queued by an older playback can arrive after replay starts.
    if (!media.paused) return;
    // The browser pauses before dispatching `ended`; keep a requested end-of-media loop alive.
    if (!restarting && !(range.loop && media.ended)) cleanup();
  };
  const ended = () => { if (range.loop) restart(); else cleanup(); };
  const tick = () => {
    if (!active) return;
    if (media.currentTime >= end) {
      if (range.loop) restart();
      else { stop(); media.currentTime = end; return; }
    }
    frame = requestAnimationFrame(tick);
  };
  media.addEventListener('pause', paused);
  media.addEventListener('ended', ended);
  media.currentTime = start;
  play();
  frame = requestAnimationFrame(tick);
  // Releasing range ownership after a user's seek must leave their new position
  // and playback untouched. An old disposer cannot interrupt later playback.
  return (pause = true) => { if (active) { if (pause) stop(); else cleanup(); } };
}
