export interface WaveformEdgeTarget {
  ownerId: string;
  edge: 'start' | 'end';
  timeMs: number;
  selected?: boolean;
}

export interface WaveformEdgeHit {
  target: WaveformEdgeTarget | null;
  ambiguous: boolean;
}

/** The painted edge is narrow for precision, but the pointer target need not be. */
export function waveformEdgeRadiusPx(pointerType: string) {
  return pointerType === 'touch' ? 22 : pointerType === 'pen' ? 17 : 13;
}

/**
 * Hit-test on the visible time scale, keeping the nearest edge authoritative.
 * An equally near selected edge wins at a shared cut. Otherwise an ambiguous
 * midpoint falls through to ordinary caption/word selection or audio seeking.
 */
export function hitTestWaveformEdges(
  candidates: readonly WaveformEdgeTarget[],
  timeMs: number,
  msPerPixel: number,
  pointerType: string,
): WaveformEdgeHit {
  if (!Number.isFinite(timeMs) || !Number.isFinite(msPerPixel) || msPerPixel <= 0) return { target: null, ambiguous: false };
  const radius = waveformEdgeRadiusPx(pointerType);
  let closest: WaveformEdgeTarget | null = null;
  let distance = Number.POSITIVE_INFINITY;
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.timeMs)) continue;
    const next = Math.abs(candidate.timeMs - timeMs) / msPerPixel;
    if (next > radius) continue;
    if (next < distance - 0.5) {
      closest = candidate;
      distance = next;
      ambiguous = false;
    } else if (Math.abs(next - distance) <= 0.5 && closest) {
      if (candidate.ownerId === closest.ownerId && candidate.edge === closest.edge) continue;
      if (candidate.selected && !closest.selected) {
        closest = candidate;
        distance = next;
        ambiguous = false;
      } else if (!candidate.selected && closest.selected) {
        continue;
      } else {
        ambiguous = true;
      }
    }
  }
  return { target: ambiguous ? null : closest, ambiguous };
}
