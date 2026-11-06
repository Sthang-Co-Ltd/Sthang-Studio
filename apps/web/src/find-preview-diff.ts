/** Presentation only: the replacement plan remains the source of both strings. */
export interface FindPreviewSpan {
  text: string;
  changed: boolean;
}

export interface FindPreviewDiff {
  before: FindPreviewSpan[];
  after: FindPreviewSpan[];
}

const MAX_TEXT_UNITS = 4000;
const MAX_DIFF_CELLS = 65_536;
let segmenter: Intl.Segmenter | undefined;

function plain(text: string): FindPreviewSpan[] {
  return text ? [{ text, changed: false }] : [];
}

function append(spans: FindPreviewSpan[], text: string, changed: boolean) {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous?.changed === changed) previous.text += text;
  else spans.push({ text, changed });
}

/** A bounded grapheme diff, never a second implementation of replacement rules.
 * Unsupported segmentation or unusually large inputs retain unhighlighted text.
 */
export function findPreviewDiff(before: string, after: string, enabled = true): FindPreviewDiff {
  const fallback = () => ({ before: plain(before), after: plain(after) });
  if (!enabled || before === after || before.length > MAX_TEXT_UNITS || after.length > MAX_TEXT_UNITS
    || typeof Intl.Segmenter !== 'function') return fallback();

  let original: string[];
  let proposed: string[];
  try {
    segmenter ??= new Intl.Segmenter('km', { granularity: 'grapheme' });
    original = Array.from(segmenter.segment(before), (part) => part.segment);
    proposed = Array.from(segmenter.segment(after), (part) => part.segment);
  } catch {
    return fallback();
  }

  let prefix = 0;
  while (prefix < original.length && prefix < proposed.length && original[prefix] === proposed[prefix]) prefix++;
  let originalEnd = original.length;
  let proposedEnd = proposed.length;
  while (originalEnd > prefix && proposedEnd > prefix && original[originalEnd - 1] === proposed[proposedEnd - 1]) {
    originalEnd--; proposedEnd--;
  }
  const rows = originalEnd - prefix;
  const columns = proposedEnd - prefix;
  const width = columns + 1;
  if ((rows + 1) * width > MAX_DIFF_CELLS) return fallback();

  const common = new Uint16Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      common[row * width + column] = original[prefix + row] === proposed[prefix + column]
        ? common[(row + 1) * width + column + 1] + 1
        : Math.max(common[(row + 1) * width + column], common[row * width + column + 1]);
    }
  }

  const result: FindPreviewDiff = { before: [], after: [] };
  const leading = original.slice(0, prefix).join('');
  append(result.before, leading, false); append(result.after, leading, false);
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (original[prefix + row] === proposed[prefix + column]) {
      append(result.before, original[prefix + row], false);
      append(result.after, proposed[prefix + column], false);
      row++; column++;
    } else if (common[(row + 1) * width + column] >= common[row * width + column + 1]) {
      append(result.before, original[prefix + row++], true);
    } else {
      append(result.after, proposed[prefix + column++], true);
    }
  }
  append(result.before, original.slice(prefix + row, originalEnd).join(''), true);
  append(result.after, proposed.slice(prefix + column, proposedEnd).join(''), true);
  const trailing = original.slice(originalEnd).join('');
  append(result.before, trailing, false); append(result.after, trailing, false);
  return result;
}
