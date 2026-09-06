/**
 * Render-only line wrapping shared by the browser preview and ASS renderer.
 * Callers supply a positive integer grapheme limit after resolving their geometry.
 * This never changes stored captions or SRT serialization.
 */
export function wrapCaptionText(text: string, maxGraphemesPerLine: number) {
  const lines = String(text || '').split(/\r?\n/);
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('km', { granularity: 'grapheme' }) : null;
  const output: string[] = [];
  for (const line of lines) {
    const graphemes = segmenter ? Array.from(segmenter.segment(line), (item) => item.segment) : Array.from(line);
    if (graphemes.length <= maxGraphemesPerLine) {
      output.push(line);
      continue;
    }
    let cursor = 0;
    while (cursor < graphemes.length) {
      const hardEnd = Math.min(graphemes.length, cursor + maxGraphemesPerLine);
      let end = hardEnd;
      if (hardEnd < graphemes.length) {
        const floor = cursor + Math.max(1, Math.floor(maxGraphemesPerLine * 0.62));
        for (let index = hardEnd - 1; index >= floor; index -= 1) {
          if (/\s|[។៕៖!?.,:;]/u.test(graphemes[index] || '')) {
            end = index + 1;
            break;
          }
        }
      }
      output.push(graphemes.slice(cursor, end).join('').trim());
      cursor = end;
      while (cursor < graphemes.length && /\s/u.test(graphemes[cursor] || '')) cursor += 1;
    }
  }
  return output.filter(Boolean).join('\n');
}
