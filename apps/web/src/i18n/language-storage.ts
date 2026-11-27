import type { Locale } from './types';

const languageKey = 'sthang:interface-language:v1';

export function readInterfaceLanguage(): Locale | undefined {
  try {
    const value = localStorage.getItem(languageKey);
    if (value === 'en' || value === 'km') return value;
  } catch { /* optional browser mirror */ }
}

export function mirrorInterfaceLanguage(locale: Locale) {
  try { localStorage.setItem(languageKey, locale); }
  catch { /* optional browser mirror */ }
}
