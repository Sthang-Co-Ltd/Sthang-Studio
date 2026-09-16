import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { normalizeCaptionAppearance, planCaptionRenderStates, type CaptionAppearance, type CaptionPreviewFrame, type CaptionPreviewResult, type CaptionProject, type CaptionSegment, type VideoResolutionPreset } from '@kcs/shared';
import { captionPreviewLookahead, captionPreviewStateIndex, containedVideoFrame } from '../caption-preview-plan';
import './native-caption-preview.css';

interface Props {
  project: CaptionProject;
  media: RefObject<HTMLMediaElement | null>;
  captions: CaptionSegment[];
  appearance: CaptionAppearance;
  resolution: VideoResolutionPreset;
  timeMs: number;
  reviewFocus: boolean;
  focusLabel: boolean;
  focusKey: string;
  focusIndices: number[];
}

type ImageFrame = CaptionPreviewFrame & { width: number; height: number };
interface PreviewSession {
  signature: string;
  cache: Map<string, ImageFrame>;
  pending: Set<string>;
  error: string;
  retries: number;
}

interface ActivePreviewRequest {
  signature: string;
  continuityKey: string;
  kind: 'current' | 'prefetch';
  cancel(): void;
}

interface PresentedFrame {
  continuityKey: string;
  image: ImageFrame;
}

export function NativeCaptionPreview({ project, media, captions, appearance, resolution, timeMs, reviewFocus, focusLabel, focusKey, focusIndices }: Props) {
  const states = useMemo(() => planCaptionRenderStates(captions), [captions]);
  const index = captionPreviewStateIndex(states, timeMs);
  const state = states[index];
  const focusMask = useMemo(() => {
    const selected = new Set(focusIndices);
    return states.some((item) => {
      const active = item.key ? item.key.split(',').map(Number) : [];
      return active.some((id) => selected.has(id)) && active.some((id) => !selected.has(id));
    }) ? focusIndices : undefined;
  }, [states, focusIndices]);
  const payload = useMemo(() => ({
    resolution, focusIndices: focusMask, appearance: normalizeCaptionAppearance(appearance),
    captions: captions.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
  }), [captions, appearance, resolution, focusMask]);
  const signature = useMemo(() => JSON.stringify([project.id, project.media.filename, payload]), [project.id, project.media.filename, payload]);
  const session = useRef<PreviewSession | null>(null);
  const activeRequest = useRef<ActivePreviewRequest | null>(null);
  const lastPresented = useRef<PresentedFrame | null>(null);
  const [revision, redraw] = useReducer((value: number) => value + 1, 0);
  const [frame, setFrame] = useState<ReturnType<typeof containedVideoFrame>>(null);
  const continuityKey = state?.key
    ? JSON.stringify([project.id, project.media.filename, state.key, state.atMs, state.endMs, state.text])
    : '';

  useEffect(() => {
    const video = media.current;
    if (!(video instanceof HTMLVideoElement)) return;
    const update = () => setFrame(containedVideoFrame(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight));
    const observer = new ResizeObserver(update);
    observer.observe(video);
    video.addEventListener('loadedmetadata', update);
    update();
    return () => { observer.disconnect(); video.removeEventListener('loadedmetadata', update); };
  }, [media, project.id, project.media.filename]);

  useEffect(() => () => { activeRequest.current?.cancel(); activeRequest.current = null; session.current = null; }, []);

  useEffect(() => {
    if (session.current?.signature !== signature) {
      session.current = { signature, cache: new Map(), pending: new Set(), error: '', retries: 0 };
    }
    const current = session.current;
    const key = states[index]?.key;
    // Gaps still prefetch the next caption, but never show a stale caption in that gap.
    const start = Math.max(0, index);
    if (index < 0 && timeMs >= (states.at(-1)?.endMs ?? 0)) return;
    const active = activeRequest.current;
    if (active) {
      const sameCaption = Boolean(continuityKey && active.continuityKey === continuityKey);
      const appearanceChanged = active.signature !== signature;
      if (!sameCaption || (appearanceChanged && active.kind === 'prefetch')) {
        active.cancel();
        if (activeRequest.current === active) activeRequest.current = null;
      } else {
        // Keep one native current-frame render alive while the slider continues to
        // move. The newest signature is rendered as soon as it finishes, avoiding
        // cancel/restart starvation during continuous appearance input.
        return;
      }
    }
    if (current.error) return;
    const wanted = captionPreviewLookahead(states, start);
    const missingCurrent = key && !current.cache.has(key) && state ? [state] : [];
    const missing = missingCurrent.length ? missingCurrent : wanted.filter((item) => !current.cache.has(item.key));
    if (!missing.length || (key && current.cache.has(key) && missing.length < 4)) return;
    const kind: ActivePreviewRequest['kind'] = missingCurrent.length ? 'current' : 'prefetch';
    const controller = new AbortController();
    current.pending = new Set(missing.map((item) => item.key));
    const retained = lastPresented.current?.continuityKey === continuityKey;
    const delay = current.retries
      ? Math.min(1000, current.retries * 250)
      : kind === 'current' && retained
        ? 0
        : media.current?.paused === false
          ? 0
          : 120;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/video-export/${encodeURIComponent(project.id)}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ ...payload, timesMs: missing.map((item) => item.atMs) }),
          });
          const result = await response.json() as CaptionPreviewResult & { error?: string };
          if (!response.ok) {
            if (response.status === 429 && current.retries < 3) { current.retries += 1; return; }
            throw new Error(result.error || 'Caption preview could not render.');
          }
          if (controller.signal.aborted) return;
          for (const image of result.frames) {
            const target = missing.find((item) => item.atMs === image.atMs);
            if (!target) continue;
            const rendered = { ...image, width: result.width, height: result.height };
            current.cache.set(target.key, rendered);
            if (target.key === key && continuityKey) lastPresented.current = { continuityKey, image: rendered };
          }
          // Only compressed caption images are retained, only for this project/look. They never
          // enter localStorage, exported project data, analytics, or the contribution queue.
          let bytes = [...current.cache.values()].reduce((sum, item) => sum + item.png.length, 0);
          for (const [id, image] of current.cache) {
            if (current.cache.size <= 24 && bytes <= 32 * 1024 * 1024) break;
            if (id === key) continue;
            bytes -= image.png.length;
            current.cache.delete(id);
          }
          current.retries = 0;
        } catch (error) {
          if (!controller.signal.aborted && session.current === current) current.error = error instanceof Error ? error.message : 'Caption preview is unavailable.';
        } finally {
          if (activeRequest.current === request) activeRequest.current = null;
          current.pending.clear();
          if (!controller.signal.aborted) redraw();
        }
      })();
    }, delay);
    const request: ActivePreviewRequest = {
      signature,
      continuityKey,
      kind,
      cancel: () => { window.clearTimeout(timer); controller.abort(); current.pending.clear(); },
    };
    activeRequest.current = request;
    // An index change does not cancel a useful current-frame render; word captions can be
    // shorter than one render request. A different caption/project or obsolete lookahead does.
  }, [signature, index, revision, continuityKey]);

  const current = session.current?.signature === signature ? session.current : null;
  const exactImage = state?.key ? current?.cache.get(state.key) : undefined;
  const retainedImage = continuityKey && lastPresented.current?.continuityKey === continuityKey ? lastPresented.current.image : undefined;
  const image = exactImage || retainedImage;
  const error = current?.error;
  const box = focusMask ? image?.focusBounds : image?.bounds;
  const retry = () => { if (current) { current.error = ''; current.retries = 0; redraw(); } };

  return <>
    {frame && image && <div className="native-caption-surface" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
      <img className="native-caption-image" src={`data:image/png;base64,${image.png}`} alt={state?.text || ''} draggable={false}/>
      {reviewFocus && box && <div key={focusKey} className="native-caption-focus" style={{ left: `${box.x / image.width * 100}%`, top: `${box.y / image.height * 100}%`, width: `${box.width / image.width * 100}%`, height: `${box.height / image.height * 100}%` }} aria-hidden="true">
        <div className="review-focus-frame">
          {focusLabel && <span className="review-focus-label">Reviewing</span>}
          <i className="review-focus-corner review-focus-tl"/><i className="review-focus-corner review-focus-tr"/><i className="review-focus-corner review-focus-bl"/><i className="review-focus-corner review-focus-br"/>
        </div>
      </div>}
    </div>}
    {state?.key && (!image || error) && <div className={`native-preview-status ${error ? 'error' : ''}`} role="status">
      <span>{error || 'Preparing caption preview…'}</span>{error && <button onClick={retry}>Retry preview</button>}
    </div>}
  </>;
}
