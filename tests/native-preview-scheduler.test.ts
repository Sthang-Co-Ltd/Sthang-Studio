import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionRenderState } from '@kcs/shared';
import { captionPreviewPaintKey, captionPreviewStateIndex } from '../apps/web/src/caption-preview-plan.js';
import { planNativePreviewBatch, planNativePreviewCatchup, nativePreviewCatchupTimeoutMs, retainNativePreviewPrefetch } from '../apps/web/src/native-preview-scheduler.js';

const paints: CaptionRenderState[] = Array.from({ length: 9 }, (_, index) => ({
  atMs: index * 100,
  endMs: (index + 1) * 100,
  key: '0',
  paintKey: `0|word:${index}`,
  text: 'ខ្មែរកម្ពុជា',
}));

test('the uncached current spoken word is rendered alone, never behind future native paints', () => {
  const result = planNativePreviewBatch(paints, 0, new Set(), true);
  assert.equal(result?.kind, 'current');
  assert.deepEqual(result?.states.map((paint) => paint.paintKey), ['0|word:0']);
  assert.equal(result?.states[0], paints[0]);
});

test('after the exact current frame is decoded, temporal prefetch is short, bounded and paint-key aware', () => {
  const cached = new Set(['0|word:0', '0|word:2']);
  const planned = planNativePreviewBatch(paints, 0, cached, true);
  assert.equal(planned?.kind, 'prefetch');
  assert.deepEqual(planned?.states.map((paint) => paint.paintKey), ['0|word:1', '0|word:3', '0|word:4', '0|word:5']);
  assert.ok((planned?.states.length ?? 0) <= 4);
  assert.equal(planNativePreviewBatch(paints, 8, new Set(paints.map((item) => item.paintKey!)), true), null);
});

test('temporal lookahead crosses caption and gap boundaries without rendering an absent current state', () => {
  const timeline: CaptionRenderState[] = [
    ...paints.slice(0, 3),
    { atMs: 300, endMs: 400, key: '', text: '' },
    { atMs: 400, endMs: 500, key: '1', text: 'next', paintKey: '1|word:0' },
  ];
  assert.deepEqual(planNativePreviewBatch(timeline, 0, new Set(['0|word:0']), true)?.states.map((s) => s.paintKey), ['0|word:1', '0|word:2', '1|word:0']);
  assert.deepEqual(planNativePreviewBatch(timeline, 3, new Set(), true)?.states.map((s) => s.paintKey), ['1|word:0']);
});

test('static captions retain the established threshold and can batch eight uncached paints', () => {
  const staticStates: CaptionRenderState[] = Array.from({ length: 8 }, (_, i) => ({
    atMs: i * 1000, endMs: (i + 1) * 1000, key: String(i), text: String(i),
  }));
  assert.deepEqual(planNativePreviewBatch(staticStates, 1, new Set(), false)?.states.map((state) => state.key), ['1']);
  assert.equal(planNativePreviewBatch(staticStates, 1, new Set(['1']), false)?.states.length, 6);
  assert.equal(planNativePreviewBatch(staticStates, 5, new Set(['5']), false), null);
});


test('a cached cue tail warms the adjacent cue before its first word becomes current', () => {
  const timeline: CaptionRenderState[] = [
    ...paints.slice(0, 3),
    { atMs: 300, endMs: 400, key: '1', text: 'next', paintKey: '1|word:0' },
    { atMs: 400, endMs: 500, key: '1', text: 'next', paintKey: '1|word:1' },
  ];
  const result = planNativePreviewBatch(timeline, 2, new Set(['0|word:2']), true);
  assert.equal(result?.kind, 'prefetch');
  assert.deepEqual(result?.states.map((state) => state.paintKey), ['1|word:0', '1|word:1']);
});

test('cross-cue temporal lookahead remains bounded to nine states and preserves overlap paint identities', () => {
  const timeline: CaptionRenderState[] = Array.from({ length: 12 }, (_, index) => ({
    atMs: index * 100, endMs: (index + 1) * 100,
    key: index === 1 ? '0,1' : String(index),
    paintKey: index === 1 ? '0,1|overlap' : `${index}|word:0`,
    text: 'caption',
  }));
  const cached = new Set(timeline.slice(0, 9).map((state) => state.paintKey!));
  assert.equal(planNativePreviewBatch(timeline, 0, cached, true), null);
  cached.delete('0,1|overlap');
  const result = planNativePreviewBatch(timeline, 0, cached, true);
  assert.deepEqual(result?.states, [timeline[1]]);
  assert.ok((planNativePreviewBatch(timeline, 0, new Set(['0|word:0']), true)?.states.length ?? 0) <= 4);
});


test('one catch-up prepares a complete native interval after predicted completion', () => {
  const result = planNativePreviewCatchup(paints, 1, new Set(['0|word:0']), 150, 150, 1);
  assert.equal(result?.kind, 'catchup');
  assert.deepEqual(result?.states, [paints[4]]);
  assert.equal(result?.states.length, 1);
  assert.deepEqual(planNativePreviewCatchup(paints, 1, new Set(), 150, 150, 2)?.states, [paints[5]]);
});

test('catch-up preserves cached current pixels and skips cached future pixels', () => {
  const cached = new Set(['0|word:1', '0|word:4']);
  assert.deepEqual(planNativePreviewCatchup(paints, 1, cached, 150, 150, 1)?.states, [paints[5]]);
  assert.deepEqual([...cached], ['0|word:1', '0|word:4'], 'planning preserves both cached paint identities');
  assert.deepEqual(planNativePreviewCatchup(paints, 1, new Set(['0|word:4']), 150, 150, 1)?.states, [paints[5]]);
  assert.equal(planNativePreviewCatchup(paints, 1, new Set(paints.map((state) => state.paintKey!)), 150, 150, 1), null);
});

test('a late 1400 ms current render recovers ahead of cached 1600 ms pixels instead of prefetching an expired word', () => {
  const timeline: CaptionRenderState[] = Array.from({ length: 30 }, (_, index) => ({
    atMs: index * 100, endMs: (index + 1) * 100, key: '0', paintKey: `word:${index}`, text: 'caption',
  }));
  // Rounded post-merge trace: a 1400 ms current paint completes at 1666 ms
  // after about 207 ms, when the 1600 ms paint is already cached.
  const completedAtMs = 1666;
  const renderDurationMs = 207;
  const startedAtMs = completedAtMs - renderDurationMs;
  const cached = new Set([captionPreviewPaintKey(timeline[16])]);
  const lateCurrent = planNativePreviewBatch(timeline, captionPreviewStateIndex(timeline, startedAtMs), cached, true)!;
  assert.equal(lateCurrent.kind, 'current');
  assert.deepEqual(lateCurrent.states, [timeline[14]]);
  assert.ok(lateCurrent.states[0].endMs < completedAtMs);
  cached.add(captionPreviewPaintKey(lateCurrent.states[0]));

  const currentIndex = captionPreviewStateIndex(timeline, completedAtMs);
  assert.equal(currentIndex, 16);
  const ordinaryPrefetch = planNativePreviewBatch(timeline, currentIndex, cached, true)!;
  assert.equal(ordinaryPrefetch.kind, 'prefetch');
  assert.equal(ordinaryPrefetch.states[0], timeline[17]);
  assert.ok(ordinaryPrefetch.states[0].endMs < completedAtMs + renderDurationMs,
    'the ordinary next-word prefetch would expire before another equally slow render finishes');

  const catchup = planNativePreviewCatchup(timeline, currentIndex, cached, completedAtMs, renderDurationMs, 1);
  assert.equal(catchup?.kind, 'catchup');
  assert.deepEqual(catchup?.states, [timeline[19]], 'the one-shot recovery prepares only the complete 1900 ms interval');
  assert.ok(catchup!.states[0].atMs >= completedAtMs + renderDurationMs + 25);
  assert.deepEqual([...cached], ['word:16', 'word:14'], 'the exact current pixels remain cached under their own identity');
});

test('catch-up rejects invalid estimates and work beyond time or state bounds', () => {
  for (const duration of [NaN, Infinity, 0, -1, 1000]) {
    assert.equal(planNativePreviewCatchup(paints, 1, new Set(), 150, duration, 1), null);
  }
  for (const rate of [NaN, Infinity, 0, -1]) {
    assert.equal(planNativePreviewCatchup(paints, 1, new Set(), 150, 150, rate), null);
  }
  assert.equal(planNativePreviewCatchup(paints, 8, new Set(), 850, 150, 1), null);
  const dense = Array.from({ length: 30 }, (_, i) => ({ ...paints[0], atMs: i * 10, endMs: (i + 1) * 10, paintKey: `dense:${i}` }));
  assert.equal(planNativePreviewCatchup(dense, 0, new Set(), 0, 150, 1), null);
  const gap = [paints[0], { atMs: 100, endMs: 2000, key: '', text: '' }, { ...paints[1], atMs: 2000, endMs: 2100 }];
  assert.equal(planNativePreviewCatchup(gap, 0, new Set(), 0, 150, 1), null);
});

test('150 ms renders can prepare an exact future 100 ms word instead of only expired current paints', () => {
  const cached = new Set<string>();
  const initial = planNativePreviewBatch(paints, 0, cached, true)!;
  assert.deepEqual(initial.states, [paints[0]]);
  cached.add(initial.states[0].paintKey!); // completes at 150 ms, after word zero
  const baseline = planNativePreviewBatch(paints, 1, cached, true)!;
  assert.ok(baseline.states[0].endMs <= 300, 'another current-only render expires by its arrival');
  const catchup = planNativePreviewCatchup(paints, 1, cached, 150, 150, 1)!;
  assert.ok(catchup.states[0].atMs >= 300, 'the exact future pixels can be ready before their interval begins');
  assert.equal(catchup.states[0].paintKey, paints[4].paintKey, 'arrival is cached under its own exact future word identity');
});


test('catch-up lifetime is a bounded wall-time deadline adjusted for playback rate', () => {
  assert.equal(nativePreviewCatchupTimeoutMs(400, 150, 1), 350);
  assert.equal(nativePreviewCatchupTimeoutMs(400, 150, 2), 225);
  assert.equal(nativePreviewCatchupTimeoutMs(400, 150, 0.5), 600);
  assert.equal(nativePreviewCatchupTimeoutMs(2000, 150, 1), 1000);
  assert.equal(nativePreviewCatchupTimeoutMs(100, 150, 1), 100);
  assert.equal(nativePreviewCatchupTimeoutMs(400, NaN, 1), 100);
  assert.equal(nativePreviewCatchupTimeoutMs(400, 150, 0), 100);
});


test('useful singleton prefetch survives cached-word and gap transitions until target promotion', () => {
  const timeline: CaptionRenderState[] = [
    ...paints.slice(0, 2),
    { atMs: 200, endMs: 300, key: '', text: '' },
    { atMs: 300, endMs: 400, key: '1', text: 'next', paintKey: '1|word:0' },
  ];
  const cached = new Set(['0|word:0', '0|word:1']);
  const pending = new Set(['1|word:0']);
  assert.equal(retainNativePreviewPrefetch(timeline, 0, cached, pending, 50), true);
  assert.equal(retainNativePreviewPrefetch(timeline, 1, cached, pending, 150), true);
  assert.equal(retainNativePreviewPrefetch(timeline, 2, cached, pending, 250), true);
  // At the target, the component's existing singleton pending-current rule
  // takes over. This helper must never exempt an uncached current paint itself.
  assert.equal(retainNativePreviewPrefetch(timeline, 3, cached, pending, 350), false);
  assert.equal(pending.has(timeline[3].paintKey!), true);
  assert.equal(retainNativePreviewPrefetch(timeline, 1, new Set(['0|word:0']), pending, 150), false);
});

test('prefetch retention rejects expired, out-of-window and multi-paint work', () => {
  const timeline = Array.from({ length: 12 }, (_, index) => ({ ...paints[0], atMs: index * 100, endMs: (index + 1) * 100, paintKey: `word:${index}` }));
  const cached = new Set(['word:0']);
  assert.equal(retainNativePreviewPrefetch(timeline, 0, cached, new Set(['word:9']), 50), false);
  assert.equal(retainNativePreviewPrefetch(timeline, 0, cached, new Set(['word:1', 'word:2']), 50), false);
  assert.equal(retainNativePreviewPrefetch(timeline, -1, cached, new Set(['word:0']), 1200), false);
  assert.equal(retainNativePreviewPrefetch(timeline, 0, cached, new Set(['word:1']), NaN), false);
});


test('catch-up reserves the next full word when predicted completion is at the tail of a word', () => {
  const timeline: CaptionRenderState[] = Array.from({ length: 30 }, (_, index) => ({
    atMs: index * 100, endMs: (index + 1) * 100, key: '0', paintKey: `word:${index}`, text: 'caption',
  }));
  // CI trace: preceding request took about 230 ms. At media 1544 ms, a
  // 25 ms margin predicts 1799 ms. Rendering 1700–1800 leaves only 1 ms to
  // publish; preparing 1800–1900 instead leaves a complete valid interval.
  const result = planNativePreviewCatchup(timeline, 15, new Set(), 1544, 230, 1);
  assert.deepEqual(result?.states, [timeline[18]]);
  assert.ok(result!.states[0].atMs >= 1544 + 230 + 25);
});
