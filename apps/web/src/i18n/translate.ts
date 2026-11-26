import { createElement, Fragment, type ReactNode } from 'react';
import { en } from './messages/en';
import { km } from './messages/km';
import type { DeepPartial, EnglishMessages, Locale, MessageKey, MessageParams, PluralKey, PluralMessage } from './types';

type RichTag = 'b' | 'code';
type RichTags = Partial<Record<RichTag, (text: string) => ReactNode>>;
type Catalog = { readonly [key: string]: string | Catalog | undefined };

function lookup(catalog: Catalog, key: string) {
  let node: Catalog | string | undefined = catalog;
  for (const part of key.split('.')) {
    node = typeof node === 'object' && Object.hasOwn(node, part) ? node[part] : undefined;
  }
  return node;
}

function interpolate(template: string, key: string, params: MessageParams) {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) => {
    if (Object.hasOwn(params, name)) return String(params[name]);
    if (import.meta.env?.DEV) console.error(`Missing message parameter "${name}" for "${key}".`);
    return placeholder;
  });
}

const pluralRules = { en: new Intl.PluralRules('en'), km: new Intl.PluralRules('km') };

export function createTranslator({ en, km }: { en: EnglishMessages; km: DeepPartial<EnglishMessages> }) {
  function templateFor(locale: Locale, key: MessageKey) {
    return (locale === 'km' ? lookup(km, key) ?? lookup(en, key) : lookup(en, key)) as string;
  }

  function translate(locale: Locale, key: MessageKey, params: MessageParams = {}) {
    return interpolate(templateFor(locale, key), key, params);
  }

  function translatePlural(locale: Locale, key: PluralKey, count: number, params: MessageParams = {}) {
    const category = pluralRules[locale].select(count);
    const english = lookup(en, key) as PluralMessage;
    const translated = locale === 'km' ? lookup(km, key) as Partial<PluralMessage> | undefined : undefined;
    const template = translated?.[category as keyof PluralMessage] ?? translated?.other
      ?? (pluralRules.en.select(count) === 'one' ? english.one : english.other);
    return interpolate(template, key, { ...params, count });
  }

  function translateRich(locale: Locale, key: MessageKey, params: MessageParams, tags: RichTags): ReactNode[] {
    // Parse the trusted template before substituting parameters. Inserted tags are text.
    const parts = templateFor(locale, key).split(/(<(?:b|code)>[\s\S]*?<\/(?:b|code)>)/);
    return parts.map((part, index) => {
      const match = /^<(b|code)>([\s\S]*?)<\/\1>$/.exec(part);
      if (!match) return interpolate(part, key, params);
      const tag = match[1] as RichTag;
      const content = interpolate(match[2], key, params);
      const render = tags[tag];
      return createElement(Fragment, { key: index }, render ? render(content) : createElement(tag, null, content));
    });
  }

  return { translate, translatePlural, translateRich };
}

export const { translate, translatePlural, translateRich } = createTranslator({ en, km });
