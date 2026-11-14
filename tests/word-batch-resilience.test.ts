import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionWordTiming, resolveCaptionWordTiming, type CaptionSegment } from '@kcs/shared';
import { ApiRequestError } from '../apps/web/src/api.js';
import { applyWordHighlightBatch, prepareWordHighlightBatch } from '../apps/web/src/word-highlight-batch.js';

function cue(index: number): CaptionSegment {
  return { id: `c${index}`, text: 'one two', startMs: index * 1000, endMs: index * 1000 + 900, approved: true };
}
function ready(caption: CaptionSegment) {
  const wordTiming = buildCaptionWordTiming(caption, [
    { id: `${caption.id}-one`, text: 'one', startMs: caption.startMs + 50, endMs: caption.startMs + 350, spaceBefore: false, timingSource: 'stt' },
    { id: `${caption.id}-two`, text: 'two', startMs: caption.startMs + 450, endMs: caption.startMs + 850, spaceBefore: true, timingSource: 'stt' },
  ]);
  assert.ok(wordTiming);
  assert.equal(resolveCaptionWordTiming({ ...caption, wordTiming }).state, 'ready');
  return { basis: structuredClone(caption), wordTiming };
}
const prepare = (captions: CaptionSegment[], sync: Parameters<typeof prepareWordHighlightBatch>[0]['sync'], controller = new AbortController()) =>
  prepareWordHighlightBatch({ captions, sync, signal: controller.signal });

test('an offline first response pauses a 5000-caption pass after one request, without labeling untouched cues as failures', async () => {
  const captions = Array.from({ length: 5000 }, (_, index) => cue(index));
  let requests = 0;
  const result = await prepare(captions, async () => { requests++; throw new TypeError('PRIVATE network details'); });
  assert.equal(requests, 1);
  assert.equal(result.pauseReason, 'connection');
  assert.equal(result.total, 5000);
  assert.equal(result.completed, 0);
  assert.equal(result.canceled, false);
  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.needsReview, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

for (const failure of [
  new ApiRequestError('PRIVATE runtime path', 503, 'WORD_TIMING_UNAVAILABLE'),
  new SyntaxError('PRIVATE invalid service body'),
  new Error('PRIVATE unclassified runtime failure'),
]) test(`a ${failure.name} systemic failure stays distinct from per-cue review and permits a fresh deliberate pass`, async () => {
  const captions = [cue(1), cue(2)]; let requests = 0;
  const failed = await prepare(captions, async () => { requests++; throw failure; });
  assert.equal(requests, 1); assert.equal(failed.completed, 0);
  assert.equal(failed.pauseReason, 'unavailable'); assert.deepEqual(failed.needsReview, []);
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  const recovered = await prepare(captions, async (caption) => { requests++; return ready(caption); });
  assert.equal(recovered.ready.length, 2);
  assert.equal(recovered.pauseReason, undefined);
  assert.equal(requests, 3, 'a new pass occurs only through this explicit call');
});

test('explicit caption input errors continue to the next cue and keep only that cue in review', async () => {
  const captions = [cue(1), cue(2)]; const calls: string[] = [];
  const result = await prepare(captions, async (caption) => {
    calls.push(caption.id);
    if (caption.id === 'c1') throw new ApiRequestError('PRIVATE invalid caption details', 400);
    return ready(caption);
  });
  assert.deepEqual(calls, ['c1', 'c2']);
  assert.equal(result.completed, 2); assert.equal(result.pauseReason, undefined);
  assert.deepEqual(result.needsReview, [{ id: 'c1', reason: 'Word timing could not be prepared.' }]);
  assert.deepEqual(result.ready.map((candidate) => candidate.basis.id), ['c2']);
});

for (const status of [404, 409, 428]) test(`a project precondition ${status} stops later requests while preserving the exact earlier candidates for the caller's ownership decision`, async () => {
  const captions = [cue(1), cue(2), cue(3)]; const original = structuredClone(captions); const calls: string[] = [];
  const result = await prepare(captions, async (caption) => {
    calls.push(caption.id);
    if (caption.id === 'c2') throw new ApiRequestError('Saved source changed.', status);
    return ready(caption);
  });
  assert.deepEqual(calls, ['c1', 'c2']);
  assert.equal(result.pauseReason, 'project-changed'); assert.equal(result.completed, 1);
  assert.deepEqual(result.needsReview, []);
  assert.deepEqual(result.ready.map((candidate) => candidate.basis), [original[0]]);
  assert.deepEqual(captions, original, 'preparation never mutates or applies its input');
});

for (const failure of [
  new ApiRequestError('Timing busy.', 429),
  new ApiRequestError('Project admission is busy.', 409, 'WORD_TIMING_PROJECT_BUSY'),
]) test(`a busy response ${failure.status} pauses without turning later captions into review failures`, async () => {
  let requests = 0;
  const result = await prepare([cue(1), cue(2)], async () => { requests++; throw failure; });
  assert.equal(requests, 1); assert.equal(result.pauseReason, 'busy');
  assert.equal(result.interruptedByBusy, true); assert.equal(result.completed, 0);
  assert.deepEqual(result.needsReview, []);
});

test('safe partial results apply through the existing guard and retry skips the already-ready cue', async () => {
  const captions = [cue(1), cue(2), cue(3)]; const calls: string[] = [];
  const first = await prepare(captions, async (caption) => {
    calls.push(caption.id);
    if (caption.id === 'c2') throw new TypeError('Synthetic connection interruption');
    return ready(caption);
  });
  assert.equal(first.pauseReason, 'connection');
  const applied = applyWordHighlightBatch(captions, first.ready);
  assert.deepEqual(applied.applied.map(({ before }) => before.id), ['c1']);
  assert.equal(applied.next[0].approved, true);
  const second = await prepare(applied.next, async (caption) => { calls.push(caption.id); return ready(caption); });
  assert.deepEqual(calls, ['c1', 'c2', 'c2', 'c3']);
  assert.deepEqual(second.ready.map((candidate) => candidate.basis.id), ['c2', 'c3']);
});

test('a newer edit aborts future preparation without applying an earlier ready candidate or accepting a late result', async () => {
  const controller = new AbortController(); const captions = [cue(1), cue(2), cue(3)];
  const original = structuredClone(captions); const calls: string[] = [];
  const result = await prepare(captions, async (caption) => {
    calls.push(caption.id);
    if (caption.id === 'c2') controller.abort('captions-changed');
    return ready(caption);
  }, controller);
  assert.deepEqual(calls, ['c1', 'c2']);
  assert.equal(result.canceled, true); assert.equal(result.pauseReason, 'edits');
  assert.equal(result.completed, 1);
  assert.deepEqual(result.ready.map((candidate) => candidate.basis), [original[0]]);
  assert.deepEqual(captions, original);
});
