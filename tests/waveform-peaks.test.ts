import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaveformPeaks, waveformExtrema } from '../apps/web/src/audio/peaks.js';

function raw(samples: Float32Array, from: number, to: number) {
  let min = 0, max = 0;
  for (let i = from; i < to; i += 1) { min = Math.min(min, samples[i]); max = Math.max(max, samples[i]); }
  return { min, max };
}

test('peaks preserve exact pixel extrema at arbitrary zoom boundaries, impulses and partial final blocks', async () => {
  let seed = 731;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const length of [0, 1, 255, 256, 257, 8193, 65537]) {
    const samples = Float32Array.from({ length }, () => random() * 2 - 1);
    if (length > 257) { samples[255] = -1; samples[256] = 1; }
    const peaks = (await buildWaveformPeaks(samples, undefined, async () => {}))!;
    assert.ok(peaks.byteLength <= Math.ceil(length / 256) * 16 + 128);
    for (let trial = 0; trial < 1000; trial += 1) {
      const a = Math.floor(random() * (length + 1)), b = Math.floor(random() * (length + 1));
      const from = Math.min(a, b), to = Math.max(a, b);
      assert.deepEqual(waveformExtrema(samples, peaks, from, to), raw(samples, from, to));
    }
    assert.deepEqual(waveformExtrema(samples, peaks, 0, length), raw(samples, 0, length));
  }
});

test('silence, non-finite samples and a different PCM identity use correct extrema', async () => {
  const samples = new Float32Array(1000);
  const peaks = (await buildWaveformPeaks(samples, undefined, async () => {}))!;
  assert.deepEqual(waveformExtrema(samples, peaks, 3, 999), { min: 0, max: 0 });
  const other = samples.slice(); other[500] = 1;
  assert.deepEqual(waveformExtrema(other, peaks, 0, 1000), { min: 0, max: 1 });
  other[510] = NaN;
  const nonfinite = await buildWaveformPeaks(other, undefined, async () => {});
  assert.deepEqual(waveformExtrema(other, nonfinite, 0, 1000), raw(other, 0, 1000));
});

test('cancelled peak preparation stops after the next yield without publishing a partial cache', async () => {
  let yields = 0;
  const result = await buildWaveformPeaks(new Float32Array(200000), () => yields === 2, async () => { yields += 1; });
  assert.equal(yields, 2);
  assert.equal(result, null);
});
