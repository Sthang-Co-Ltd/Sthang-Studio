import { createHash } from 'node:crypto';
import type { CaptionProject, CaptionSegment, GroupingPassage, SegmentOptions } from '@kcs/shared';
import { assertRetainedTimingCanBeDerived } from './media-alignment.js';
import { requireTimedTokens, segmentTimedTokens } from './segmenter.js';
import { preserveCaptionLocks } from './caption-locks.js';

export function planGrouping(project: CaptionProject, options: SegmentOptions) {
  assertRetainedTimingCanBeDerived(project);
  const tokens = requireTimedTokens(project.transcript?.tokens);
  return preserveCaptionLocks(project.captions, segmentTimedTokens(tokens, {
    ...options, protectedPhrases: project.transcript?.vocabularyTerms,
  }));
}

export function groupingPassage(project: CaptionProject, proposed: CaptionSegment[], atMs: number, options: SegmentOptions): GroupingPassage {
  const startMs = Math.max(0, Math.round(atMs) - 1000);
  const endMs = startMs + 3000;
  const inPassage = (cues: CaptionSegment[]) => cues.filter(cue => cue.startMs < endMs && cue.endMs > startMs)
    .map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
  const passage = { startMs, endMs, current: inPassage(project.captions), proposed: inPassage(proposed) };
  // Segment IDs are freshly allocated. Bind the visual evidence to the saved
  // revision and exact cue boundaries/wording, independent of those IDs.
  const digest = createHash('sha256').update(JSON.stringify([
    project.id, project.media.filename, project.media.size, project.updatedAt,
    options.mode, options.maxChars, options.maxDurationMs, atMs, passage,
  ])).digest('hex');
  return { ...passage, digest };
}
