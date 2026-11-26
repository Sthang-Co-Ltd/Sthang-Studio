import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { translate, translatePlural, translateRich } from './translate';
import type { Locale } from './types';

export type { Locale } from './types';
export { translate, translatePlural, translateRich } from './translate';

export function messagesFor(locale: Locale) {
  return {
    locale,
    t: (...args: Parameters<typeof translate> extends [Locale, ...infer Rest] ? Rest : never) => translate(locale, ...args),
    tn: (...args: Parameters<typeof translatePlural> extends [Locale, ...infer Rest] ? Rest : never) => translatePlural(locale, ...args),
    tr: (...args: Parameters<typeof translateRich> extends [Locale, ...infer Rest] ? Rest : never) => translateRich(locale, ...args),
  };
}

const LocaleContext = createContext(messagesFor('en'));

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => messagesFor(locale), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  return useContext(LocaleContext);
}
