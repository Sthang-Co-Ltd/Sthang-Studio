import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionSegment, TimedToken } from '@kcs/shared';
import { resolveCaptionWordTiming } from '@kcs/shared';
import {
  AudioLines,
  LocateFixed,
  Minus,
  Plus,
  RefreshCw,
  ScanLine,
  ChevronLeft,
  ChevronRight,
  Play,
  Square,
  Undo2,
  Redo2,
} from 'lucide-react';
import { decodeWaveformAudio } from '../audio/wav';
import { buildWaveformPeaks, waveformExtrema, type WaveformPeaks } from '../audio/peaks';
import { TimestampInput } from './TimestampInput';
import { focusedTimingViewport, sameTimingRevision, timingPreviewWindow, type TimingEditKind } from '../timing-edit';
import { captionNeighborLimits, planCaptionTimingEdit, type CaptionTimingOptions, type CaptionTimingTransaction } from '../caption-timing-transaction';
import type { TimingPlaybackRange } from '../timing-playback';
import { WordTimingPanel, type WordTimingCandidate } from './WordTimingPanel';
import { changeWordTiming } from '../word-timing-edit';
import './waveform-editor.css';

interface WaveformEditorProps {
  projectId: string;
  mediaIdentity: string;
  mediaDurationMs?: number;
  captions: CaptionSegment[];
  tokens: TimedToken[];
  selectedIds: string[];
  playheadMs: number;
  playbackRate: number;
  initialMode: 'waveform' | 'spectrum';
  initialZoom: number;
  initialEditMode?: 'caption' | 'words';
  onSyncWords(caption: CaptionSegment, signal?: AbortSignal): Promise<WordTimingCandidate | null>;
  syncDisabled: boolean;
  highlightEnabled: boolean;
  onOpenAppearance(): void;
  onEditCaptionText(): void;
  onWordPreview(basis: CaptionSegment, preview: CaptionSegment | null): void;
  onSeek(ms: number): void;
  onSelect(id: string): void;
  onTimingChange(before: CaptionSegment[], after: CaptionSegment[]): boolean;
  onPreview(range: TimingPlaybackRange): void;
  onStopPreview(): void;
  onNotice(message: string): void;
  onPlaybackRate(rate: number): void;
  onPreferenceChange(value: { waveformMode?: 'waveform' | 'spectrum'; waveformZoom?: number }): void;
}

interface DragState {
  captionId: string;
  edge: TimingEditKind;
  before: CaptionSegment;
  basis: CaptionSegment[];
  options: CaptionTimingOptions;
  originMs: number;
  originX: number;
  pointerId: number;
  wordId?: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function formatMs(value: number) {
  const seconds = Math.max(0, value) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

function nearestBoundary(tokens: TimedToken[], value: number, edge: TimingEditKind) {
  let result = value;
  let distance = Number.POSITIVE_INFINITY;
  for (const token of tokens) {
    const candidate = edge === 'end' ? token.endMs : token.startMs;
    const next = Math.abs(candidate - value);
    if (next < distance) { distance = next; result = candidate; }
  }
  return distance <= 220 ? result : value;
}

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

type Spectrum = ReturnType<typeof computeSpectrum>;
interface WaveformMemoryEntry {
  samples: Float32Array;
  durationMs: number;
  spectrum: Spectrum | null;
  peaks?: WaveformPeaks | null;
  touchedAt: number;
}

const waveformMemory = new Map<string, WaveformMemoryEntry>();
const maxWaveformMemoryEntries = 4;
const maxWaveformMemoryBytes = 128 * 1024 * 1024;

function waveformIdentity(projectId: string, mediaIdentity: string, tokens: TimedToken[]) {
  const first = tokens[0];
  const last = tokens.at(-1);
  return JSON.stringify([
    projectId,
    mediaIdentity,
    tokens.length,
    first?.id || 'none',
    first?.startMs ?? 0,
    last?.id || 'none',
    last?.endMs ?? 0,
  ]);
}

function entryBytes(entry: WaveformMemoryEntry) {
  return entry.samples.byteLength + (entry.spectrum?.values.byteLength || 0) + (entry.peaks?.byteLength || 0);
}

function trimWaveformMemory(keepKey: string) {
  const entries = [...waveformMemory.entries()]
    .sort((a, b) => a[0] === keepKey ? -1 : b[0] === keepKey ? 1 : b[1].touchedAt - a[1].touchedAt);
  let keptBytes = 0;
  let keptEntries = 0;
  for (const [key, entry] of entries) {
    const bytes = entryBytes(entry);
    const isCurrent = key === keepKey;
    const fits = keptEntries < maxWaveformMemoryEntries && keptBytes + bytes <= maxWaveformMemoryBytes;
    if ((isCurrent && bytes <= maxWaveformMemoryBytes) || fits) {
      keptEntries += 1;
      keptBytes += bytes;
    } else {
      waveformMemory.delete(key);
    }
  }
}

function rememberWaveform(key: string, entry: WaveformMemoryEntry) {
  if (entryBytes(entry) > maxWaveformMemoryBytes) {
    waveformMemory.delete(key);
    return;
  }
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
  mediaIdentity,
  mediaDurationMs,
  captions,
  tokens,
  selectedIds,
  playheadMs,
  playbackRate,
  initialMode,
  initialZoom,
  initialEditMode = 'caption',
  onSyncWords,
  syncDisabled,
  highlightEnabled,
  onOpenAppearance,
  onEditCaptionText,
  onWordPreview,
  onSeek,
  onSelect,
  onTimingChange,
  onPreview,
  onStopPreview,
  onNotice,
  onPlaybackRate,
  onPreferenceChange,
}: WaveformEditorProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const playheadCanvas = useRef<HTMLCanvasElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const samplesRef = useRef<Float32Array | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [width, setWidth] = useState(900);
  const [mode, setMode] = useState<'waveform' | 'spectrum'>(initialMode);
  const [zoom, setZoom] = useState(clamp(initialZoom || 2, 1, 24));
  const [viewStartMs, setViewStartMs] = useState(0);
  const [follow, setFollow] = useState(true);
  const [snap, setSnap] = useState<'word' | 'silence' | 'off'>(tokens.length ? 'word' : 'off');
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<CaptionSegment[] | null>(null);
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [sharedBoundary, setSharedBoundary] = useState(false);
  const [editMode, setEditMode] = useState<'caption' | 'words'>(initialEditMode);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [wordCandidate, setWordCandidate] = useState<{ basis: CaptionSegment; preview: CaptionSegment } | null>(null);
  const [showReferenceWords, setShowReferenceWords] = useState(false);
  const [stepMs, setStepMs] = useState(50);
  const [loop, setLoop] = useState(false);
  const history = useRef<{ undo: CaptionTimingTransaction[]; redo: CaptionTimingTransaction[] }>({ undo: [], redo: [] });
  const [, setHistoryRevision] = useState(0);
  const focusIdentity = useRef('');
  const [spectrum, setSpectrum] = useState<Spectrum | null>(null);
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const memoryKey = useMemo(() => waveformIdentity(projectId, mediaIdentity, tokens), [projectId, mediaIdentity, tokens]);
  const captionIndex = captions.findIndex((caption) => caption.id === selectedIds[0]);
  const selectedCaption = captions[captionIndex];
  const validCandidate = wordCandidate && sameTimingRevision(selectedCaption, wordCandidate.basis) ? wordCandidate.preview : null;
  const currentCaption = dragPreview?.find((caption) => caption.id === selectedCaption?.id) || validCandidate || selectedCaption;
  const drawnCaptions = useMemo(() => dragPreview ? captions.map((caption) => dragPreview.find((preview) => preview.id === caption.id) || caption) : captions, [captions, dragPreview]);
  const maxZoom = Math.max(24, durationMs / 500);
  const viewDurationMs = durationMs ? durationMs / zoom : 1;
  const viewEndMs = viewStartMs + viewDurationMs;
  const editLimitMs = mediaDurationMs && Number.isFinite(mediaDurationMs)
    ? (durationMs ? Math.min(durationMs, mediaDurationMs) : mediaDurationMs) : durationMs;
  const editingDisabled = !selectedCaption || Boolean(selectedCaption.timingLocked) || !editLimitMs;
  const wordResolution = useMemo(() => currentCaption ? resolveCaptionWordTiming(currentCaption) : null, [currentCaption]);
  const editableWords = wordResolution?.state === 'stale' ? [] : wordResolution?.words || [];
  const selectedWord = editableWords.find((word) => word.id === selectedWordId) || editableWords[0];
  const neighbourLimits = captionNeighborLimits(captions, selectedCaption?.id || '', editLimitMs);
  const edgeBounds = (edge: 'start' | 'end') => {
    if (!currentCaption) return { min: 0, max: editLimitMs, blocked: true };
    if (sharedBoundary) {
      const other = edge === 'start' ? neighbourLimits.previous : neighbourLimits.next;
      return {
        min: edge === 'start' ? (other?.startMs ?? 0) + 40 : currentCaption.startMs + 40,
        max: edge === 'start' ? currentCaption.endMs - 40 : (other?.endMs ?? editLimitMs) - 40,
        blocked: !other || Boolean(other.timingLocked),
      };
    }
    return {
      min: edge === 'start' ? allowOverlap ? 0 : neighbourLimits.lower : currentCaption.startMs + 40,
      max: edge === 'start' ? currentCaption.endMs - 40 : allowOverlap ? editLimitMs : neighbourLimits.upper,
      blocked: false,
    };
  };

  const focusCaption = (caption = selectedCaption) => {
    if (!caption || !durationMs) return;
    const view = focusedTimingViewport(caption, durationMs);
    setFollow(false);
    setZoom(durationMs / view.spanMs);
    setViewStartMs(view.startMs);
  };

  useEffect(() => {
    if (!selectedCaption || !durationMs) return;
    const identity = `${memoryKey}:${selectedCaption.id}`;
    if (focusIdentity.current === identity) return;
    focusIdentity.current = identity;
    focusCaption(selectedCaption);
  }, [memoryKey, selectedCaption?.id, durationMs]);

  useEffect(() => () => onStopPreview(), []);

  useEffect(() => {
    setSelectedWordId(null);
    setWordCandidate(null);
    onStopPreview();
  }, [selectedCaption?.id]);
  useEffect(() => { setEditMode(initialEditMode); }, [initialEditMode]);

  useEffect(() => {
    setMode(initialMode);
    setZoom(clamp(initialZoom || 2, 1, 24));
  }, [projectId]);

  useEffect(() => {
    const element = canvasHost.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(1, Math.round(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const key of waveformMemory.keys()) {
      const [cachedProject, cachedMedia] = JSON.parse(key) as [string, string];
      if (cachedProject === projectId && cachedMedia !== mediaIdentity) waveformMemory.delete(key);
    }
    setLoading(true);
    setLoadError('');
    setPeaks(null);
    setSpectrum(null);
    setDurationMs(0);
    samplesRef.current = null;

    if (reloadKey === 0) {
      const remembered = recalledWaveform(memoryKey);
      if (remembered) {
        if (import.meta.env.DEV) {
          (window as unknown as { __STHANG_TEST_HOOKS__?: { onAudioCacheHit?: (key: string) => void } }).__STHANG_TEST_HOOKS__?.onAudioCacheHit?.(memoryKey);
        }
        samplesRef.current = remembered.samples;
        setDurationMs(remembered.durationMs);
        setSpectrum(remembered.spectrum);
        setPeaks(remembered.peaks || null);
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
      } catch (reason) {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : 'Waveform could not load');
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, memoryKey, reloadKey]);

  useEffect(() => {
    const samples = samplesRef.current;
    if (loading || mode !== 'waveform' || !samples || peaks?.samples === samples) return;
    let cancelled = false;
    void buildWaveformPeaks(samples, () => cancelled || samplesRef.current !== samples).then((value) => {
      if (!value || cancelled || samplesRef.current !== samples) return;
      setPeaks(value);
      const entry = waveformMemory.get(memoryKey);
      // Do not resurrect an evicted project or replace concurrently computed spectrum.
      if (entry?.samples === samples) rememberWaveform(memoryKey, { ...entry, peaks: value });
    }).catch(() => { /* Optional peaks: exact raw PCM drawing remains the fallback. */ });
    return () => { cancelled = true; };
  }, [loading, mode, memoryKey, reloadKey, durationMs, peaks]);

  useEffect(() => {
    if (loading || mode !== 'spectrum' || spectrum) return;
    const samples = samplesRef.current;
    if (!samples || !durationMs) return;

    const remembered = recalledWaveform(memoryKey);
    if (remembered?.samples === samples && remembered.spectrum) {
      if (import.meta.env.DEV) {
        (window as unknown as { __STHANG_TEST_HOOKS__?: { onSpectrumCacheHit?: (key: string) => void } }).__STHANG_TEST_HOOKS__?.onSpectrumCacheHit?.(memoryKey);
      }
      setSpectrum(remembered.spectrum);
      return;
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __STHANG_TEST_HOOKS__?: { onScheduleSpectrum?: (key: string) => void } }).__STHANG_TEST_HOOKS__?.onScheduleSpectrum?.(memoryKey);
    }
    const delay = (import.meta.env.DEV && (window as unknown as { __STHANG_TEST_HOOKS__?: { spectrumDelayMs?: number } }).__STHANG_TEST_HOOKS__?.spectrumDelayMs) || 0;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || samplesRef.current !== samples) return;
      if (import.meta.env.DEV) {
        (window as unknown as { __STHANG_TEST_HOOKS__?: { onComputeSpectrum?: (key: string) => void } }).__STHANG_TEST_HOOKS__?.onComputeSpectrum?.(memoryKey);
      }
      const computed = computeSpectrum(samples);
      if (cancelled) return;
      setSpectrum(computed);
      const existing = recalledWaveform(memoryKey);
      rememberWaveform(memoryKey, {
        samples,
        durationMs,
        peaks: existing?.samples === samples ? existing.peaks : null,
        spectrum: computed,
        touchedAt: Date.now(),
      });
      if (import.meta.env.DEV) {
        (window as unknown as { __STHANG_TEST_HOOKS__?: { onPublishSpectrum?: (key: string, spectrum: Spectrum) => void } }).__STHANG_TEST_HOOKS__?.onPublishSpectrum?.(memoryKey, computed);
      }
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, spectrum, memoryKey, durationMs, loading, reloadKey]);

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
    let maximumEnergy = 0;
    for (let index = Math.max(windowSize, centerIndex - search); index < Math.min(samples.length - windowSize, centerIndex + search); index += Math.max(1, Math.floor(windowSize / 3))) {
      let energy = 0;
      for (let i = -windowSize; i <= windowSize; i += 1) energy += Math.abs(samples[index + i] || 0);
      energy /= windowSize * 2 + 1;
      maximumEnergy = Math.max(maximumEnergy, energy);
      if (energy < bestEnergy || (energy === bestEnergy && Math.abs(index - centerIndex) < Math.abs(best - centerIndex))) { bestEnergy = energy; best = index; }
    }
    // A flat tone or uniformly quiet recording is not evidence of a speech gap.
    return maximumEnergy > 0.003 && bestEnergy < maximumEnergy * 0.25 && bestEnergy < 0.015
      ? best / samples.length * durationMs : value;
  };

  const snapTime = (value: number, edge: TimingEditKind) => {
    const candidate = snap === 'word' ? nearestBoundary(tokens, value, edge) : snap === 'silence' ? nearestSilence(value) : value;
    return Math.abs(candidate - value) <= Math.min(160, viewDurationMs / Math.max(1, width) * 10) ? candidate : value;
  };

  useEffect(() => {
    const target = canvas.current;
    const samples = samplesRef.current;
    if (!target || !samples || !durationMs) return;
    const ratio = window.devicePixelRatio || 1;
    const height = 184;
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

    const secondsVisible = viewDurationMs / 1000;
    const gridSeconds = secondsVisible > 90 ? 15 : secondsVisible > 40 ? 10 : secondsVisible > 16 ? 5 : secondsVisible > 7 ? 2 : secondsVisible > 2 ? 1 : 0.25;
    const firstGrid = Math.ceil(viewStartMs / 1000 / gridSeconds) * gridSeconds * 1000;
    ctx.font = '11px ui-monospace, monospace';
    for (let value = firstGrid; value < viewEndMs; value += gridSeconds * 1000) {
      const x = timeToX(value);
      ctx.strokeStyle = '#20252c';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = '#a6adb7';
      ctx.fillText(formatMs(value), x + 4, 14);
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
        const { min, max } = waveformExtrema(samples, peaks, from, to);
        ctx.moveTo(x + 0.5, middle + min * 54);
        ctx.lineTo(x + 0.5, middle + max * 54);
      }
      ctx.stroke();
      ctx.strokeStyle = '#2b331b';
      ctx.beginPath(); ctx.moveTo(0, middle + 0.5); ctx.lineTo(width, middle + 0.5); ctx.stroke();
    }

    for (const caption of drawnCaptions) {
      if (caption.endMs < viewStartMs || caption.startMs > viewEndMs) continue;
      const x1 = timeToX(caption.startMs);
      const x2 = timeToX(caption.endMs);
      const isSelected = selected.has(caption.id);
      ctx.fillStyle = isSelected ? 'rgba(215,255,79,.15)' : caption.approved ? 'rgba(87,190,132,.08)' : 'rgba(126,138,154,.055)';
      ctx.fillRect(x1, 142, Math.max(2, x2 - x1), 32);
      ctx.strokeStyle = caption.timingLocked ? '#e7b95d' : isSelected ? '#d7ff4f' : '#48505b';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x1 + 0.5, 142.5, Math.max(1, x2 - x1 - 1), 31);
      if (isSelected) {
        for (const x of [x1, x2]) {
          ctx.fillStyle = caption.timingLocked ? '#e7b95d' : '#d7ff4f';
          ctx.fillRect(x - 3, 139, 6, 38);
          ctx.strokeStyle = 'rgba(215,255,79,.55)';
          ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, 138); ctx.stroke();
        }
      }
      if (x2 - x1 > 35) {
        ctx.save();
        ctx.beginPath(); ctx.rect(Math.max(0, x1 + 8), 144, Math.max(0, Math.min(width, x2 - 8) - Math.max(0, x1 + 8)), 28); ctx.clip();
        ctx.fillStyle = isSelected ? '#ecf6ce' : '#adb5c0';
        ctx.font = '12px "Noto Sans Khmer", sans-serif';
        ctx.fillText(caption.text, Math.max(0, x1 + 8), 163);
        ctx.restore();
      }
    }

    const showWords = viewDurationMs <= 28_000;
    for (const token of showReferenceWords && editMode === 'caption' ? tokens : []) {
      if (token.endMs < viewStartMs || token.startMs > viewEndMs) continue;
      const x = timeToX(token.startMs);
      ctx.strokeStyle = token.timingSource === 'interpolated' ? '#d56565' : '#697748';
      ctx.beginPath(); ctx.moveTo(x, 112); ctx.lineTo(x, 124); ctx.stroke();
      if (showWords) {
        ctx.font = '11px "Noto Sans Khmer", Inter, sans-serif';
        ctx.save();
        ctx.beginPath(); ctx.rect(x + 2, 96, Math.max(0, timeToX(token.endMs) - x - 4), 20); ctx.clip();
        ctx.fillStyle = 'rgba(8,13,19,.88)';
        ctx.fillRect(x + 2, 96, ctx.measureText(token.text).width + 5, 20);
        ctx.fillStyle = token.timingSource === 'interpolated' ? '#ffc2c2' : '#dce8c9';
        ctx.fillText(token.text, x + 2, 110);
        ctx.restore();
      }
    }

    if (editMode === 'words' && currentCaption) {
      for (const word of editableWords) {
        if (word.startMs === null || word.endMs === null || word.endMs < viewStartMs || word.startMs > viewEndMs) continue;
        const x1 = timeToX(word.startMs);
        const x2 = timeToX(word.endMs);
        const activeWord = word.id === selectedWord?.id;
        const tentative = word.needsReview || word.source === 'estimated';
        ctx.fillStyle = tentative ? 'rgba(112,76,25,.92)' : activeWord ? '#314619' : '#151e29';
        ctx.fillRect(x1, 100, Math.max(2, x2 - x1), 33);
        ctx.strokeStyle = tentative ? '#f0c179' : activeWord ? '#d7ff4f' : '#8d9aa9';
        ctx.lineWidth = activeWord ? 2 : 1;
        ctx.strokeRect(x1 + .5, 100.5, Math.max(1, x2 - x1 - 1), 32);
        if (activeWord) for (const x of [x1, x2]) {
          ctx.fillStyle = '#d7ff4f'; ctx.fillRect(x - 3, 98, 6, 36);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(Math.max(0, x1 + 7), 102, Math.max(0, Math.min(width, x2 - 6) - Math.max(0, x1 + 7)), 28); ctx.clip();
        ctx.font = '12px "Noto Sans Khmer", sans-serif';
        ctx.fillStyle = '#f5f7ea';
        ctx.fillText(currentCaption.text.slice(word.startOffset, word.endOffset), Math.max(0, x1 + 7), 122);
        ctx.restore();
      }
    }

  }, [width, durationMs, loading, memoryKey, mode, spectrum, peaks, viewStartMs, viewDurationMs, viewEndMs, drawnCaptions, tokens, selected, currentCaption, editMode, showReferenceWords, selectedWord?.id]);

  // The moving cursor has its own transparent layer; it never invalidates the
  // expensive waveform/spectrum, word anchors, or caption background drawing.
  useEffect(() => {
    const target = playheadCanvas.current;
    if (!target) return;
    const ratio = window.devicePixelRatio || 1;
    const height = 184;
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    if (!durationMs || loading) return;
    const playheadX = timeToX(playheadMs);
    if (playheadX >= 0 && playheadX <= width) {
      ctx.strokeStyle = '#d7ff4f';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, height); ctx.stroke();
      ctx.fillStyle = '#d7ff4f';
      ctx.beginPath(); ctx.moveTo(playheadX - 5, 0); ctx.lineTo(playheadX + 5, 0); ctx.lineTo(playheadX, 7); ctx.closePath(); ctx.fill();
    }
  }, [width, durationMs, loading, viewStartMs, viewDurationMs, playheadMs]);

  const pointerTime = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return xToTime(clamp(event.clientX - rect.left, 0, rect.width) / rect.width * width);
  };

  const chooseBoundary = (value: number) => {
    let best: { caption: CaptionSegment; edge: 'start' | 'end'; distance: number } | null = null;
    const tolerance = viewDurationMs / width * 10;
    for (const caption of [...captions].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))) {
      if (caption.timingLocked) continue;
      for (const edge of ['start', 'end'] as const) {
        const distance = Math.abs(caption[edge === 'start' ? 'startMs' : 'endMs'] - value);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { caption, edge, distance };
      }
    }
    return best;
  };

  const commit = (transaction: CaptionTimingTransaction, record = true) => {
    const { before, after, limited } = transaction;
    if (limited) onNotice(limited);
    if (!after.length || after.every((caption, index) => sameTimingRevision(caption, before[index]))) return false;
    if (!before.every((expected) => sameTimingRevision(captions.find((caption) => caption.id === expected.id), expected)) || !onTimingChange(before, after)) {
      onNotice('This caption changed during the timing edit. Its newer edits were kept.');
      return false;
    }
    onStopPreview();
    if (record) {
      history.current.undo = [...history.current.undo.slice(-49), { before, after }];
      history.current.redo = [];
    }
    setHistoryRevision((value) => value + 1);
    return true;
  };
  const edit = (kind: TimingEditKind, value: number) => {
    return selectedCaption ? commit(planCaptionTimingEdit(captions, selectedCaption.id, kind, value, editLimitMs, { allowOverlap, sharedBoundary })) : false;
  };
  const restore = (direction: 'undo' | 'redo') => {
    const stack = history.current[direction];
    const entry = stack.at(-1);
    if (!entry) return;
    const before = direction === 'undo' ? entry.after : entry.before;
    const after = direction === 'undo' ? entry.before : entry.after;
    if (commit({ before, after }, false)) {
      stack.pop();
      history.current[direction === 'undo' ? 'redo' : 'undo'].push(entry);
      const target = after.find((caption) => caption.id === selectedCaption?.id) || after[0];
      onSelect(target.id);
      focusCaption(target);
    } else {
      history.current = { undo: [], redo: [] };
      setHistoryRevision((value) => value + 1);
    }
  };
  const previewForPointer = (event: React.PointerEvent<HTMLCanvasElement>, gesture: DragState) => {
    if (Math.abs(event.clientX - gesture.originX) < 2) return { before: [], after: [] } as CaptionTimingTransaction;
    const delta = pointerTime(event) - gesture.originMs;
    if (gesture.wordId) {
      const word = gesture.before.wordTiming?.words.find((item) => item.id === gesture.wordId);
      if (word?.startMs == null || word.endMs == null) return { before: [], after: [] };
      const value = gesture.edge === 'move' ? delta : (gesture.edge === 'start' ? word.startMs : word.endMs) + delta;
      const after = changeWordTiming(gesture.before, gesture.wordId, gesture.edge, value);
      return after === gesture.before ? { before: [], after: [] } : { before: [gesture.before], after: [after] };
    }
    const target = gesture.edge === 'move' ? gesture.before.startMs + delta
      : gesture.before[gesture.edge === 'start' ? 'startMs' : 'endMs'] + delta;
    const snapped = event.shiftKey ? target : snapTime(target, gesture.edge);
    return planCaptionTimingEdit(gesture.basis, gesture.before.id, gesture.edge, gesture.edge === 'move' ? snapped - gesture.before.startMs : snapped, editLimitMs, gesture.options);
  };
  const cancelDrag = () => { dragRef.current = null; setDrag(null); setDragPreview(null); };
  const updateDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = dragRef.current;
    if (gesture?.pointerId === event.pointerId) setDragPreview(previewForPointer(event, gesture).after);
  };
  const navigateCaption = (delta: number) => {
    const next = captions[clamp(captionIndex + delta, 0, captions.length - 1)];
    if (!next) return;
    onStopPreview(); onSelect(next.id); onSeek(next.startMs); focusCaption(next);
  };
  const audition = (part: 'caption' | 'start' | 'end') => {
    if (currentCaption && editLimitMs) onPreview({ ...timingPreviewWindow(currentCaption, part, editLimitMs), loop });
  };
  const lastUndo = history.current.undo.at(-1);
  const lastRedo = history.current.redo.at(-1);
  const canUndo = Boolean(lastUndo && lastUndo.after.every((expected) => sameTimingRevision(captions.find((caption) => caption.id === expected.id), expected)));
  const canRedo = Boolean(lastRedo && lastRedo.before.every((expected) => sameTimingRevision(captions.find((caption) => caption.id === expected.id), expected)));

  const setZoomValue = (value: number) => {
    const next = clamp(value, 1, maxZoom);
    const previousDuration = durationMs / zoom;
    const center = viewStartMs + previousDuration / 2;
    const nextDuration = durationMs / next;
    setZoom(next);
    setFollow(false);
    setViewStartMs(clamp(center - nextDuration / 2, 0, Math.max(0, durationMs - nextDuration)));
    // Caption-focused zoom can exceed the legacy whole-video preference range.
    if (next <= 24) onPreferenceChange({ waveformZoom: next });
  };

  const handleTimingKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && dragRef.current) { event.preventDefault(); event.stopPropagation(); cancelDrag(); return; }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [aria-modal="true"]')) return;
      if (dragRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); if (event.shiftKey ? canRedo : canUndo) restore(event.shiftKey ? 'redo' : 'undo');
      } else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const delta = (event.key === 'ArrowLeft' ? -1 : 1) * stepMs;
        if (editMode === 'words') {
          if (selectedCaption && selectedWord && !validCandidate) {
            const after = changeWordTiming(selectedCaption, selectedWord.id, 'move', delta);
            if (after !== selectedCaption) commit({ before: [selectedCaption], after: [after] });
          }
        } else edit('move', delta);
      } else if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'r') {
        event.preventDefault(); audition('caption');
      }
  };
  useEffect(() => {
    // While this workspace is open, its shortcuts share the same bounded edit and undo path.
    window.addEventListener('keydown', handleTimingKey, true);
    return () => window.removeEventListener('keydown', handleTimingKey, true);
  });

  return <section className="waveform-card fine-timing" ref={host} aria-label="Fine timing editor">
    <div className="timing-selection">
      <div className="timing-caption-nav">
        <button aria-label="Previous caption" disabled={captionIndex <= 0} onClick={() => navigateCaption(-1)}><ChevronLeft size={16}/><span>Previous</span></button>
        <strong>{selectedCaption ? `Caption ${captionIndex + 1} / ${captions.length}` : 'Select a caption'}</strong>
        <button aria-label="Next caption" disabled={captionIndex < 0 || captionIndex >= captions.length - 1} onClick={() => navigateCaption(1)}><span>Next</span><ChevronRight size={16}/></button>
      </div>
      <p className="timing-caption-text">{currentCaption?.text || 'Choose a caption from the list to adjust its timing.'}</p>
      {selectedIds.length > 1 && <p className="timing-hint">Editing the first selected caption. Use Previous or Next to time each caption individually.</p>}
    </div>
    <div className="timing-transport">
      <button className="timing-primary" disabled={!currentCaption || !editLimitMs || Boolean(drag)} onClick={() => audition('caption')} title="Replay this caption (R)"><Play size={15}/>Replay caption</button>
      <button onClick={onStopPreview} title="Stop timing preview"><Square size={14}/>Stop</button>
      <label className="timing-loop"><input type="checkbox" checked={loop} onChange={(event) => { setLoop(event.target.checked); onStopPreview(); }}/>Loop</label>
      <div className="timing-history">
        <button disabled={!canUndo || Boolean(drag)} onClick={() => restore('undo')} title="Undo timing edit (Ctrl+Z)"><Undo2 size={15}/>Undo</button>
        <button disabled={!canRedo || Boolean(drag)} onClick={() => restore('redo')} title="Redo timing edit (Ctrl+Shift+Z)"><Redo2 size={15}/>Redo</button>
      </div>
    </div>
    <div className="timing-mode-switch" role="group" aria-label="Timing editing mode">
      <button aria-pressed={editMode === 'caption'} className={editMode === 'caption' ? 'selected' : ''} onClick={() => { cancelDrag(); onStopPreview(); setEditMode('caption'); }}>Caption edges</button>
      <button aria-pressed={editMode === 'words'} className={editMode === 'words' ? 'selected' : ''} onClick={() => { cancelDrag(); onStopPreview(); setEditMode('words'); }}>Word timing</button>
      {editMode === 'words' && <span className="timing-hint">{wordResolution?.state === 'ready' ? 'Timing ready' : 'Word timing needs review'}</span>}
    </div>
    <div className="timing-view-controls">
      <button onClick={() => focusCaption()} disabled={!currentCaption || !durationMs}><LocateFixed size={15}/>Focus caption</button>
      <button onClick={() => setZoomValue(1)} disabled={!durationMs}>Full clip</button>
      <button onClick={() => setZoomValue(zoom / 1.5)} disabled={zoom <= 1 || !durationMs} title="Zoom out"><Minus size={15}/><span>Zoom out</span></button>
      <button onClick={() => setZoomValue(zoom * 1.5)} disabled={zoom >= maxZoom || !durationMs} title="Zoom in"><Plus size={15}/><span>Zoom in</span></button>
      <span className="timing-view-span">{(viewDurationMs / 1000).toFixed(1)} s visible</span>
    </div>
    <div ref={canvasHost} className={`waveform-canvas-wrap ${drag ? 'dragging' : ''}`}>
      {loading && <div className="waveform-loading">Preparing waveform…</div>}
      {loadError && <div className="waveform-loading error waveform-recovery">
        <strong>The audio preview could not load.</strong>
        <span>Your video and captions are safe. Rebuild only the waveform preview.</span>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw size={14}/> Rebuild waveform
        </button>
        <small>Still not working? Open System check.</small>
      </div>}
      <canvas
        ref={canvas}
        className="waveform-data-canvas"
        tabIndex={0}
        aria-label="Timing waveform. Click audio to seek. Drag a caption edge to trim or its middle to move. Use the labeled time controls below for keyboard editing."
        onPointerDown={(event: React.PointerEvent<HTMLCanvasElement>) => {
          if (!durationMs || loading || loadError || event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          const value = pointerTime(event);
          const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
          if (editMode === 'words' && y >= 96 && y < 136 && selectedCaption) {
            const tolerance = viewDurationMs / width * 10;
            const possible = editableWords.filter((word) => word.startMs !== null && word.endMs !== null);
            let wordEdge: { id: string; edge: 'start' | 'end'; distance: number } | undefined;
            for (const word of possible) for (const edge of ['start', 'end'] as const) {
              const distance = Math.abs(value - (edge === 'start' ? word.startMs! : word.endMs!));
              if (distance <= tolerance && (!wordEdge || distance < wordEdge.distance)) wordEdge = { id: word.id, edge, distance };
            }
            const word = wordEdge ? possible.find((item) => item.id === wordEdge!.id) : possible.find((item) => value >= item.startMs! && value < item.endMs!);
            setFollow(false); onStopPreview();
            if (word) {
              setSelectedWordId(word.id);
              if (!selectedCaption.timingLocked && !validCandidate) {
                event.currentTarget.setPointerCapture(event.pointerId);
                const gesture: DragState = { captionId: selectedCaption.id, edge: wordEdge?.edge || 'move', wordId: word.id, before: selectedCaption, basis: captions, options: {}, originMs: value, originX: event.clientX, pointerId: event.pointerId };
                dragRef.current = gesture; setDrag(gesture); setDragPreview([selectedCaption]);
              }
            } else onSeek(value);
            return;
          }
          const inCaptionLane = y >= 136 && y <= 180;
          const boundary = inCaptionLane ? chooseBoundary(value) : null;
          const bodyCaption = inCaptionLane ? (captions.find((item) => selected.has(item.id) && value >= item.startMs && value < item.endMs)
            || captions.find((item) => value >= item.startMs && value < item.endMs)) : undefined;
          const target = boundary?.caption || bodyCaption;
          setFollow(false);
          onStopPreview();
          if (target && !target.timingLocked && editMode === 'caption') {
            event.currentTarget.setPointerCapture(event.pointerId);
            focusIdentity.current = `${memoryKey}:${target.id}`;
            const gesture: DragState = { captionId: target.id, edge: boundary?.edge || 'move', before: target, basis: captions, options: { allowOverlap, sharedBoundary }, originMs: value, originX: event.clientX, pointerId: event.pointerId };
            dragRef.current = gesture;
            setDrag(gesture);
            setDragPreview([target]);
            onSelect(target.id);
          } else {
            if (target) onSelect(target.id);
            onSeek(value);
          }
        }}
        onPointerMove={updateDrag}
        onPointerUp={(event: React.PointerEvent<HTMLCanvasElement>) => {
          const gesture = dragRef.current;
          if (gesture?.pointerId === event.pointerId) commit(previewForPointer(event, gesture));
          cancelDrag();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      />
      <canvas ref={playheadCanvas} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}/>

    </div>
    <div className="waveform-navigation">
      <span>{formatMs(viewStartMs)}</span>
      <input
        type="range"
        aria-label="Scroll timing waveform"
        min="0"
        max={Math.max(0, durationMs - viewDurationMs)}
        step="50"
        value={Math.min(viewStartMs, Math.max(0, durationMs - viewDurationMs))}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setFollow(false); setViewStartMs(Number(event.target.value)); }}
      />
      <span>{formatMs(viewEndMs)}</span>
    </div>
    <p className="timing-hint">{editMode === 'words' ? 'Click a word above the caption bar. Drag its edges to trim, or its middle to move; other words stay in place.' : 'Click the audio to seek. Drag the caption edges to trim, or the middle to move. Hold Shift to ignore snapping.'}</p>
    {currentCaption && editMode === 'caption' && <>
      {currentCaption.timingLocked && <p className="timing-lock-status">Timing is locked. Unlock it in the caption menu to make changes; playback remains available.</p>}
      <div className="timing-edge-grid">
        {(['start', 'end'] as const).map((edge) => <div className="timing-edge" key={edge}>
          <div className="timing-edge-value"><span>{edge === 'start' ? 'Start' : 'End'}</span>
            <TimestampInput label={`Fine timing ${edge}`} valueMs={currentCaption[edge === 'start' ? 'startMs' : 'endMs']}
              minMs={edgeBounds(edge).min} maxMs={edgeBounds(edge).max}
              disabled={editingDisabled || Boolean(drag) || edgeBounds(edge).blocked} onFocus={onStopPreview} onCommit={(value) => edit(edge, value)}/>
          </div>
          <div className="timing-edge-actions">
            <button disabled={editingDisabled || Boolean(drag) || edgeBounds(edge).blocked} onClick={() => edit(edge, currentCaption[edge === 'start' ? 'startMs' : 'endMs'] - stepMs)} aria-label={`Move ${edge} earlier by ${stepMs} milliseconds`}>−{stepMs} ms</button>
            <button disabled={editingDisabled || Boolean(drag) || edgeBounds(edge).blocked} onClick={() => edit(edge, currentCaption[edge === 'start' ? 'startMs' : 'endMs'] + stepMs)} aria-label={`Move ${edge} later by ${stepMs} milliseconds`}>+{stepMs} ms</button>
            <button disabled={editingDisabled || Boolean(drag) || edgeBounds(edge).blocked || playheadMs < edgeBounds(edge).min || playheadMs > edgeBounds(edge).max} onClick={() => edit(edge, playheadMs)} aria-label={`Set ${edge} to playhead`} title={`Set ${edge} to the current playback position`}>Set to playhead</button>
            <button disabled={!editLimitMs || Boolean(drag)} onClick={() => audition(edge)}>Hear {edge}</button>
          </div>
        </div>)}
      </div>
      <p className="timing-hint">{sharedBoundary ? 'Shared edges: changing Start also changes the previous caption’s End; changing End also changes the next caption’s Start.' : allowOverlap ? 'Overlaps allowed. Other captions stay in place.' : 'Neighbor protection is on. Edits stop before creating or increasing an overlap.'}</p>
      <div className="timing-move-controls">
        <label>Step<select aria-label="Timing nudge step" value={stepMs} onChange={(event) => setStepMs(Number(event.target.value))}>{[10, 50, 100].map((value) => <option key={value} value={value}>{value} ms</option>)}</select></label>
        <button disabled={editingDisabled || Boolean(drag)} onClick={() => edit('move', -stepMs)} title="Move the whole caption earlier (Alt+Left)">Move earlier</button>
        <button disabled={editingDisabled || Boolean(drag)} onClick={() => edit('move', stepMs)} title="Move the whole caption later (Alt+Right)">Move later</button>
        <span className="timing-duration">Duration {((currentCaption.endMs - currentCaption.startMs) / 1000).toFixed(3)} s</span>
      </div>
      {captions.some((caption) => caption.id !== currentCaption.id && caption.startMs < currentCaption.endMs && caption.endMs > currentCaption.startMs)
        && <p className="timing-lock-status">This caption overlaps another caption. Adjust its edges to separate them; other captions stay in place.</p>}
    </>}
    {selectedCaption && editMode === 'words' && <WordTimingPanel key={selectedCaption.id} caption={selectedCaption} selectedWordId={selectedWordId}
      playheadMs={playheadMs} stepMs={stepMs} disabled={Boolean(drag)} syncDisabled={syncDisabled} loop={loop} highlightEnabled={highlightEnabled}
      onSelectWord={setSelectedWordId} onChange={(before, after) => commit({ before: [before], after: [after] })} onSync={onSyncWords}
      onCandidatePreview={(basis, preview) => { setWordCandidate(preview ? { basis, preview } : null); onWordPreview(basis, preview); }}
      onPreview={onPreview} onStopPreview={onStopPreview} onOpenAppearance={onOpenAppearance} onEditText={onEditCaptionText}/>}
    {editMode === 'words' && <div className="timing-move-controls"><label>Step<select aria-label="Word nudge step" value={stepMs} onChange={(event) => setStepMs(Number(event.target.value))}>{[10, 50, 100].map((value) => <option key={value} value={value}>{value} ms</option>)}</select></label></div>}
    <details className="timing-options"><summary>Snapping, playback speed and display</summary>
      <div className="timing-options-controls">
        <label><input type="checkbox" checked={allowOverlap} onChange={(event) => setAllowOverlap(event.target.checked)}/>Allow overlaps</label>
        <label><input type="checkbox" checked={sharedBoundary} onChange={(event) => setSharedBoundary(event.target.checked)}/>Move adjoining edge too</label>
        <label><input type="checkbox" checked={showReferenceWords} onChange={(event) => setShowReferenceWords(event.target.checked)}/>Show original word estimates</label>
        <label>Snap<select value={snap} onChange={(event) => setSnap(event.target.value as typeof snap)} title="Boundary snapping" aria-label="Boundary snapping">
          <option value="word" disabled={!tokens.length}>Words</option><option value="silence">Quiet gaps</option><option value="off">Off</option>
        </select></label>
        <label>Speed<select value={playbackRate} onChange={(event) => onPlaybackRate(Number(event.target.value))} title="Playback speed" aria-label="Timing playback speed">
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select></label>
        <button className={mode === 'waveform' ? 'selected' : ''} aria-pressed={mode === 'waveform'} onClick={() => { setMode('waveform'); onPreferenceChange({ waveformMode: 'waveform' }); }} title="Waveform"><AudioLines size={15}/>Waveform</button>
        <button className={mode === 'spectrum' ? 'selected' : ''} aria-pressed={mode === 'spectrum'} onClick={() => { setMode('spectrum'); onPreferenceChange({ waveformMode: 'spectrum' }); }} title="Spectral view"><ScanLine size={15}/>Spectrum overview</button>
        <button className={follow ? 'selected' : ''} aria-pressed={follow} onClick={() => setFollow((value) => !value)} title={follow ? 'Pause follow' : 'Follow playhead'}><LocateFixed size={15}/>Follow playhead</button>
      </div>
      <p className="timing-hint">Word marks are existing timing estimates. Quiet-gap snapping requires a clear drop in audio energy. Undo is available here until this workspace closes.</p>
    </details>
  </section>;
}
