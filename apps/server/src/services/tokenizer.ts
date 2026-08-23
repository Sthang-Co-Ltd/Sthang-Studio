export interface TextToken {
  text: string;
  spaceBefore: boolean;
  normalized: string;
}

const PUNCT = /^[\p{P}\p{S}។៕…]+$/u;
const KHMER_WORD_START = /^[\u1780-\u17D3\u17DD]/u;
const KHMER_WORD_END = /[\u1780-\u17D3\u17DD]$/u;
const STRONG_END = /[។៕៘៙៚!?…]["'»”’\)\]\}]*$/u;
const KHMER_INTERNAL_SPACE = /([\u1780-\u17D3\u17DD])[\t \u00A0]+(?=[\u1780-\u17D3\u17DD])/gu;
const SPACE_BEFORE_PUNCT = /\s+([,.;:!?%…។៕៘៙៚\)\]\}»”’])/gu;
const SPACE_AFTER_OPEN = /([\(\[\{«“‘])\s+/gu;
const KHMER_DIGITS: Record<string, string> = {
  '០':'0','១':'1','២':'2','៣':'3','៤':'4','៥':'5','៦':'6','៧':'7','៨':'8','៩':'9'
};

export function normalizeForMatch(value: string) {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('en')
    .replace(/[០-៩]/g, (d) => KHMER_DIGITS[d] ?? d)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

export function tokenizeText(text: string): TextToken[] {
  const clean = text.normalize('NFC').trim();
  if (!clean) return [];
  const segments = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(clean)];
  const out: Array<TextToken & { endIndex: number }> = [];

  for (const seg of segments) {
    const value = seg.segment;
    if (!value || /^\s+$/u.test(value)) continue;
    if (!seg.isWordLike && PUNCT.test(value) && out.length) {
      out[out.length - 1].text += value;
      out[out.length - 1].normalized = normalizeForMatch(out[out.length - 1].text);
      out[out.length - 1].endIndex = seg.index + value.length;
      continue;
    }
    if (!seg.isWordLike && PUNCT.test(value)) continue;
    const prevEnd = out.length ? out[out.length - 1].endIndex : 0;
    const between = clean.slice(prevEnd, seg.index);
    out.push({
      text: value.trim(),
      normalized: normalizeForMatch(value),
      spaceBefore: out.length > 0 && /\s/u.test(between),
      endIndex: seg.index + value.length,
    });
  }
  return out.filter((x) => x.text && x.normalized).map(({ endIndex: _endIndex, ...x }) => x);
}

interface JoinableToken {
  text: string;
  spaceBefore?: boolean;
  startMs?: number;
  endMs?: number;
}

function isKhmerBoundary(left: JoinableToken, right: JoinableToken) {
  return KHMER_WORD_END.test(left.text) && KHMER_WORD_START.test(right.text);
}

/**
 * Gemini sometimes inserts a space between nearly every Khmer lexical token.
 * Khmer normally uses spaces for phrase-level separation rather than English-style
 * word separation. Detect over-spaced Khmer runs and keep only acoustically meaningful
 * boundaries (or punctuation boundaries). Latin words, numbers and mixed-script terms
 * retain their original spaces.
 */
export function normalizeKhmerTokenSpacing<T extends JoinableToken>(tokens: T[]): T[] {
  const out = tokens.map((token) => ({ ...token })) as T[];
  let runStart = 0;

  while (runStart < out.length) {
    let runEnd = runStart;
    while (runEnd + 1 < out.length && isKhmerBoundary(out[runEnd], out[runEnd + 1])) runEnd += 1;

    const pairCount = runEnd - runStart;
    if (pairCount >= 2) {
      let spacedPairs = 0;
      for (let i = runStart + 1; i <= runEnd; i += 1) {
        if (out[i].spaceBefore) spacedPairs += 1;
      }
      const looksWordSpaced = spacedPairs / pairCount >= 0.5;
      if (looksWordSpaced) {
        for (let i = runStart + 1; i <= runEnd; i += 1) {
          if (!out[i].spaceBefore) continue;
          const previous = out[i - 1];
          const current = out[i];
          const hasTiming = Number.isFinite(previous.endMs) && Number.isFinite(current.startMs);
          const pauseMs = hasTiming ? Math.max(0, Number(current.startMs) - Number(previous.endMs)) : 0;
          // A short pause threshold keeps genuine Khmer phrase spacing while removing
          // artificial word-by-word spaces introduced by transcription/tokenization.
          current.spaceBefore = STRONG_END.test(previous.text) || pauseMs >= 210;
        }
      }
    }

    runStart = Math.max(runStart + 1, runEnd + 1);
  }

  return out;
}

/** Explicit cleanup for already-generated/manual caption strings. */
export function normalizeKhmerDisplayText(text: string) {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(KHMER_INTERNAL_SPACE, '$1')
    .replace(SPACE_BEFORE_PUNCT, '$1')
    .replace(SPACE_AFTER_OPEN, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function joinTokens(tokens: Array<JoinableToken>) {
  const normalized = normalizeKhmerTokenSpacing(tokens);
  return normalized.map((token, i) => `${i > 0 && token.spaceBefore ? ' ' : ''}${token.text}`).join('').trim();
}

export function levenshteinSimilarity(a: string, b: string) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aa = [...a];
  const bb = [...b];
  const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const above = prev[j];
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return 1 - prev[bb.length] / Math.max(aa.length, bb.length);
}
