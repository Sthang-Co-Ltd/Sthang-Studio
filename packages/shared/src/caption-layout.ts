import type { CaptionSegment } from './index.js';
import type { CaptionAppearance } from './caption-settings.js';
import { captionRenderTime } from './caption-settings.js';
import { resolveCaptionWordTiming } from './word-timing.js';

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
  /** Paint-only identity. Caption key remains the comma-separated active cue indices. */
  paintKey?: string;
  /** Ready spoken words active during this paint interval, expressed in caption UTF-16 offsets. */
  activeWordOffsets?: CaptionRenderWordOffset[];
  /** Per-cue whole-caption opacity for bounded temporal paint. Geometry remains keyed by `key`. */
  cueOpacities?: CaptionRenderCueOpacity[];
}

export interface CaptionRenderWordOffset {
  captionIndex: number;
  startOffset: number;
  endOffset: number;
}

export interface CaptionRenderCueOpacity {
  captionIndex: number;
  opacity: number;
}

const FADE_LEVEL_MAX = 15;
const DEFAULT_FADE_DURATION_MS = 160;
const MAX_FADE_DURATION_MS = 400;

function cueFadeDurationMs(startMs: number, endMs: number, appearance: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'> | undefined) {
  if (appearance?.motionPreset !== 'fade') return 0;
  const requested = Number.isFinite(Number(appearance.motionDurationMs)) ? Number(appearance.motionDurationMs) : DEFAULT_FADE_DURATION_MS;
  const requestedOnGrid = Math.floor(Math.max(0, Math.min(MAX_FADE_DURATION_MS, requested)) / 10) * 10;
  // Round down so neither side can consume more than half of a short cue. A 10ms
  // cue therefore stays static; 20-40ms cues still get a full-opacity interval.
  const halfCueOnGrid = Math.floor((endMs - startMs) / 20) * 10;
  return Math.max(0, Math.min(requestedOnGrid, halfCueOnGrid));
}

function cueFadeLevel(atMs: number, startMs: number, endMs: number, durationMs: number) {
  if (durationMs <= 0) return FADE_LEVEL_MAX;
  const edgeDistance = Math.min(atMs - startMs, endMs - atMs);
  if (edgeDistance >= durationMs) return FADE_LEVEL_MAX;
  if (edgeDistance <= 0) return 0;
  return Math.max(0, Math.min(FADE_LEVEL_MAX, Math.floor(edgeDistance * FADE_LEVEL_MAX / durationMs + 1e-9)));
}

/** Sweep caption/word/effect boundaries once, not the entire project at every playback frame. */
export function planCaptionRenderStates(
  captions: CaptionSegment[],
  highlightWords = false,
  appearance?: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'>,
): CaptionRenderState[] {
  const events = new Map<number, { starts: number[]; ends: number[] }>();
  const boundary = (time: number) => {
    let value = events.get(time);
    if (!value) { value = { starts: [], ends: [] }; events.set(time, value); }
    return value;
  };
  const readyWords = new Map<number, Array<CaptionRenderWordOffset & { startMs: number; endMs: number }>>();
  const fadeDurations = new Map<number, number>();
  captions.forEach((caption, index) => {
    const start = captionRenderTime(caption.startMs);
    const end = captionRenderTime(caption.endMs);
    if (!caption.text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    boundary(start).starts.push(index);
    boundary(end).ends.push(index);
    const fadeDuration = cueFadeDurationMs(start, end, appearance);
    if (appearance?.motionPreset === 'fade') {
      fadeDurations.set(index, fadeDuration);
      if (fadeDuration > 0) {
        // Bound the native state palette to 16 opacity levels. Every transition is
        // snapped to ASS's 10ms clock, and the mirrored exit uses the same levels.
        for (let level = 1; level <= FADE_LEVEL_MAX; level += 1) {
          const threshold = Math.ceil((fadeDuration * level / FADE_LEVEL_MAX) / 10) * 10;
          const fadeInAt = start + threshold;
          const fadeOutAt = end - threshold + 10;
          if (fadeInAt > start && fadeInAt < end) boundary(fadeInAt);
          if (fadeOutAt > start && fadeOutAt < end) boundary(fadeOutAt);
        }
      }
    }
    if (!highlightWords) return;
    const resolved = resolveCaptionWordTiming(caption);
    if (resolved.state !== 'ready') return;
    const words = resolved.words.flatMap((word) => {
      const wordStart = Math.max(start, captionRenderTime(word.startMs!));
      const wordEnd = Math.min(end, captionRenderTime(word.endMs!));
      if (wordEnd <= wordStart) return [];
      boundary(wordStart);
      boundary(wordEnd);
      return [{
        captionIndex: index,
        startOffset: word.startOffset,
        endOffset: word.endOffset,
        startMs: wordStart,
        endMs: wordEnd,
      }];
    });
    if (words.length) readyWords.set(index, words);
  });
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Set<number>();
  return times.slice(0, -1).map((time, index) => {
    const event = events.get(time)!;
    event.ends.forEach((id) => active.delete(id));
    event.starts.forEach((id) => active.add(id));
    const ids = [...active].sort((a, b) => a - b);
    const key = ids.join(',');
    const activeWordOffsets = highlightWords
      ? ids.flatMap((captionIndex) => readyWords.get(captionIndex)?.filter((word) => time >= word.startMs && time < word.endMs).map(({ startMs: _startMs, endMs: _endMs, ...word }) => word) || [])
      : [];
    const opacityLevels = appearance?.motionPreset === 'fade'
      ? ids.map((captionIndex) => {
        const caption = captions[captionIndex];
        const startMs = captionRenderTime(caption.startMs);
        const endMs = captionRenderTime(caption.endMs);
        return {
          captionIndex,
          level: cueFadeLevel(time, startMs, endMs, fadeDurations.get(captionIndex) || 0),
        };
      })
      : [];
    const cueOpacities = opacityLevels.map(({ captionIndex, level }) => ({ captionIndex, opacity: level / FADE_LEVEL_MAX }));
    const hasWordPaint = highlightWords && ids.some((id) => readyWords.has(id));
    const hasFadePaint = appearance?.motionPreset === 'fade' && ids.length > 0;
    const paintParts = [
      ...(hasWordPaint ? [activeWordOffsets.map((word) => `${word.captionIndex}:${word.startOffset}-${word.endOffset}`).join(';') || 'base'] : []),
      ...(hasFadePaint ? [`fade:${opacityLevels.map(({ captionIndex, level }) => `${captionIndex}:${level}`).join(';')}`] : []),
    ];
    return {
      atMs: time,
      endMs: times[index + 1],
      key,
      text: ids.map((id) => captions[id].text).join('\n'),
      ...(paintParts.length ? { paintKey: `${key}|${paintParts.join('|')}` } : {}),
      ...(hasWordPaint ? {
        activeWordOffsets,
      } : {}),
      ...(hasFadePaint ? { cueOpacities } : {}),
    };
  });
}
