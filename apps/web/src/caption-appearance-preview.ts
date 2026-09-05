import { DEFAULT_CAPTION_APPEARANCE, type CaptionAppearance } from '@kcs/shared';

const PREVIEW_VARIABLES = [
  '--caption-live-bottom', '--caption-live-side', '--caption-live-justify', '--caption-live-align', '--caption-live-font',
  '--caption-live-size', '--caption-live-weight', '--caption-live-color', '--caption-live-stroke', '--caption-live-stroke-color',
  '--caption-live-shadow', '--caption-live-background', '--caption-live-padding',
] as const;

// Keep these values in sync with the ASS render-only wrapping contract in
// apps/server/src/services/video-export.ts. The preview deliberately follows the
// renderer's line planner instead of letting browser and libass wrap independently.
const CAPTION_WRAP_ADVANCE = 0.72;
const CAPTION_WRAP_FLOOR = 0.62;

let currentAppearance: CaptionAppearance | null = null;
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let observedVideo: HTMLVideoElement | null = null;
let observedStage: HTMLElement | null = null;
let syncFrame = 0;

export function resolveCaptionAppearance(value?: Partial<CaptionAppearance>): CaptionAppearance {
  return { ...DEFAULT_CAPTION_APPEARANCE, ...value };
}

function rgba(hex: string, opacity: number) {
  const raw = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '000000';
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function wrapCaptionText(text: string, maxGraphemesPerLine: number) {
  const lines = String(text || '').split(/\r?\n/);
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('km', { granularity: 'grapheme' }) : null;
  const output: string[] = [];
  for (const line of lines) {
    const graphemes = segmenter ? Array.from(segmenter.segment(line), (item) => item.segment) : Array.from(line);
    if (graphemes.length <= maxGraphemesPerLine) {
      output.push(line);
      continue;
    }
    let cursor = 0;
    while (cursor < graphemes.length) {
      const hardEnd = Math.min(graphemes.length, cursor + maxGraphemesPerLine);
      let end = hardEnd;
      if (hardEnd < graphemes.length) {
        const floor = cursor + Math.max(1, Math.floor(maxGraphemesPerLine * CAPTION_WRAP_FLOOR));
        for (let index = hardEnd - 1; index >= floor; index -= 1) {
          if (/\s|[។៕៖!?.,:;]/u.test(graphemes[index] || '')) {
            end = index + 1;
            break;
          }
        }
      }
      output.push(graphemes.slice(cursor, end).join('').trim());
      cursor = end;
      while (cursor < graphemes.length && /\s/u.test(graphemes[cursor] || '')) cursor += 1;
    }
  }
  return output.filter(Boolean).join('\n');
}

export function planCaptionPreviewText(text: string, appearance: CaptionAppearance, frameWidth: number, frameHeight: number) {
  const safeHeight = Math.max(1, frameHeight);
  const scale = safeHeight / 1080;
  const fontSize = Math.max(1, appearance.fontSize1080 * scale);
  const usableWidth = Math.max(1, frameWidth * appearance.maxWidthPct / 100);
  const maxGraphemesPerLine = Math.max(6, Math.floor(usableWidth / Math.max(1, fontSize * CAPTION_WRAP_ADVANCE)));
  return wrapCaptionText(text, maxGraphemesPerLine);
}

function renderedVideoFrame(video: HTMLVideoElement) {
  const width = Math.max(1, video.clientWidth);
  const height = Math.max(1, video.clientHeight);
  const intrinsicWidth = Math.max(1, video.videoWidth || width);
  const intrinsicHeight = Math.max(1, video.videoHeight || height);
  const scale = Math.min(width / intrinsicWidth, height / intrinsicHeight);
  const frameWidth = intrinsicWidth * scale;
  const frameHeight = intrinsicHeight * scale;
  return {
    frameWidth,
    frameHeight,
    sideInset: Math.max(0, (width - frameWidth) / 2),
    bottomInset: Math.max(0, (height - frameHeight) / 2),
  };
}

function formatPreviewCaption(appearance: CaptionAppearance, frameWidth: number, frameHeight: number) {
  const caption = document.querySelector<HTMLElement>('.caption-preview-shell .caption-preview');
  if (!caption) return;
  const current = caption.textContent || '';
  const priorRendered = caption.dataset.sthangRenderText || '';
  const source = current === priorRendered
    ? caption.dataset.sthangSourceText || current
    : current;
  const planned = planCaptionPreviewText(source, appearance, frameWidth, frameHeight);
  caption.dataset.sthangSourceText = source;
  caption.dataset.sthangRenderText = planned;
  if (current !== planned) caption.textContent = planned;
}

function observePreviewSurface(video: HTMLVideoElement, stage: HTMLElement) {
  if (observedVideo !== video) {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => schedulePreviewSync());
    resizeObserver.observe(video);
    video.addEventListener('loadedmetadata', schedulePreviewSync, { once: true });
    observedVideo = video;
  }
  if (observedStage !== stage) {
    mutationObserver?.disconnect();
    mutationObserver = new MutationObserver(() => schedulePreviewSync());
    mutationObserver.observe(stage, { subtree: true, childList: true, characterData: true });
    observedStage = stage;
  }
}

function syncPreview() {
  syncFrame = 0;
  const appearance = currentAppearance;
  if (!appearance) return;
  const root = document.documentElement;
  const video = document.querySelector<HTMLVideoElement>('.media-stage video');
  const stage = video?.closest<HTMLElement>('.media-stage');
  if (!video || !stage) return;
  observePreviewSurface(video, stage);

  const frame = renderedVideoFrame(video);
  const scale = frame.frameHeight / 1080;
  const side = frame.sideInset + frame.frameWidth * Math.max(0, 100 - appearance.maxWidthPct) / 200;
  const bottom = frame.bottomInset + frame.frameHeight * appearance.positionBottomPct / 100;
  const shadow = Math.max(0, appearance.shadowWidth1080 * scale);
  const padding = Math.max(0, appearance.backgroundPadding1080 * scale);

  root.style.setProperty('--caption-live-bottom', `${bottom.toFixed(2)}px`);
  root.style.setProperty('--caption-live-side', `${side.toFixed(2)}px`);
  root.style.setProperty('--caption-live-justify', appearance.alignment === 'left' ? 'flex-start' : appearance.alignment === 'right' ? 'flex-end' : 'center');
  root.style.setProperty('--caption-live-align', appearance.alignment);
  root.style.setProperty('--caption-live-font', `'${appearance.fontFamily.replaceAll("'", "\\'")}', 'Noto Sans Khmer', sans-serif`);
  root.style.setProperty('--caption-live-size', `${Math.max(1, appearance.fontSize1080 * scale).toFixed(2)}px`);
  root.style.setProperty('--caption-live-weight', appearance.bold ? '700' : '400');
  root.style.setProperty('--caption-live-color', appearance.textColor);
  root.style.setProperty('--caption-live-stroke', `${Math.max(0, appearance.outlineWidth1080 * scale).toFixed(2)}px`);
  root.style.setProperty('--caption-live-stroke-color', appearance.outlineColor);
  root.style.setProperty('--caption-live-shadow', shadow > 0 ? `${shadow.toFixed(2)}px ${shadow.toFixed(2)}px 0 rgba(0,0,0,.88)` : 'none');
  root.style.setProperty('--caption-live-background', appearance.backgroundEnabled ? rgba(appearance.backgroundColor, appearance.backgroundOpacity) : 'transparent');
  root.style.setProperty('--caption-live-padding', appearance.backgroundEnabled ? `${padding.toFixed(2)}px` : '0px');
  formatPreviewCaption(appearance, frame.frameWidth, frame.frameHeight);
}

function schedulePreviewSync() {
  if (syncFrame || !currentAppearance) return;
  syncFrame = window.requestAnimationFrame(syncPreview);
}

export function applyCaptionAppearancePreview(value?: Partial<CaptionAppearance>) {
  currentAppearance = resolveCaptionAppearance(value);
  document.documentElement.classList.add('caption-project-appearance');
  schedulePreviewSync();
}

export function clearCaptionAppearancePreview() {
  currentAppearance = null;
  if (syncFrame) window.cancelAnimationFrame(syncFrame);
  syncFrame = 0;
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  resizeObserver = null;
  mutationObserver = null;
  observedVideo = null;
  observedStage = null;
  const caption = document.querySelector<HTMLElement>('.caption-preview-shell .caption-preview');
  if (caption?.dataset.sthangSourceText) caption.textContent = caption.dataset.sthangSourceText;
  const root = document.documentElement;
  root.classList.remove('caption-project-appearance');
  PREVIEW_VARIABLES.forEach((name) => root.style.removeProperty(name));
}
