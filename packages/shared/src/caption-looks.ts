import {
  DEFAULT_CAPTION_APPEARANCE,
  normalizeCaptionAppearance,
  type CaptionAppearance,
} from './caption-settings.js';

export type CaptionLookId = 'clean' | 'bold-outline' | 'soft-shadow' | 'solid-box' | 'high-contrast' | 'soft-glow';

export type CaptionLookDecoration = Pick<CaptionAppearance,
  | 'textColor'
  | 'outlineColor'
  | 'outlineWidth1080'
  | 'shadowWidth1080'
  | 'backgroundEnabled'
  | 'backgroundColor'
  | 'backgroundOpacity'
  | 'backgroundPadding1080'
  | 'glowEnabled'
  | 'glowColor'
  | 'glowWidth1080'
  | 'glowOpacity'
>;

export interface CaptionLook {
  id: CaptionLookId;
  label: string;
  description: string;
  decoration: Readonly<CaptionLookDecoration>;
}

const BASE_DECORATION: CaptionLookDecoration = {
  textColor: DEFAULT_CAPTION_APPEARANCE.textColor,
  outlineColor: DEFAULT_CAPTION_APPEARANCE.outlineColor,
  outlineWidth1080: DEFAULT_CAPTION_APPEARANCE.outlineWidth1080,
  shadowWidth1080: DEFAULT_CAPTION_APPEARANCE.shadowWidth1080,
  backgroundEnabled: DEFAULT_CAPTION_APPEARANCE.backgroundEnabled,
  backgroundColor: DEFAULT_CAPTION_APPEARANCE.backgroundColor,
  backgroundOpacity: DEFAULT_CAPTION_APPEARANCE.backgroundOpacity,
  backgroundPadding1080: DEFAULT_CAPTION_APPEARANCE.backgroundPadding1080,
  glowEnabled: DEFAULT_CAPTION_APPEARANCE.glowEnabled,
  glowColor: DEFAULT_CAPTION_APPEARANCE.glowColor,
  glowWidth1080: DEFAULT_CAPTION_APPEARANCE.glowWidth1080,
  glowOpacity: DEFAULT_CAPTION_APPEARANCE.glowOpacity,
};

function recipe(id: CaptionLookId, label: string, description: string, decoration: CaptionLookDecoration): CaptionLook {
  return Object.freeze({ id, label, description, decoration: Object.freeze(decoration) });
}

export const CAPTION_LOOKS: readonly CaptionLook[] = Object.freeze([
  recipe('clean', 'Clean', 'Balanced white type with a restrained outline and shadow.', { ...BASE_DECORATION }),
  recipe('bold-outline', 'Bold Outline', 'A stronger edge treatment for busy footage.', {
    ...BASE_DECORATION,
    outlineWidth1080: 6,
    shadowWidth1080: 0,
  }),
  recipe('soft-shadow', 'Soft Shadow', 'Light outline with a deeper soft separation from the picture.', {
    ...BASE_DECORATION,
    outlineWidth1080: 1,
    shadowWidth1080: 5,
  }),
  recipe('solid-box', 'Solid Box', 'High-legibility text on a compact dark caption box.', {
    ...BASE_DECORATION,
    outlineWidth1080: 0,
    shadowWidth1080: 0,
    backgroundEnabled: true,
    backgroundOpacity: 0.72,
    backgroundPadding1080: 12,
  }),
  recipe('high-contrast', 'High Contrast', 'Strong outline and dark backing for difficult backgrounds.', {
    ...BASE_DECORATION,
    outlineWidth1080: 5,
    shadowWidth1080: 2,
    backgroundEnabled: true,
    backgroundOpacity: 0.78,
    backgroundPadding1080: 10,
  }),
  recipe('soft-glow', 'Soft Glow', 'A restrained lime halo around clean white caption text.', {
    ...BASE_DECORATION,
    outlineColor: '#111111',
    outlineWidth1080: 2,
    shadowWidth1080: 0,
    glowEnabled: true,
    glowColor: '#D7FF4F',
    glowWidth1080: 6,
    glowOpacity: 0.55,
  }),
]);

const DECORATION_KEYS = Object.freeze([
  'textColor', 'outlineColor', 'outlineWidth1080', 'shadowWidth1080',
  'backgroundEnabled', 'backgroundColor', 'backgroundOpacity', 'backgroundPadding1080',
  'glowEnabled', 'glowColor', 'glowWidth1080', 'glowOpacity',
] as const satisfies readonly (keyof CaptionLookDecoration)[]);

function decorationMatches(appearance: CaptionAppearance, decoration: Readonly<CaptionLookDecoration>) {
  return DECORATION_KEYS.every((key) => appearance[key] === decoration[key]);
}

/** Apply only visual decoration. Typography, layout, motion and word emphasis remain creator-owned. */
export function applyCaptionLook(
  current: Partial<CaptionAppearance> | null | undefined,
  look: CaptionLookId | null,
): CaptionAppearance {
  const appearance = normalizeCaptionAppearance(current);
  const decoration = look === null ? BASE_DECORATION : CAPTION_LOOKS.find((candidate) => candidate.id === look)?.decoration;
  if (!decoration) throw new Error(`Unknown caption look: ${String(look)}.`);
  return normalizeCaptionAppearance({ ...appearance, ...decoration });
}

/** Return the exact matching decoration recipe, ignoring typography, layout, motion and word emphasis. */
export function matchingCaptionLook(current: Partial<CaptionAppearance> | null | undefined): CaptionLookId | null {
  const appearance = normalizeCaptionAppearance(current);
  return CAPTION_LOOKS.find((look) => decorationMatches(appearance, look.decoration))?.id ?? null;
}
