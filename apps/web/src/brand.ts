export const STUDIO_MARK_ASSETS = Object.freeze({
  dark: '/brand/sthang-studio-mark.svg',
  light: '/brand/sthang-studio-mark-ink.svg',
  mono: '/brand/sthang-studio-mark-mono.svg',
} as const);

export const STHANG_WORDMARK_ASSETS = Object.freeze({
  dark: '/brand/sthang-wordmark.svg',
  light: '/brand/sthang-wordmark-ink.svg',
  mono: '/brand/sthang-wordmark.svg',
} as const);

export type StudioMarkSurface = keyof typeof STUDIO_MARK_ASSETS;

export function studioMarkForSurface(surface: StudioMarkSurface = 'dark'): string {
  return STUDIO_MARK_ASSETS[surface];
}

export function sthangWordmarkForSurface(surface: StudioMarkSurface = 'dark'): string {
  return STHANG_WORDMARK_ASSETS[surface];
}
