export interface TimingPlaybackRange { startMs: number; endMs: number; loop: boolean }

/** A bounded audition owns playback only until stopped, paused or manually sought. */
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
  let ownSeekTarget: number | null = null;
  const cleanup = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    media.removeEventListener('pause', paused);
    media.removeEventListener('ended', ended);
    media.removeEventListener('seeking', seeking);
    media.removeEventListener('seeked', seeked);
    ownSeekTarget = null;
    onFinish?.();
  };
  const stop = () => { cleanup(); media.pause(); };
  const play = () => { void media.play().catch(() => { if (active) { stop(); onError(); } }); };
  const seekToStart = () => { ownSeekTarget = start; media.currentTime = start; };
  const restart = () => {
    if (!active) return;
    restarting = true;
    seekToStart();
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
  const seeking = () => {
    // Initial playback and every loop restart seek deliberately. Their queued
    // events must not retire the range; another seek yields without pausing it.
    if (ownSeekTarget !== null && Math.abs(media.currentTime - ownSeekTarget) < 0.05) return;
    cleanup();
  };
  const seeked = () => { ownSeekTarget = null; };
  const tick = () => {
    if (!active) return;
    // A new seek position is visible before its queued seeking handler can
    // release range ownership. Never clamp or restart that pending seek.
    if (!media.seeking && media.currentTime >= end) {
      if (range.loop) restart();
      else { stop(); media.currentTime = end; return; }
    }
    frame = requestAnimationFrame(tick);
  };
  media.addEventListener('pause', paused);
  media.addEventListener('ended', ended);
  media.addEventListener('seeking', seeking);
  media.addEventListener('seeked', seeked);
  seekToStart();
  play();
  frame = requestAnimationFrame(tick);
  // Releasing range ownership after a user's seek must leave their new position
  // and playback untouched. An old disposer cannot interrupt later playback.
  return (pause = true) => { if (active) { if (pause) stop(); else cleanup(); } };
}
