/** Exact multiresolution extrema. Partial blocks are always read from original PCM. */
export interface WaveformPeaks {
  samples: Float32Array;
  levels: Array<{ stride: number; min: Float32Array; max: Float32Array }>;
  byteLength: number;
}

export async function buildWaveformPeaks(
  samples: Float32Array,
  cancelled: () => boolean = () => false,
  yieldWork: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<WaveformPeaks | null> {
  const stride = 256;
  const count = Math.ceil(samples.length / stride);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  // Yield before preparation and between bounded chunks; raw drawing remains available.
  for (let batch = 0; batch < count; batch += 256) {
    await yieldWork();
    if (cancelled()) return null;
    for (let block = batch; block < Math.min(count, batch + 256); block += 1) {
      let lo = 0, hi = 0;
      for (let i = block * stride; i < Math.min(samples.length, (block + 1) * stride); i += 1) {
        lo = Math.min(lo, samples[i]); hi = Math.max(hi, samples[i]);
      }
      min[block] = lo; max[block] = hi;
    }
  }
  const levels = [{ stride, min, max }];
  while (levels.at(-1)!.min.length > 1) {
    await yieldWork();
    if (cancelled()) return null;
    const prev = levels.at(-1)!;
    const next = { stride: prev.stride * 2, min: new Float32Array(Math.ceil(prev.min.length / 2)), max: new Float32Array(Math.ceil(prev.max.length / 2)) };
    for (let i = 0; i < next.min.length; i += 1) {
      next.min[i] = Math.min(prev.min[i * 2], prev.min[i * 2 + 1] ?? 0);
      next.max[i] = Math.max(prev.max[i * 2], prev.max[i * 2 + 1] ?? 0);
    }
    levels.push(next);
  }
  if (cancelled()) return null;
  return { samples, levels, byteLength: levels.reduce((bytes, level) => bytes + level.min.byteLength + level.max.byteLength, 0) };
}

export function waveformExtrema(samples: Float32Array, peaks: WaveformPeaks | null, from: number, to: number) {
  let lo = 0, hi = 0;
  let cursor = Math.max(0, Math.floor(from));
  const end = Math.min(samples.length, Math.ceil(to));
  const levels = peaks?.samples === samples ? peaks.levels : [];
  const rawUntil = (limit: number) => {
    while (cursor < limit) {
      lo = Math.min(lo, samples[cursor]); hi = Math.max(hi, samples[cursor]); cursor += 1;
    }
  };
  const stride = levels[0]?.stride;
  if (!stride) rawUntil(end);
  else {
    rawUntil(Math.min(end, Math.ceil(cursor / stride) * stride));
    while (cursor + stride <= end) {
      let level = levels.length - 1;
      while (level > 0 && (cursor % levels[level].stride !== 0 || cursor + levels[level].stride > end)) level -= 1;
      const entry = levels[level];
      const block = cursor / entry.stride;
      lo = Math.min(lo, entry.min[block]); hi = Math.max(hi, entry.max[block]);
      cursor += entry.stride;
    }
    rawUntil(end);
  }
  return { min: lo, max: hi };
}
