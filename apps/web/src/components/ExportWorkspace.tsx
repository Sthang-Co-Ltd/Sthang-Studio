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
  type VideoResolutionPreset,
} from '@kcs/shared';
import { Download, Film, HardDrive, LoaderCircle, RefreshCw, RotateCcw, Save, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import './video-export.css';

interface Props {
  project: CaptionProject;
  sampleText: string;
  busy: boolean;
  activeExportJob?: ProcessingJob;
  onExportSrt(): void;
  onSaveAppearance(appearance: CaptionAppearance): Promise<void>;
  onStartVideoExport(settings: VideoExportSettings, appearance: CaptionAppearance): Promise<ProcessingJob | null>;
}

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

function hexToRgba(hex: string, opacity: number) {
  const raw = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '000000';
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function frameRateLabel(value: VideoFrameRatePreset, source: number) {
  return value === 'source' ? `Match source (${source > 0 ? source.toFixed(source % 1 ? 2 : 0) : 'auto'} fps)` : `${value} fps`;
}

export function ExportWorkspace({ project, sampleText, busy, activeExportJob, onExportSrt, onSaveAppearance, onStartVideoExport }: Props) {
  const [capabilities, setCapabilities] = useState<VideoExportCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [capabilityError, setCapabilityError] = useState('');
  const [settings, setSettings] = useState<VideoExportSettings>(DEFAULT_SETTINGS);
  const [appearance, setAppearance] = useState<CaptionAppearance>({ ...DEFAULT_CAPTION_APPEARANCE, ...project.captionAppearance });
  const [savingAppearance, setSavingAppearance] = useState(false);
  const [startingExport, setStartingExport] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const loadCapabilities = async (refresh = false) => {
    setLoadingCapabilities(true);
    setCapabilityError('');
    try { setCapabilities(await api.videoExportCapabilities(project.id, refresh)); }
    catch (error) { setCapabilityError(error instanceof Error ? error.message : 'Could not inspect video export support'); }
    finally { setLoadingCapabilities(false); }
  };

  useEffect(() => {
    setAppearance({ ...DEFAULT_CAPTION_APPEARANCE, ...project.captionAppearance });
    setSettings(DEFAULT_SETTINGS);
    setCapabilities(null);
    void loadCapabilities(false);
  }, [project.id, project.media.filename]);

  useEffect(() => {
    if (!capabilities) return;
    const availableFonts = capabilities.fonts.filter((font) => font.available);
    if (availableFonts.length && !availableFonts.some((font) => font.name === appearance.fontFamily)) {
      setAppearance((current) => ({ ...current, fontFamily: availableFonts[0].name, bold: availableFonts[0].boldAvailable && current.bold }));
    }
    const codecAvailable = capabilities.encoders.some((encoder) => encoder.codec === settings.codec && encoder.available);
    if (!codecAvailable && settings.codec === 'hevc') setSettings((current) => ({ ...current, codec: 'h264', encoder: 'auto' }));
  }, [capabilities]);

  const resolution = useMemo(() => capabilities?.resolutions.find((item) => item.id === settings.resolution), [capabilities, settings.resolution]);
  const estimatedBytes = useMemo(() => capabilities ? estimateBytes(capabilities, settings) : 0, [capabilities, settings]);
  const availableEncoders = useMemo(() => capabilities?.encoders.filter((item) => item.codec === settings.codec && item.available) || [], [capabilities, settings.codec]);
  const availableFonts = capabilities?.fonts.filter((font) => font.available) || [];
  const hevcAvailable = Boolean(capabilities?.encoders.some((encoder) => encoder.codec === 'hevc' && encoder.available));
  const source = capabilities?.source;
  const exportBlocked = Boolean(!capabilities?.supported || activeExportJob || busy || startingExport || !project.captions.length);
  const sampleScale = Math.max(0.55, Math.min(1.7, appearance.fontSize1080 / DEFAULT_CAPTION_APPEARANCE.fontSize1080));

  const saveAppearance = async () => {
    setSavingAppearance(true);
    try { await onSaveAppearance(appearance); }
    finally { setSavingAppearance(false); }
  };

  const startExport = async () => {
    setStartingExport(true);
    try { await onStartVideoExport(settings, appearance); }
    finally { setStartingExport(false); }
  };

  const setCodec = (codec: VideoCodec) => setSettings((current) => ({ ...current, codec, encoder: 'auto' }));
  const setEncoder = (encoder: VideoEncoderPreference) => setSettings((current) => ({ ...current, encoder }));

  return <div className="export-workspace">
    <div className="export-workspace-head">
      <div><strong>Export</strong><span>Keep captions editable as SRT, or render a finished MP4 with the appearance baked into the picture.</span></div>
      <button onClick={() => void loadCapabilities(true)} disabled={loadingCapabilities} title="Recheck local video encoders and fonts"><RefreshCw className={loadingCapabilities ? 'spin' : ''} size={14}/>Recheck</button>
    </div>

    <div className="export-paths">
      <section className="export-path-card">
        <div className="export-path-title"><Download size={19}/><div><strong>Captions file</strong><span>SRT · editable in compatible caption and video apps</span></div></div>
        <p>Includes caption text and timing. Font, color, size, position and animation remain controlled by the destination editing app.</p>
        <button disabled={!project.captions.length || busy} onClick={onExportSrt}><Download size={14}/>Download SRT</button>
      </section>

      <section className="export-path-card video-path">
        <div className="export-path-title"><Film size={19}/><div><strong>Captioned video</strong><span>MP4 · finished appearance included in the picture</span></div></div>
        <p>Studio renders a new local video. The original media is never overwritten, and the exported captions are no longer separately editable inside the MP4.</p>
        {activeExportJob && <div className="export-active"><LoaderCircle className="spin" size={15}/><div><strong>{activeExportJob.message}</strong><span>{activeExportJob.progress}% · you can keep editing while this saved snapshot renders</span></div></div>}
      </section>
    </div>

    {loadingCapabilities && <div className="export-status"><LoaderCircle className="spin" size={16}/>Checking video, color, encoders, Khmer fonts and disk space…</div>}
    {capabilityError && <div className="export-block"><TriangleAlert size={17}/><div><strong>Video export check failed</strong><span>{capabilityError}</span></div></div>}
    {capabilities && !capabilities.supported && <div className="export-block"><TriangleAlert size={17}/><div><strong>Captioned video is blocked for this source</strong><span>{capabilities.blockingReason}</span></div></div>}

    {capabilities && <>
      <section className="export-section">
        <div className="export-section-title"><div><strong>Video quality</strong><span>Match source is safest. Higher-than-source resolutions are allowed but are clearly marked as upscaled.</span></div>{source && <span className="export-source-chip">Source {source.displayWidth}×{source.displayHeight} · {source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps · {source.hdr === 'sdr' ? 'SDR' : source.hdr.toUpperCase()}</span>}</div>

        <div className="export-resolution-grid">
          {capabilities.resolutions.map((item) => <button key={item.id} className={settings.resolution === item.id ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, resolution: item.id }))}>
            <strong>{item.label}</strong><span>{item.width}×{item.height}{item.upscaled ? ' · Upscaled' : ''}</span>
          </button>)}
        </div>

        <div className="export-inline-controls">
          <label><span>Frame rate</span><select value={String(settings.frameRate)} onChange={(event) => setSettings((current) => ({ ...current, frameRate: event.target.value === 'source' ? 'source' : Number(event.target.value) as VideoFrameRatePreset }))}>
            {(['source', 24, 25, 30, 50, 60] as VideoFrameRatePreset[]).map((value) => <option key={String(value)} value={String(value)}>{frameRateLabel(value, source?.frameRate || 0)}</option>)}
          </select></label>
          <div className="export-quality-choice"><span>Quality</span><div>{(['smaller', 'recommended', 'high'] as VideoQualityPreset[]).map((quality) => <button key={quality} className={settings.quality === quality ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, quality, customBitrateMbps: undefined }))}>{qualityCopy[quality]}</button>)}</div></div>
        </div>

        <details className="export-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary>Advanced codec and bitrate</summary>
          <div className="export-advanced-grid">
            <label><span>Codec</span><select value={settings.codec} onChange={(event) => setCodec(event.target.value as VideoCodec)}><option value="h264">H.264 · widest compatibility</option>{hevcAvailable && <option value="hevc">HEVC / H.265 · smaller at similar quality</option>}</select></label>
            <label><span>Encoder</span><select value={settings.encoder} onChange={(event) => setEncoder(event.target.value as VideoEncoderPreference)}><option value="auto">Auto · prefer verified GPU encoder</option>{availableEncoders.map((encoder) => <option key={`${encoder.codec}-${encoder.id}`} value={encoder.id}>{encoder.label}{encoder.hardware ? ' · hardware' : ' · CPU'}</option>)}</select></label>
            <label><span>Custom bitrate (Mbps)</span><input type="number" min="1" max="200" step="0.5" value={settings.customBitrateMbps ?? ''} placeholder="Use quality preset" onChange={(event) => setSettings((current) => ({ ...current, customBitrateMbps: event.target.value ? Math.max(1, Math.min(200, Number(event.target.value))) : undefined }))}/></label>
          </div>
          <span className="export-advanced-help">Auto performs a real one-frame encoder check on this PC. If a GPU encoder cannot actually initialize, Studio does not offer it.</span>
        </details>

        <div className="export-quality-summary">
          <div><Film size={15}/><span><b>{resolution ? `${resolution.width}×${resolution.height}` : 'Source'}</b> · {frameRateLabel(settings.frameRate, source?.frameRate || 0)} · {settings.codec.toUpperCase()}</span></div>
          <div><HardDrive size={15}/><span>Estimated output <b>≈ {bytes(estimatedBytes)}</b> · free space {bytes(capabilities.availableDiskBytes)}</span></div>
        </div>
      </section>

      <section className="export-section appearance-section">
        <div className="export-section-title"><div><strong>Caption appearance</strong><span>These controls affect Captioned video only. SRT export remains text + timing.</span></div><button className="quiet-action" onClick={() => setAppearance({ ...DEFAULT_CAPTION_APPEARANCE, fontFamily: availableFonts[0]?.name || DEFAULT_CAPTION_APPEARANCE.fontFamily })}><RotateCcw size={13}/>Reset</button></div>

        <div className="appearance-preview">
          <div className="appearance-safe-area"/>
          <div className={`appearance-preview-text align-${appearance.alignment}`} style={{
            bottom: `${appearance.positionBottomPct}%`,
            left: `${(100 - appearance.maxWidthPct) / 2}%`,
            right: `${(100 - appearance.maxWidthPct) / 2}%`,
            color: appearance.textColor,
            fontFamily: `'${appearance.fontFamily}', 'Noto Sans Khmer', sans-serif`,
            fontSize: `${Math.round(28 * sampleScale)}px`,
            fontWeight: appearance.bold ? 700 : 400,
            WebkitTextStroke: `${Math.max(0, appearance.outlineWidth1080 * 0.45)}px ${appearance.outlineColor}`,
            textShadow: appearance.shadowWidth1080 > 0 ? `0 ${Math.max(1, appearance.shadowWidth1080 * 0.45)}px ${Math.max(2, appearance.shadowWidth1080 * 1.4)}px rgba(0,0,0,.85)` : 'none',
            background: appearance.backgroundEnabled ? hexToRgba(appearance.backgroundColor, appearance.backgroundOpacity) : 'transparent',
            padding: appearance.backgroundEnabled ? `${Math.max(2, appearance.backgroundPadding1080 * 0.35)}px ${Math.max(4, appearance.backgroundPadding1080 * 0.7)}px` : 0,
          }}>{sampleText || 'សាកល្បងអក្សរខ្មែរ · Caption preview'}</div>
          <span className="appearance-preview-note">Browser preview · final MP4 uses the local FFmpeg/libass renderer</span>
        </div>

        <div className="appearance-grid">
          <label><span>Khmer font</span><select value={appearance.fontFamily} onChange={(event) => { const font = availableFonts.find((item) => item.name === event.target.value); setAppearance((current) => ({ ...current, fontFamily: event.target.value, bold: font?.boldAvailable ? current.bold : false })); }}>{availableFonts.map((font) => <option key={font.name} value={font.name}>{font.name}{font.boldAvailable ? '' : ' · regular only'}</option>)}</select></label>
          <label className="toggle-field"><span>Weight</span><button className={appearance.bold ? 'selected' : ''} disabled={!availableFonts.find((font) => font.name === appearance.fontFamily)?.boldAvailable} onClick={() => setAppearance((current) => ({ ...current, bold: !current.bold }))}>{appearance.bold ? 'Bold' : 'Regular'}</button></label>
          <label><span>Text color</span><input type="color" value={appearance.textColor} onChange={(event) => setAppearance((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label>
          <label><span>Outline color</span><input type="color" value={appearance.outlineColor} onChange={(event) => setAppearance((current) => ({ ...current, outlineColor: event.target.value.toUpperCase() }))}/></label>
          <label className="range-field"><span>Size <b>{appearance.fontSize1080}px @1080p</b></span><input type="range" min="22" max="120" value={appearance.fontSize1080} onChange={(event) => setAppearance((current) => ({ ...current, fontSize1080: Number(event.target.value) }))}/></label>
          <label className="range-field"><span>Outline <b>{appearance.outlineWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.outlineWidth1080} onChange={(event) => setAppearance((current) => ({ ...current, outlineWidth1080: Number(event.target.value) }))}/></label>
          <label className="range-field"><span>Shadow <b>{appearance.shadowWidth1080.toFixed(1)}</b></span><input type="range" min="0" max="12" step="0.5" value={appearance.shadowWidth1080} onChange={(event) => setAppearance((current) => ({ ...current, shadowWidth1080: Number(event.target.value) }))}/></label>
          <label className="range-field"><span>Max width <b>{appearance.maxWidthPct}%</b></span><input type="range" min="45" max="96" value={appearance.maxWidthPct} onChange={(event) => setAppearance((current) => ({ ...current, maxWidthPct: Number(event.target.value) }))}/></label>
          <label className="range-field"><span>Position from bottom <b>{appearance.positionBottomPct}%</b></span><input type="range" min="3" max="82" value={appearance.positionBottomPct} onChange={(event) => setAppearance((current) => ({ ...current, positionBottomPct: Number(event.target.value) }))}/></label>
          <label><span>Alignment</span><select value={appearance.alignment} onChange={(event) => setAppearance((current) => ({ ...current, alignment: event.target.value as CaptionAppearance['alignment'] }))}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
          <label className="toggle-field"><span>Background box</span><button className={appearance.backgroundEnabled ? 'selected' : ''} onClick={() => setAppearance((current) => ({ ...current, backgroundEnabled: !current.backgroundEnabled }))}>{appearance.backgroundEnabled ? 'On' : 'Off'}</button></label>
          {appearance.backgroundEnabled && <><label><span>Background color</span><input type="color" value={appearance.backgroundColor} onChange={(event) => setAppearance((current) => ({ ...current, backgroundColor: event.target.value.toUpperCase() }))}/></label><label className="range-field"><span>Background opacity <b>{Math.round(appearance.backgroundOpacity * 100)}%</b></span><input type="range" min="5" max="100" value={Math.round(appearance.backgroundOpacity * 100)} onChange={(event) => setAppearance((current) => ({ ...current, backgroundOpacity: Number(event.target.value) / 100 }))}/></label><label className="range-field"><span>Box padding <b>{appearance.backgroundPadding1080}px</b></span><input type="range" min="0" max="28" value={appearance.backgroundPadding1080} onChange={(event) => setAppearance((current) => ({ ...current, backgroundPadding1080: Number(event.target.value) }))}/></label></>}
        </div>
        <div className="appearance-actions"><button disabled={savingAppearance || busy} onClick={() => void saveAppearance()}><Save size={14}/>{savingAppearance ? 'Saving…' : 'Save appearance'}</button><span>Appearance is stored with this project and never changes SRT output.</span></div>
      </section>

      {capabilities.warnings.length > 0 && <div className="export-warnings">{capabilities.warnings.map((warning) => <div key={warning}><TriangleAlert size={13}/><span>{warning}</span></div>)}</div>}

      <div className="export-finalize">
        <div><ShieldCheck size={18}/><div><strong>Non-destructive export</strong><span>Studio renders to a partial file, verifies dimensions, duration, audio and decode health, then atomically publishes the finished MP4.</span></div></div>
        <button className="primary" disabled={exportBlocked} onClick={() => void startExport()}>{startingExport ? <LoaderCircle className="spin" size={16}/> : <Film size={16}/>} {activeExportJob ? 'Export already running' : startingExport ? 'Starting…' : 'Export captioned video'}</button>
      </div>
    </>}
  </div>;
}
