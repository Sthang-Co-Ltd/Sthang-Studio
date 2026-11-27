export interface PlaybackSettings {
  playbackRate: number;
  volume: number;
  muted: boolean;
}

const playbackFailures = {
  1: { message: "Playback was interrupted. Retry playback to restart the player. Your source file and captions are unchanged.", key: 'notices.playback.interrupted' },
  2: { message: "The browser could not read the playback file. Retry playback to restart the player. Your source file and captions are unchanged.", key: 'notices.playback.network' },
  3: { message: "The browser could not decode the playback file. Retry playback to restart the player. Your source file and captions are unchanged.", key: 'notices.playback.decode' },
  4: { message: "The browser could not open the playback file. Retry playback to restart the player. Your source file and captions are unchanged.", key: 'notices.playback.unsupported' },
  fallback: { message: "Playback could not continue. Retry playback to restart the player. Your source file and captions are unchanged.", key: 'notices.playback.unknownFailure' },
} as const;

export function playbackFailure(code?: number) {
  return code === 1 || code === 2 || code === 3 || code === 4 ? playbackFailures[code] : playbackFailures.fallback;
}

export function playbackFailureMessage(code?: number) {
  return playbackFailure(code).message;
}

/** A failed decoder can reset currentTime to zero; keep the last healthy clock. */
export function recoveryPosition(element: { error: unknown; currentTime: number }, lastPosition: number) {
  return !element.error && Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : lastPosition;
}

export function restoredPosition(position: number, duration: number) {
  return Number.isFinite(duration) ? Math.min(position, Math.max(0, duration - 0.05)) : position;
}

/** No automatic reload: a slow/blocked player offers an explicit, state-preserving retry. */
interface PlaybackWatchScheduler {
  now(): number;
  visible(): boolean;
  every(callback: () => void): () => void;
  onVisibilityChange?(callback: () => void): () => void;
}
interface PlaybackPresentation {
  onFirstFrame?: () => void;
  onFirstFrameWait?: (visibleWaitMs: number) => void;
  alreadyPresented?: boolean;
}
const playbackWatchScheduler: PlaybackWatchScheduler = {
  now: () => performance.now(), visible: () => document.visibilityState === 'visible',
  every: (callback) => { const timer = setInterval(callback, 1000); return () => clearInterval(timer); },
  onVisibilityChange: (callback) => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
};
export function watchPlaybackProgress(element: HTMLMediaElement, onStall: () => void, onProgress: () => void = () => {}, scheduler: PlaybackWatchScheduler = playbackWatchScheduler, presentation: PlaybackPresentation = {}) {
  const source = element.getAttribute('src');
  let lastTime = element.currentTime;
  let lastProgress = scheduler.now();
  let firstFrameStarted = lastProgress;
  let firstFrameSeen = Boolean(presentation.alreadyPresented);
  let warned = false;
  let frame: number | undefined;
  let disposed = false;
  const video = element as HTMLVideoElement;
  const hasFrames = typeof video.requestVideoFrameCallback === 'function';
  const ownsSource = () => !disposed && Boolean(source) && element.isConnected && element.getAttribute('src') === source && !element.error;
  const presented = () => {
    if (!ownsSource()) return;
    lastProgress = scheduler.now(); lastTime = element.currentTime; warned = false;
    if (!firstFrameSeen) { firstFrameSeen = true; presentation.onFirstFrame?.(); }
    onProgress();
  };
  const nextFrame = () => {
    if (disposed || !hasFrames) return;
    frame = video.requestVideoFrameCallback(() => {
      if (!ownsSource()) return;
      presented(); nextFrame();
    });
  };
  nextFrame();
  // Metadata and an advancing audio clock do not prove that video was presented.
  // Older video implementations and audio use loadeddata as their readiness signal.
  const loaded = () => { if (!hasFrames && element.readyState >= 2) presented(); };
  element.addEventListener('loadeddata', loaded);
  loaded();
  const reset = () => { lastProgress = scheduler.now(); lastTime = element.currentTime; };
  const events = ['play', 'pause', 'seeking', 'seeked', 'ratechange'];
  for (const event of events) element.addEventListener(event, reset);
  // A background tab can suspend every interval. Reset on visibility changes
  // as well, so hidden wall time cannot consume the first-frame trial.
  const stopVisibility = scheduler.onVisibilityChange?.(() => {
    if (disposed) return;
    reset(); firstFrameStarted = scheduler.now();
  });
  const stopTimer = scheduler.every(() => {
    if (disposed) return;
    if (!ownsSource() || !scheduler.visible()) { reset(); firstFrameStarted = scheduler.now(); return; }
    const now = scheduler.now();
    if (!firstFrameSeen) {
      // This also catches a paused HAVE_CURRENT_DATA player with no picture and
      // a decoder whose audio clock advances before its first video frame.
      presentation.onFirstFrameWait?.(now - firstFrameStarted);
      if (!warned && now - firstFrameStarted >= 20_000) { warned = true; onStall(); }
      return;
    }
    if (element.ended) { reset(); return; }
    if (element.currentTime !== lastTime) { lastTime = element.currentTime; lastProgress = now; warned = false; onProgress(); }
    const awaitingData = element.readyState < 2 || element.seeking;
    if (!awaitingData && element.paused) { reset(); return; }
    if (!warned && now - lastProgress >= 20_000) {
      warned = true; onStall();
    }
  });
  return () => {
    disposed = true; stopTimer(); stopVisibility?.();
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    element.removeEventListener('loadeddata', loaded);
    for (const event of events) element.removeEventListener(event, reset);
  };
}
