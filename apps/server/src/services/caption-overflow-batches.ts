import { captionRenderTime, type CaptionSegment } from '@kcs/shared';

/** Bounds apply to native inspection, independently of the size of the final ASS file. */
export const MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS = 200_000;
export const MAX_CAPTION_OVERFLOW_BATCHES = 8;
export const MAX_CAPTION_OVERFLOW_TOTAL_CHARACTERS = MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS * MAX_CAPTION_OVERFLOW_BATCHES;
export const MAX_CAPTION_OVERFLOW_CAPTIONS = 10_000;
export const MAX_CAPTION_OVERFLOW_CAPTION_CHARACTERS = 4096;

export class CaptionOverflowBatchBudgetError extends Error {}

export interface CaptionOverflowComponent {
  /** Original indices; text composition and overlap layering must keep this order. */
  indices: number[];
  characters: number;
}

export interface CaptionOverflowBatch {
  captions: CaptionSegment[];
  components: CaptionOverflowComponent[];
  characters: number;
}

const overBudget = () => new CaptionOverflowBatchBudgetError('Caption bounds cannot be safely checked within the native batch limits.');

/** A half-open 10ms interval either paints as a whole or is absent from ASS.
 * Packing by raw millisecond edges could separate two cues that really overlap.
 */
export function captionOverflowComponents(captions: readonly CaptionSegment[]): CaptionOverflowComponent[] {
  const intervals = captions.flatMap((caption, index) => {
    const startMs = captionRenderTime(caption.startMs);
    const endMs = captionRenderTime(caption.endMs);
    return caption.text.trim() && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? [{ index, startMs, endMs }] : [];
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.index - b.index);

  const components: CaptionOverflowComponent[] = [];
  let maximumEnd = -Infinity;
  for (const interval of intervals) {
    // Ends are exclusive. An end equal to the next start has no shared paint.
    if (!components.length || interval.startMs >= maximumEnd) {
      components.push({ indices: [], characters: 0 });
      maximumEnd = interval.endMs;
    } else maximumEnd = Math.max(maximumEnd, interval.endMs);
    const component = components[components.length - 1];
    component.indices.push(interval.index);
    component.characters += captions[interval.index].text.length;
  }
  for (const component of components) component.indices.sort((a, b) => a - b);
  return components;
}

/** Restore the source's relative index order, including when the stored list was
 * not sorted chronologically. Source IDs, original clocks and word data survive.
 */
export function captionOverflowBatchFromComponents(
  captions: readonly CaptionSegment[], components: CaptionOverflowComponent[],
): CaptionOverflowBatch {
  const indices = components.flatMap((component) => component.indices).sort((a, b) => a - b);
  return { captions: indices.map((index) => captions[index]), components,
    characters: components.reduce((sum, component) => sum + component.characters, 0) };
}

/** Bound the entire accepted request and the raw instantaneous text load before
 * any native process starts. An individual overlap chain is never divided.
 */
export function planCaptionOverflowBatches(
  captions: CaptionSegment[], maxBatchCharacters = MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS,
): CaptionOverflowBatch[] {
  if (!Number.isInteger(maxBatchCharacters) || maxBatchCharacters < 1 || maxBatchCharacters > MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS
    || captions.length > MAX_CAPTION_OVERFLOW_CAPTIONS) throw overBudget();
  let characters = 0;
  const boundaries: Array<{ at: number; delta: number }> = [];
  for (const caption of captions) {
    if (!caption || typeof caption.text !== 'string' || caption.text.length > MAX_CAPTION_OVERFLOW_CAPTION_CHARACTERS
      || !Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)
      || caption.startMs < 0 || caption.endMs < caption.startMs || caption.endMs > 1_000_000_000) throw overBudget();
    characters += caption.text.length;
    if (characters > MAX_CAPTION_OVERFLOW_TOTAL_CHARACTERS) throw overBudget();
    boundaries.push({ at: caption.startMs, delta: caption.text.length + 1 },
      { at: caption.endMs, delta: -caption.text.length - 1 });
  }
  boundaries.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let overlappingCharacters = 0;
  for (const boundary of boundaries) {
    overlappingCharacters += boundary.delta;
    if (overlappingCharacters > 4096) throw overBudget();
  }
  const components = captionOverflowComponents(captions);
  // Preserve the original single native document whenever its established
  // character limit fits. This also keeps nonpainting cues in the old path.
  if (characters <= maxBatchCharacters) return [{ captions, components, characters }];
  if (!components.length) throw overBudget();

  const batches: CaptionOverflowBatch[] = [];
  let current: CaptionOverflowComponent[] = [];
  let currentCharacters = 0;
  for (const component of components) {
    if (component.characters > maxBatchCharacters) throw overBudget();
    if (current.length && currentCharacters + component.characters > maxBatchCharacters) {
      batches.push(captionOverflowBatchFromComponents(captions, current));
      current = [];
      currentCharacters = 0;
    }
    current.push(component);
    currentCharacters += component.characters;
  }
  if (current.length) batches.push(captionOverflowBatchFromComponents(captions, current));
  if (!batches.length || batches.length > MAX_CAPTION_OVERFLOW_BATCHES) throw overBudget();
  return batches;
}
