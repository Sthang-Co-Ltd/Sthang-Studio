import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  normalizeCaptionAppearance, estimateVideoExportBytes, isVideoProject, resolveCaptionWordTiming,
  type CaptionAppearance,
  type CaptionProject,
  type CaptionLayoutCheckResult,
  type ProcessingJob,
  type VideoCodec,
  type VideoEncoderPreference,
  type VideoExportCapabilities,
  type VideoExportSettings,
  type VideoFrameRatePreset,
  type VideoQualityPreset,
  type VideoResolutionPreset,
} from '@kcs/shared';
import { Download, FileText, Film, HardDrive, LoaderCircle, Palette, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { waitForCaptionAppearanceSaves } from '../caption-appearance-save';
import { CaptionHandoffPanel } from './CaptionHandoffPanel';
import { CaptionRestoreReview, type CaptionRestoreReviewState } from './CaptionRestoreReview';
import type { CaptionFileFormat } from '../caption-handoff-client';
import type { ReviewIssue } from '../review';
import type { ExportWorkspaceSession } from '../export-session';
import { buildExportCaptionIssues, exportLayoutKey, type ExportCheckIssue, type ExportRepairTarget } from '../export-checks';
import { ExportChecksPanel, type ExportLayoutState } from './ExportChecksPanel';
import './video-export.css';

interface Props {
  project: CaptionProject;
  busy: boolean;
  activeExportJob?: ProcessingJob;
  onExportCaptions(format: CaptionFileFormat): Promise<boolean>;
  onImportCaptionData(file: File): Promise<void>;
  captionImportPreview?: CaptionRestoreReviewState;
  onApplyCaptionImport(): void;
  onCancelCaptionImport(): void;
  onEditAppearance(): void;
  onEditWordTiming?(id?: string): void;
  onPreviewResolution(resolution: VideoResolutionPreset): void;
  onStartVideoExport(settings: VideoExportSettings, appearance: CaptionAppearance, isCurrent: () => boolean): Promise<ProcessingJob | null>;
  session: ExportWorkspaceSession;
  onSessionChange: Dispatch<SetStateAction<ExportWorkspaceSession>>;
  onRepair(target: ExportRepairTarget): void;
  reviewIssues: ReviewIssue[];
  unsaved: boolean;
  saveBlocked: boolean;
  fontRevision: number;
}

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

function frameRateLabel(value: VideoFrameRatePreset, source: number) {
  return value === 'source' ? `Match source (${source > 0 ? source.toFixed(source % 1 ? 2 : 0) : 'auto'} fps)` : `${value} fps`;
}

function resolutionLabel(item: VideoExportCapabilities['resolutions'][number]) {
  const label = item.id === 'source' ? 'Match source' : item.label;
  return `${label} · ${item.width}×${item.height}${item.upscaled ? ' · Upscaled' : ''}`;
}

function elapsedLabel(job: ProcessingJob) {
  if (!job.startedAt) return '';
  const started = Date.parse(job.startedAt);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m elapsed`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
  return `${seconds}s elapsed`;
}

export function ExportWorkspace({ project, busy, activeExportJob, onExportCaptions, onImportCaptionData, captionImportPreview,
  onApplyCaptionImport, onCancelCaptionImport, onEditAppearance, onEditWordTiming, onStartVideoExport, onPreviewResolution,
  session, onSessionChange, onRepair, reviewIssues, unsaved, saveBlocked, fontRevision }: Props) {
  const videoProject = isVideoProject(project);
  const { outputMode, settings, advancedOpen } = session;
  const setOutputMode = (mode: ExportWorkspaceSession['outputMode']) => onSessionChange((current) => ({ ...current, outputMode: mode }));
  const setSettings: Dispatch<SetStateAction<VideoExportSettings>> = (value) => onSessionChange((current) => ({ ...current,
    settings: typeof value === 'function' ? value(current.settings) : value }));
  const setAdvancedOpen = (open: boolean) => onSessionChange((current) => ({ ...current, advancedOpen: open }));
  const [capabilities, setCapabilities] = useState<VideoExportCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(videoProject);
  const [capabilityError, setCapabilityError] = useState('');
  const [actionError, setActionError] = useState('');
  const [appearance, setAppearance] = useState<CaptionAppearance>(normalizeCaptionAppearance(project.captionAppearance));
  const [appearanceSaveBlocked, setAppearanceSaveBlocked] = useState(false);
  const [startingExport, setStartingExport] = useState(false);
  const [loadingAppearance, setLoadingAppearance] = useState(videoProject);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const [layoutCheck, setLayoutCheck] = useState<{ key: string; result?: CaptionLayoutCheckResult; error?: string } | null>(null);
  const [checkingLayoutKey, setCheckingLayoutKey] = useState<string | null>(null);
  const layoutRequest = useRef<AbortController | null>(null);
  const startRequest = useRef(0);
  useEffect(() => () => { startRequest.current += 1; }, []);
  useEffect(() => { document.getElementById('export-checks-heading')?.focus({ preventScroll: true }); }, []);

  const capabilityRequest = useRef(0);
  useEffect(() => { onPreviewResolution(outputMode === 'video' ? settings.resolution : 'source'); }, [outputMode, settings.resolution, onPreviewResolution]);
  useEffect(() => () => { capabilityRequest.current += 1; onPreviewResolution('source'); }, [onPreviewResolution]);

  const loadCapabilities = async (refresh = false) => {
    if (!videoProject) {
      setCapabilities(null);
      setLoadingCapabilities(false);
      setCapabilityError('');
      return;
    }
    const request = ++capabilityRequest.current;
    setLoadingCapabilities(true);
    setCapabilityError('');
    if (refresh) setCapabilityRevision((current) => current + 1);
    try { const result = await api.videoExportCapabilities(project.id, refresh); if (request === capabilityRequest.current) setCapabilities(result); }
    catch (error) { if (request === capabilityRequest.current) { setCapabilities(null); setCapabilityError(error instanceof Error ? error.message : 'Could not inspect video export support'); } }
    finally { if (request === capabilityRequest.current) setLoadingCapabilities(false); }
  };

  useEffect(() => {
    let active = true;
    setAppearance(normalizeCaptionAppearance(project.captionAppearance));
    setLoadingAppearance(videoProject);
    setAppearanceSaveBlocked(false);
    setCapabilities(null);
    setCapabilityError('');
    setActionError('');
    void loadCapabilities(fontRevision > 0);
    void (async () => {
      const saved = await waitForCaptionAppearanceSaves(project.id, project.media);
      if (!active) return;
      if (!saved) {
        setAppearanceSaveBlocked(true);
        setActionError('Your latest caption appearance could not be saved. Return to Appearance and retry before rendering.');
        setLoadingAppearance(false);
        return;
      }
      try {
        const fresh = await api.get(project.id);
        if (active) setAppearance(normalizeCaptionAppearance(fresh.captionAppearance));
      } catch {
        if (active) {
          setAppearanceSaveBlocked(true);
          setActionError('Could not load the latest saved caption appearance. Reopen Export to try again.');
        }
      } finally {
        if (active) setLoadingAppearance(false);
      }
    })();
    return () => { active = false; };
  }, [project.id, project.media.filename, project.media.size, fontRevision]);

  useEffect(() => {
    if (!capabilities) return;
    const codecAvailable = capabilities.encoders.some((encoder) => encoder.codec === settings.codec && encoder.available);
    if (!codecAvailable && settings.codec === 'hevc') setSettings((current) => ({ ...current, codec: 'h264', encoder: 'auto' }));
  }, [capabilities]);

  const resolution = useMemo(() => capabilities?.resolutions.find((item) => item.id === settings.resolution), [capabilities, settings.resolution]);
  const estimatedBytes = useMemo(() => capabilities ? estimateVideoExportBytes(capabilities.source, settings) : 0, [capabilities, settings]);
  const availableEncoders = useMemo(() => capabilities?.encoders.filter((item) => item.codec === settings.codec && item.available) || [], [capabilities, settings.codec]);
  const hevcAvailable = Boolean(capabilities?.encoders.some((encoder) => encoder.codec === 'hevc' && encoder.available));
  const source = capabilities?.source;
  const appearanceFontUnavailable = Boolean(capabilities && !capabilities.fonts.some((font) => font.available && font.name === appearance.fontFamily && (!appearance.bold || font.boldAvailable)));
  const plainWordCaptions = useMemo(() => appearance.highlightMode === 'word'
    ? project.captions.filter((caption) => caption.text.trim() && resolveCaptionWordTiming(caption).state !== 'ready') : [], [project.captions, appearance.highlightMode]);
  const selectedFormat = outputMode === 'video' ? 'video' : session.handoff.advancedFormat || 'srt';
  const checksAppearance = outputMode === 'video' || selectedFormat === 'ass';
  const layoutResolution = outputMode === 'video' ? settings.resolution : 'source';
  const layoutKey = useMemo(() => exportLayoutKey({ projectId: project.id, media: project.media, captions: project.captions,
    appearance, resolution: layoutResolution, fontRevision, capabilityRevision }),
  [project.id, project.media.filename, project.media.size, project.captions, appearance, layoutResolution, fontRevision, capabilityRevision]);
  const currentLayoutKey = useRef(layoutKey);
  currentLayoutKey.current = layoutKey;
  const startContext = useMemo(() => JSON.stringify([layoutKey, outputMode, settings]), [layoutKey, outputMode, settings]);
  const currentStartContext = useRef(startContext);
  currentStartContext.current = startContext;
  useEffect(() => {
    layoutRequest.current?.abort();
    layoutRequest.current = null;
    setCheckingLayoutKey(null);
    return () => { layoutRequest.current?.abort(); layoutRequest.current = null; };
  }, [layoutKey, checksAppearance]);
  const currentLayout = layoutCheck?.key === layoutKey ? layoutCheck : null;
  const layoutState: ExportLayoutState = checkingLayoutKey === layoutKey ? 'checking'
    : currentLayout?.error || currentLayout?.result?.status === 'unavailable' ? 'error'
      : currentLayout?.result?.status === 'blocked' ? 'blocked'
        : currentLayout?.result?.status === 'passed' ? 'passed'
          : layoutCheck ? 'stale' : 'unchecked';
  const layoutMessage = currentLayout?.error || (currentLayout?.result?.status === 'unavailable'
    ? currentLayout.result.issues.map((issue) => issue.message).join(' ') : undefined);

  // Match the handoff serializer's persisted duration authority. The editor's
  // actual playback-duration QA remains separate advisory evidence.
  const fileDurationMs = project.transcript?.timing?.audioDurationMs;
  const captionIssues = useMemo(() => buildExportCaptionIssues({ captions: project.captions, reviewIssues, format: selectedFormat,
    appearance, durationMs: fileDurationMs }), [project.captions, reviewIssues, selectedFormat, appearance, fileDurationMs]);
  const invalidCaptionFiles = useMemo(() => buildExportCaptionIssues({ captions: project.captions, reviewIssues: [], format: 'srt',
    appearance, durationMs: fileDurationMs }).some((issue) => issue.severity === 'blocker'), [project.captions, appearance, fileDurationMs]);
  const checkIssues = useMemo(() => {
    const native: ExportCheckIssue[] = checksAppearance && currentLayout?.result?.status === 'blocked'
      ? currentLayout.result.issues.map((issue, index) => ({ id: `layout:${index}:${issue.captionIds.join(':')}`, severity: 'blocker',
        title: issue.captionIds.length > 1 ? 'Overlapping captions extend outside the frame' : 'Caption layout needs attention',
        reasons: [issue.message], remedy: 'Inspect this caption in Appearance. Reduce Size, increase Max width, or adjust its position, then return and check again.',
        captionIds: issue.captionIds, repair: 'appearance' })) : [];
    if (checksAppearance && appearanceFontUnavailable) native.unshift({ id: 'font', severity: 'blocker', title: 'Saved font selection is unavailable',
      reasons: [`${appearance.fontFamily}${appearance.bold ? ' Bold' : ''} is not available for this output.`],
      remedy: 'Choose an available Khmer font or weight in Appearance. Studio will keep your selection until you change it.', captionIds: [], repair: 'appearance' });
    return [...native, ...captionIssues];
  }, [checksAppearance, currentLayout, appearanceFontUnavailable, appearance, captionIssues]);
  const nativeLayoutBlocked = checksAppearance && currentLayout?.result?.status === 'blocked';
  const exportBlocked = Boolean(!videoProject || !capabilities?.supported || loadingCapabilities || loadingAppearance
    || appearanceSaveBlocked || appearanceFontUnavailable || nativeLayoutBlocked || saveBlocked
    || activeExportJob || busy || startingExport || checkingLayoutKey || !project.captions.some((caption) => caption.text.trim()));

  const checkLayout = async () => {
    if (layoutRequest.current || !videoProject || loadingAppearance || startingExport || !capabilities?.subtitlesFilter || appearanceSaveBlocked || appearanceFontUnavailable) return;
    const key = layoutKey;
    const controller = new AbortController();
    layoutRequest.current = controller;
    setCheckingLayoutKey(key);
    try {
      const result = await api.checkCaptionLayout(project.id, { captions: project.captions, appearance, resolution: layoutResolution,
        expectedMedia: { filename: project.media.filename, size: project.media.size } }, controller.signal);
      if (!controller.signal.aborted && layoutRequest.current === controller && currentLayoutKey.current === key) setLayoutCheck({ key, result });
    } catch (error) {
      if (!controller.signal.aborted && layoutRequest.current === controller && currentLayoutKey.current === key) {
        setLayoutCheck({ key, error: error instanceof Error ? error.message : 'Could not check the caption layout. Try again.' });
      }
    } finally {
      if (layoutRequest.current === controller) { layoutRequest.current = null; setCheckingLayoutKey(null); }
    }
  };
  const cancelLayoutCheck = () => {
    layoutRequest.current?.abort();
    layoutRequest.current = null;
    setCheckingLayoutKey(null);
    setLayoutCheck({ key: layoutKey, error: 'Layout check cancelled. Run it again when you are ready.' });
  };

  const startExport = async () => {
    if (exportBlocked) return;
    const request = ++startRequest.current;
    const context = startContext;
    const active = () => startRequest.current === request && currentStartContext.current === context;
    setStartingExport(true);
    setActionError('');
    try {
      const saved = await waitForCaptionAppearanceSaves(project.id, project.media);
      if (!active()) return;
      if (!saved) {
        setAppearanceSaveBlocked(true);
        setActionError('Your latest caption appearance could not be saved. Return to Appearance and retry before rendering.');
        return;
      }
      const fresh = await api.get(project.id);
      if (!active()) return;
      if (fresh.media.filename !== project.media.filename || fresh.media.size !== project.media.size) {
        setActionError('The source changed while preparing export. Reopen the project before rendering.');
        return;
      }
      const latestAppearance = normalizeCaptionAppearance(fresh.captionAppearance);
      setAppearance(latestAppearance);
      setAppearanceSaveBlocked(false);
      const fontUnavailable = Boolean(capabilities && !capabilities.fonts.some((font) => font.available && font.name === latestAppearance.fontFamily && (!latestAppearance.bold || font.boldAvailable)));
      if (fontUnavailable) {
        setActionError(`Studio can't export with the saved font selection (${latestAppearance.fontFamily}${latestAppearance.bold ? ' Bold' : ''}). Choose an available Khmer font or weight in Appearance.`);
        return;
      }
      await onStartVideoExport(settings, latestAppearance, active);
    } catch (error) {
      if (active()) setActionError(error instanceof Error ? error.message : 'Could not start video export');
    } finally { if (startRequest.current === request) setStartingExport(false); }
  };

  const setCodec = (codec: VideoCodec) => setSettings((current) => ({ ...current, codec, encoder: 'auto' }));
  const setEncoder = (encoder: VideoEncoderPreference) => setSettings((current) => ({ ...current, encoder }));

  return <div className="export-workspace">
    <div className="export-workspace-head">
      <div><strong>Export</strong><span>Choose a file or captioned video. Edit the look in Appearance.</span></div>
      {videoProject && outputMode === 'video' && <button onClick={() => void loadCapabilities(true)} disabled={loadingCapabilities} title="Recheck video export support"><RefreshCw className={loadingCapabilities ? 'spin' : ''} size={14}/>Recheck</button>}
    </div>

    <div className="export-mode-switch" role="group" aria-label="Export type">
      <button aria-pressed={outputMode === 'video'} disabled={!videoProject} onClick={() => setOutputMode('video')}><Film size={16}/><span>Captioned video</span><small>MP4</small></button>
      <button aria-pressed={outputMode === 'captions'} onClick={() => setOutputMode('captions')}><FileText size={16}/><span>Captions file</span><small>SRT</small></button>
    </div>

    {!videoProject && <p className="export-mode-help">Audio projects can export editable caption files. Captioned video requires a video source.</p>}

    {!captionImportPreview && <ExportChecksPanel captions={project.captions} issues={checkIssues} onRepair={onRepair}
      unsaved={unsaved} saveBlocked={saveBlocked}
      {...(videoProject && checksAppearance ? { layoutState, layoutMessage, onCheckLayout: () => void checkLayout(), onCancelLayout: cancelLayoutCheck,
        layoutDisabled: loadingCapabilities || loadingAppearance || !capabilities?.subtitlesFilter || appearanceSaveBlocked || appearanceFontUnavailable || busy || startingExport } : {})}/>}

    {outputMode === 'captions' && (captionImportPreview
      ? <CaptionRestoreReview review={captionImportPreview} busy={busy} onApply={onApplyCaptionImport} onCancel={onCancelCaptionImport}/>
      : <CaptionHandoffPanel project={project} busy={busy} onExport={onExportCaptions} onImport={onImportCaptionData}
          session={session.handoff} onSessionChange={(handoff) => onSessionChange((current) => ({ ...current, handoff }))}
          saveBlocked={saveBlocked} invalidCaptions={invalidCaptionFiles}
          selectedFormatBlocked={captionIssues.some((issue) => issue.severity === 'blocker')}
          styledLayoutBlocked={Boolean(appearanceFontUnavailable || nativeLayoutBlocked || appearanceSaveBlocked)}
          onEditWordTiming={onEditWordTiming} onRenderedVideo={videoProject ? () => setOutputMode('video') : undefined}/>)}

    {outputMode === 'video' && <>
      {activeExportJob && <div className="export-active" role="status"><LoaderCircle className="spin" size={15}/><div><strong>{activeExportJob.message}</strong><span>{activeExportJob.progress}%{elapsedLabel(activeExportJob) ? ` · ${elapsedLabel(activeExportJob)}` : ''} · keep editing while this snapshot renders</span><div className="export-active-progress" aria-label={`${activeExportJob.progress}% complete`}><i style={{ width: `${activeExportJob.progress}%` }}/></div></div></div>}
      {loadingCapabilities && <div className="export-status" role="status"><LoaderCircle className="spin" size={16}/>Checking video export support…</div>}
      {capabilityError && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Video export check failed</strong><span>{capabilityError}</span></div></div>}
      {actionError && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Export needs attention</strong><span>{actionError}</span></div></div>}
      {capabilities && !capabilities.supported && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Captioned video is blocked for this source</strong><span>{capabilities.blockingReason}</span></div></div>}

      {capabilities?.supported && <>
        <section className="export-section" aria-labelledby="video-quality-title">
          <div className="export-section-title"><div><strong id="video-quality-title">Video</strong><span>For most videos, use Match source + Recommended.</span></div>{source && <span className="export-source-chip">{source.displayWidth}×{source.displayHeight} · {source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps · {source.hdr === 'sdr' ? 'SDR' : source.hdr.toUpperCase()}</span>}</div>

          <div className="export-setting-grid">
            <label htmlFor="export-resolution-select">
              <span>Resolution</span>
              <select id="export-resolution-select" aria-label="Resolution" value={settings.resolution} onChange={(event) => setSettings((current) => ({ ...current, resolution: event.target.value as VideoExportSettings['resolution'] }))}>
                {capabilities.resolutions.map((item) => <option key={item.id} value={item.id}>{resolutionLabel(item)}</option>)}
              </select>
            </label>
            <label htmlFor="export-framerate-select">
              <span>Frame rate</span>
              <select id="export-framerate-select" aria-label="Frame rate" value={String(settings.frameRate)} onChange={(event) => setSettings((current) => ({ ...current, frameRate: event.target.value === 'source' ? 'source' : Number(event.target.value) as VideoFrameRatePreset }))}>
                {(['source', 24, 25, 30, 50, 60] as VideoFrameRatePreset[]).map((value) => <option key={String(value)} value={String(value)}>{frameRateLabel(value, source?.frameRate || 0)}</option>)}
              </select>
            </label>
            <div className="export-quality-choice"><span>Quality</span><div role="group" aria-label="Video quality">{(['smaller', 'recommended', 'high'] as VideoQualityPreset[]).map((quality) => <button key={quality} aria-pressed={settings.quality === quality} className={settings.quality === quality ? 'selected' : ''} onClick={() => setSettings((current) => ({ ...current, quality, customBitrateMbps: undefined }))}>{qualityCopy[quality]}</button>)}</div></div>
          </div>

          <div className="export-summary-line" aria-live="polite">
            <span><Film size={14}/><b>{resolution ? `${resolution.width}×${resolution.height}` : 'Source'}</b>{resolution?.upscaled ? ' · Upscaled' : ''} · {frameRateLabel(settings.frameRate, source?.frameRate || 0)} · {settings.codec.toUpperCase()}</span>
            <span><HardDrive size={14}/>≈ <b>{bytes(estimatedBytes)}</b> · {bytes(capabilities.availableDiskBytes)} free</span>
          </div>

          <details className="export-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>Advanced video settings</summary>
            <div className="export-advanced-grid">
              <label htmlFor="export-codec-select">
                <span>Codec</span>
                <select id="export-codec-select" aria-label="Codec" value={settings.codec} onChange={(event) => setCodec(event.target.value as VideoCodec)}>
                  <option value="h264">H.264 · widest compatibility</option>
                  {hevcAvailable && <option value="hevc">HEVC / H.265 · smaller at similar quality</option>}
                </select>
              </label>
              <label htmlFor="export-encoder-select">
                <span>Encoder</span>
                <select id="export-encoder-select" aria-label="Encoder" value={settings.encoder} onChange={(event) => setEncoder(event.target.value as VideoEncoderPreference)}>
                  <option value="auto">Auto · prefer verified GPU encoder</option>
                  {availableEncoders.map((encoder) => <option key={`${encoder.codec}-${encoder.id}`} value={encoder.id}>{encoder.label}{encoder.hardware ? ' · hardware' : ' · CPU'}</option>)}
                </select>
              </label>
              <label htmlFor="export-bitrate-input">
                <span>Custom bitrate (Mbps)</span>
                <input id="export-bitrate-input" aria-label="Custom bitrate (Mbps)" type="number" min="1" max="200" step="0.5" value={settings.customBitrateMbps ?? ''} placeholder="Use quality preset" onChange={(event) => setSettings((current) => ({ ...current, customBitrateMbps: event.target.value ? Math.max(1, Math.min(200, Number(event.target.value))) : undefined }))}/>
              </label>
            </div>
            <span className="export-advanced-help">Auto tests local encoders and uses a fallback if needed.</span>
          </details>
        </section>

        <section className="export-appearance-summary" aria-labelledby="export-appearance-title">
          <div className="export-appearance-copy"><Palette size={17}/><div><strong id="export-appearance-title">Caption appearance</strong><span><i className="export-color-swatch" style={{ background: appearance.textColor }} aria-hidden="true"/>{appearance.fontFamily} · {appearance.fontSize1080}px @1080p · {appearance.alignment} · {appearance.positionBottomPct}% from bottom{appearance.glowEnabled ? ' · Glow' : ''}{appearance.motionPreset && appearance.motionPreset !== 'none' ? ` · ${{ fade: 'Fade', rise: 'Rise', 'soft-pop': 'Soft Pop' }[appearance.motionPreset]} ${appearance.motionDurationMs} ms` : ''}</span></div></div>
          <button onClick={onEditAppearance}>Edit appearance</button>
        </section>

        {appearance.highlightMode === 'word' && <div className="export-warnings" role="status">
          <div><Palette size={14}/><span>Word highlights appear in captioned video.
            {plainWordCaptions.length > 0 ? ` ${plainWordCaptions.length} caption${plainWordCaptions.length === 1 ? '' : 's'} will remain plain because word timing needs review.` : ' All captions with text have usable word timing.'}</span></div>
          {plainWordCaptions.length > 0 && onEditWordTiming && <button type="button" onClick={() => onEditWordTiming(plainWordCaptions[0].id)}>Review word timing</button>}
        </div>}

        {appearanceFontUnavailable && <div className="export-block" role="alert"><TriangleAlert size={17}/><div><strong>Font selection unavailable</strong><span>Studio can't export with the saved font selection ({appearance.fontFamily}{appearance.bold ? ' Bold' : ''}). Choose an available Khmer font or weight in Appearance; Studio won't substitute another.</span></div></div>}

        {capabilities.warnings.length > 0 && <div className="export-warnings" aria-label="Video export notices">{capabilities.warnings.map((warning) => <div key={warning}><TriangleAlert size={14}/><span>{warning}</span></div>)}</div>}

        <div className="export-finalize">
          <div><ShieldCheck size={17}/><span>Your source stays unchanged. Studio renders from a snapshot of your captions, appearance and settings, then verifies the file.</span></div>
          <button className="primary" disabled={exportBlocked} onClick={() => void startExport()}>{startingExport ? <LoaderCircle className="spin" size={16}/> : <Film size={16}/>} {activeExportJob ? 'Export already running' : startingExport ? 'Starting…' : 'Render captioned video'}</button>
        </div>
      </>}
    </>}
  </div>;
}
