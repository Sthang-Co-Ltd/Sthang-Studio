const TARGET_FRAME_INTERVAL_MS = 1000 / 30;
const MIN_TIME_DELTA_SECONDS = 0.0005;
const CAPTION_MEDIA_SELECTOR = '.media-stage > video, .media-stage > audio';

type VideoFrameMetadataLike = { mediaTime: number };
type VideoFrameCallbackLike = (now: number, metadata: VideoFrameMetadataLike) => void;

export interface MediaClockTarget extends EventTarget {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  isConnected?: boolean;
  requestVideoFrameCallback?: (callback: VideoFrameCallbackLike) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface MediaClockScheduler {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  now(): number;
}

const browserScheduler: MediaClockScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};

type ScheduledFrame = {
  kind: 'animation' | 'video';
  handle: number;
};

/**
 * Fill the long, browser-dependent gaps between native `timeupdate` events.
 *
 * Sthang Studio already treats `timeupdate` as the single playback clock for
 * preview captions, selection, and review loops. Word captions expose the
 * browser's normal coarse event cadence much more clearly than longer groups.
 * This helper emits only the missing events, prefers presented video frames,
 * and never changes media time or caption/SRT timestamps.
 */
export function attachPreciseMediaTimeUpdates(
  target: MediaClockTarget,
  scheduler: MediaClockScheduler = browserScheduler,
) {
  let scheduled: ScheduledFrame | null = null;
  let disposed = false;
  let dispatching = false;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;
  let lastObservedTime = Number.NaN;

  const currentTime = () => Number.isFinite(target.currentTime) ? Math.max(0, target.currentTime) : 0;

  const cancelScheduled = () => {
    if (!scheduled) return;
    if (scheduled.kind === 'video') target.cancelVideoFrameCallback?.call(target, scheduled.handle);
    else scheduler.cancelAnimationFrame(scheduled.handle);
    scheduled = null;
  };

  const dispatchTimeUpdate = (now: number, observedTime = currentTime(), force = false) => {
    if (!Number.isFinite(observedTime)) return;
    const normalizedTime = Math.max(0, observedTime);
    if (!force && now - lastUpdateAt < TARGET_FRAME_INTERVAL_MS) return;
    if (!force && Number.isFinite(lastObservedTime) && Math.abs(normalizedTime - lastObservedTime) < MIN_TIME_DELTA_SECONDS) return;

    lastUpdateAt = now;
    lastObservedTime = normalizedTime;
    dispatching = true;
    try {
      target.dispatchEvent(new Event('timeupdate'));
    } finally {
      dispatching = false;
    }
  };

  const scheduleNext = () => {
    if (disposed || scheduled || target.paused || target.ended || target.isConnected === false) return;

    const requestVideoFrame = target.requestVideoFrameCallback;
    const cancelVideoFrame = target.cancelVideoFrameCallback;
    if (typeof requestVideoFrame === 'function' && typeof cancelVideoFrame === 'function') {
      const pending: ScheduledFrame = { kind: 'video', handle: 0 };
      scheduled = pending;
      pending.handle = requestVideoFrame.call(target, (now, metadata) => {
        if (scheduled !== pending) return;
        scheduled = null;
        if (disposed || target.paused || target.ended || target.isConnected === false) return;
        dispatchTimeUpdate(now, metadata.mediaTime);
        scheduleNext();
      });
      return;
    }

    const pending: ScheduledFrame = { kind: 'animation', handle: 0 };
    scheduled = pending;
    pending.handle = scheduler.requestAnimationFrame((now) => {
      if (scheduled !== pending) return;
      scheduled = null;
      if (disposed || target.paused || target.ended || target.isConnected === false) return;
      dispatchTimeUpdate(now);
      scheduleNext();
    });
  };

  const forceSync = () => dispatchTimeUpdate(scheduler.now(), currentTime(), true);
  const onPlay: EventListener = () => { forceSync(); scheduleNext(); };
  const onPlaying: EventListener = () => scheduleNext();
  const onPause: EventListener = () => { cancelScheduled(); forceSync(); };
  const onWaiting: EventListener = () => cancelScheduled();
  const onSeeking: EventListener = () => { cancelScheduled(); forceSync(); };
  const onSeeked: EventListener = () => { forceSync(); scheduleNext(); };
  const onEnded: EventListener = () => { cancelScheduled(); forceSync(); };
  const onEmptied: EventListener = () => { cancelScheduled(); forceSync(); };
  const onLoadedMetadata: EventListener = () => forceSync();
  const onNativeTimeUpdate: EventListener = () => {
    if (dispatching || disposed) return;
    lastUpdateAt = scheduler.now();
    lastObservedTime = currentTime();
  };

  const listeners: Array<[string, EventListener]> = [
    ['play', onPlay],
    ['playing', onPlaying],
    ['pause', onPause],
    ['waiting', onWaiting],
    ['seeking', onSeeking],
    ['seeked', onSeeked],
    ['ended', onEnded],
    ['emptied', onEmptied],
    ['loadedmetadata', onLoadedMetadata],
    ['timeupdate', onNativeTimeUpdate],
  ];
  for (const [name, listener] of listeners) target.addEventListener(name, listener);

  forceSync();
  scheduleNext();

  return () => {
    if (disposed) return;
    disposed = true;
    cancelScheduled();
    for (const [name, listener] of listeners) target.removeEventListener(name, listener);
  };
}

/** Keep the frame-rate clock scoped to the single media player in the caption stage. */
export function installCaptionMediaClock(root: ParentNode = document) {
  const attached = new Map<HTMLMediaElement, () => void>();

  const reconcile = () => {
    const current = new Set(Array.from(root.querySelectorAll<HTMLMediaElement>(CAPTION_MEDIA_SELECTOR)));
    for (const element of current) {
      if (!attached.has(element)) attached.set(element, attachPreciseMediaTimeUpdates(element));
    }
    for (const [element, cleanup] of attached) {
      if (current.has(element)) continue;
      cleanup();
      attached.delete(element);
    }
  };

  const observer = new MutationObserver(reconcile);
  observer.observe(root as Node, { childList: true, subtree: true });
  reconcile();

  return () => {
    observer.disconnect();
    for (const cleanup of attached.values()) cleanup();
    attached.clear();
  };
}
