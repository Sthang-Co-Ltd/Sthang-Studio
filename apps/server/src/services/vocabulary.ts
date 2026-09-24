import type { TranscriptionContext } from '@kcs/shared';

export interface VocabularyEntry {
  canonical: string;
  aliases: string[];
}

const contextHintStopwords = new Set([
  'a', 'about', 'accuracy', 'an', 'and', 'audio', 'brand', 'brands', 'called',
  'clip', 'compare', 'compares', 'comparing', 'context', 'discusses', 'discussion',
  'english', 'exact', 'first', 'is', 'keep', 'khmer', 'make', 'mention', 'mentions',
  'model', 'models', 'name', 'names', 'or', 'person', 'people', 'please', 'preserve',
  'product', 'products', 'say', 'says', 'speaker', 'speakers', 'talk', 'talking',
  'term', 'terms', 'that', 'the', 'these', 'this', 'those', 'today', 'topic', 'use',
  'uses', 'using', 'version', 'versions', 'versus', 'video', 'vs', 'with', 'without',
]);

function contextTokenKind(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\-/]*$/.test(value)) return 'none' as const;
  if (contextHintStopwords.has(value.toLocaleLowerCase('en'))) return 'none' as const;
  if (/\d/.test(value)) return /[A-Za-z]/.test(value) ? 'strong' as const : 'numeric' as const;
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return 'strong' as const;
  if (/[a-z][A-Z]/.test(value) || /^[a-z]+[A-Z]/.test(value)) return 'strong' as const;
  if (/^[A-Z][a-z]{1,}$/.test(value)) return 'title' as const;
  return 'none' as const;
}

function atSentenceStart(value: string, index: number) {
  const prefix = value.slice(0, index).trimEnd();
  return !prefix || /[.!?]\s*$/.test(prefix);
}

/**
 * Extract soft ASR recognition hints from exact substrings of the user's free-form
 * Accuracy description. This deliberately does not infer entities, synonyms, or
 * canonical spellings: derived hints may bias Transcribe recognition, but only the
 * explicit protected-vocabulary field is allowed to authorize canonical repair.
 */
export function contextRecognitionHints(description: string | undefined, limit = 24) {
  const text = String(description || '');
  if (!text.trim() || limit <= 0) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || value.length > 80 || !/[\p{L}\p{N}]/u.test(value)) return;
    const key = value.toLocaleLowerCase('en');
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(value);
  };

  // Explicit quoting/backticks are the strongest signal that the user intended an
  // exact name/phrase to help recognition. Keep only the exact text they typed.
  for (const pattern of [/[“"]([^”"\n]{1,80})[”"]/gu, /«([^»\n]{1,80})»/gu, /`([^`\n]{1,80})`/gu, /'([^'\n]{1,80})'/gu]) {
    for (const match of text.matchAll(pattern)) {
      add(match[1]);
      if (hints.length >= limit) return hints;
    }
  }

  const tokens = [...text.matchAll(/[\p{L}\p{N}]+(?:[._+\-/][\p{L}\p{N}]+)*/gu)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    kind: contextTokenKind(match[0]),
  }));

  let index = 0;
  while (index < tokens.length && hints.length < limit) {
    if (tokens[index].kind === 'none') { index += 1; continue; }
    const run = [tokens[index]];
    let cursor = index + 1;
    while (cursor < tokens.length && run.length < 5 && tokens[cursor].kind !== 'none') {
      const gap = text.slice(run.at(-1)!.end, tokens[cursor].start);
      if (!/^\s+$/.test(gap)) break;
      run.push(tokens[cursor]);
      cursor += 1;
    }
    const hasLetters = run.some((token) => /[A-Za-z]/.test(token.value));
    const singleWeakSentenceStarter = run.length === 1
      && run[0].kind === 'title'
      && atSentenceStart(text, run[0].start);
    if (hasLetters && !singleWeakSentenceStarter) {
      add(text.slice(run[0].start, run.at(-1)!.end));
    }
    index = Math.max(cursor, index + 1);
  }
  return hints.slice(0, limit);
}

export function normalizeTranscriptionContext(value: unknown): TranscriptionContext {
  const raw = value && typeof value === 'object' ? value as Partial<TranscriptionContext> : {};
  const description = String(raw.description || '').trim().slice(0, 6000);
  const vocabulary = Array.isArray(raw.vocabulary)
    ? raw.vocabulary
      .map((line) => String(line || '').trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 100)
    : [];
  return { description, vocabulary };
}

export function parseVocabulary(lines: string[] | undefined): VocabularyEntry[] {
  const seen = new Set<string>();
  const entries: VocabularyEntry[] = [];
  for (const line of lines || []) {
    const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) continue;
    const canonical = parts[0];
    const key = canonical.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    const aliases = [...new Set(parts.slice(1).filter((x) => x.toLocaleLowerCase('en') !== key))];
    entries.push({ canonical, aliases });
  }
  return entries;
}

export function vocabularyHints(entries: VocabularyEntry[]) {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const value of [entry.canonical, ...entry.aliases]) {
      const cleaned = value.trim();
      const key = cleaned.toLocaleLowerCase('en');
      if (!cleaned || seen.has(key)) continue;
      seen.add(key);
      hints.push(cleaned);
    }
  }
  return hints;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic alias repair. The user explicitly owns these mappings, so a line
 * like `Terra | ថេរ៉ា` means that exact heard/transcribed alias should display as `Terra`.
 */
export function canonicalizeVocabularyAliases(text: string, entries: VocabularyEntry[]) {
  let output = text;
  let replacements = 0;
  const candidates = entries
    .flatMap((entry) => entry.aliases.map((alias) => ({ canonical: entry.canonical, alias })))
    .sort((a, b) => [...b.alias].length - [...a.alias].length);

  for (const { canonical, alias } of candidates) {
    if (!alias || alias === canonical) continue;
    const escaped = escapeRegExp(alias);
    const latinWordish = /^[A-Za-z0-9 ._+\-/]+$/.test(alias);
    const re = latinWordish
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu')
      : new RegExp(escaped, 'gu');
    output = output.replace(re, (match) => {
      if (match === canonical) return match;
      replacements += 1;
      return canonical;
    });
  }
  return { text: output, replacements };
}
