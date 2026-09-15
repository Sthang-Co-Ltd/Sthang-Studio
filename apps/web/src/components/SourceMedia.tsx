import { useCallback, useRef, useState, type SyntheticEvent, type RefObject } from 'react';
import './source-media.css';

interface Props {
  src: string;
  video: boolean;
  media: RefObject<HTMLMediaElement | null>;
  onLoadedMetadata: (element: HTMLMediaElement) => void;
  onTimeUpdate: (element: HTMLMediaElement) => void;
  onRetry: () => void;
}

/** Mount with a project/media key. Reloads are explicit, never timer-driven. */
export function SourceMedia({ src, video, media, onLoadedMetadata, onTimeUpdate, onRetry }: Props) {
  const [failed, setFailed] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const restoreTime = useRef<number | null>(null);
  const lastPosition = useRef(0);
  const attach = useCallback((element: HTMLMediaElement | null) => { media.current = element; }, [media]);
  const retry = () => {
    const element = media.current;
    if (!element) return;
    onRetry();
    // Some decoders reset currentTime before raising error. Keep the last good time.
    restoreTime.current = lastPosition.current;
    element.pause();
    setRecovering(true);
    setFailed(false);
    element.load();
  };
  const props = {
    src, controls: true,
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current !== null) {
        const target = restoreTime.current;
        restoreTime.current = null;
        // A retry stays paused; no automatic replay or project change.
        element.currentTime = Number.isFinite(element.duration)
          ? Math.min(target, Math.max(0, element.duration - 0.05)) : target;
      }
      setRecovering(false);
      setFailed(false);
      onLoadedMetadata(element);
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (media.current !== element) return;
      if (restoreTime.current === null && !element.error && Number.isFinite(element.currentTime)) lastPosition.current = element.currentTime;
      onTimeUpdate(element);
    },
    onError: () => { setFailed(true); setRecovering(false); },
  };
  return <>
    {video ? <video ref={attach} {...props}/> : <audio ref={attach} {...props}/>}
    {(failed || recovering) && <div className="source-media-status" role="status">
      <span>{recovering ? 'Reloading playback…' : 'Playback could not continue. Your source file and captions are unchanged.'}</span>
      <button type="button" onClick={retry}>{recovering ? 'Retry again' : 'Retry playback'}</button>
    </div>}
  </>;
}
