export interface TimingPlaybackRange { startMs: number; endMs: number; loop: boolean }

/** A bounded audition owns its listeners/animation only until stopped or paused. */
export function playTimingRange(
  media: HTMLMediaElement,
  range: TimingPlaybackRange,
  onError: () => void,
): () => void {
  const durationMs = Number.isFinite(media.duration) ? media.duration * 1000 : range.endMs;
  const start = Math.max(0, range.startMs) / 1000;
  const end = Math.min(durationMs, range.endMs) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return () => {};
  let active = true;
  let frame = 0;
  let restarting = false;
  const cleanup = () => {
    active = false;
    cancelAnimationFrame(frame);
    media.removeEventListener('pause', paused);
    media.removeEventListener('ended', ended);
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
  // Calling an old disposer must not interrupt a newer ordinary playback session.
  return () => { if (active) stop(); };
}
