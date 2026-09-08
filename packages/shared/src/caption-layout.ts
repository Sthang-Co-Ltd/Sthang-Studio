import type { CaptionSegment } from './index.js';
import { captionRenderTime } from './caption-settings.js';

/**
 * Render-only line wrapping for the native preview and video renderer.
 * Callers supply a positive integer grapheme limit after resolving their geometry.
 * This never changes stored captions or SRT serialization.
 */
export function wrapCaptionText(text: string, maxGraphemesPerLine: number) {
  const lines = String(text || '').split(/\r?\n/);
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('km', { granularity: 'grapheme' }) : null;
  const graphemesFor = (value: string) => segmenter ? Array.from(segmenter.segment(value), (item) => item.segment) : Array.from(value);
  const hardWrap = (value: string) => {
    const graphemes = graphemesFor(value);
    if (graphemes.length <= maxGraphemesPerLine) return value;
    const chunks: string[] = [];
    for (let cursor = 0; cursor < graphemes.length; cursor += maxGraphemesPerLine) {
      chunks.push(graphemes.slice(cursor, cursor + maxGraphemesPerLine).join(''));
    }
    return chunks.join('\n');
  };
  const output: string[] = [];
  for (const line of lines) {
    const graphemes = graphemesFor(line);
    if (graphemes.length <= maxGraphemesPerLine) {
      output.push(line);
      continue;
    }
    // Keep ordinary word-spaced captions intact so libass can measure the real
    // glyph widths and keep them on one line when they fit. Only an individual
    // unbroken run needs a render-only hard wrap.
    if (/\s/u.test(line)) {
      output.push(line.split(/(\s+)/u).map((part) => /\s/u.test(part) ? part : hardWrap(part)).join(''));
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

export interface CaptionRenderState {
  atMs: number;
  endMs: number;
  key: string;
  text: string;
}

/** Sweep caption boundaries once, not the entire project at every playback frame. */
export function planCaptionRenderStates(captions: CaptionSegment[]): CaptionRenderState[] {
  const events = new Map<number, { starts: number[]; ends: number[] }>();
  const boundary = (time: number) => {
    let value = events.get(time);
    if (!value) { value = { starts: [], ends: [] }; events.set(time, value); }
    return value;
  };
  captions.forEach((caption, index) => {
    const start = captionRenderTime(caption.startMs);
    const end = captionRenderTime(caption.endMs);
    if (!caption.text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    boundary(start).starts.push(index);
    boundary(end).ends.push(index);
  });
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Set<number>();
  return times.slice(0, -1).map((time, index) => {
    const event = events.get(time)!;
    event.ends.forEach((id) => active.delete(id));
    event.starts.forEach((id) => active.add(id));
    const ids = [...active].sort((a, b) => a - b);
    return { atMs: time, endMs: times[index + 1], key: ids.join(','), text: ids.map((id) => captions[id].text).join('\n') };
  });
}
