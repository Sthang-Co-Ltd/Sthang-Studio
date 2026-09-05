import { DEFAULT_CAPTION_APPEARANCE, type CaptionAppearance } from '@kcs/shared';

const PREVIEW_VARIABLES = [
  '--caption-live-bottom', '--caption-live-side', '--caption-live-justify', '--caption-live-align', '--caption-live-font',
  '--caption-live-size', '--caption-live-weight', '--caption-live-color', '--caption-live-stroke', '--caption-live-stroke-color',
  '--caption-live-shadow', '--caption-live-background', '--caption-live-padding',
] as const;

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

export function applyCaptionAppearancePreview(value?: Partial<CaptionAppearance>) {
  const appearance = resolveCaptionAppearance(value);
  const ratio = Math.max(0.38, Math.min(2.15, appearance.fontSize1080 / DEFAULT_CAPTION_APPEARANCE.fontSize1080));
  const minimum = Math.max(12, Math.round(22 * ratio));
  const maximum = Math.max(minimum, Math.round(42 * ratio));
  const side = Math.max(2, (100 - appearance.maxWidthPct) / 2);
  const shadow = appearance.shadowWidth1080 > 0
    ? `0 ${Math.max(1, appearance.shadowWidth1080 * 0.42)}px ${Math.max(2, appearance.shadowWidth1080 * 1.3)}px rgba(0,0,0,.88)`
    : 'none';
  const root = document.documentElement;
  root.classList.add('caption-project-appearance');
  root.style.setProperty('--caption-live-bottom', `${appearance.positionBottomPct}%`);
  root.style.setProperty('--caption-live-side', `${side}%`);
  root.style.setProperty('--caption-live-justify', appearance.alignment === 'left' ? 'flex-start' : appearance.alignment === 'right' ? 'flex-end' : 'center');
  root.style.setProperty('--caption-live-align', appearance.alignment);
  root.style.setProperty('--caption-live-font', `'${appearance.fontFamily.replaceAll("'", "\\'")}', 'Noto Sans Khmer', sans-serif`);
  root.style.setProperty('--caption-live-size', `clamp(${minimum}px, ${(3 * ratio).toFixed(2)}vw, ${maximum}px)`);
  root.style.setProperty('--caption-live-weight', appearance.bold ? '700' : '400');
  root.style.setProperty('--caption-live-color', appearance.textColor);
  root.style.setProperty('--caption-live-stroke', `${Math.max(0, appearance.outlineWidth1080 * 0.42)}px`);
  root.style.setProperty('--caption-live-stroke-color', appearance.outlineColor);
  root.style.setProperty('--caption-live-shadow', shadow);
  root.style.setProperty('--caption-live-background', appearance.backgroundEnabled ? rgba(appearance.backgroundColor, appearance.backgroundOpacity) : 'transparent');
  root.style.setProperty('--caption-live-padding', appearance.backgroundEnabled ? `${Math.max(2, appearance.backgroundPadding1080 * 0.32)}px ${Math.max(4, appearance.backgroundPadding1080 * 0.64)}px` : '0px');
}

export function clearCaptionAppearancePreview() {
  const root = document.documentElement;
  root.classList.remove('caption-project-appearance');
  PREVIEW_VARIABLES.forEach((name) => root.style.removeProperty(name));
}
