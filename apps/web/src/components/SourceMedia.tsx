import { useI18n } from '../i18n';
import type { MessageKey, MessageParams } from '../i18n/types';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent, type RefObject } from 'react';
import { checkMediaPreviewCopy, MediaPreviewClientError, needsCompatiblePlayback, requestMediaPreview, type MediaPreviewStatus } from '../media-preview-client';
import { playbackFailure, recoveryPosition, restoredPosition, watchPlaybackProgress, type PlaybackSettings } from '../media-playback-recovery';
import { createMediaClockBinding } from '../media-clock';
import './source-media.css';

interface Props {
  src: string;
  projectId: string;
  source: string;
  video: boolean;
  playbackRate: number;
  media: RefObject<HTMLMediaElement | null>;
  recoveryFocusTarget: RefObject<HTMLElement | null>;
  onElementChange: (element: HTMLMediaElement | null) => void;
  onLoadedMetadata: (element: HTMLMediaElement) => void;
  onTimeUpdate: (element: HTMLMediaElement) => void;
  onRetry: () => void;
}

type PreviewError = { key: MessageKey; params?: MessageParams } | { message: string; serverText?: boolean };

function previewRequestFailure(error: unknown, fallback: MessageKey): PreviewError {
  if (error instanceof MediaPreviewClientError && error.messageMetadata) return error.messageMetadata;
  if (error instanceof Error) return { message: error.message, serverText: error instanceof MediaPreviewClientError };
  return { key: fallback };
}

function readyPreviewWarning(preview: MediaPreviewStatus | null): PreviewError | null {
  return preview?.state === 'ready' && preview.message ? { message: preview.message, serverText: true } : null;
}

/** Mount with a project/media key. Recovery never changes the source project. */
export function SourceMedia({ src, projectId, source, video, playbackRate, media, recoveryFocusTarget, onElementChange, onLoadedMetadata, onTimeUpdate, onRetry }: Props) {
  const [playbackSrc, setPlaybackSrc] = useState<string | undefined>(video ? undefined : src);
  const [failed, setFailed] = useState(false);
  const [failureCode, setFailureCode] = useState<number>();
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [preview, setPreview] = useState<MediaPreviewStatus | null>(null);
  const { t } = useI18n();
  const [previewError, setPreviewError] = useState<PreviewError | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [pollStopped, setPollStopped] = useState(false);
  const [stalled, setStalled] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const stopWatch = useRef<(() => void) | null>(null);
  const stallFailure = useRef(false);
  const selectedSource = useRef(playbackSrc);
  const readyPlayer = useRef<{ element: HTMLMediaElement; source: string } | null>(null);
  const directPlaybackTrial = useRef<{ element: HTMLMediaElement; source: string; sequence: number } | null>(null);
  const decoderFailure = useRef<HTMLMediaElement | null>(null);
  const restoreTime = useRef<number | null>(null);
  const lastPosition = useRef(0);
  const alive = useRef(true);
  const sequence = useRef(0);
  const terminalResponseSequence = useRef<number | null>(null);
  const retrySequence = useRef<number | null>(null);
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const playbackSettings = useRef<PlaybackSettings | null>(null);
  // Set before any metadata/status reply; later speed controls write to the
  // current element directly and must not change this stable ref callback.
  const initialPlaybackRate = useRef(playbackRate);
  const [bindClock] = useState(() => createMediaClockBinding());
  const handoffRecoveryFocus = (trigger?: HTMLButtonElement) => {
    if (!trigger || document.activeElement !== trigger || document.querySelector('[aria-modal="true"]')) return;
    const target = recoveryFocusTarget.current;
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[inert], [aria-hidden="true"]')) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  };
  const attach = useCallback((element: HTMLMediaElement | null) => {
    // StrictMode can replay a newly keyed media ref after the parent's layout
    // effect. That replay must not tear down its live presentation watcher;
    // effect cleanup, explicit replacement and media errors own that teardown.
    media.current = element;
    if (element) {
      const settings = playbackSettings.current;
      const rate = settings?.playbackRate ?? initialPlaybackRate.current;
      Object.assign(element, { defaultPlaybackRate: rate, playbackRate: rate, ...settings });
    }
    onElementChange(element);
    bindClock(element);
  }, [media, onElementChange, bindClock]);
  useLayoutEffect(() => {
    const element = media.current;
    if (!element || !playbackSrc) return;
    const ownsPlayer = () => media.current === element && element.getAttribute('src') === playbackSrc && !element.error && decoderFailure.current !== element;
    const stop = watchPlaybackProgress(element, () => {
      if (!ownsPlayer()) return;
      stallFailure.current = true;
      setStalled(true); setFailed(true); setRecovering(false);
    }, () => {
      if (ownsPlayer() && stallFailure.current) { stallFailure.current = false; setStalled(false); setFailed(false); }
    }, undefined, {
      alreadyPresented: readyPlayer.current?.element === element && readyPlayer.current?.source === playbackSrc,
      onFirstFrame: () => {
        if (!ownsPlayer()) return;
        directPlaybackTrial.current = null;
        readyPlayer.current = { element, source: playbackSrc };
        stallFailure.current = false;
        setRecovering(false); setFailed(false); setStalled(false);
      },
      onFirstFrameWait: (visibleWaitMs) => {
        const trial = directPlaybackTrial.current;
        if (visibleWaitMs < 5000 || !alive.current || !ownsPlayer() || trial?.element !== element
          || trial.source !== playbackSrc || trial.sequence !== sequence.current
          || selectedSource.current !== src || attempted.current || inFlight.current) return;
        directPlaybackTrial.current = null;
        void prepare();
      },
    });
    stopWatch.current = stop;
    return () => { stop(); if (stopWatch.current === stop) stopWatch.current = null; };
  }, [attach, media, playbackSrc, playerGeneration, video]);
  const selectSource = (next: string) => { selectedSource.current = next; setPlaybackSrc(next); };
  const currentPlayerReady = () => readyPlayer.current?.element === media.current && readyPlayer.current?.source === selectedSource.current
    && Boolean(media.current) && !media.current!.error && decoderFailure.current !== media.current;
  const preservePosition = () => {
    const element = media.current;
    // Repeated Retry clicks before metadata must not replace the saved position with zero.
    if (restoreTime.current === null) restoreTime.current = element ? recoveryPosition(element, lastPosition.current) : lastPosition.current;
    if (element) playbackSettings.current = { playbackRate: element.playbackRate, volume: element.volume, muted: element.muted };
    element?.pause();
    onRetry();
  };
  const replacePlayer = () => {
    const previous = media.current;
    // Retire the failed decoder before creating a new one. Ignore its late events.
    stopWatch.current?.(); stopWatch.current = null;
    directPlaybackTrial.current = null;
    readyPlayer.current = null;
    media.current = null;
    previous?.pause();
    previous?.removeAttribute('src');
    previous?.load();
    setPlayerGeneration((generation) => generation + 1);
  };
  const accept = (value: MediaPreviewStatus, keepRecoveredPlayer = false) => {
    terminalResponseSequence.current = value.state === 'processing' ? null : sequence.current;
    if (value.state !== 'processing') setRequesting(false);
    setPreviewError(readyPreviewWarning(value));
    setPreview(value);
    setPollStopped(false);
    if (value.state === 'ready' && value.url) {
      // A late status reply cannot restart a same-URL decoder that Retry has
      // already recovered. A deliberate rebuild still gets a fresh decoder.
      if (keepRecoveredPlayer && value.url === selectedSource.current && currentPlayerReady()) return;
      if (media.current?.getAttribute('src')) preservePosition();
      stallFailure.current = false;
      setStalled(false);
      selectSource(value.url);
      setRecovering(true);
      setFailed(false);
      replacePlayer();
    }
  };
  const prepare = async (trigger?: HTMLButtonElement) => {
    if (inFlight.current || preview?.state === 'processing' || (playbackSrc && playbackSrc !== src && !failed && !preview?.message)) return;
    directPlaybackTrial.current = null;
    handoffRecoveryFocus(trigger);
    attempted.current = true;
    inFlight.current = true;
    const request = ++sequence.current;
    retrySequence.current = null;
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setRequesting(true); setPreviewError(null);
    // Keep tracking manual seeks during preparation; only arm restoration when
    // a new source is actually loaded. Cancelling leaves the original playable.
    media.current?.pause();
    onRetry();
    try {
      const value = await requestMediaPreview(projectId, source, 'POST', controller.signal, Boolean(playbackSrc && playbackSrc !== src));
      if (alive.current && sequence.current === request) accept(value);
    } catch (error) {
      if (alive.current && sequence.current === request) setPreviewError(previewRequestFailure(error, 'media.playback.preparationFailed'));
    } finally {
      if (sequence.current === request) { inFlight.current = false; if (alive.current) setRequesting(false); }
    }
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const request = sequence.current;
    const ownsStartup = () => !controller.signal.aborted && alive.current && sequence.current === request;
    let sourceFallback: ReturnType<typeof setTimeout> | undefined;
    if (video) {
      // Release direct playback promptly without discarding a slower local
      // inspection. Its normal request deadline still bounds headers and body.
      sourceFallback = setTimeout(() => { if (ownsStartup()) selectSource(src); }, 1500);
      void requestMediaPreview(projectId, source, 'GET', controller.signal).then((value) => {
        clearTimeout(sourceFallback);
        if (!ownsStartup()) return;
        if (value.state !== 'ready') selectSource(src);
        accept(value);
        const element = media.current;
        if (value.state === 'original' && element && needsCompatiblePlayback(value.videoCodec, (type) => element.canPlayType(type))) {
          // Codec hints can be false negatives even when this browser presents
          // HEVC. Give the owned original five visible seconds for a real frame;
          // a late inspection must also respect a frame already presented.
          if (typeof (element as HTMLVideoElement).requestVideoFrameCallback !== 'function') void prepare();
          else if (!currentPlayerReady()) directPlaybackTrial.current = { element, source: src, sequence: request };
        }
      }).catch(() => { if (ownsStartup()) selectSource(src); })
        .finally(() => { clearTimeout(sourceFallback); });
    }
    return () => { alive.current = false; directPlaybackTrial.current = null; clearTimeout(sourceFallback); controller.abort(); operation.current?.abort(); };
    // The parent keys this component by project and immutable media filename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, source, video]);
  useEffect(() => {
    if (preview?.state !== 'processing' || pollStopped) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const request = sequence.current;
    const deadline = performance.now() + 16 * 60_000;
    let errors = 0;
    const poll = async () => {
      if (terminalResponseSequence.current === request) return;
      if (performance.now() >= deadline) { setPollStopped(true); setPreviewError({ key: 'media.playback.preparationSlow' }); return; }
      try {
        const value = await requestMediaPreview(projectId, source, 'GET', controller.signal);
        if (controller.signal.aborted || !alive.current || sequence.current !== request || terminalResponseSequence.current === request) return;
        errors = 0;
        accept(value, retrySequence.current === request);
        if (value.state === 'processing') timer = setTimeout(poll, 750);
      } catch {
        if (!controller.signal.aborted && alive.current && sequence.current === request && terminalResponseSequence.current !== request) {
          setPreviewError({ key: 'media.playback.progressUnavailable' });
          if (++errors >= 3) setPollStopped(true);
          else timer = setTimeout(poll, 1500);
        }
      }
    };
    timer = setTimeout(poll, 250);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.state, projectId, source, pollGeneration, pollStopped]);
  const cancel = async (trigger?: HTMLButtonElement) => {
    directPlaybackTrial.current = null;
    handoffRecoveryFocus(trigger);
    const request = ++sequence.current;
    retrySequence.current = null;
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    inFlight.current = false;
    setPollGeneration((generation) => generation + 1);
    setRequesting(true);
    try {
      const value = await requestMediaPreview(projectId, source, 'DELETE', controller.signal);
      if (alive.current && sequence.current === request && terminalResponseSequence.current !== request) {
        accept(value, true); setPreviewError(null);
      }
    } catch {
      // A restarted poll can finish preparation while this DELETE is pending.
      // Its terminal result owns the player and notice, even if DELETE arrives late.
      if (alive.current && sequence.current === request && terminalResponseSequence.current !== request) setPreviewError({ key: 'media.playback.cancelFailed' });
    } finally { if (alive.current && sequence.current === request) setRequesting(false); }
  };
  const retry = async (trigger: HTMLButtonElement) => {
    if (!media.current) return;
    directPlaybackTrial.current = null;
    handoffRecoveryFocus(trigger);
    preservePosition();
    const copy = selectedSource.current;
    const request = ++sequence.current;
    retrySequence.current = request;
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    inFlight.current = false; stallFailure.current = false;
    setRequesting(false); setStalled(false);
    setPreviewError(readyPreviewWarning(preview));
    setRecovering(true); setFailed(false);
    setPreview((value) => value && value.state !== 'ready' && value.state !== 'processing' ? { ...value, state: 'original', message: undefined } : value);
    // Decoder recovery must not wait for an optional status API. The actual
    // copy can still be healthy when status lookup is unavailable or stalled.
    replacePlayer();
    if (copy && copy !== src) {
      const ownsRequest = () => !controller.signal.aborted && alive.current && sequence.current === request && selectedSource.current === copy;
      let missing = false;
      try {
        missing = await checkMediaPreviewCopy(copy, controller.signal) === 'missing';
        if (!ownsRequest() || !missing) return;
        let value = await requestMediaPreview(projectId, source, 'GET', controller.signal);
        if (!ownsRequest()) return;
        // Only a confirmed missing exact copy warrants looking up/rebuilding
        // the latest generation; an unavailable HEAD is deliberately fail-open.
        if (value.state !== 'ready' && value.state !== 'processing') value = await requestMediaPreview(projectId, source, 'POST', controller.signal);
        if (!ownsRequest()) return;
        accept(value, true);
        setPollGeneration((generation) => generation + 1);
      } catch (error) {
        if (missing && ownsRequest() && !currentPlayerReady()) {
          setRecovering(false); setFailed(true);
          setPreviewError(previewRequestFailure(error, 'media.playback.unavailable'));
        }
      }
    }
  };
  // Refresh the bounded server lease while this compatible copy is open. A
  // sleeping tab can lose its lease; Retry then checks/rebuilds the missing copy.
  useEffect(() => {
    if (!playbackSrc || playbackSrc === src) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void checkMediaPreviewCopy(playbackSrc, controller.signal).catch(() => {});
    }, 30_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [playbackSrc, src]);
  const props = {
    src: playbackSrc, controls: true, preload: 'auto' as const,
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current !== null) {
        const target = restoreTime.current;
        restoreTime.current = null;
        element.currentTime = restoredPosition(target, element.duration);
      }
      // Settings are restored on attachment only. Later user changes during
      // loading must win over the recovery snapshot. Metadata/seek restoration
      // reaches the parent immediately; only presented data completes recovery.
      onLoadedMetadata(element);
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current === null && !element.error && Number.isFinite(element.currentTime)) lastPosition.current = element.currentTime;
      onTimeUpdate(element);
    },
    onError: (event: SyntheticEvent<HTMLMediaElement>) => {
      if (media.current !== event.currentTarget) return;
      directPlaybackTrial.current = null;
      decoderFailure.current = event.currentTarget;
      stopWatch.current?.(); stopWatch.current = null;
      setFailed(true); setRecovering(false);
      event.currentTarget.pause();
      onRetry();
      // Network/abort failures keep ordinary reload recovery. Only an actual
      // decoder/unsupported-source failure automatically requests transcoding.
      const code = event.currentTarget.error?.code;
      stallFailure.current = false; setStalled(false); setFailureCode(code);
      if (video && !attempted.current && playbackSrc === src && (code === 3 || code === 4)) void prepare();
    },
  };
  const processing = requesting || preview?.state === 'processing';
  const offerCopy = video && (failed || Boolean(preview?.state === 'ready' && preview.message) || playbackSrc === src && (failed || ['hevc', 'h265'].includes(preview?.videoCodec || '') || preview?.state === 'failed' || preview?.state === 'cancelled'));
  const failure = playbackFailure(failureCode);
  const previewErrorMessage = previewError && ('key' in previewError ? t(previewError.key, previewError.params) : previewError.message);
  const messageIsServerText = previewErrorMessage
    ? previewError && 'message' in previewError && previewError.serverText
    : !processing && preview?.state === 'failed' && Boolean(preview.message);
  const preparation = preview?.progress ? t('media.playback.preparingProgress', { progress: preview.progress }) : t('media.playback.preparing');
  const message = previewErrorMessage || (processing ? preparation
    : (preview?.state === 'failed' ? preview.message : '') || (recovering ? t('media.playback.restarting') : failed ? (stalled ? t('media.playback.stalled') : (t(failure.key) || failure.message)) : offerCopy ? t('media.playback.missingPicture') : ''));
  return <>
    {video ? <video key={playerGeneration} ref={attach} {...props}/> : <audio key={playerGeneration} ref={attach} {...props}/>}
    {message && <div className="source-media-status" role="status">
      <span data-server-text={messageIsServerText || undefined}>{message}</span>
      {preview?.state === 'processing' ? <>{pollStopped && <button type="button" onClick={() => { setPollStopped(false); setPollGeneration((generation) => generation + 1); }}>{t('media.playback.checkProgress')}</button>}<button type="button" disabled={requesting} onClick={(event) => void cancel(event.currentTarget)}>{t('media.playback.cancelPreparation')}</button></>
        : <>
          {(failed || recovering) && <button type="button" onClick={(event) => void retry(event.currentTarget)}>{t(recovering ? 'media.playback.retryAgain' : 'media.playback.retry')}</button>}
          {offerCopy && <button type="button" disabled={processing} onClick={(event) => void prepare(event.currentTarget)}>{t('media.playback.prepare')}</button>}
        </>}
    </div>}
  </>;
}
