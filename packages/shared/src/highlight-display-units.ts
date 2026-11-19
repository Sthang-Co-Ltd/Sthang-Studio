import { segmentKhmerWords } from './khmer-word-segmentation.js';

export interface HighlightDisplayUnit {
  startOffset: number;
  endOffset: number;
}

const graphemeSegmenter = new Intl.Segmenter('km', { granularity: 'grapheme' });
const spacing = /[\s\u200B]/u;
const ignorable = /^[\s\p{P}\p{S}\p{Cf}]*$/u;
const opening = /^[\p{Sc}\p{Ps}\p{Pi}]/u;
const closing = /^[\p{Pe}\p{Pf}\p{Po}]/u;

export function highlightDisplayUnits(text: string): HighlightDisplayUnit[] {
  const graphemes = [...graphemeSegmenter.segment(text)];
  const words = segmentKhmerWords(text);
  const units: HighlightDisplayUnit[] = [];
  const starts = new Map<number, Intl.SegmentData>();
  const ends = new Map<number, Intl.SegmentData>();
  let wordIndex = 0;
  let activeWord = -1;
  for (const grapheme of graphemes) {
    const startOffset = grapheme.index;
    const endOffset = startOffset + grapheme.segment.length;
    starts.set(startOffset, grapheme);
    ends.set(endOffset, grapheme);
    while (wordIndex < words.length && words[wordIndex].index + words[wordIndex].segment.length <= startOffset) {
      wordIndex += 1;
    }
    const word = words[wordIndex];
    const wordLike = word?.isWordLike && word.index < endOffset;
    if (spacing.test(grapheme.segment) || (!wordLike && ignorable.test(grapheme.segment))) {
      activeWord = -1;
      continue;
    }
    // Grapheme boundaries own the original offsets. Khmer repetition segments
    // can contain inline spacing, so only consecutive graphemes share a unit.
    if (wordLike && activeWord === wordIndex) units[units.length - 1].endOffset = endOffset;
    else if (!ignorable.test(grapheme.segment)) units.push({ startOffset, endOffset });
    else continue;
    activeWord = wordLike ? wordIndex : -1;
  }

  for (const [index, unit] of units.entries()) {
    const previousEnd = units[index - 1]?.endOffset ?? 0;
    const nextStart = units[index + 1]?.startOffset ?? text.length;
    let prefix = ends.get(unit.startOffset);
    while (prefix && prefix.index >= previousEnd && opening.test(prefix.segment) && ignorable.test(prefix.segment)) {
      unit.startOffset = prefix.index;
      prefix = ends.get(unit.startOffset);
    }
    let suffix = starts.get(unit.endOffset);
    while (suffix && suffix.index < nextStart && closing.test(suffix.segment) && ignorable.test(suffix.segment)) {
      unit.endOffset += suffix.segment.length;
      suffix = starts.get(unit.endOffset);
    }
  }
  return units;
}
