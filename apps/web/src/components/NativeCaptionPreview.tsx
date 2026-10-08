import { forwardRef, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { normalizeCaptionAppearance, planCaptionRenderStates, type CaptionAppearance, type CaptionPreviewFrame, type CaptionPreviewResult, type CaptionProject, type CaptionSegment, type VideoResolutionPreset } from '@kcs/shared';
import { captionPreviewPaintKey, captionPreviewReplayStates, captionPreviewStateIndex, containedVideoFrame } from '../caption-preview-plan';
import { captionPreviewSelection, captionPreviewTransform } from '../caption-preview-interaction';
import { planNativePreviewBatch, TEMPORAL_PREVIEW_WINDOW } from '../native-preview-scheduler';
import './native-caption-preview.css';

interface Props {
  project: CaptionProject;
  media: RefObject<HTMLMediaElement | null>;
  mediaElement: HTMLMediaElement | null;
  captions: CaptionSegment[];
  appearance: CaptionAppearance;
  interacting: boolean;
  resolution: VideoResolutionPreset;
  timeMs: number;
  reviewFocus: boolean;
  focusLabel: boolean;
  focusKey: string;
  focusIndices: number[];
  fontRevision?: number;
}

type ImageFrame = CaptionPreviewFrame & { width: number; height: number; appearance: CaptionAppearance; resolution: VideoResolutionPreset };
interface PreviewSession {
  signature: string;
  cache: Map<string, ImageFrame>;
  pending: Set<string>;
  error: string;
  retries: number;
  prefetchBlockedKey: string | null;
}

interface ActivePreviewRequest {
  signature: string;
  continuityKey: string;
  cueKey: string;
  kind: 'current' | 'prefetch';
  started: boolean;
  interactive: boolean;
  cancel(): void;
}

interface PresentedFrame {
  continuityKey: string;
  image: ImageFrame;
}

const TRANSIENT_PREVIEW_STATUS = new Set([429, 502, 503, 504]);
const MAX_BUSY_PREVIEW_RETRIES = 3;
const MAX_RECONNECT_PREVIEW_RETRIES = 6;
const MAX_CACHED_PREVIEW_FRAMES = 24;
const MAX_CACHED_PREVIEW_BYTES = 32 * 1024 * 1024;
const PREFETCH_PRESSURE_BYTES = 24 * 1024 * 1024;

/** Plan all removals before changing the cache, so an unfulfillable reservation
 * leaves existing native pixels available. Map order evicts the oldest paints.
 */
function reservePreviewCache(
  cache: Map<string, ImageFrame>, protectedKeys: ReadonlySet<string>,
  maxFrames: number, maxBytes: number,
) {
  let frames = cache.size;
  let bytes = [...cache.values()].reduce((sum, image) => sum + image.png.length, 0);
  const removals: string[] = [];
  for (const [id, image] of cache) {
    if (frames <= maxFrames && bytes <= maxBytes) break;
    if (protectedKeys.has(id)) continue;
    removals.push(id);
    frames -= 1;
    bytes -= image.png.length;
  }
  if (frames > maxFrames || bytes > maxBytes) return false;
  for (const id of removals) cache.delete(id);
  return true;
}

class CaptionPreviewResponseError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = false) {
    super(message);
    this.name = 'CaptionPreviewResponseError';
  }
}

async function readCaptionPreviewResponse(response: Response, fallbackMessage: string): Promise<CaptionPreviewResult> {
  const text = await response.text();
  let result: (CaptionPreviewResult & { error?: string }) | null = null;
  if (text.trim()) {
    try {
      result = JSON.parse(text) as CaptionPreviewResult & { error?: string };
    } catch {
      throw new CaptionPreviewResponseError(
        response.ok ? 'Caption preview returned an invalid response. Retry preview.' : `${fallbackMessage} (${response.status}).`,
        response.status,
        response.ok || TRANSIENT_PREVIEW_STATUS.has(response.status),
      );
    }
  }
  if (!response.ok) {
    const retryable = TRANSIENT_PREVIEW_STATUS.has(response.status);
    const message = typeof result?.error === 'string' && result.error.trim()
      ? result.error
      : retryable
        ? 'Caption preview service is reconnecting. Studio will retry automatically.'
        : `${fallbackMessage} (${response.status}).`;
    throw new CaptionPreviewResponseError(message, response.status, retryable);
  }
  if (!result || !Number.isFinite(result.width) || !Number.isFinite(result.height) || !Array.isArray(result.frames)) {
    throw new CaptionPreviewResponseError('Caption preview returned an incomplete response. Retry preview.', response.status, true);
  }
  return result;
}

function previewRequestError(reason: unknown, fallbackMessage: string) {
  if (reason instanceof CaptionPreviewResponseError) return reason;
  if (reason instanceof TypeError) {
    return new CaptionPreviewResponseError('Caption preview connection was interrupted. Studio will retry automatically.', 0, true);
  }
  return new CaptionPreviewResponseError(reason instanceof Error ? reason.message : fallbackMessage);
}

export interface NativeCaptionPreviewHandle {
  /** Resolve only after the bounded replay opening has decoded native pixels. */
  prepareReplay(startMs: number, endMs: number, signal: AbortSignal): Promise<boolean>;
}

export const NativeCaptionPreview = forwardRef<NativeCaptionPreviewHandle, Props>(function NativeCaptionPreview({ project, media, mediaElement, captions, appearance, interacting, resolution, timeMs, reviewFocus, focusLabel, focusKey, focusIndices, fontRevision = 0 }, ref) {
  const normalizedAppearance = useMemo(() => normalizeCaptionAppearance(appearance), [appearance]);
  const highlightWords = normalizedAppearance.highlightMode === 'word';
  const motionPreset = normalizedAppearance.motionPreset;
  const motionDurationMs = normalizedAppearance.motionDurationMs;
  const motionActive = Boolean(motionPreset && motionPreset !== 'none');
  const temporalPaint = highlightWords || motionActive;
  const states = useMemo(() => planCaptionRenderStates(captions, highlightWords, { motionPreset, motionDurationMs }), [captions, highlightWords, motionPreset, motionDurationMs]);
  // The parent's ordinary HTMLMediaElement timeupdate callback can be spaced
  // roughly a quarter-second apart. Spoken words can be much shorter. Sample
  // the actual video clock when this component renders and request a local
  // redraw only as a displayed native paint boundary is crossed. This avoids
  // re-rendering the whole editor on every decoded video frame.
  const video = mediaElement instanceof HTMLVideoElement ? mediaElement : null;
  const liveTimeMs = video && video.readyState >= HTMLMediaElement.HAVE_METADATA
    && Number.isFinite(video.currentTime) ? video.currentTime * 1000 : timeMs;
  const index = captionPreviewStateIndex(states, liveTimeMs);
  const state = states[index];
  const focusMask = useMemo(() => {
    // Review brackets identify the decision target even at the transparent start
    // of a fade. Native focus masks ignore opacity without changing caption pixels.
    if (motionActive && focusIndices.length) return focusIndices;
    const selected = new Set(focusIndices);
    return states.some((item) => {
      const active = item.key ? item.key.split(',').map(Number) : [];
      return active.some((id) => selected.has(id)) && active.some((id) => !selected.has(id));
    }) ? focusIndices : undefined;
  }, [states, focusIndices, motionActive]);
  const captionSignature = useMemo(() => JSON.stringify(captions.map(({ text, startMs, endMs, wordTiming }) => [text, startMs, endMs, wordTiming])), [captions]);
  const payload = useMemo(() => ({ resolution, appearance: normalizedAppearance }), [normalizedAppearance, resolution]);
  const contentSignature = useMemo(() => JSON.stringify([project.id, project.media.filename, captionSignature, focusMask, fontRevision]), [project.id, project.media.filename, captionSignature, focusMask, fontRevision]);
  const signature = useMemo(() => `${contentSignature}\n${JSON.stringify(payload)}`, [contentSignature, payload]);
  const session = useRef<PreviewSession | null>(null);
  const activeRequest = useRef<ActivePreviewRequest | null>(null);
  const replayPreparation = useRef<{ controller: AbortController; signature: string } | null>(null);
  const lastPresented = useRef<PresentedFrame | null>(null);
  const lastStart = useRef(0);
  const changedAt = useRef({ signature, time: performance.now() });
  if (changedAt.current.signature !== signature) changedAt.current = { signature, time: performance.now() };
  const [revision, redraw] = useReducer((value: number) => value + 1, 0);
  const [frame, setFrame] = useState<ReturnType<typeof containedVideoFrame>>(null);
  const renderKey = state?.key ? captionPreviewPaintKey(state) : '';
  const continuityKey = state?.key
    ? JSON.stringify([project.id, project.media.filename, renderKey, state.text])
    : '';

  useEffect(() => {
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let disposed = false;
    let callbackId = 0;
    let latestIndex = captionPreviewStateIndex(states, video.currentTime * 1000);
    const repaintOnTransition = (atMs: number) => {
      if (disposed || !Number.isFinite(atMs)) return;
      const nextIndex = captionPreviewStateIndex(states, atMs);
      if (nextIndex === latestIndex) return;
      latestIndex = nextIndex;
      redraw();
    };
    const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (disposed) return;
      repaintOnTransition(metadata.mediaTime * 1000);
      callbackId = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimelineEvent = () => repaintOnTransition(video.currentTime * 1000);
    video.addEventListener('seeked', onTimelineEvent);
    video.addEventListener('timeupdate', onTimelineEvent);
    video.addEventListener('loadedmetadata', onTimelineEvent);
    video.addEventListener('pause', onTimelineEvent);
    callbackId = video.requestVideoFrameCallback(onVideoFrame);
    return () => {
      disposed = true;
      video.cancelVideoFrameCallback(callbackId);
      video.removeEventListener('seeked', onTimelineEvent);
      video.removeEventListener('timeupdate', onTimelineEvent);
      video.removeEventListener('loadedmetadata', onTimelineEvent);
      video.removeEventListener('pause', onTimelineEvent);
    };
  }, [video, states]);

  useEffect(() => {
    const video = mediaElement;
    if (!(video instanceof HTMLVideoElement)) return;
    const update = () => setFrame(containedVideoFrame(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight));
    const observer = new ResizeObserver(update);
    observer.observe(video);
    video.addEventListener('loadedmetadata', update);
    update();
    return () => { observer.disconnect(); video.removeEventListener('loadedmetadata', update); };
  }, [mediaElement, project.id, project.media.filename]);

  useEffect(() => () => {
    replayPreparation.current?.controller.abort(); replayPreparation.current = null;
    activeRequest.current?.cancel(); activeRequest.current = null; session.current = null;
  }, []);
  useEffect(() => {
    if (interacting) return;
    const timer = window.setTimeout(redraw, 160);
    return () => window.clearTimeout(timer);
  }, [signature, interacting]);

  useImperativeHandle(ref, () => ({
    async prepareReplay(startMs, endMs, signal) {
      if (signal.aborted || interacting) return false;
      replayPreparation.current?.controller.abort();
      activeRequest.current?.cancel();
      activeRequest.current = null;
      if (session.current?.signature !== signature) {
        session.current = { signature, cache: new Map(), pending: new Set(), error: '', retries: 0, prefetchBlockedKey: null };
      }
      const current = session.current;
      const selected = captionPreviewReplayStates(states, startMs, endMs);
      if (!selected.length) return false;
      const controller = new AbortController();
      const preparing = { signature, controller };
      replayPreparation.current = preparing;
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
      current.error = '';
      redraw();
      try {
        const missing = selected.filter((item) => !current.cache.has(captionPreviewPaintKey(item)));
        for (let offset = 0; offset < missing.length; offset += 8) {
          if (controller.signal.aborted) return false;
          const batch = missing.slice(offset, offset + 8);
          const response = await fetch(`/api/video-export/${encodeURIComponent(project.id)}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ ...payload, ...captionPreviewSelection(captions, batch, focusMask, payload.appearance), timesMs: batch.map((item) => item.atMs) }),
          });
          const result = await readCaptionPreviewResponse(response, 'The effect preview could not be prepared. Try Replay effect again.');
          for (const target of batch) {
            const image = result.frames.find((item) => item.atMs === target.atMs);
            if (!image) throw new Error('The effect preview returned an incomplete set of frames. Try again.');
            const decoded = new Image();
            decoded.src = `data:image/png;base64,${image.png}`;
            await decoded.decode();
            if (controller.signal.aborted || session.current !== current) return false;
            const imageBytes = image.png.length;
            if (imageBytes > 32 * 1024 * 1024) throw new Error('The effect preview exceeds its local image limit. Choose a smaller preview resolution.');
            let bytes = [...current.cache.values()].reduce((sum, item) => sum + item.png.length, 0);
            const targetKey = captionPreviewPaintKey(target);
            for (const [key, cached] of current.cache) {
              if (current.cache.size < 24 && bytes + imageBytes <= 32 * 1024 * 1024) break;
              bytes -= cached.png.length;
              current.cache.delete(key);
            }
            current.cache.set(targetKey, { ...image, width: result.width, height: result.height, appearance: payload.appearance, resolution });
          }
          redraw();
        }
        if (controller.signal.aborted || session.current !== current) return false;
        if (!selected.every((item) => current.cache.has(captionPreviewPaintKey(item)))) {
          throw new Error('This effect preview is too large to prepare at once. Choose a smaller preview resolution.');
        }
        current.retries = 0;
        return true;
      } catch (reason) {
        if (controller.signal.aborted && !timedOut) return false;
        const normalized = previewRequestError(reason, 'The effect preview could not be prepared.');
        const error = new Error(timedOut
          ? 'Preparing the effect preview took too long. Try Replay effect again.'
          : normalized.retryable
            ? 'Preparing the effect preview was interrupted. Try Replay effect again.'
            : normalized.message);
        if (session.current === current) current.error = error.message;
        throw error;
      } finally {
        window.clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        if (replayPreparation.current === preparing) replayPreparation.current = null;
        redraw();
      }
    },
  }), [signature, states, captions, payload, focusMask, project.id, resolution, interacting]);

  useEffect(() => {
    const preparing = replayPreparation.current;
    if (preparing) {
      if (preparing.signature === signature && !interacting) return;
      preparing.controller.abort();
      replayPreparation.current = null;
    }
    if (session.current?.signature !== signature) {
      session.current = { signature, cache: new Map(), pending: new Set(), error: '', retries: 0, prefetchBlockedKey: null };
    }
    const current = session.current;
    const currentState = states[index];
    const key = currentState?.key ? captionPreviewPaintKey(currentState) : '';
    // Gaps still prefetch the next caption, but never show a stale caption in that gap.
    const start = Math.max(0, index);
    const active = activeRequest.current;
    if (active) {
      const pendingCurrent = Boolean(key && active.signature === signature && current.pending.has(key));
      // A one-paint prefetch already renders the newly current word by itself.
      // A multi-paint batch must yield: its HTTP response cannot deliver that
      // word until the server finishes rendering every later sample as well.
      if (pendingCurrent && (active.kind === 'current' || current.pending.size === 1)) return;
      const sameCaption = Boolean(continuityKey && active.continuityKey === continuityKey);
      const sameCueRender = Boolean(currentState?.key && active.cueKey === currentState.key
        && active.signature === signature && active.kind === 'current' && active.started);
      const appearanceChanged = active.signature !== signature;
      // Native caption paints can be shorter than a single FFmpeg request. Let
      // one already-started current render finish within the same cue, avoiding
      // perpetual abort/restart starvation at every rapid word transition. A
      // stale result remains cached only under its original exact paint key.
      if (sameCueRender && !interacting) return;
      if (pendingCurrent && active.kind === 'prefetch'
        || !sameCaption || (appearanceChanged && (!active.started || active.kind === 'prefetch'))
        || (interacting && active.kind === 'prefetch') || (!interacting && active.interactive && !active.started)) {
        active.cancel();
        if (activeRequest.current === active) activeRequest.current = null;
      } else {
        // Keep one native current-frame render alive while the slider continues to
        // move. The newest signature is rendered as soon as it finishes, avoiding
        // cancel/restart starvation during continuous appearance input.
        return;
      }
    }
    if (index < 0 && liveTimeMs >= (states.at(-1)?.endMs ?? 0)) return;
    if (current.error) return;
    const batch = planNativePreviewBatch(states, start, new Set(current.cache.keys()), temporalPaint);
    const missingCurrent = batch?.kind === 'current';
    if (!missingCurrent && (interacting || performance.now() - changedAt.current.time < 150)) return;
    if (!batch) return;
    // While playing, only warm the very next paint. A request for four frames
    // made during a pause can be preempted on seek; single-frame prefetches are
    // already current-priority when playback catches up to them.
    const missing = batch.kind === 'prefetch' && temporalPaint && media.current?.paused === false
      ? batch.states.slice(0, 1) : batch.states;
    const kind: ActivePreviewRequest['kind'] = batch.kind;
    if (kind === 'prefetch' && temporalPaint && current.prefetchBlockedKey === key) return;
    const pinned = new Set<string>(key ? [key] : []);
    if (kind === 'prefetch' && temporalPaint) {
      for (const item of states.slice(start, start + TEMPORAL_PREVIEW_WINDOW)) {
        if (item.key) pinned.add(captionPreviewPaintKey(item));
      }
      // Preserve the image currently in use even if it was rendered earlier in
      // this session. Cache eviction must not blank or relabel the visible paint.
      for (const [id, image] of current.cache) {
        if (image === lastPresented.current?.image) pinned.add(id);
      }
      const bytes = [...current.cache.values()].reduce((sum, image) => sum + image.png.length, 0);
      const estimatedIncomingBytes = Math.max(1024 * 1024,
        Math.ceil(bytes / Math.max(1, current.cache.size)) * missing.length);
      const maxBytesBefore = Math.min(PREFETCH_PRESSURE_BYTES - 1,
        MAX_CACHED_PREVIEW_BYTES - estimatedIncomingBytes);
      if (maxBytesBefore < 0 || !reservePreviewCache(current.cache, pinned,
        MAX_CACHED_PREVIEW_FRAMES - missing.length, maxBytesBefore)) return;
    }
    const controller = new AbortController();
    const pendingKeys = new Set(missing.map(captionPreviewPaintKey));
    current.pending = pendingKeys;
    const clearOwnedPending = () => {
      // An aborted fetch can settle after its replacement has installed a new
      // batch. Only the request that owns that set may clear it.
      if (current.pending === pendingKeys) pendingKeys.clear();
    };
    const retained = lastPresented.current?.continuityKey === continuityKey;
    const delay = current.retries
      ? Math.min(1000, current.retries * 250)
      : interacting
        ? Math.max(0, 40 - (performance.now() - lastStart.current))
        : kind === 'current' && retained
        ? 0
        : media.current?.paused === false
          ? 0
          : 120;
    const timer = window.setTimeout(() => {
      request.started = true;
      lastStart.current = performance.now();
      void (async () => {
        try {
          const response = await fetch(`/api/video-export/${encodeURIComponent(project.id)}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ ...payload, ...captionPreviewSelection(captions, missing, focusMask, payload.appearance), timesMs: missing.map((item) => item.atMs) }),
          });
          const result = await readCaptionPreviewResponse(response, 'Caption preview could not render.');
          if (controller.signal.aborted) return;
          // Decode and validate the entire batch before publishing any new cache
          // entries. A failed later PNG must not leave an oversized partial batch.
          const staged = new Map(current.cache);
          let presented: ImageFrame | undefined;
          const received = new Set<string>();
          for (const image of result.frames) {
            const target = missing.find((item) => item.atMs === image.atMs);
            if (!target) continue;
            if (image.png.length > MAX_CACHED_PREVIEW_BYTES) {
              throw new Error('This caption preview exceeds its local image limit. Choose a smaller preview resolution.');
            }
            // Decode before replacing the visible image; swapping an undecoded PNG
            // can otherwise introduce a blank paint between native frames.
            const decoded = new Image();
            decoded.src = `data:image/png;base64,${image.png}`;
            await decoded.decode();
            if (controller.signal.aborted) return;
            const rendered = { ...image, width: result.width, height: result.height, appearance: payload.appearance, resolution };
            const targetKey = captionPreviewPaintKey(target);
            staged.set(targetKey, rendered);
            received.add(targetKey);
            if (targetKey === key && continuityKey) presented = rendered;
          }
          if (received.size !== missing.length) throw new Error('Caption preview returned an incomplete set of frames. Retry preview.');
          // Only compressed caption images are retained, only for this project/look. They never
          // enter localStorage, exported project data, analytics, or the contribution queue.
          if (!reservePreviewCache(staged, pinned, MAX_CACHED_PREVIEW_FRAMES, MAX_CACHED_PREVIEW_BYTES)) {
            if (kind === 'prefetch' && temporalPaint) {
              // The near-playhead cache itself exceeds a safe prefetch budget.
              // Retry after the playhead advances; never fetch the same oversized
              // batch repeatedly while paused at one word.
              current.prefetchBlockedKey = key;
              return;
            }
            throw new Error('This caption preview exceeds its local image limit. Choose a smaller preview resolution.');
          }
          if (controller.signal.aborted) return;
          current.cache = staged;
          if (presented) lastPresented.current = { continuityKey, image: presented };
          current.prefetchBlockedKey = null;
          current.retries = 0;
        } catch (reason) {
          if (!controller.signal.aborted && session.current === current) {
            const error = previewRequestError(reason, 'Caption preview is unavailable.');
            const retryLimit = error.status === 429 ? MAX_BUSY_PREVIEW_RETRIES : MAX_RECONNECT_PREVIEW_RETRIES;
            if (error.retryable && current.retries < retryLimit) {
              current.retries += 1;
              return;
            }
            current.error = error.message;
          }
        } finally {
          if (activeRequest.current === request) activeRequest.current = null;
          clearOwnedPending();
          if (!controller.signal.aborted) redraw();
        }
      })();
    }, delay);
    const request: ActivePreviewRequest = {
      signature,
      continuityKey,
      cueKey: currentState?.key || '',
      kind,
      started: false,
      interactive: interacting,
      cancel: () => { window.clearTimeout(timer); controller.abort(); clearOwnedPending(); },
    };
    activeRequest.current = request;
    // An index change does not cancel a useful current-frame render; word captions can be
    // shorter than one render request. A different caption/project or obsolete lookahead does.
  }, [signature, index, revision, continuityKey, interacting, temporalPaint]);

  const current = session.current?.signature === signature ? session.current : null;
  const exactImage = renderKey ? current?.cache.get(renderKey) : undefined;
  useEffect(() => {
    if (exactImage && continuityKey) lastPresented.current = { continuityKey, image: exactImage };
  }, [exactImage, continuityKey]);
  const retainedImage = continuityKey && lastPresented.current?.continuityKey === continuityKey && lastPresented.current.image.resolution === resolution ? lastPresented.current.image : undefined;
  const image = exactImage || retainedImage;
  const error = current?.error;
  const transform = !exactImage && image && frame ? captionPreviewTransform(image.appearance, payload.appearance, image.width, image.height, image.bounds, frame.width, frame.height) : undefined;
  const box = focusMask ? image?.focusBounds : image?.bounds;
  const retry = () => { if (current) { current.error = ''; current.retries = 0; redraw(); } };

  return <>
    {frame && image && <div className="native-caption-surface" data-preview-mode={exactImage ? 'exact' : transform ? 'interpolated' : 'pending'} data-paint-key={renderKey} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
      <div className="native-caption-canvas" style={{ transform, transformOrigin: '0 0' }}>
      <img className="native-caption-image" src={`data:image/png;base64,${image.png}`} alt={state?.text || ''} draggable={false}/>
      {reviewFocus && box && <div key={focusKey} className="native-caption-focus" style={{ left: `${box.x / image.width * 100}%`, top: `${box.y / image.height * 100}%`, width: `${box.width / image.width * 100}%`, height: `${box.height / image.height * 100}%` }} aria-hidden="true">
        <div className="review-focus-frame">
          {focusLabel && <span className="review-focus-label">Reviewing</span>}
          <i className="review-focus-corner review-focus-tl"/><i className="review-focus-corner review-focus-tr"/><i className="review-focus-corner review-focus-bl"/><i className="review-focus-corner review-focus-br"/>
        </div>
      </div>}
      </div>
    </div>}
    {image && !exactImage && !error && <div className="native-preview-refining">{transform ? 'Interactive preview · refining layout…' : 'Updating caption appearance…'}</div>}
    {state?.key && (!image || error) && <div className={`native-preview-status ${error ? 'error' : ''}`} role="status">
      <span>{error || 'Preparing caption preview…'}</span>{error && <button onClick={retry}>Retry preview</button>}
    </div>}
  </>;
});
