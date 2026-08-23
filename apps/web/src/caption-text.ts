import type { CaptionSegment } from '@kcs/shared';

const KHMER = /[\u1780-\u17ff]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?…%\)\]\}»”’\u17d4-\u17da]/u;
const OPENING_PUNCTUATION = /[\(\[\{«“‘]$/u;

/**
 * Reconstruct a readable range transcript without re-introducing the
 * English-style space between every Khmer token. A real spoken pause still
 * receives a separator, while Latin names/version numbers stay legible.
 */
export function captionTextForEditing(captions: CaptionSegment[]) {
  const ordered = [...captions].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let result = '';
  let previous: CaptionSegment | undefined;

  for (const caption of ordered) {
    const text = caption.text.trim();
    if (!text) continue;
    if (!result) {
      result = text;
      previous = caption;
      continue;
    }

    const left = result.at(-1) || '';
    const right = text.at(0) || '';
    const gapMs = previous ? Math.max(0, caption.startMs - previous.endMs) : 0;
    const punctuationJoins = CLOSING_PUNCTUATION.test(text) || OPENING_PUNCTUATION.test(result);
    const continuousKhmer = KHMER.test(left) && KHMER.test(right) && gapMs < 180;
    const separator = punctuationJoins || continuousKhmer ? '' : ' ';
    result += separator + text;
    previous = caption;
  }

  return result.replace(/[ \t]+/g, ' ').trim();
}
