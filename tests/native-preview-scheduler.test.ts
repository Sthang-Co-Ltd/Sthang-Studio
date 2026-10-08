import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionRenderState } from '@kcs/shared';
import { planNativePreviewBatch } from '../apps/web/src/native-preview-scheduler.js';

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

test('temporal lookahead stops before another caption and pauses do not render an absent current state', () => {
  const timeline: CaptionRenderState[] = [
    ...paints.slice(0, 3),
    { atMs: 300, endMs: 400, key: '', text: '' },
    { atMs: 400, endMs: 500, key: '1', text: 'next', paintKey: '1|word:0' },
  ];
  assert.deepEqual(planNativePreviewBatch(timeline, 0, new Set(['0|word:0']), true)?.states.map((s) => s.paintKey), ['0|word:1', '0|word:2']);
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
