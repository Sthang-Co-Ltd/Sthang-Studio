import type { TranscriptionContext } from '@kcs/shared';

export interface VocabularyEntry {
  canonical: string;
  aliases: string[];
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
