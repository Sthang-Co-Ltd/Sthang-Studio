import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_CAPTION_APPEARANCE,
  type CaptionAppearance,
  type CaptionProject,
  type ProcessingJob,
  type VideoCodec,
  type VideoEncoderPreference,
  type VideoExportCapabilities,
  type VideoExportSettings,
  type VideoFrameRatePreset,
  type VideoQualityPreset,
} from '@kcs/shared';
import { Download, Film, HardDrive, LoaderCircle, Palette, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { waitForCaptionAppearanceSaves } from '../caption-appearance-save';
import './video-export.css';

interface Props {
  project: CaptionProject;
  sampleText?: string;
  busy: boolean;
  activeExportJob?: ProcessingJob;
  onExportSrt(): void;
  onSaveAppearance?(appearance: CaptionAppearance): Promise<void>;
  onEditAppearance(): void;
  onStartVideoExport(settings: VideoExportSettings, appearance: CaptionAppearance): Promise<ProcessingJob | null>;
}

type OutputMode = 'video' | 'captions';

const DEFAULT_SETTINGS: VideoExportSettings = {
  resolution: 'source',
  frameRate: 'source',
  quality: 'recommended',
  codec: 'h264',
  encoder: 'auto',
};

const qualityCopy: Record<VideoQualityPreset, string> = {
  smaller: 'Smaller file',
  recommended: 'Recommended',
  high: 'High quality',
};

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${current >= 100 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}

function estimateBytes(capabilities: VideoExportCapabilities, settings: VideoExportSettings) {
  const resolution = capabilities.resolutions.find((item) => item.id === settings.resolution) || capabilities.resolutions[0];
  if (!resolution || capabilities.source.durationMs <= 0) return 0;
  const fps = settings.frameRate === 'source' ? capabilities.source.frameRate : settings.frameRate;
  const bpp = settings.quality === 'high' ? 0.15 : settings.quality === 'smaller' ? 0.065 : 0.1;
  const efficiency = settings.codec === 'hevc' ? 0.72 : 1;
  const videoMbps = settings.customBitrateMbps || Math.max(1.5, Math.min(settings.codec === 'hevc' ? 100 : 140, resolution.width * resolution.height * Math.max(12, fps) * bpp * efficiency / 1_000_000));
  const audioMbps = capabilities.source.audioStreams ? 0.256 * capabilities.source.audioStreams : 0;
  return Math.ceil((videoMbps + audioMbps) * 1_000_000 / 8 * capabilities.source.durationMs / 1000 * 1.04);
}

function frameRateLabel(value: VideoFrameRatePreset, source: number) {
  return value === 'source' ? `Match source (${source > 0 ? source.toFixed(source % 1 ? 2 : 0) : 'auto'} fps)` : `${value} fps`;
}

function resolutionLabel(item: VideoExportCapabilities['resolutions'][number]) {
  const label = item.id === 'source' ? 'Match source' : item.label;
  return `${label} · ${item.width}×${item.height}${item.upscaled ? ' · Upscaled' : ''}`;
}

function isVideoProject(project: CaptionProject) {
  return project.media.mimeType.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(project.media.originalName);
}

function resolvedAppearance(project: CaptionProject): CaptionAppearance {
  return { ...DEFAULT_CAPTION_APPEARANCE, ...project.captionAppearance };
}

export function ExportWorkspace({ project, busy, activeExportJob, onExportSrt, onEditAppearance, onStartVideoExport }: Props) {
  const videoProject = isVideoProject(project);
  const [outputMode, setOutputMode] = useState<OutputMode>(videoProject ? 'video' : 'captions');
  const [capabilities, setCapabilities] = useState<VideoExportCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(videoProject);
  const [capabilityError, setCapabilityError] = useState('');
  const [actionError, setActionError] = useState('');
  const [settings, setSettings] = useState<VideoExportSettings>(DEFAULT_SETTINGS);
  const [appearance, setAppearance] = useState<CaptionAppearance>(resolvedAppearance(project));
  const [appearanceSaveBlocked, setAppearanceSaveBlocked] = useState(false);
  const [startingExport, setStartingExport] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const loadCapabilities = async (refresh = false) => {
    if (!videoProject) {
      setCapabilities(null);
      setLoadingCapabilities(false);
      setCapabilityError('');
      return;
    }
    setLoadingCapabilities(true);
    setCapabilityError('');
    try { setCapabilities(await api.videoExportCapabilities(project.id, refresh)); }
    catch (error) { setCapabilityError(error instanceof Error ? error.message : 'Could not inspect video export support'); }
    finally { setLoadingCapabilities(false); }
  };

  useEffect(() => {
    let active = true;
    setOutputMode(videoProject ? 'video' : 'captions');
    setSettings(DEFAULT_SETTINGS);
    setAppearance(resolvedAppearance(project));
    setAppearanceSaveBlocked(false);
    setCapabilities(null);
    setCapabilityError('');
    setActionError('');
    setAdvancedOpen(false);
    void loadCapabilities(false);
    void (async () => {
      const saved = await waitForCaptionAppearanceSaves(project.id);
      if (!active) return;
      if (!saved) {
        setAppearanceSaveBlocked(true);
        setActionError('Your latest caption appearance could not be saved. Return to Appearance and retry before rendering.');
        return;
      }
      try {
        const fresh = await api.get(project.id);
        if (active) setAppearance(resolvedAppearance(fresh));
      } catch {
        if (active) setActionError('Could not load the latest saved caption appearance. Reopen Export to try again.');
      }
    })();
    return () => { active = false; };
  }, [project.id, project.media.filename]);

  useEffect(() => {
    if (!capabilities) return;
    const codecAvailable = capabilities.encoders.some((encoder) => encoder.codec === settings.codec && encoder.available);
    if (!codecAvailable && settings.codec === 'hevc') setSettings((current) => ({ ...current, codec: 'h264', encoder: 'auto' }));
  }, [capabilities]);

  const resolution = useMemo(() => capabilities?.resolutions.find((item) => item.id === settings.resolution), [capabilities, settings.resolution]);
  const estimatedBytes = useMemo(() => capabilities ? estimateBytes(capabilities, settings) : 0, [capabilities, settings]);
  const availableEncoders = useMemo(() => capabilities?.encoders.filter((item) => item.codec === settings.codec && item.available) || [], [capabilities, settings.codec]);
  const hevcAvailable = Boolean(capabilities?.encoders.some((encoder) => encoder.codec === 'hevc' && encoder.available));
  const source = capabilities?.source;
  const appearanceFontUnavailable = Boolean(capabilities?.fonts.some((font) => font.available) && !capabilities.fonts.some((font) => font.available && font.name === appearance.fontFamily));
  const exportBlocked = Boolean(!videoProject || !capabilities?.supported || appearanceSaveBlocked || appearanceFontUnavailable || activeExportJob || busy || startingExport || !project.captions.length);

  const startExport = async () => {
    setStartingExport(true);
    setActionError('');
    try {
      const saved = await waitForCaptionAppearanceSaves(project.id);
      if (!saved) {
        setAppearanceSaveBlocked(true);
        setActionError('Your latest caption appearance could not be saved. Return to Appearance and retry before rendering.');
        return;
      }
      const fresh = await api.get(project.id);
      const latestAppearance = resolvedAppearance(fresh);
      setAppearance(latestAppearance);
      setAppearanceSaveBlocked(false);
      const fontUnavailable = Boolean(capabilities?.fonts.some((font) => font.available) && !capabilities.fonts.some((font) => font.available && font.name === latestAppearance.fontFamily));
      if (fontUnavailable) {
        setActionError(`${latestAppearance.fontFamily} is not available on this PC. Edit appearance and choose an available Khmer font before rendering.`);
        return;
      }
      await onStartVideoExport(settings, latestAppearance);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start video export');
    } finally { setStartingExport(false); }
  };

  const setCodec = (codec: VideoCodec) => setSettings((current) => ({ ...current, codec, encoder: 'auto' }));
  const setEncoder = (encoder: VideoEncoderPreference) => setSettings((current) => ({ ...current, encoder }));

  return <div className="export-workspace">
    <div className="export-workspace-head">
      <div><strong>Export</strong><span>Choose the output and quality. Caption styling stays in the editor, where you can judge it on the video.</span></div>
      {videoProject && outputMode === 'video' && <button onClick={() => void loadCapabilities(true)} disabled={loadingCapabilities} title="Recheck video export support"><RefreshCw className={loadingCapabilities ? 'spin' : ''} size={14}/>Recheck</button>}
    </div>

    <div className="export-mode-switch" role="group" aria-label="Export type">
      <button aria-pressed={outputMode === 'video'} disabled={!videoProject} onClick={() => setOutputMode('video')}><Film size={16}/><span>Captioned video</span><small>MP4</small></button>
      <button aria-pressed={outputMode === 'captions'} onClick={() => setOutputMode('captions')}><Download size={16}/><span>Captions file</span><small>SRT</small></button>
    </div>

    {!videoProject && <p className="export-mode-help">This project contains audio only, so SRT is the available export path.</p>}

    {outputMode === 'captions' && <section className="export-srt-panel" aria-labelledby="export-srt-title">
      <div><strong id="export-srt-title">Captions file (SRT)</strong><span>Caption text + timing. Visual styling stays controlled by the destination editing app.</span></div>
      <button disabled={!project.captions.length || busy} onClick={onExportSrt}><Download size={14}/>Download SRT</button>
    </section>}

    {outputMode === 'video' && <>
      {activeExportJob && <div className="export-active" role="status"><LoaderCircle className="spin" size={15}/><div><strong>{activeExportJob.message}</strong><span>{activeExportJob.progress}% · you can keep editing while this saved snapshot renders</span></div></div>}
      {loadingCapabilities && <div className="export-status" role="status"><LoaderCircle className="spin" size={16}/>Checking video export support…</div>}
      {capabilityError && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Video export check failed</strong><span>{capabilityError}</span></div></div>}
      {actionError && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Export needs attention</strong><span>{actionError}</span></div></div>}
      {capabilities && !capabilities.supported && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Captioned video is blocked for this source</strong><span>{capabilities.blockingReason}</span></div></div>}

      {capabilities?.supported && <>
        <section className="export-section" aria-labelledby="video-quality-title">
          <div className="export-section-title"><div><strong id="video-quality-title">Video</strong><span>Match source + Recommended is the safest default.</span></div>{source && <span className="export-source-chip">{source.displayWidth}×{source.displayHeight} · {source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps · {source.hdr === 'sdr' ? 'SDR' : source.hdr.toUpperCase()}</span>}</div>

          <div className="export-setting-grid">
            <label><span>Resolution</span><select value={settings.resolution} onChange={(event) => setSettings((current) => ({ ...current, resolution: event.target.value as VideoExportSettings['resolution'] }))}>{capabilities.resolutions.map((item) => <option key={item.id} value={item.id}>{resolutionLabel(item)}</option>)}</select></label>
            <label><span>Frame rate</span><select value={String(settings.frameRate)} onChange={(event) => setSettings((current) => ({ ...current, frameRate: event.target.value === 'source' ? 'source' : Number(event.target.value) as VideoFrameRatePreset }))}>{(['source', 24, 25, 30, 50, 60] as VideoFrameRatePreset[]).map((value) => <option key={String(value)} value={String(value)}>{frameRateLabel(value, source?.frameRate || 0)}</option>)}</select></label>
            <div className="export-quality-choice"><span>Quality</span><div role="group" aria-label="Video quality">{(['smaller', 'recommended', 'high'] as VideoQualityPreset[]).map((quality) => <button key={quality} aria-pressed={settings.quality === quality} className={settings.quality === quality ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, quality, customBitrateMbps: undefined }))}>{qualityCopy[quality]}</button>)}</div></div>
          </div>

          <div className="export-summary-line" aria-live="polite">
            <span><Film size={14}/><b>{resolution ? `${resolution.width}×${resolution.height}` : 'Source'}</b>{resolution?.upscaled ? ' · Upscaled' : ''} · {frameRateLabel(settings.frameRate, source?.frameRate || 0)} · {settings.codec.toUpperCase()}</span>
            <span><HardDrive size={14}/>≈ <b>{bytes(estimatedBytes)}</b> · {bytes(capabilities.availableDiskBytes)} free</span>
          </div>

          <details className="export-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>Advanced video settings</summary>
            <div className="export-advanced-grid">
              <label><span>Codec</span><select value={settings.codec} onChange={(event) => setCodec(event.target.value as VideoCodec)}><option value="h264">H.264 · widest compatibility</option>{hevcAvailable && <option value="hevc">HEVC / H.265 · smaller at similar quality</option>}</select></label>
              <label><span>Encoder</span><select value={settings.encoder} onChange={(event) => setEncoder(event.target.value as VideoEncoderPreference)}><option value="auto">Auto · prefer verified GPU encoder</option>{availableEncoders.map((encoder) => <option key={`${encoder.codec}-${encoder.id}`} value={encoder.id}>{encoder.label}{encoder.hardware ? ' · hardware' : ' · CPU'}</option>)}</select></label>
              <label><span>Custom bitrate (Mbps)</span><input type="number" min="1" max="200" step="0.5" value={settings.customBitrateMbps ?? ''} placeholder="Use quality preset" onChange={(event) => setSettings((current) => ({ ...current, customBitrateMbps: event.target.value ? Math.max(1, Math.min(200, Number(event.target.value))) : undefined }))}/></label>
            </div>
            <span className="export-advanced-help">Auto tests encoders on this PC and falls back safely when needed.</span>
          </details>
        </section>

        <section className="export-appearance-summary" aria-labelledby="export-appearance-title">
          <div className="export-appearance-copy"><Palette size={17}/><div><strong id="export-appearance-title">Caption appearance</strong><span><i className="export-color-swatch" style={{ background: appearance.textColor }} aria-hidden="true"/>{appearance.fontFamily} · {appearance.fontSize1080}px @1080p · {appearance.alignment} · {appearance.positionBottomPct}% from bottom</span></div></div>
          <button onClick={onEditAppearance}>Edit appearance</button>
        </section>

        {appearanceFontUnavailable && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Choose an available caption font</strong><span>{appearance.fontFamily} is not available on this PC. Edit appearance and select an available Khmer font before rendering so the export does not silently substitute typography.</span></div></div>}

        {capabilities.warnings.length > 0 && <div className="export-warnings" aria-label="Video export notices">{capabilities.warnings.map((warning) => <div key={warning}><TriangleAlert size={14}/><span>{warning}</span></div>)}</div>}

        <div className="export-finalize">
          <div><ShieldCheck size={17}/><span>Source stays untouched. Studio snapshots the current captions, appearance and quality settings, then verifies the finished file.</span></div>
          <button className="primary" disabled={exportBlocked} onClick={() => void startExport()}>{startingExport ? <LoaderCircle className="spin" size={16}/> : <Film size={16}/>} {activeExportJob ? 'Export already running' : startingExport ? 'Starting…' : 'Export captioned video'}</button>
        </div>
      </>}
    </>}
  </div>;
}
