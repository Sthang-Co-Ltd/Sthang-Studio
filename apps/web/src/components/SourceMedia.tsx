import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type RefObject } from 'react';
import { needsCompatiblePlayback, requestMediaPreview, type MediaPreviewStatus } from '../media-preview-client';
import './source-media.css';

interface Props {
  src: string;
  projectId: string;
  source: string;
  video: boolean;
  media: RefObject<HTMLMediaElement | null>;
  onLoadedMetadata: (element: HTMLMediaElement) => void;
  onTimeUpdate: (element: HTMLMediaElement) => void;
  onRetry: () => void;
}

/** Mount with a project/media key. Recovery never changes the source project. */
export function SourceMedia({ src, projectId, source, video, media, onLoadedMetadata, onTimeUpdate, onRetry }: Props) {
  const [playbackSrc, setPlaybackSrc] = useState(src);
  const [failed, setFailed] = useState(false);
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
  const attach = useCallback((element: HTMLMediaElement | null) => { media.current = element; }, [media]);
  const preservePosition = () => {
    const element = media.current;
    restoreTime.current = element && !element.error && Number.isFinite(element.currentTime) ? element.currentTime : lastPosition.current;
    element?.pause();
    onRetry();
  };
  const accept = (value: MediaPreviewStatus) => {
    setPreviewError('');
    setPreview(value);
    if (value.state === 'ready' && value.url) {
      preservePosition();
      setPlaybackSrc(value.url);
      setRecovering(true);
      setFailed(false);
      // Eviction/rebuild can publish at the same URL: force the browser to reopen it.
      if (value.url === playbackSrc) media.current?.load();
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
    setRecovering(true); setFailed(false);
    media.current.load();
  };
  const props = {
    src: playbackSrc, controls: true,
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current !== null) {
        const target = restoreTime.current;
        restoreTime.current = null;
        element.currentTime = Number.isFinite(element.duration) ? Math.min(target, Math.max(0, element.duration - 0.05)) : target;
      }
      setRecovering(false); setFailed(false);
      onLoadedMetadata(element);
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current === null && !element.error && Number.isFinite(element.currentTime)) lastPosition.current = element.currentTime;
      onTimeUpdate(element);
    },
    onError: () => {
      setFailed(true); setRecovering(false);
      if (video && !attempted.current && playbackSrc === src) void prepare();
    },
  };
  const processing = requesting || preview?.state === 'processing';
  const offerCopy = video && (failed || playbackSrc === src && (failed || ['hevc', 'h265'].includes(preview?.videoCodec || '') || preview?.state === 'failed' || preview?.state === 'cancelled'));
  const message = previewError || (processing ? `Preparing browser playback${preview?.progress ? ` · ${preview.progress}%` : '…'}`
    : (preview?.state === 'failed' ? preview.message : '') || (recovering ? 'Reloading playback…' : failed ? 'Playback could not continue. Your source file and captions are unchanged.' : offerCopy ? 'Picture missing? Prepare a local playback copy. Your original stays unchanged.' : ''));
  return <>
    {video ? <video ref={attach} {...props}/> : <audio ref={attach} {...props}/>}
    {message && <div className="source-media-status" role="status">
      <span>{message}</span>
      {preview?.state === 'processing' ? <button type="button" disabled={requesting} onClick={() => void cancel()}>Cancel preparation</button>
        : offerCopy ? <button type="button" disabled={processing} onClick={() => void prepare()}>Prepare playback</button>
        : (failed || recovering) && <button type="button" onClick={retry}>{recovering ? 'Retry again' : 'Retry playback'}</button>}
    </div>}
  </>;
}
