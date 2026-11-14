import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTestWaveformEdges, waveformEdgeRadiusPx, type WaveformEdgeTarget } from '../apps/web/src/components/waveform-hit-targets.js';

const edges: WaveformEdgeTarget[] = [
  { ownerId: 'first', edge: 'start', timeMs: 200, selected: true },
  { ownerId: 'first', edge: 'end', timeMs: 1000, selected: true },
];

test('waveform edge targets expand for pen and touch without moving the precise time anchor', () => {
  assert.deepEqual(['mouse', 'pen', 'touch'].map(waveformEdgeRadiusPx), [13, 17, 22]);
  // At 2 ms/px a pointer 20px from the edge is beyond a mouse hit, but within touch reach.
  assert.equal(hitTestWaveformEdges(edges, 240, 2, 'mouse').target, null);
  assert.deepEqual(hitTestWaveformEdges(edges, 240, 2, 'touch').target, edges[0]);
  assert.deepEqual(hitTestWaveformEdges(edges, 222, 2, 'mouse').target, edges[0]);
  assert.equal(hitTestWaveformEdges(edges, 245, 2, 'touch').target, null);
  assert.equal(hitTestWaveformEdges(edges, 1, 0, 'touch').target, null);
});

test('nearest boundary wins over selected priority, while equal shared cuts prefer the selected cue', () => {
  const shared: WaveformEdgeTarget[] = [
    { ownerId: 'previous', edge: 'end', timeMs: 1000 },
    { ownerId: 'next', edge: 'start', timeMs: 1000, selected: true },
    { ownerId: 'third', edge: 'start', timeMs: 1004 },
  ];
  assert.equal(hitTestWaveformEdges(shared, 1000, 2, 'mouse').target?.ownerId, 'next');
  assert.equal(hitTestWaveformEdges(shared, 1004, 2, 'mouse').target?.ownerId, 'third');
  // With neither shared edge selected, don't guess which neighbor should move.
  assert.deepEqual(hitTestWaveformEdges(shared.map((edge) => ({ ...edge, selected: false })), 1000, 2, 'mouse'), { target: null, ambiguous: true });
});

test('equal word boundaries and a very short caption midpoint never randomly choose a side', () => {
  const words: WaveformEdgeTarget[] = [
    { ownerId: 'one', edge: 'end', timeMs: 500 },
    { ownerId: 'two', edge: 'start', timeMs: 500 },
  ];
  assert.deepEqual(hitTestWaveformEdges(words, 500, 1, 'mouse'), { target: null, ambiguous: true });
  assert.equal(hitTestWaveformEdges(words.map((edge) => ({ ...edge, selected: edge.ownerId === 'two' })), 500, 1, 'mouse').target?.ownerId, 'two');
  const short: WaveformEdgeTarget[] = [
    { ownerId: 'short', edge: 'start', timeMs: 500, selected: true },
    { ownerId: 'short', edge: 'end', timeMs: 516, selected: true },
  ];
  assert.deepEqual(hitTestWaveformEdges(short, 508, 1, 'mouse'), { target: null, ambiguous: true });
});
