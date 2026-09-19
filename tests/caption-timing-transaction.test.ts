import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '@kcs/shared';
import { planCaptionTimingEdit } from '../apps/web/src/caption-timing-transaction.js';

const cues = (): CaptionSegment[] => [
  { id: 'a', text: 'First', startMs: 1000, endMs: 2000, approved: true },
  { id: 'b', text: 'Second', startMs: 2100, endMs: 3000, approved: true },
  { id: 'c', text: 'Third', startMs: 3500, endMs: 4500, approved: true },
];

test('default moves stop at a neighbor without pushing any other caption', () => {
  const captions = cues();
  const result = planCaptionTimingEdit(captions, 'a', 'move', 200, 5000);
  assert.equal(result.after[0].startMs, 1100);
  assert.equal(result.after[0].endMs, 2100);
  assert.deepEqual(result.before.map((item) => item.id), ['a']);
  assert.equal(captions[1].startMs, 2100);
  assert.match(result.limited!, /neighbor/);
  const reverse = planCaptionTimingEdit(captions, 'b', 'move', -200, 5000);
  assert.equal(reverse.after[0].startMs, 2000);
  assert.equal(reverse.after[0].endMs, 2900);
});

test('edge trim stops at a neighbor and explicit overlap permits independent crossing', () => {
  const captions = cues();
  assert.equal(planCaptionTimingEdit(captions, 'a', 'end', 2400, 5000).after[0].endMs, 2100);
  const result = planCaptionTimingEdit(captions, 'a', 'move', 2500, 5000, { allowOverlap: true });
  assert.equal(result.after[0].startMs, 3500);
  assert.equal(result.after[0].endMs, 4500);
  assert.equal(result.after.length, 1);
});

test('shared boundary changes exactly two edges and preserves outer bounds', () => {
  const captions = cues();
  const result = planCaptionTimingEdit(captions, 'a', 'end', 2300, 5000, { sharedBoundary: true });
  assert.deepEqual(result.after.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })), [
    { id: 'a', startMs: 1000, endMs: 2300 }, { id: 'b', startMs: 2300, endMs: 3000 },
  ]);
  assert.equal(result.after.every((item) => item.approved === false), true);
  assert.equal(captions[2].startMs, 3500);
  assert.deepEqual(planCaptionTimingEdit(captions, 'b', 'start', 2300, 5000, { sharedBoundary: true }).after, result.after);
});

test('shared boundary refuses a locked neighbor as one atomic operation', () => {
  const captions = cues();
  captions[1].timingLocked = true;
  const result = planCaptionTimingEdit(captions, 'a', 'end', 2300, 5000, { sharedBoundary: true });
  assert.deepEqual(result.after, []);
  assert.deepEqual(result.before, []);
  assert.match(result.limited!, /locked/);
  assert.equal(captions[0].endMs, 2000);
});

test('existing overlaps can be reduced without an unexpected jump or worsened overlap', () => {
  const captions = cues();
  captions[0].endMs = 2300;
  assert.equal(planCaptionTimingEdit(captions, 'a', 'move', -50, 5000).after[0].endMs, 2250);
  assert.deepEqual(planCaptionTimingEdit(captions, 'a', 'move', 50, 5000).after, []);
  assert.equal(planCaptionTimingEdit(captions, 'b', 'start', 2150, 5000).after[0].startMs, 2150);
});

test('an enclosing earlier caption also prevents creating a worse collision', () => {
  const captions = cues();
  captions[0].endMs = 4000;
  const result = planCaptionTimingEdit(captions, 'c', 'move', -100, 5000);
  assert.deepEqual(result.after, []);
});

test('minimum durations, missing neighbor, invalid values and no-op stay bounded', () => {
  const captions = cues();
  assert.deepEqual(planCaptionTimingEdit(captions, 'a', 'start', 0, 5000, { sharedBoundary: true }).after, []);
  assert.deepEqual(planCaptionTimingEdit(captions, 'a', 'move', NaN, 5000).after, []);
  assert.deepEqual(planCaptionTimingEdit(captions, 'a', 'move', 0, 5000).after, []);
  const clamped = planCaptionTimingEdit(captions, 'b', 'start', 4000, 5000, { sharedBoundary: true });
  assert.equal(clamped.after[1].endMs - clamped.after[1].startMs, 40);
  assert.equal(clamped.after[0].endMs, clamped.after[1].startMs);
});
