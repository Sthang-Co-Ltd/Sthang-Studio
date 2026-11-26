import type { en } from './messages/en';

export type Locale = 'en' | 'km';
export type MessageParams = Readonly<Record<string, string | number>>;
export type EnglishMessages = typeof en;
export type PluralMessage = { readonly one: string; readonly other: string };

export type KhmerMessages<T = EnglishMessages> = {
  readonly [K in keyof T]: T[K] extends PluralMessage ? { readonly other: string; readonly one?: string }
    : T[K] extends string ? string : KhmerMessages<T[K]>;
};

export type DeepPartial<T> = T extends string ? string : {
  [K in keyof T]?: DeepPartial<T[K]>;
};

type Keys<T, Leaf> = {
  [K in keyof T & string]: T[K] extends Leaf ? K
    : T[K] extends string | PluralMessage ? never
    : `${K}.${Keys<T[K], Leaf>}`
}[keyof T & string];

export type MessageKey = Keys<EnglishMessages, string>;
export type PluralKey = Keys<EnglishMessages, PluralMessage>;
