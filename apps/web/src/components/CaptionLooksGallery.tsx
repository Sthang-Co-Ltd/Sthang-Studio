import { useI18n } from '../i18n';
import { lookNameKey } from '../server-labels';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  CAPTION_LOOKS,
  matchingCaptionLook,
  type CaptionAppearance,
  type CaptionLook,
  type CaptionLookId,
} from '@kcs/shared';
import { Check, RotateCcw } from 'lucide-react';

interface Props {
  appearance: CaptionAppearance;
  mediaElement: HTMLMediaElement | null;
  sampleCaptionText?: string;
  onSelect(look: CaptionLookId): void;
  onReset(): void;
}

const SAMPLE_GRAPHEME_LIMIT = 72;
const sampleSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('km', { granularity: 'grapheme' })
  : null;

function rgba(hex: string, opacity: number) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex);
  if (!match) return hex;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${opacity})`;
}

function sampleStyle(decoration: CaptionLook['decoration']): CSSProperties {
  const shadows: string[] = [];
  if (decoration.shadowWidth1080 > 0) {
    const blur = Math.max(2, Math.min(8, decoration.shadowWidth1080));
    shadows.push(`0 ${Math.max(1, blur / 2)}px ${blur}px rgba(0, 0, 0, .9)`);
  }
  if (decoration.glowEnabled && decoration.glowWidth1080 && decoration.glowOpacity) {
    const blur = Math.max(3, Math.min(12, decoration.glowWidth1080 * 1.5));
    shadows.push(`0 0 ${blur}px ${rgba(decoration.glowColor || '#D7FF4F', decoration.glowOpacity)}`);
  }
  return {
    color: decoration.textColor,
    paintOrder: 'stroke fill',
    WebkitTextStroke: decoration.outlineWidth1080 > 0
      ? `${Math.max(.35, Math.min(1.25, decoration.outlineWidth1080 / 5))}px ${decoration.outlineColor}`
      : undefined,
    textShadow: shadows.length ? shadows.join(', ') : 'none',
    background: decoration.backgroundEnabled
      ? rgba(decoration.backgroundColor, decoration.backgroundOpacity)
      : 'transparent',
    padding: decoration.backgroundEnabled
      ? `${Math.max(3, Math.min(8, decoration.backgroundPadding1080 / 2))}px ${Math.max(5, Math.min(11, decoration.backgroundPadding1080 * .75))}px`
      : undefined,
  };
}

function boundedSampleText(value?: string) {
  const source = value?.trim() || 'សួស្តី ពី Sthang Studio';
  if (source.length <= 160 || !sampleSegmenter) return source;
  let sample = '';
  let count = 0;
  for (const part of sampleSegmenter.segment(source)) {
    if (count >= SAMPLE_GRAPHEME_LIMIT) return `${sample.trimEnd()}…`;
    sample += part.segment;
    count += 1;
  }
  return sample;
}

export function CaptionLooksGallery({ appearance, mediaElement, sampleCaptionText, onSelect, onReset }: Props) {
  const { t, tr } = useI18n();
  const grid = useRef<HTMLDivElement>(null);
  const [comparison, setComparison] = useState<{ text: string; candidate: CaptionLook } | null>(null);
  const [side, setSide] = useState<'current' | 'candidate'>('candidate');
  const compareButton = useRef<HTMLButtonElement>(null);
  const compareId = useId();
  useEffect(() => {
    const sheet = grid.current;
    if (!sheet || !(mediaElement instanceof HTMLVideoElement) || !mediaElement.isConnected) return;
    const waiting = new AbortController();
    let disposed = false;
    let frameUrl: string | undefined;

    // Share one decoded frame for the lifetime of this sheet. Playback and slider
    // edits must not seek the player or regenerate the thumbnails.
    const video = mediaElement;
    const capture = () => {
      if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      waiting.abort();
      const scale = Math.min(1, 384 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob || disposed) return;
          frameUrl = URL.createObjectURL(blob);
          sheet.style.setProperty('--look-frame', `url("${frameUrl}")`);
        }, 'image/jpeg', 0.82);
      } catch { /* Protected or unreadable frames retain the plain sample. */ }
    };
    for (const event of ['loadeddata', 'canplay', 'seeked']) {
      video.addEventListener(event, capture, { signal: waiting.signal });
    }
    capture();
    return () => {
      disposed = true;
      waiting.abort();
      sheet.style.removeProperty('--look-frame');
      if (frameUrl) URL.revokeObjectURL(frameUrl);
    };
  }, [mediaElement]);
  const activeLook = matchingCaptionLook(appearance);
  const lookLabel = ({ id, label }: CaptionLook) => {
    const key = lookNameKey(id);
    return key ? t(key) : label;
  };
  const activeRecipe = CAPTION_LOOKS.find((look) => look.id === activeLook);
  const activeLookLabel = activeRecipe ? lookLabel(activeRecipe) : t('appearance.looks.custom');
  const sample = boundedSampleText(sampleCaptionText);
  function closeComparison() {
    setComparison(null);
    compareButton.current?.focus({ preventScroll: true });
  }

  return <section className="caption-effects-section appearance-look-section" aria-labelledby="appearance-look-title" onKeyDown={(event) => {
    if (!comparison || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing
      || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.stopPropagation();
    if (event.target instanceof HTMLSelectElement && CSS.supports('selector(select:open)') && event.target.matches(':open')) return;
    event.preventDefault();
    closeComparison();
  }}>
    <div className="caption-effects-section-head">
      <div>
        <strong id="appearance-look-title">{t('appearance.looks.title')}</strong>
        <div className="appearance-look-current" role="status">{tr('appearance.looks.current', { look: activeLookLabel }, {})}</div>
      </div>
      <div className="look-actions">
        <button type="button" ref={compareButton} aria-expanded={Boolean(comparison)} aria-controls={comparison ? compareId : undefined}
          onClick={() => {
            if (comparison) { closeComparison(); return; }
            const candidate = CAPTION_LOOKS.find((look) => look.id !== activeLook) || CAPTION_LOOKS[0];
            setSide('candidate');
            setComparison({ text: sampleCaptionText?.trim() || sample, candidate });
          }}>{t('appearance.looks.compare')}</button>
        {!comparison && <button type="button" className="effect-reset-button" onClick={onReset}>
          <RotateCcw size={14}/>{t('appearance.looks.reset')}</button>}
      </div>
    </div>
    {comparison && <div id={compareId} className="look-comparison">
      <label>{t('appearance.looks.candidate')}
        <select value={comparison.candidate.id} onChange={(event) => {
          const candidate = CAPTION_LOOKS.find((look) => look.id === event.target.value);
          if (candidate) { setComparison({ ...comparison, candidate }); setSide('candidate'); }
        }}>{CAPTION_LOOKS.map((look) => <option key={look.id} value={look.id}>{lookLabel(look)}</option>)}</select>
      </label>
      <LookComparisonFrame media={mediaElement} text={comparison.text} appearance={appearance}
        decoration={side === 'current' ? appearance : comparison.candidate.decoration}>
        <div className="look-comparison-controls">
          <div className="look-comparison-switch" role="group" aria-label={t('appearance.looks.sample')}>
            {(['current', 'candidate'] as const).map((choice) => <button key={choice} type="button" aria-pressed={side === choice}
              onClick={() => setSide(choice)}>{t(choice === 'current' ? 'appearance.looks.currentVersion' : 'appearance.looks.candidate')}</button>)}
          </div>
          <button type="button" disabled={comparison.candidate.id === activeLook}
            onClick={() => { onSelect(comparison.candidate.id); closeComparison(); }}>{t('appearance.looks.applyCandidate')}</button>
        </div>
      </LookComparisonFrame>
    </div>}
    <div ref={grid} hidden={Boolean(comparison)} className="appearance-look-grid" role="group" aria-label={t('appearance.looks.group')}>
      {CAPTION_LOOKS.map((look) => <button
        key={look.id}
        type="button"
        className="appearance-look-card"
        title={t(`appearance.looks.description.${look.id}`)}
        aria-description={t(`appearance.looks.description.${look.id}`)}
        aria-pressed={activeLook === look.id}
        onClick={() => onSelect(look.id)}
      >
        <span className="appearance-look-preview" aria-hidden="true">
          <span style={sampleStyle(look.decoration)}>{sample}</span>
        </span>
        <span className="appearance-look-copy">
          <strong>{lookLabel(look)}</strong>
          {activeLook === look.id && <Check size={14} aria-hidden="true"/>}
        </span>
      </button>)}
    </div>
    <details className="appearance-look-help"><summary>{t('appearance.looks.about')}</summary><p>{t('appearance.looks.help')}</p></details>
  </section>;
}

function LookComparisonFrame({ media, text, appearance, decoration, children }: {
  media: HTMLMediaElement | null; text: string; appearance: CaptionAppearance; decoration: CaptionLook['decoration']; children: ReactNode;
}) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const frame = canvas.current;
    setFrameWidth(0);
    if (!frame || !(media instanceof HTMLVideoElement) || !media.isConnected) return;
    const waiting = new AbortController();
    const capture = () => {
      if (media.seeking || media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !media.videoWidth || !media.videoHeight) return;
      waiting.abort();
      const scale = Math.min(1, 720 / Math.max(media.videoWidth, media.videoHeight));
      frame.width = Math.max(1, Math.round(media.videoWidth * scale));
      frame.height = Math.max(1, Math.round(media.videoHeight * scale));
      const context = frame.getContext('2d');
      if (!context) return;
      try {
        context.drawImage(media, 0, 0, frame.width, frame.height);
        context.getImageData(0, 0, 1, 1);
        setFrameWidth(Math.min(frame.width, 300 * frame.width / frame.height));
      } catch { /* Leave the unavailable-frame message visible. */ }
    };
    for (const event of ['loadeddata', 'canplay', 'seeked']) media.addEventListener(event, capture, { signal: waiting.signal });
    capture();
    return () => waiting.abort();
  }, [media]);
  useLayoutEffect(() => {
    const viewport = overlay.current;
    if (!frameWidth || !viewport || !caption.current) return;
    const measure = () => setScrollable(viewport.scrollHeight > viewport.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(caption.current);
    measure();
    return () => observer.disconnect();
  }, [frameWidth]);
  return <><figure className="look-comparison-figure">
    <div className="look-comparison-picture" hidden={!frameWidth} style={{ width: frameWidth }}>
      <canvas ref={canvas} aria-hidden="true"/>
      <div ref={overlay} className="look-comparison-overlay" style={{ '--look-bottom': appearance.positionBottomPct + '%' } as CSSProperties}
        tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'region' : undefined}
        aria-label={scrollable ? t('appearance.looks.fullCaption') : undefined} onKeyDown={(event) => {
          if (scrollable && [' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
            event.stopPropagation();
          }
        }}>
        <div ref={caption} className="look-comparison-caption" style={{ width: appearance.maxWidthPct + '%', textAlign: appearance.alignment,
          fontFamily: JSON.stringify(appearance.fontFamily) + ', "Noto Sans Khmer", sans-serif', fontWeight: appearance.bold ? 700 : 400 }}>
          <span data-server-text style={sampleStyle(decoration)}>{text}</span>
        </div>
      </div>
    </div>
    <figcaption>{t(!frameWidth ? 'appearance.looks.frameUnavailable' : scrollable ? 'appearance.looks.fullCaption' : 'appearance.looks.sample')}</figcaption>
  </figure>{frameWidth > 0 && children}</>;
}
