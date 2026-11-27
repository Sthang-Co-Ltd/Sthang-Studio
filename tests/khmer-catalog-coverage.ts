import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { pendingKhmerNamespaces } from '../apps/web/src/i18n/pending.js';

type Catalog = { readonly [key: string]: string | Catalog };

export function catalogValues(catalog: Catalog): string[] {
  return Object.values(catalog).flatMap((value) => typeof value === 'string' ? [value] : catalogValues(value));
}

export function pendingEnglishValues(namespaces: readonly (keyof typeof en)[] = pendingKhmerNamespaces): Set<string> {
  return new Set(namespaces.flatMap((namespace) => catalogValues(en[namespace])).map((value) => value.trim()));
}
