import type { CSSProperties } from 'react';
import {
  CAPTION_LOOKS,
  matchingCaptionLook,
  type CaptionAppearance,
  type CaptionLook,
  type CaptionLookId,
} from '@kcs/shared';
import { RotateCcw } from 'lucide-react';

interface Props {
  appearance: CaptionAppearance;
  sampleCaptionText?: string;
  onSelect(look: CaptionLookId): void;
  onReset(): void;
}

function rgba(hex: string, opacity: number) {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(hex);
  if (!match) return hex;
  return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${opacity})`;
}

function sampleStyle(look: CaptionLook): CSSProperties {
  const decoration = look.decoration;
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

export function CaptionLooksGallery({ appearance, sampleCaptionText, onSelect, onReset }: Props) {
  const activeLook = matchingCaptionLook(appearance);
  const activeLookLabel = CAPTION_LOOKS.find((look) => look.id === activeLook)?.label || 'Custom';
  const sample = sampleCaptionText?.trim() || 'សួស្តី ពី Sthang Studio';

  return <section className="caption-effects-section appearance-look-section" aria-labelledby="appearance-look-title">
    <div className="caption-effects-section-head">
      <div>
        <strong id="appearance-look-title">Look</strong>
        <span>Choose a Look for all captions. Your font, weight, size, position, Motion and word emphasis stay as they are.</span>
      </div>
      <button type="button" className="effect-reset-button" onClick={onReset}>
        <RotateCcw size={14}/>Reset look
      </button>
    </div>
    <div className="appearance-look-current" role="status">Current look <b>{activeLookLabel}</b></div>
    <div className="appearance-look-grid" role="group" aria-label="Caption looks">
      {CAPTION_LOOKS.map((look) => <button
        key={look.id}
        type="button"
        className="appearance-look-card"
        aria-pressed={activeLook === look.id}
        onClick={() => onSelect(look.id)}
      >
        <span className="appearance-look-preview" aria-hidden="true">
          <span style={sampleStyle(look)}>{sample}</span>
        </span>
        <span className="appearance-look-copy">
          <strong>{look.label}</strong>
          <small>{look.description}</small>
        </span>
      </button>)}
    </div>
    <small className="appearance-look-note">Style samples only. Check the video above for final layout.</small>
  </section>;
}
