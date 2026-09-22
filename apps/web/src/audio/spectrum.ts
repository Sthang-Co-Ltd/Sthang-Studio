const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function computeSpectrum(samples: Float32Array, columns = 320, bands = 28) {
  const result = new Float32Array(columns * bands);
  const windowSize = 192;
  const usefulBins = Math.min(72, Math.floor(windowSize / 2));
  let maximum = 0;
  for (let x = 0; x < columns; x += 1) {
    const center = Math.floor((x + 0.5) / columns * samples.length);
    const start = clamp(center - Math.floor(windowSize / 2), 0, Math.max(0, samples.length - windowSize));
    for (let band = 0; band < bands; band += 1) {
      const bin = 1 + Math.floor(Math.pow(band / Math.max(1, bands - 1), 1.55) * (usefulBins - 1));
      let re = 0;
      let im = 0;
      for (let n = 0; n < windowSize; n += 1) {
        const sample = samples[start + n] || 0;
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (windowSize - 1));
        const angle = 2 * Math.PI * bin * n / windowSize;
        re += sample * window * Math.cos(angle);
        im -= sample * window * Math.sin(angle);
      }
      const magnitude = Math.log1p(Math.sqrt(re * re + im * im));
      result[x * bands + band] = magnitude;
      maximum = Math.max(maximum, magnitude);
    }
  }
  if (maximum > 0) for (let i = 0; i < result.length; i += 1) result[i] /= maximum;
  return { values: result, columns, bands };
}
