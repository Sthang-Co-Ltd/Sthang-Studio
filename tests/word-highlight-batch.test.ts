import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionWordTiming, resolveCaptionWordTiming, type CaptionSegment, type CaptionWordTiming, type TimedToken } from '@kcs/shared';
import type { CaptionWordTimingCandidate } from '../apps/web/src/api.js';
import {
  applyWordHighlightBatch,
  mergePublishedWordHighlightBatch,
  prepareWordHighlightBatch,
  undoWordHighlightBatch,
  type WordHighlightBatchProgress,
} from '../apps/web/src/word-highlight-batch.js';

function caption(id: string, text = 'one two', startMs = 1_000): CaptionSegment {
  return { id, text, startMs, endMs: startMs + 1_000, approved: true };
}

function timingFor(cue: CaptionSegment, options?: { partial?: boolean; collapseGrid?: boolean; overlap?: boolean }): CaptionWordTiming {
  const parts = cue.text.split(' ');
  const tokens: TimedToken[] = parts.map((text, index) => {
    const startMs = options?.collapseGrid && index === 0 ? cue.startMs + 1 : cue.startMs + 100 + index * 300;
    const endMs = options?.collapseGrid && index === 0 ? cue.startMs + 4 : startMs + 180;
    return {
      id: `${cue.id}-w${index}`,
      text,
      startMs: options?.overlap && index === 1 ? cue.startMs + 200 : startMs,
      endMs,
      spaceBefore: index > 0,
      timingSource: options?.partial && index === parts.length - 1 ? 'interpolated' : 'stt',
      ...(options?.partial && index === parts.length - 1 ? { alignmentScore: 0 } : {}),
    };
  });
  const timing = buildCaptionWordTiming(cue, tokens);
  assert.ok(timing);
  return timing;
}

function candidateFor(cue: CaptionSegment, timing = timingFor(cue)): CaptionWordTimingCandidate {
  return { basis: structuredClone(cue), wordTiming: timing };
}

test('prepare skips blank and ready captions, classifies locks, and syncs unresolved cues sequentially', async () => {
  const blank = caption('blank', '\u200B  ');
  const readyBase = caption('ready');
  const ready = { ...readyBase, wordTiming: timingFor(readyBase) };
  const locked = { ...caption('locked'), timingLocked: true };
  const first = caption('first');
  const second = caption('second');
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const progress: WordHighlightBatchProgress[] = [];

  const result = await prepareWordHighlightBatch({
    captions: [blank, ready, locked, first, second],
    signal: new AbortController().signal,
    sync: async (cue) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(cue.id);
      await Promise.resolve();
      active -= 1;
      return candidateFor(cue);
    },
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(maxActive, 1);
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.ready.length, 2);
  assert.deepEqual(result.needsReview, [{ id: 'locked', reason: 'Caption timing is locked.' }]);
  assert.equal(result.canceled, false);
  assert.deepEqual(progress.at(-1), { completed: 3, total: 3, ready: 2, needsReview: 1 });
});

test('prepare keeps partial/grid-unsafe results for review and continues after per-cue failures', async () => {
  const partial = caption('partial');
  const collapsed = caption('collapsed');
  const failed = caption('failed');
  const good = caption('good');
  const result = await prepareWordHighlightBatch({
    captions: [partial, collapsed, failed, good],
    signal: new AbortController().signal,
    sync: async (cue) => {
      if (cue.id === 'failed') throw new Error('secret provider details must not escape');
      if (cue.id === 'partial') return candidateFor(cue, timingFor(cue, { partial: true }));
      if (cue.id === 'collapsed') return candidateFor(cue, timingFor(cue, { collapseGrid: true }));
      return candidateFor(cue);
    },
  });

  assert.deepEqual(result.ready.map((item) => item.basis.id), ['good']);
  assert.deepEqual(result.needsReview, [
    { id: 'partial', reason: 'Word timing still needs review.' },
    { id: 'collapsed', reason: 'Word timing still needs review.' },
    { id: 'failed', reason: 'Word timing could not be prepared.' },
  ]);
  assert.equal(result.completed, 4);
});

test('prepare rejects a stale candidate basis without accepting its word timing', async () => {
  const cue = caption('stale');
  const result = await prepareWordHighlightBatch({
    captions: [cue],
    signal: new AbortController().signal,
    sync: async () => candidateFor({ ...cue, text: 'changed text' }),
  });
  assert.equal(result.ready.length, 0);
  assert.deepEqual(result.needsReview, [{ id: cue.id, reason: 'Caption changed while word timing was prepared.' }]);
});

test('cancellation stops future sync calls and retains prior safe candidates', async () => {
  const first = caption('first');
  const second = caption('second');
  const third = caption('third');
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await prepareWordHighlightBatch({
    captions: [first, second, third],
    signal: controller.signal,
    sync: async (cue) => {
      calls.push(cue.id);
      if (cue.id === 'second') {
        controller.abort();
        throw new DOMException('Canceled', 'AbortError');
      }
      return candidateFor(cue);
    },
  });

  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(result.ready.map((item) => item.basis.id), ['first']);
  assert.equal(result.completed, 1);
  assert.equal(result.total, 3);
  assert.equal(result.canceled, true);
  assert.deepEqual(result.needsReview, []);
});

test('timing busy stops future calls without converting the busy cue or later cues into review failures', async () => {
  const first = caption('first');
  const second = caption('second');
  const third = caption('third');
  const calls: string[] = [];
  const result = await prepareWordHighlightBatch({
    captions: [first, second, third],
    signal: new AbortController().signal,
    sync: async (cue) => {
      calls.push(cue.id);
      if (cue.id === 'second') {
        const error = new Error('Local timing is still busy') as Error & { status: number };
        error.status = 429;
        throw error;
      }
      return candidateFor(cue);
    },
  });

  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(result.ready.map((item) => item.basis.id), ['first']);
  assert.deepEqual(result.needsReview, []);
  assert.equal(result.completed, 1);
  assert.equal(result.total, 3);
  assert.equal(result.canceled, false);
  assert.equal(result.interruptedByBusy, true);
});

test('apply changes only exact ready revisions and rejects locked, stale, partial, overlapping, and duplicate candidates', () => {
  const good = caption('good');
  const locked = { ...caption('locked'), timingLocked: true };
  const stale = caption('stale');
  const partial = caption('partial');
  const overlap = caption('overlap');
  const unrelated = caption('unrelated');
  const candidates = [
    candidateFor(good),
    candidateFor(locked),
    candidateFor({ ...stale, text: 'older text' }),
    candidateFor(partial, timingFor(partial, { partial: true })),
    candidateFor(overlap, timingFor(overlap, { overlap: true })),
    candidateFor(good),
  ];

  const result = applyWordHighlightBatch([good, locked, stale, partial, overlap, unrelated], candidates);
  assert.deepEqual(result.applied.map((item) => item.before.id), ['good']);
  assert.deepEqual(result.staleIds, ['locked', 'stale', 'partial', 'overlap', 'good']);
  assert.equal(result.next[5], unrelated);
  assert.equal(result.next[0].text, good.text);
  assert.equal(result.next[0].startMs, good.startMs);
  assert.equal(result.next[0].endMs, good.endMs);
  assert.equal(result.next[0].approved, false);
  assert.equal(resolveCaptionWordTiming(result.next[0]).state, 'ready');
  assert.equal(good.wordTiming, undefined);
});

test('apply with no candidates is unchanged and undo is atomic across every applied revision', () => {
  const first = caption('first');
  const second = caption('second');
  const unchanged = applyWordHighlightBatch([first, second], []);
  assert.equal(unchanged.next[0], first);
  assert.equal(unchanged.next[1], second);
  assert.deepEqual(unchanged.applied, []);

  const applied = applyWordHighlightBatch([first, second], [candidateFor(first), candidateFor(second)]);
  const undone = undoWordHighlightBatch(applied.next, applied.applied);
  assert.ok(undone);
  assert.equal(undone[0], first);
  assert.equal(undone[1], second);

  const changedAfterApply = applied.next.map((cue) => cue.id === 'second' ? { ...cue, approved: true } : cue);
  assert.equal(undoWordHighlightBatch(changedAfterApply, applied.applied), null);
  assert.equal(changedAfterApply[0], applied.next[0]);
});

test('published batch merge preserves unrelated local edits while adopting server timing for unchanged targets', () => {
  const target = caption('target');
  const unrelated = caption('unrelated');
  const applied = applyWordHighlightBatch([target, unrelated], [candidateFor(target)]);
  const localUnrelated = { ...unrelated, text: 'new local wording', approved: false };
  const local = [target, localUnrelated];
  const published = applied.next;

  const merged = mergePublishedWordHighlightBatch(local, published, applied.applied);
  assert.notEqual(merged, local);
  assert.equal(merged[0].text, target.text);
  assert.deepEqual(merged[0].wordTiming, published[0].wordTiming);
  assert.equal(merged[0].approved, false);
  assert.equal(merged[1], localUnrelated);
  assert.equal(local[0], target);
  assert.equal(target.wordTiming, undefined);
});

test('published batch merge keeps a target that changed locally during the request', () => {
  const target = caption('target');
  const applied = applyWordHighlightBatch([target], [candidateFor(target)]);
  const localChanged = { ...target, text: 'one changed' };
  const local = [localChanged];

  const merged = mergePublishedWordHighlightBatch(local, applied.next, applied.applied);
  assert.equal(merged, local);
  assert.equal(merged[0], localChanged);
  assert.equal(merged[0].wordTiming, undefined);
});

test('published undo merge removes restored word timing and approval when the server omits them', () => {
  const original: CaptionSegment = { id: 'target', text: 'one two', startMs: 1_000, endMs: 2_000 };
  const applied = applyWordHighlightBatch([original], [candidateFor(original)]);
  assert.ok(applied.next[0].wordTiming);
  assert.equal(applied.next[0].approved, false);
  const reverse = applied.applied.map(({ before, after }) => ({ before: after, after: before }));
  const serverRestored = [{ ...original }];

  const merged = mergePublishedWordHighlightBatch(applied.next, serverRestored, reverse);
  assert.notEqual(merged, applied.next);
  assert.equal(Object.prototype.hasOwnProperty.call(merged[0], 'wordTiming'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged[0], 'approved'), false);
  assert.ok(applied.next[0].wordTiming);
  assert.equal(applied.next[0].approved, false);
});
