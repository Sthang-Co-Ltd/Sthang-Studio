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
  /** Rise displacement at the 1080px reference height. Omitted when block geometry stays neutral. */
  motionTranslateY1080?: number;
  /** Whole-block Soft Pop scale. Omitted when block geometry stays neutral. */
  motionScale?: number;
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

function cueMotionDurationMs(startMs: number, endMs: number, appearance: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'> | undefined) {
  if (!appearance?.motionPreset || appearance.motionPreset === 'none') return 0;
  // At common 25/30/60fps rates, very short cues may have only one or two encoded
  // frames. Animating from zero opacity can erase every visible frame. Treat cues
  // up to 80ms as instant: full paint at saved geometry for the whole half-open cue.
  if (endMs - startMs <= 80) return 0;
  const requested = Number.isFinite(Number(appearance.motionDurationMs)) ? Number(appearance.motionDurationMs) : DEFAULT_FADE_DURATION_MS;
  const requestedOnGrid = Math.floor(Math.max(0, Math.min(MAX_FADE_DURATION_MS, requested)) / 10) * 10;
  // Round down so neither side can consume more than half of a bounded cue.
  const halfCueOnGrid = Math.floor((endMs - startMs) / 20) * 10;
  return Math.max(0, Math.min(requestedOnGrid, halfCueOnGrid));
}

function cueMotionOpacityLevel(atMs: number, startMs: number, endMs: number, durationMs: number) {
  if (durationMs <= 0) return FADE_LEVEL_MAX;
  const edgeDistance = Math.min(atMs - startMs, endMs - atMs);
  if (edgeDistance >= durationMs) return FADE_LEVEL_MAX;
  if (edgeDistance <= 0) return 0;
  return Math.max(0, Math.min(FADE_LEVEL_MAX, Math.floor(edgeDistance * FADE_LEVEL_MAX / durationMs + 1e-9)));
}

function cueMotionEntranceLevel(atMs: number, startMs: number, durationMs: number) {
  if (durationMs <= 0 || atMs - startMs >= durationMs) return FADE_LEVEL_MAX;
  if (atMs <= startMs) return 0;
  return Math.max(0, Math.min(FADE_LEVEL_MAX, Math.floor((atMs - startMs) * FADE_LEVEL_MAX / durationMs + 1e-9)));
}

interface CaptionMotionTiming {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

function captionMotionTiming(caption: CaptionSegment, index: number, appearance: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'> | undefined): CaptionMotionTiming | null {
  const startMs = captionRenderTime(caption.startMs);
  const endMs = captionRenderTime(caption.endMs);
  if (!caption.text.trim() || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { index, startMs, endMs, durationMs: cueMotionDurationMs(startMs, endMs, appearance) };
}

function blockedMotionEntranceIndices(timings: readonly CaptionMotionTiming[], motionPreset: CaptionAppearance['motionPreset']) {
  const blocked = new Set<number>();
  if (motionPreset !== 'rise' && motionPreset !== 'soft-pop') return blocked;
  const sorted = [...timings].sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  let priorMaxEnd = -Infinity;
  for (let index = 0; index < sorted.length; index += 1) {
    const timing = sorted[index];
    const nextStart = sorted[index + 1]?.startMs ?? Infinity;
    if (timing.durationMs > 0 && (priorMaxEnd > timing.startMs || nextStart < timing.startMs + timing.durationMs)) blocked.add(timing.index);
    priorMaxEnd = Math.max(priorMaxEnd, timing.endMs);
  }
  return blocked;
}

/** Keep enough original cue context for Rise/Soft Pop to make the same entrance-overlap
 * decision after the browser narrows a native preview request. Fade/None need no blockers. */
export function captionMotionContextIndices(
  captions: CaptionSegment[],
  selectedIndices: readonly number[],
  appearance?: Pick<CaptionAppearance, 'motionPreset' | 'motionDurationMs'>,
) {
  const selected = new Set(selectedIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < captions.length));
  if (appearance?.motionPreset !== 'rise' && appearance?.motionPreset !== 'soft-pop') return [...selected].sort((a, b) => a - b);
  const timings = captions.map((caption, index) => captionMotionTiming(caption, index, appearance));
  for (const selectedIndex of [...selected]) {
    const timing = timings[selectedIndex];
    if (!timing || timing.durationMs <= 0) continue;
    const entranceEnd = timing.startMs + timing.durationMs;
    for (const other of timings) {
      if (!other || other.index === selectedIndex) continue;
      if (other.startMs < entranceEnd && other.endMs > timing.startMs) selected.add(other.index);
    }
  }
  return [...selected].sort((a, b) => a - b);
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
  const motionDurations = new Map<number, number>();
  const motionTimings = captions.flatMap((caption, index) => captionMotionTiming(caption, index, appearance) || []);
  const motionTimingByIndex = new Map(motionTimings.map((timing) => [timing.index, timing]));
  const blockedEntrances = blockedMotionEntranceIndices(motionTimings, appearance?.motionPreset);
  captions.forEach((caption, index) => {
    const timing = motionTimingByIndex.get(index);
    if (!timing) return;
    const start = timing.startMs;
    const end = timing.endMs;
    boundary(start).starts.push(index);
    boundary(end).ends.push(index);
    const motionDuration = timing.durationMs;
    if (appearance?.motionPreset && appearance.motionPreset !== 'none') {
      motionDurations.set(index, motionDuration);
      if (motionDuration > 0) {
        // Bound the native state palette to 16 opacity levels. Every transition is
        // snapped to ASS's 10ms clock, and the mirrored exit uses the same levels.
        for (let level = 1; level <= FADE_LEVEL_MAX; level += 1) {
          const threshold = Math.ceil((motionDuration * level / FADE_LEVEL_MAX) / 10) * 10;
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
    const motionPreset = appearance?.motionPreset || 'none';
    const opacityLevels = motionPreset !== 'none'
      ? ids.map((captionIndex) => {
        const timing = motionTimingByIndex.get(captionIndex)!;
        return {
          captionIndex,
          level: cueMotionOpacityLevel(time, timing.startMs, timing.endMs, motionDurations.get(captionIndex) || 0),
        };
      })
      : [];
    const cueOpacities = opacityLevels.map(({ captionIndex, level }) => ({ captionIndex, opacity: level / FADE_LEVEL_MAX }));
    const hasWordPaint = highlightWords && ids.some((id) => readyWords.has(id));
    const hasMotionPaint = motionPreset !== 'none' && ids.length > 0;
    const singleCaptionIndex = ids.length === 1 && !blockedEntrances.has(ids[0]) ? ids[0] : undefined;
    const entranceLevel = singleCaptionIndex === undefined ? FADE_LEVEL_MAX : cueMotionEntranceLevel(
      time,
      motionTimingByIndex.get(singleCaptionIndex)!.startMs,
      motionDurations.get(singleCaptionIndex) || 0,
    );
    const motionTranslateY1080 = motionPreset === 'rise' && singleCaptionIndex !== undefined
      ? Math.round((12 * (FADE_LEVEL_MAX - entranceLevel) / FADE_LEVEL_MAX) * 10) / 10
      : undefined;
    const motionScale = motionPreset === 'soft-pop' && singleCaptionIndex !== undefined
      ? Math.round((0.94 + 0.06 * entranceLevel / FADE_LEVEL_MAX) * 1000) / 1000
      : undefined;
    const motionPaintKey = hasMotionPaint
      ? motionPreset === 'fade'
        ? `fade:${opacityLevels.map(({ captionIndex, level }) => `${captionIndex}:${level}`).join(';')}`
        : `${motionPreset}:${opacityLevels.map(({ captionIndex, level }) => `${captionIndex}:${level}`).join(';')}|geometry:${singleCaptionIndex === undefined ? 'neutral' : entranceLevel}`
      : undefined;
    const paintParts = [
      ...(hasWordPaint ? [activeWordOffsets.map((word) => `${word.captionIndex}:${word.startOffset}-${word.endOffset}`).join(';') || 'base'] : []),
      ...(motionPaintKey ? [motionPaintKey] : []),
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
      ...(hasMotionPaint ? { cueOpacities } : {}),
      ...(motionTranslateY1080 !== undefined ? { motionTranslateY1080 } : {}),
      ...(motionScale !== undefined ? { motionScale } : {}),
    };
  });
}
