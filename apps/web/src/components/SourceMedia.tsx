import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type RefObject } from 'react';
import { needsCompatiblePlayback, requestMediaPreview, type MediaPreviewStatus } from '../media-preview-client';
import { playbackFailureMessage, recoveryPosition, restoredPosition, type PlaybackSettings } from '../media-playback-recovery';
import './source-media.css';

interface Props {
  src: string;
  projectId: string;
  source: string;
  video: boolean;
  playbackRate: number;
  media: RefObject<HTMLMediaElement | null>;
  onElementChange: (element: HTMLMediaElement | null) => void;
  onLoadedMetadata: (element: HTMLMediaElement) => void;
  onTimeUpdate: (element: HTMLMediaElement) => void;
  onRetry: () => void;
}

/** Mount with a project/media key. Recovery never changes the source project. */
export function SourceMedia({ src, projectId, source, video, playbackRate, media, onElementChange, onLoadedMetadata, onTimeUpdate, onRetry }: Props) {
  const [playbackSrc, setPlaybackSrc] = useState(src);
  const [failed, setFailed] = useState(false);
  const [failureCode, setFailureCode] = useState<number>();
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [preview, setPreview] = useState<MediaPreviewStatus | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const restoreTime = useRef<number | null>(null);
  const lastPosition = useRef(0);
  const alive = useRef(true);
  const sequence = useRef(0);
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const playbackSettings = useRef<PlaybackSettings | null>(null);
  // Set before any metadata/status reply; later speed controls write to the
  // current element directly and must not change this stable ref callback.
  const initialPlaybackRate = useRef(playbackRate);
  const attach = useCallback((element: HTMLMediaElement | null) => {
    media.current = element;
    if (element) {
      const settings = playbackSettings.current;
      const rate = settings?.playbackRate ?? initialPlaybackRate.current;
      Object.assign(element, { defaultPlaybackRate: rate, playbackRate: rate, ...settings });
    }
    onElementChange(element);
  }, [media, onElementChange]);
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
    media.current = null;
    previous?.pause();
    previous?.removeAttribute('src');
    previous?.load();
    setPlayerGeneration((generation) => generation + 1);
  };
  const accept = (value: MediaPreviewStatus) => {
    setPreviewError('');
    setPreview(value);
    if (value.state === 'ready' && value.url) {
      preservePosition();
      setPlaybackSrc(value.url);
      setRecovering(true);
      setFailed(false);
      // Every accepted copy gets a fresh decoder, even when its URL is unchanged.
      replacePlayer();
    }
  };
  const prepare = async () => {
    if (inFlight.current || preview?.state === 'processing' || (playbackSrc !== src && !failed)) return;
    attempted.current = true;
    inFlight.current = true;
    const request = ++sequence.current;
    setRequesting(true); setPreviewError('');
    // Keep tracking manual seeks during preparation; only arm restoration when
    // a new source is actually loaded. Cancelling leaves the original playable.
    media.current?.pause();
    onRetry();
    try {
      const value = await requestMediaPreview(projectId, source, 'POST', undefined, playbackSrc !== src);
      if (alive.current && sequence.current === request) accept(value);
    } catch (error) {
      if (alive.current && sequence.current === request) setPreviewError(error instanceof Error ? error.message : 'Playback preparation failed.');
    } finally {
      inFlight.current = false;
      if (alive.current && sequence.current === request) setRequesting(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const request = sequence.current;
    if (video) void requestMediaPreview(projectId, source, 'GET', controller.signal).then((value) => {
      if (!alive.current || sequence.current !== request) return;
      accept(value);
      if (value.state === 'original' && media.current && needsCompatiblePlayback(value.videoCodec, (type) => media.current!.canPlayType(type))) void prepare();
    }).catch(() => { /* Original playback stays available; decoder errors expose recovery. */ });
    return () => { alive.current = false; controller.abort(); };
    // The parent keys this component by project and immutable media filename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, source, video]);
  useEffect(() => {
    if (preview?.state !== 'processing') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const request = sequence.current;
    const poll = async () => {
      try {
        const value = await requestMediaPreview(projectId, source, 'GET', controller.signal);
        if (controller.signal.aborted || !alive.current || sequence.current !== request) return;
        accept(value);
        if (value.state === 'processing') timer = setTimeout(poll, 750);
      } catch {
        if (!controller.signal.aborted && alive.current && sequence.current === request) {
          setPreviewError('Playback progress is unavailable. Retry or cancel preparation.');
          timer = setTimeout(poll, 1500);
        }
      }
    };
    timer = setTimeout(poll, 250);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.state, projectId, source, pollGeneration]);
  const cancel = async () => {
    const request = ++sequence.current;
    setPollGeneration((generation) => generation + 1);
    setRequesting(true);
    try {
      const value = await requestMediaPreview(projectId, source, 'DELETE');
      if (alive.current && sequence.current === request) { accept(value); setPreviewError(''); }
    } catch {
      if (alive.current && sequence.current === request) setPreviewError('Could not cancel preparation. Try again.');
    } finally { if (alive.current && sequence.current === request) setRequesting(false); }
  };
  const retry = () => {
    if (!media.current) return;
    preservePosition();
    setPreviewError('');
    setPreview((value) => value && value.state !== 'ready' ? { ...value, state: 'original', message: undefined } : value);
    setRecovering(true); setFailed(false);
    replacePlayer();
  };
  const props = {
    src: playbackSrc, controls: true,
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current !== null) {
        const target = restoreTime.current;
        restoreTime.current = null;
        element.currentTime = restoredPosition(target, element.duration);
      }
      setRecovering(false); setFailed(false);
      // Settings are restored on attachment only. Later user changes during
      // loading must win over the recovery snapshot.
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
      setFailed(true); setRecovering(false);
      event.currentTarget.pause();
      onRetry();
      // Network/abort failures keep ordinary reload recovery. Only an actual
      // decoder/unsupported-source failure automatically requests transcoding.
      const code = event.currentTarget.error?.code;
      setFailureCode(code);
      if (video && !attempted.current && playbackSrc === src && (code === 3 || code === 4)) void prepare();
    },
  };
  const processing = requesting || preview?.state === 'processing';
  const offerCopy = video && (failed || playbackSrc === src && (failed || ['hevc', 'h265'].includes(preview?.videoCodec || '') || preview?.state === 'failed' || preview?.state === 'cancelled'));
  const message = previewError || (processing ? `Preparing browser playback${preview?.progress ? ` · ${preview.progress}%` : '…'}`
    : (preview?.state === 'failed' ? preview.message : '') || (recovering ? 'Restarting playback…' : failed ? playbackFailureMessage(failureCode) : offerCopy ? 'Picture missing? Prepare a local playback copy. Your original stays unchanged.' : ''));
  return <>
    {video ? <video key={playerGeneration} ref={attach} {...props}/> : <audio key={playerGeneration} ref={attach} {...props}/>}
    {message && <div className="source-media-status" role="status">
      <span>{message}</span>
      {preview?.state === 'processing' ? <button type="button" disabled={requesting} onClick={() => void cancel()}>Cancel preparation</button>
        : <>
          {(failed || recovering) && <button type="button" onClick={retry}>{recovering ? 'Retry again' : 'Retry playback'}</button>}
          {offerCopy && <button type="button" disabled={processing} onClick={() => void prepare()}>Prepare playback</button>}
        </>}
    </div>}
  </>;
}
