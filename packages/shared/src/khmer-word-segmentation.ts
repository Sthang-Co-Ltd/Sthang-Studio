const KHMER_WORD_END = /[\u1780-\u17D3\u17DD](?:[\t\p{Zs}\u200B]*\u17D7)*$/u;
const REPETITION_SIGNS = /^\u17D7+$/u;
const INLINE_SPACING = /^[\t\p{Zs}\u200B]+$/u;

export function endsWithKhmerWord(text: string) {
  return KHMER_WORD_END.test(text);
}

/** ICU may make the Khmer repetition sign a word of its own. Keep it with
 * its preceding Khmer word, including any original inline separator. */
export function segmentKhmerWords(text: string): Intl.SegmentData[] {
  const segments = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)];
  if (!text.includes('\u17D7')) return segments;

  const words: Intl.SegmentData[] = [];
  for (const segment of segments) {
    if (REPETITION_SIGNS.test(segment.segment)) {
      let previousIndex = words.length - 1;
      while (previousIndex >= 0 && INLINE_SPACING.test(words[previousIndex].segment)) previousIndex -= 1;
      const previous = words[previousIndex];
      if (previous?.isWordLike && endsWithKhmerWord(previous.segment)) {
        words.length = previousIndex + 1;
        words[previousIndex] = { ...previous, segment: text.slice(previous.index, segment.index + segment.segment.length) };
        continue;
      }
    }
    words.push(segment);
  }
  return words;
}
