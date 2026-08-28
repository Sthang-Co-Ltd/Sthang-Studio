import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionSegment, TimedToken } from '@kcs/shared';
import {
  AudioLines,
  LocateFixed,
  Minus,
  Plus,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import { decodeWaveformAudio } from '../audio/wav';

interface WaveformEditorProps {
  projectId: string;
  captions: CaptionSegment[];
  tokens: TimedToken[];
  selectedIds: string[];
  playheadMs: number;
  playbackRate: number;
  initialMode: 'waveform' | 'spectrum';
  initialZoom: number;
  onSeek(ms: number): void;
  onSelect(id: string): void;
  onBoundaryChange(id: string, edge: 'start' | 'end', valueMs: number): void;
  onPlaybackRate(rate: number): void;
  onPreferenceChange(value: { waveformMode?: 'waveform' | 'spectrum'; waveformZoom?: number }): void;
}

interface DragState {
  captionId: string;
  edge: 'start' | 'end';
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function formatMs(value: number) {
  const seconds = Math.max(0, value) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function nearestBoundary(tokens: TimedToken[], value: number) {
  let result = value;
  let distance = Number.POSITIVE_INFINITY;
  for (const token of tokens) {
    for (const candidate of [token.startMs, token.endMs]) {
      const next = Math.abs(candidate - value);
      if (next < distance) { distance = next; result = candidate; }
    }
  }
  return distance <= 220 ? result : value;
}

function computeSpectrum(samples: Float32Array, columns = 320, bands = 28) {
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

type Spectrum = ReturnType<typeof computeSpectrum>;
interface WaveformMemoryEntry {
  samples: Float32Array;
  durationMs: number;
  spectrum: Spectrum | null;
  touchedAt: number;
}

const waveformMemory = new Map<string, WaveformMemoryEntry>();
const maxWaveformMemoryEntries = 4;
const maxWaveformMemoryBytes = 128 * 1024 * 1024;

function waveformIdentity(projectId: string, tokens: TimedToken[]) {
  const first = tokens[0];
  const last = tokens.at(-1);
  return [
    projectId,
    tokens.length,
    first?.id || 'none',
    first?.startMs ?? 0,
    last?.id || 'none',
    last?.endMs ?? 0,
  ].join(':');
}

function trimWaveformMemory(keepKey: string) {
  const entries = [...waveformMemory.entries()]
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
  let keptBytes = 0;
  let keptEntries = 0;
  for (const [key, entry] of entries) {
    const bytes = entry.samples.byteLength + (entry.spectrum?.values.byteLength || 0);
    const isCurrent = key === keepKey;
    const fits = keptEntries < maxWaveformMemoryEntries && keptBytes + bytes <= maxWaveformMemoryBytes;
    if (isCurrent || fits) {
      keptEntries += 1;
      keptBytes += bytes;
    } else {
      waveformMemory.delete(key);
    }
  }
}

function rememberWaveform(key: string, entry: WaveformMemoryEntry) {
  waveformMemory.set(key, { ...entry, touchedAt: Date.now() });
  trimWaveformMemory(key);
}

function recalledWaveform(key: string) {
  const entry = waveformMemory.get(key);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  return entry;
}

export function WaveformEditor({
  projectId,
  captions,
  tokens,
  selectedIds,
  playheadMs,
  playbackRate,
  initialMode,
  initialZoom,
  onSeek,
  onSelect,
  onBoundaryChange,
  onPlaybackRate,
  onPreferenceChange,
}: WaveformEditorProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const samplesRef = useRef<Float32Array | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [width, setWidth] = useState(900);
  const [mode, setMode] = useState<'waveform' | 'spectrum'>(initialMode);
  const [zoom, setZoom] = useState(clamp(initialZoom || 2, 1, 24));
  const [viewStartMs, setViewStartMs] = useState(0);
  const [follow, setFollow] = useState(true);
  const [snap, setSnap] = useState<'word' | 'silence' | 'off'>('word');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [spectrum, setSpectrum] = useState<Spectrum | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const memoryKey = useMemo(() => waveformIdentity(projectId, tokens), [projectId, tokens]);
  const viewDurationMs = durationMs ? durationMs / zoom : 1;
  const viewEndMs = viewStartMs + viewDurationMs;

  useEffect(() => {
    setMode(initialMode);
    setZoom(clamp(initialZoom || 2, 1, 24));
  }, [projectId]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(320, Math.round(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setSpectrum(null);
    setDurationMs(0);
    samplesRef.current = null;

    if (reloadKey === 0) {
      const remembered = recalledWaveform(memoryKey);
      if (remembered) {
        samplesRef.current = remembered.samples;
        setDurationMs(remembered.durationMs);
        setSpectrum(remembered.spectrum);
        setViewStartMs(0);
        setLoading(false);
        return () => { cancelled = true; };
      }
    } else {
      waveformMemory.delete(memoryKey);
    }

    const fetchAndDecode = async (forceRefresh: boolean) => {
      const query = new URLSearchParams({ cacheBust: String(Date.now()) });
      if (forceRefresh) query.set('refresh', '1');
      const response = await fetch(`/api/projects/${projectId}/normalized-audio.wav?${query}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json() as { error?: string };
          detail = body.error ? `: ${body.error}` : '';
        } catch {
          // The response may not be JSON; the status still explains the failure.
        }
        throw new Error(`Waveform audio request failed (${response.status})${detail}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 44) throw new Error('The waveform preview was incomplete.');
      return decodeWaveformAudio(buffer);
    };

    const load = async () => {
      try {
        let decoded: Awaited<ReturnType<typeof fetchAndDecode>>;
        try {
          decoded = await fetchAndDecode(reloadKey > 0);
        } catch (firstError) {
          if (reloadKey > 0) throw firstError;
          console.warn('[waveform] Cached preview failed; rebuilding once.', firstError);
          decoded = await fetchAndDecode(true);
        }
        if (cancelled) return;
        samplesRef.current = decoded.samples;
        setDurationMs(decoded.durationMs);
        setViewStartMs(0);
        setLoading(false);
        rememberWaveform(memoryKey, {
          samples: decoded.samples,
          durationMs: decoded.durationMs,
          spectrum: null,
          touchedAt: Date.now(),
        });
        window.setTimeout(() => {
          if (cancelled) return;
          const computed = computeSpectrum(decoded.samples);
          setSpectrum(computed);
          rememberWaveform(memoryKey, {
            samples: decoded.samples,
            durationMs: decoded.durationMs,
            spectrum: computed,
            touchedAt: Date.now(),
          });
        }, 50);
      } catch (reason) {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : 'Waveform could not load');
          setLoading(false);
        }
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [projectId, memoryKey, reloadKey]);

  useEffect(() => {
    if (!follow || !durationMs) return;
    const left = viewStartMs + viewDurationMs * 0.14;
    const right = viewStartMs + viewDurationMs * 0.86;
    if (playheadMs < left || playheadMs > right) {
      setViewStartMs(clamp(playheadMs - viewDurationMs * 0.4, 0, Math.max(0, durationMs - viewDurationMs)));
    }
  }, [playheadMs, follow, durationMs, viewDurationMs, viewStartMs]);

  const timeToX = (value: number) => (value - viewStartMs) / viewDurationMs * width;
  const xToTime = (value: number) => clamp(viewStartMs + value / width * viewDurationMs, 0, durationMs);

  const nearestSilence = (value: number) => {
    const samples = samplesRef.current;
    if (!samples || !durationMs) return value;
    const centerIndex = Math.round(value / durationMs * samples.length);
    const search = Math.max(1, Math.round(260 / durationMs * samples.length));
    const windowSize = Math.max(8, Math.round(24 / durationMs * samples.length));
    let best = centerIndex;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let index = Math.max(windowSize, centerIndex - search); index < Math.min(samples.length - windowSize, centerIndex + search); index += Math.max(1, Math.floor(windowSize / 3))) {
      let energy = 0;
      for (let i = -windowSize; i <= windowSize; i += 1) energy += Math.abs(samples[index + i] || 0);
      if (energy < bestEnergy) { bestEnergy = energy; best = index; }
    }
    return best / samples.length * durationMs;
  };

  const snapTime = (value: number) => snap === 'word' ? nearestBoundary(tokens, value) : snap === 'silence' ? nearestSilence(value) : value;

  useEffect(() => {
    const target = canvas.current;
    const samples = samplesRef.current;
    if (!target || !samples || !durationMs) return;
    const ratio = window.devicePixelRatio || 1;
    const height = 168;
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#090b0e';
    ctx.fillRect(0, 0, width, height);

    // Time grid.
    const secondsVisible = viewDurationMs / 1000;
    const gridSeconds = secondsVisible > 90 ? 15 : secondsVisible > 40 ? 10 : secondsVisible > 16 ? 5 : secondsVisible > 7 ? 2 : 1;
    const firstGrid = Math.ceil(viewStartMs / 1000 / gridSeconds) * gridSeconds * 1000;
    ctx.font = '9px Inter, sans-serif';
    for (let value = firstGrid; value < viewEndMs; value += gridSeconds * 1000) {
      const x = timeToX(value);
      ctx.strokeStyle = '#20252c';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = '#59616c';
      ctx.fillText(formatMs(value), x + 4, 11);
    }

    if (mode === 'spectrum' && spectrum) {
      const { values, columns, bands } = spectrum;
      for (let x = 0; x < width; x += 2) {
        const time = xToTime(x);
        const col = clamp(Math.floor(time / durationMs * columns), 0, columns - 1);
        for (let band = 0; band < bands; band += 1) {
          const energy = values[col * bands + band];
          if (energy < 0.055) continue;
          const y = 22 + (bands - 1 - band) / bands * 105;
          const alpha = Math.min(0.82, energy * 1.05);
          ctx.fillStyle = `rgba(215,255,79,${alpha})`;
          ctx.fillRect(x, y, 2, Math.ceil(106 / bands) + 1);
        }
      }
    } else {
      const startIndex = Math.floor(viewStartMs / durationMs * samples.length);
      const endIndex = Math.ceil(viewEndMs / durationMs * samples.length);
      const samplesPerPixel = Math.max(1, (endIndex - startIndex) / width);
      const middle = 80;
      ctx.strokeStyle = '#aacf3b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor(startIndex + x * samplesPerPixel);
        const to = Math.min(samples.length, Math.ceil(from + samplesPerPixel));
        let min = 0;
        let max = 0;
        for (let i = from; i < to; i += 1) { min = Math.min(min, samples[i]); max = Math.max(max, samples[i]); }
        ctx.moveTo(x + 0.5, middle + min * 54);
        ctx.lineTo(x + 0.5, middle + max * 54);
      }
      ctx.stroke();
      ctx.strokeStyle = '#2b331b';
      ctx.beginPath(); ctx.moveTo(0, middle + 0.5); ctx.lineTo(width, middle + 0.5); ctx.stroke();
    }

    // Caption blocks and draggable edges.
    for (const caption of captions) {
      if (caption.endMs < viewStartMs || caption.startMs > viewEndMs) continue;
      const x1 = timeToX(caption.startMs);
      const x2 = timeToX(caption.endMs);
      const isSelected = selected.has(caption.id);
      ctx.fillStyle = isSelected ? 'rgba(215,255,79,.15)' : caption.approved ? 'rgba(87,190,132,.08)' : 'rgba(126,138,154,.055)';
      ctx.fillRect(x1, 126, Math.max(2, x2 - x1), 30);
      ctx.strokeStyle = caption.timingLocked ? '#e7b95d' : isSelected ? '#d7ff4f' : '#48505b';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x1 + 0.5, 126.5, Math.max(1, x2 - x1 - 1), 29);
    }

    // Word anchors become readable as zoom increases.
    const showWords = viewDurationMs <= 28_000;
    for (const token of tokens) {
      if (token.endMs < viewStartMs || token.startMs > viewEndMs) continue;
      const x = timeToX(token.startMs);
      ctx.strokeStyle = token.timingSource === 'interpolated' ? '#d56565' : '#697748';
      ctx.beginPath(); ctx.moveTo(x, 112); ctx.lineTo(x, 124); ctx.stroke();
      if (showWords) {
        ctx.fillStyle = token.timingSource === 'interpolated' ? '#d78d8d' : '#a7b58b';
        ctx.font = '9px "Noto Sans Khmer", Inter, sans-serif';
        ctx.fillText(token.text.slice(0, 18), x + 2, 110);
      }
    }

    const playheadX = timeToX(playheadMs);
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#d7ff4f';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, height); ctx.stroke();
      ctx.fillStyle = '#d7ff4f';
      ctx.beginPath(); ctx.moveTo(playheadX - 5, 0); ctx.lineTo(playheadX + 5, 0); ctx.lineTo(playheadX, 7); ctx.closePath(); ctx.fill();
    }
  }, [width, durationMs, mode, spectrum, viewStartMs, viewDurationMs, viewEndMs, captions, tokens, selected, playheadMs]);

  const pointerTime = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return xToTime(clamp(event.clientX - rect.left, 0, rect.width) / rect.width * width);
  };

  const chooseBoundary = (value: number) => {
    let best: { caption: CaptionSegment; edge: 'start' | 'end'; distance: number } | null = null;
    const tolerance = viewDurationMs / width * 10;
    for (const caption of captions) {
      if (caption.timingLocked) continue;
      for (const edge of ['start', 'end'] as const) {
        const distance = Math.abs(caption[edge === 'start' ? 'startMs' : 'endMs'] - value);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { caption, edge, distance };
      }
    }
    return best;
  };

  const updateDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const caption = captions.find((item) => item.id === drag.captionId);
    if (!caption) return;
    const raw = snapTime(pointerTime(event));
    const value = drag.edge === 'start'
      ? clamp(raw, 0, caption.endMs - 40)
      : clamp(raw, caption.startMs + 40, durationMs);
    onBoundaryChange(caption.id, drag.edge, Math.round(value));
  };

  const setZoomValue = (value: number) => {
    const next = clamp(value, 1, 24);
    const previousDuration = durationMs / zoom;
    const center = viewStartMs + previousDuration / 2;
    const nextDuration = durationMs / next;
    setZoom(next);
    setViewStartMs(clamp(center - nextDuration / 2, 0, Math.max(0, durationMs - nextDuration)));
    onPreferenceChange({ waveformZoom: next });
  };

  return <section className="waveform-card" ref={host}>
    <div className="waveform-toolbar">
      <div className="waveform-title"><AudioLines size={17}/><div><strong>Precision timeline</strong><span>Drag caption edges · word anchors stay tied to speech timing</span></div></div>
      <div className="waveform-controls">
        <button className={mode === 'waveform' ? 'selected' : ''} onClick={() => { setMode('waveform'); onPreferenceChange({ waveformMode: 'waveform' }); }} title="Waveform"><AudioLines size={14}/></button>
        <button className={mode === 'spectrum' ? 'selected' : ''} onClick={() => { setMode('spectrum'); onPreferenceChange({ waveformMode: 'spectrum' }); }} title="Spectral view"><ScanLine size={14}/></button>
        <button onClick={() => setZoomValue(zoom / 1.5)} title="Zoom out"><Minus size={14}/></button>
        <span className="zoom-label">{zoom.toFixed(1)}×</span>
        <button onClick={() => setZoomValue(zoom * 1.5)} title="Zoom in"><Plus size={14}/></button>
        <button
          className={follow ? 'selected' : ''}
          onClick={() => setFollow((current) => {
            const next = !current;
            if (next) setViewStartMs(clamp(playheadMs - viewDurationMs * .4, 0, Math.max(0, durationMs - viewDurationMs)));
            return next;
          })}
          title={follow ? 'Pause follow' : 'Follow playhead'}
        ><LocateFixed size={14}/></button>
        <select value={snap} onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setSnap(event.target.value as typeof snap)} title="Boundary snapping">
          <option value="word">Snap: words</option>
          <option value="silence">Snap: silence</option>
          <option value="off">Snap: off</option>
        </select>
        <select value={playbackRate} onChange={(event: React.ChangeEvent<HTMLSelectElement>) => onPlaybackRate(Number(event.target.value))} title="Playback speed">
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
      </div>
    </div>
    <div className={`waveform-canvas-wrap ${drag ? 'dragging' : ''}`}>
      {loading && <div className="waveform-loading">Preparing waveform…</div>}
      {loadError && <div className="waveform-loading error waveform-recovery">
        <strong>Precision timeline could not decode its audio preview.</strong>
        <span>Your video and captions are safe. Rebuild only the waveform preview.</span>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw size={14}/> Rebuild waveform
        </button>
        <small>Still not working? Open System check.</small>
      </div>}
      <canvas
        ref={canvas}
        onPointerDown={(event: React.PointerEvent<HTMLCanvasElement>) => {
          if (!durationMs) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const value = pointerTime(event);
          const boundary = chooseBoundary(value);
          if (boundary) {
            setDrag({ captionId: boundary.caption.id, edge: boundary.edge });
            onSelect(boundary.caption.id);
          } else {
            setFollow(false);
            onSeek(value);
            const caption = captions.find((item) => value >= item.startMs && value < item.endMs);
            if (caption) onSelect(caption.id);
          }
        }}
        onPointerMove={updateDrag}
        onPointerUp={(event: React.PointerEvent<HTMLCanvasElement>) => {
          updateDrag(event);
          setDrag(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => setDrag(null)}
      />
    </div>
    <div className="waveform-navigation">
      <span>{formatMs(viewStartMs)}</span>
      <input
        type="range"
        min="0"
        max={Math.max(0, durationMs - viewDurationMs)}
        step="50"
        value={Math.min(viewStartMs, Math.max(0, durationMs - viewDurationMs))}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setFollow(false); setViewStartMs(Number(event.target.value)); }}
      />
      <span>{formatMs(viewEndMs)}</span>
    </div>
  </section>;
}
