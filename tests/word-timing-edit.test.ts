import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionWordTiming, type CaptionSegment, type TimedToken } from '@kcs/shared';
import { changeWordTiming, wordTimingLimits } from '../apps/web/src/word-timing-edit.js';
import { editCaptionTiming } from '../apps/web/src/timing-edit.js';
import { splitCaptionForEditing } from '../apps/web/src/caption-word-structure.js';

function cue(): CaptionSegment {
  const caption: CaptionSegment = { id: 'phrase', text: 'I love you very much', startMs: 1000, endMs: 4000, approved: true };
  const tokens: TimedToken[] = caption.text.split(' ').map((text, index) => ({ id: `w${index}`, text, startMs: 1000 + index * 500, endMs: 1300 + index * 500, spaceBefore: index > 0, timingSource: 'stt' }));
  return { ...caption, wordTiming: buildCaptionWordTiming(caption, tokens) };
}

test('moving an individual word keeps caption edges and every other word untouched', () => {
  const before = cue();
  const after = changeWordTiming(before, 'w3', 'move', -100);
  assert.equal(after.startMs, before.startMs);
  assert.equal(after.endMs, before.endMs);
  assert.equal(after.text, before.text);
  assert.equal(after.wordTiming!.words[3].startMs, 2400);
  assert.equal(after.wordTiming!.words[3].endMs, 2700);
  assert.deepEqual(after.wordTiming!.words.filter((word) => word.id !== 'w3'), before.wordTiming!.words.filter((word) => word.id !== 'w3'));
  assert.equal(after.approved, false);
});

test('word moves and trims stop at neighboring words and cue bounds', () => {
  const before = cue();
  assert.equal(changeWordTiming(before, 'w3', 'move', -1000).wordTiming!.words[3].startMs, 2300);
  assert.equal(changeWordTiming(before, 'w3', 'move', 1000).wordTiming!.words[3].endMs, 3000);
  assert.equal(changeWordTiming(before, 'w0', 'start', -1000).wordTiming!.words[0].startMs, 1000);
  assert.equal(changeWordTiming(before, 'w3', 'end', 2500).wordTiming!.words[3].endMs, 2510);
});

test('unassigned, locked and nonfinite word movement is a no-op', () => {
  const before = cue();
  before.wordTiming!.words[3] = { ...before.wordTiming!.words[3], startMs: null, endMs: null, needsReview: true };
  assert.equal(changeWordTiming(before, 'w3', 'move', 50), before);
  const locked = { ...cue(), timingLocked: true };
  assert.equal(changeWordTiming(locked, 'w3', 'move', 50), locked);
  assert.equal(changeWordTiming(locked, 'w3', 'move', NaN), locked);
});

for (const [label, startMs, endMs] of [
  ['before', 1300, 2300],
  ['after', 3050, 4100],
  ['across', 1800, 3500],
] as const) {
  for (const kind of ['move', 'start', 'end'] as const) {
    test(`${kind} repairs a word stranded ${label} its available interval`, () => {
      const before = cue();
      before.wordTiming!.words[3] = { ...before.wordTiming!.words[3], startMs, endMs, needsReview: true };
      const after = changeWordTiming(before, 'w3', kind, kind === 'move' ? 100 : 2600);
      assert.notEqual(after, before);
      const edited = after.wordTiming!.words[3];
      assert.ok(edited.startMs! >= 2300);
      assert.ok(edited.endMs! <= 3000);
      assert.ok(edited.endMs! - edited.startMs! >= 10);
      assert.equal(edited.source, 'manual');
      assert.notEqual(edited.needsReview, true);
      assert.deepEqual(after.wordTiming!.words.filter((word) => word.id !== 'w3'), before.wordTiming!.words.filter((word) => word.id !== 'w3'));
      assert.deepEqual([after.startMs, after.endMs, after.text], [before.startMs, before.endMs, before.text]);
    });
  }
}

test('moving a stranded word preserves its duration when it fits and never invents room', () => {
  const before = cue();
  before.wordTiming!.words[3] = { ...before.wordTiming!.words[3], startMs: 1900, endMs: 2100, needsReview: true };
  const moved = changeWordTiming(before, 'w3', 'move', 50);
  assert.equal(moved.wordTiming!.words[3].startMs, 2300);
  assert.equal(moved.wordTiming!.words[3].endMs, 2500);
  before.wordTiming!.words[2].endMs = 3000;
  for (const kind of ['move', 'start', 'end'] as const) assert.equal(changeWordTiming(before, 'w3', kind, 2600), before);
  before.timingLocked = true;
  before.wordTiming!.words[2].endMs = 2300;
  for (const kind of ['move', 'start', 'end'] as const) assert.equal(changeWordTiming(before, 'w3', kind, 2600), before);
});

test('whole cue movement translates owned word times once and an edge trim never stretches them', () => {
  const before = cue();
  const moved = editCaptionTiming(before, 'move', 100, 10000);
  moved.wordTiming!.words.forEach((word, index) => {
    assert.equal(word.startMs, before.wordTiming!.words[index].startMs! + 100);
    assert.equal(word.endMs, before.wordTiming!.words[index].endMs! + 100);
  });
  const trimmed = editCaptionTiming(before, 'start', 1100, 10000);
  assert.equal(trimmed.wordTiming!.words[0].startMs, 1000);
  assert.equal(trimmed.wordTiming!.words[0].needsReview, true);
});

test('manual bounds use an interior timing-grid point and splits keep the cue minimum duration', () => {
  const before = cue();
  before.wordTiming!.words[2].endMs = 2301;
  before.wordTiming!.words[4].startMs = 2999;
  assert.equal(wordTimingLimits(before, 'w3').min, 2310);
  assert.equal(wordTimingLimits(before, 'w3').max, 2990);
  assert.equal(splitCaptionForEditing({ id: 'short', text: 'one two', startMs: 0, endMs: 79 }, 'a', 'b'), null);
  const result = splitCaptionForEditing({ id: 'short', text: 'one two', startMs: 0, endMs: 80 }, 'a', 'b');
  assert.ok(result);
  assert.equal(result[0].endMs, 40);
  assert.equal(result[1].startMs, 40);
});
