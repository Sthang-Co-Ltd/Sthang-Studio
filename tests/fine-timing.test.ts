import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '@kcs/shared';
import {
  MIN_CAPTION_MS,
  editCaptionTiming,
  sameTimingRevision,
  timingFields,
} from '../apps/web/src/timing-edit.js';

function caption(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return {
    id: 'caption-1',
    startMs: 1_000,
    endMs: 2_000,
    text: 'ខ្មែរ AI',
    timingSource: 'stt',
    timingQuality: 'high',
    approved: true,
    ...overrides,
  };
}

test('edge edits clamp to media and minimum-duration bounds without moving the opposite edge', () => {
  const source = caption();

  const startBeforeMedia = editCaptionTiming(source, 'start', -500, 5_000);
  assert.deepEqual(
    { startMs: startBeforeMedia.startMs, endMs: startBeforeMedia.endMs },
    { startMs: 0, endMs: 2_000 },
  );

  const startPastEnd = editCaptionTiming(source, 'start', 9_000, 5_000);
  assert.deepEqual(
    { startMs: startPastEnd.startMs, endMs: startPastEnd.endMs },
    { startMs: 2_000 - MIN_CAPTION_MS, endMs: 2_000 },
  );

  const endBeforeStart = editCaptionTiming(source, 'end', 0, 5_000);
  assert.deepEqual(
    { startMs: endBeforeStart.startMs, endMs: endBeforeStart.endMs },
    { startMs: 1_000, endMs: 1_000 + MIN_CAPTION_MS },
  );

  const endPastMedia = editCaptionTiming(source, 'end', 99_000, 5_000);
  assert.deepEqual(
    { startMs: endPastMedia.startMs, endMs: endPastMedia.endMs },
    { startMs: 1_000, endMs: 5_000 },
  );
});

test('moving a caption preserves duration and clamps the whole interval inside media', () => {
  const source = caption({ startMs: 1_250, endMs: 2_000 });
  const duration = source.endMs - source.startMs;

  const forward = editCaptionTiming(source, 'move', 800, 5_000);
  assert.equal(forward.startMs, 2_050);
  assert.equal(forward.endMs, 2_800);
  assert.equal(forward.endMs - forward.startMs, duration);

  const clampedStart = editCaptionTiming(source, 'move', -99_000, 5_000);
  assert.equal(clampedStart.startMs, 0);
  assert.equal(clampedStart.endMs, duration);

  const clampedEnd = editCaptionTiming(source, 'move', 99_000, 5_000);
  assert.equal(clampedEnd.endMs, 5_000);
  assert.equal(clampedEnd.startMs, 5_000 - duration);
  assert.equal(clampedEnd.endMs - clampedEnd.startMs, duration);
});

test('successful timing edits preserve caption content and locks while marking timing as manual and unapproved', () => {
  const source = caption({ textLocked: true, timingLocked: false, confidence: 0.7 });
  const edited = editCaptionTiming(source, 'end', 2_400, 5_000);

  assert.notEqual(edited, source);
  assert.equal(edited.text, source.text);
  assert.equal(edited.textLocked, true);
  assert.equal(edited.timingLocked, false);
  assert.equal(edited.confidence, source.confidence);
  assert.equal(edited.timingSource, 'manual');
  assert.equal(edited.timingQuality, 'medium');
  assert.equal(edited.approved, false);
});

test('locks, invalid input, invalid source ranges and exact no-ops return the original caption object', () => {
  const source = caption();
  const locked = caption({ timingLocked: true });
  assert.equal(editCaptionTiming(locked, 'end', 2_500, 5_000), locked);
  assert.equal(editCaptionTiming(source, 'start', Number.NaN, 5_000), source);
  assert.equal(editCaptionTiming(source, 'end', 2_500, Number.POSITIVE_INFINITY), source);
  assert.equal(editCaptionTiming(source, 'move', 0, 5_000), source);
  assert.equal(editCaptionTiming(source, 'start', source.startMs, 5_000), source);
  assert.equal(editCaptionTiming(source, 'end', source.endMs, 5_000), source);
  const tooShort = caption({ startMs: 1_000, endMs: 1_020 });
  assert.equal(editCaptionTiming(tooShort, 'move', 50, 5_000), tooShort);
  const tooLong = caption({ startMs: 0, endMs: 6_000 });
  assert.equal(editCaptionTiming(tooLong, 'move', 50, 5_000), tooLong);
  const invalidSource = caption({ startMs: Number.NaN });
  assert.equal(editCaptionTiming(invalidSource, 'start', 500, 5_000), invalidSource);
});

test('timingFields exposes only the transaction fields App is allowed to merge', () => {
  const source = caption({ timingLocked: true, textLocked: true });
  assert.deepEqual(timingFields(source), {
    startMs: 1_000,
    endMs: 2_000,
    timingSource: 'stt',
    timingQuality: 'high',
    approved: true,
    wordTiming: undefined,
  });
  assert.equal('timingLocked' in timingFields(source), false);
  assert.equal('textLocked' in timingFields(source), false);
  assert.equal('text' in timingFields(source), false);
});

test('undo revision guard accepts only the exact timing revision and rejects intervening edits', () => {
  const expected = caption({ textLocked: false, timingLocked: false });
  assert.equal(sameTimingRevision({ ...expected }, expected), true);
  assert.equal(sameTimingRevision(undefined, expected), false);
  assert.equal(sameTimingRevision({ ...expected, id: 'other' }, expected), false);

  const intervening: CaptionSegment[] = [
    { ...expected, text: `${expected.text}!` },
    { ...expected, startMs: expected.startMs + 10 },
    { ...expected, endMs: expected.endMs + 10 },
    { ...expected, timingSource: 'manual' },
    { ...expected, timingQuality: 'medium' },
    { ...expected, approved: false },
    { ...expected, timingLocked: true },
    { ...expected, textLocked: true },
  ];
  for (const current of intervening) assert.equal(sameTimingRevision(current, expected), false);

  // Optional booleans intentionally normalize undefined and false to one revision state.
  const optionalFalse = caption({ approved: undefined, timingLocked: undefined, textLocked: undefined });
  assert.equal(sameTimingRevision({ ...optionalFalse, approved: false, timingLocked: false, textLocked: false }, optionalFalse), true);

  const withWords = caption({
    textLocked: false,
    timingLocked: false,
    wordTiming: { version: 1, text: expected.text, words: [] },
  });
  assert.equal(sameTimingRevision(structuredClone(withWords), withWords), true);
  assert.equal(sameTimingRevision({
    ...withWords,
    wordTiming: {
      ...withWords.wordTiming!,
      words: [{ id: 'changed-word', startOffset: 0, endOffset: 1, startMs: 1_050, endMs: 1_250, source: 'manual' }],
    },
  }, withWords), false);
});
