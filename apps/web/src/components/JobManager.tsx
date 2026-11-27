import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { useEffect, useRef, useState } from 'react';
import type { CaptionProject, ProcessingJob } from '@kcs/shared';
import { ExportJobFreshness } from './ExportHistory';
import type { AppearanceReconciliation } from '../caption-appearance-reconciliation';
import { Ban, CheckCircle2, CircleAlert, Clock3, Download, LoaderCircle, Play, RefreshCw, X } from 'lucide-react';
import { JOBS_UPDATED_EVENT } from '../api';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';
import './job-manager.css';

interface Props {
  open: boolean;
  entryJobId: string | null;
  uncertainProject?: string;
  jobs: ProcessingJob[];
  loadState: { loading: boolean; loaded: boolean; error: string };
  pendingActions: Readonly<Partial<Record<string, 'resume' | 'cancel'>>>;
  openingJobId?: string | null;
  blockedSave?: { id: string; message: string };
  onReturnToEdits(): void;
  project?: CaptionProject;
  appearanceReconciliation: AppearanceReconciliation;
  onClose(): void;
  onRefresh(feedback?: boolean): void;
  onResume(id: string): Promise<boolean | undefined>;
  onCancel(id: string): Promise<boolean | undefined>;
  onOpen(job: ProcessingJob): void;
  getResultFocusTarget(): HTMLElement | null;
}

function isStopping(job: ProcessingJob) {
  return job.status === 'running' && job.message.toLocaleLowerCase('en').startsWith('cancellation requested');
}

function activityLabelKey(job: ProcessingJob) {
  if (job.type === 'export-video' && job.status === 'interrupted') {
    if (job.stage === 'checking-export-completion') return 'activity.checkingOutput';
    if (job.stage === 'export-completion-uncertain') return 'activity.completionUncertain';
  }
  if (job.status === 'queued') return 'activity.waiting';
  if (isStopping(job)) return 'activity.stopping';
  if (job.status === 'running') return 'activity.working';
  if (job.status === 'completed') return 'activity.completed';
  if (job.status === 'cancelled') return 'activity.cancelled';
  if (job.status === 'interrupted') return 'activity.interrupted';
  return 'activity.needsAttention';
}

function jobLabelKey(job: ProcessingJob) {
  if (job.type === 'transcribe') return 'activity.generate';
  if (job.type === 'export-video') return 'activity.export';
  if (job.type === 'refine-proposal') return 'activity.refine';
  return 'activity.improve';
}

function icon(job: ProcessingJob) {
  if (job.status === 'queued') return <Clock3 size={16}/>;
  if (job.status === 'running') return <LoaderCircle className="spin" size={16}/>;
  if (job.status === 'completed') return <CheckCircle2 size={16}/>;
  if (job.status === 'cancelled') return <Ban size={16}/>;
  return <CircleAlert size={16}/>;
}

function downloadExport(job: ProcessingJob) {
  if (!job.resultExport) return;
  const anchor = document.createElement('a');
  anchor.href = job.resultExport.url;
  anchor.download = job.resultExport.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function jobDurationMs(job: ProcessingJob, now: number) {
  if (!job.startedAt) return 0;
  const start = Date.parse(job.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = job.completedAt
    ? Date.parse(job.completedAt)
    : job.status === 'running'
      ? now
      : Date.parse(job.updatedAt);
  return Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 1) return '<1s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function JobManager({ open, entryJobId, uncertainProject, jobs, loadState, pendingActions, openingJobId, blockedSave, onReturnToEdits, project, appearanceReconciliation, onClose, onRefresh, onResume, onCancel, onOpen, getResultFocusTarget }: Props) {
  const { locale, t, tr } = useI18n();
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  const entryCard = useRef<HTMLElement | null>(null);
  useModalFocus(open, dialog, onClose, entryCard, getResultFocusTarget);
  const [actionErrors, setActionErrors] = useState<Record<string, { observation: string; action: 'resume' | 'cancel' }>>({});
  async function act(job: ProcessingJob, action: 'resume' | 'cancel', button: HTMLButtonElement) {
    if (pendingActions[job.id]) return;
    const card = button.closest('article');
    if (document.activeElement === button) card?.focus({ preventScroll: true });
    setActionErrors((current) => {
      const next = { ...current };
      delete next[job.id];
      return next;
    });
    const confirmed = await (action === 'resume' ? onResume(job.id) : onCancel(job.id));
    if (confirmed !== false) return;
    setActionErrors((current) => ({ ...current, [job.id]: { observation: job.status, action } }));
    if (button.isConnected && card === document.activeElement) button.focus({ preventScroll: true });
  }
  const [now, setNow] = useState(Date.now());
  const [exportDirectory, setExportDirectory] = useState('');
  const [exportDirectoryError, setExportDirectoryError] = useState<string | { key: 'activity.exportLocationHttpError'; status: number }
    | { key: 'activity.missingExportLocation' | 'activity.exportLocationError' }>('');
  const hasCompletedExport = jobs.some((job) => job.status === 'completed' && Boolean(job.resultExport)
    || job.type === 'export-video' && ['checking-export-completion', 'export-completion-uncertain'].includes(job.stage));

  useEffect(() => {
    const refresh = () => onRefresh();
    window.addEventListener(JOBS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(JOBS_UPDATED_EVENT, refresh);
  }, [onRefresh]);

  useEffect(() => {
    if (!open || !jobs.some((job) => job.status === 'running')) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, jobs]);

  useEffect(() => {
    if (!open || !hasCompletedExport) return;
    let cancelled = false;
    setExportDirectoryError('');
    void (async () => {
      try {
        const response = await fetch('/api/video-export/location');
        if (!response.ok) {
          if (!cancelled) {
            setExportDirectory('');
            setExportDirectoryError({ key: 'activity.exportLocationHttpError', status: response.status });
          }
          return;
        }
        const body = await response.json() as { directory?: string };
        const directory = String(body.directory || '').trim();
        if (!cancelled) {
          setExportDirectory(directory);
          if (!directory) setExportDirectoryError({ key: 'activity.missingExportLocation' });
        }
      } catch (error) {
        if (!cancelled) {
          setExportDirectory('');
          setExportDirectoryError(error instanceof Error ? error.message : { key: 'activity.exportLocationError' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, hasCompletedExport]);

  if (!presence.present) return null;
  const exportLocationError = typeof exportDirectoryError === 'string' ? exportDirectoryError
    : t(exportDirectoryError.key, 'status' in exportDirectoryError ? { status: exportDirectoryError.status } : {});
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const runningJobs = activeJobs.filter((job) => job.status === 'running');
  const queueSummary = runningJobs.length
    ? t('activity.runningHelp')
    : activeJobs.length
      ? t('activity.queuedHelp')
      : t('activity.recentHelp');

  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="activity-title" tabIndex={-1} className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head job-modal-head">
        <div className="job-modal-heading-copy"><strong id="activity-title">{t('activity.title')}</strong><span>{queueSummary}</span></div>
        <button className="job-modal-close" aria-label={t('activity.close')} title={t('activity.close')} onClick={onClose}><X size={18}/></button>
      </div>
      <div className="history-toolbar job-toolbar">
        <span role="status" aria-live="polite" aria-atomic="true">{openingJobId ? t('activity.openingSavedResult') : loadState.loading
          ? loadState.loaded ? t('activity.refreshing') : t('activity.loading')
          : loadState.error && !loadState.loaded ? t('activity.unavailable')
          : t(loadState.error ? 'activity.lastLoadedCount' : 'activity.count', { active: activeJobs.length, recent: jobs.length })}</span>
        <button aria-disabled={loadState.loading || undefined} aria-busy={loadState.loading || undefined} onClick={() => { if (!loadState.loading) onRefresh(true); }}><RefreshCw size={13}/>{loadState.error ? t('activity.retry') : t('activity.refresh')}</button>
      </div>
      {uncertainProject && <p className="job-outcome-message" role="status">{tr('activity.uncertain', { project: uncertainProject }, { b: (text) => <strong>{text}</strong> })}</p>}
      {loadState.error && <p className="job-load-error" role="alert">{loadState.error}{loadState.loaded ? t('activity.lastLoadedWarning') : ''}</p>}
      {appearanceReconciliation.value.status === 'error' && jobs.some((job) => job.projectId === project?.id && job.resultExport && job.exportContentFingerprint) && <div className="history-toolbar" role="status"><span>{t('activity.appearanceUnavailable')}</span><button onClick={() => void appearanceReconciliation.refresh()}>{t('activity.retryAppearance')}</button></div>}
      {hasCompletedExport && <div className="activity-export-location" aria-label={t('activity.exportLocation')} aria-live="polite">
        <span>{t('activity.exportFolder')}</span>
        <code title={exportDirectory || undefined}>{exportDirectory || exportLocationError || t('activity.loadingLocation')}</code>
      </div>}
      <div className="job-list" aria-busy={loadState.loading}>
        {jobs.map((job) => {
          const pending = pendingActions[job.id];
          const stopping = isStopping(job);
          const duration = jobDurationMs(job, now);
          const label = t(jobLabelKey(job));
          const status = t(activityLabelKey(job));
          const durationCopy = Number.isFinite(Date.parse(job.startedAt || ''))
            ? job.status === 'completed'
              ? t('activity.durationCompleted', { duration: formatDuration(duration) })
              : t('activity.durationElapsed', { duration: formatDuration(duration) })
            : '';
          const failedAction = actionErrors[job.id];
          return <article ref={entryJobId === job.id ? entryCard : undefined} tabIndex={-1} key={job.id} className={`job-${job.status}`} aria-label={t('activity.jobForProject', { job: label, project: job.projectTitle })}>
            <div className="job-status-icon" aria-hidden="true">{icon(job)}</div>
            <div className="job-copy">
              <div className="job-title-line"><strong>{label}</strong><span title={job.projectTitle}>{job.projectTitle}</span></div>
              <div className="job-meta">
                <span className="job-state">{status}</span>
                <span className="job-duration">{durationCopy}</span>
              </div>
              <p data-server-text>{job.message}</p>
              <div className="job-progress-line">
                <div className="job-progress" role="progressbar" aria-label={t('activity.progress', { job: label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} aria-valuetext={t('activity.progressStatus', { progress: job.progress, status })}><i style={{ width: `${job.progress}%` }}/></div>
                <span className="job-percent" aria-hidden="true">{job.progress}%</span>
              </div>
              {job.error && <em>{job.error}</em>}
              {job.status === 'completed' && job.resultExport && <ExportJobFreshness job={job} project={project} appearance={appearanceReconciliation.value}/>}
              <details className="job-details">
                <summary>{t('activity.details')}</summary>
                <dl>
                  <div><dt>{t('activity.stage')}</dt><dd data-server-text>{job.stage.replaceAll('-', ' ')}</dd></div>
                  <div><dt>{t('activity.updated')}</dt><dd><time dateTime={job.updatedAt}>{formatInterfaceDate(locale, job.updatedAt, { time: true })}</time></dd></div>
                  {job.resultExport && <div><dt>{t('activity.video')}</dt><dd>{t('activity.videoMetadata', { width: job.resultExport.width, height: job.resultExport.height, frameRate: job.resultExport.frameRate.toFixed(job.resultExport.frameRate % 1 ? 2 : 0), size: (job.resultExport.sizeBytes / 1024 / 1024).toFixed(1) })}</dd></div>}
                </dl>
              </details>
              {failedAction?.observation === job.status && <p role="alert" className="job-action-error">{failedAction.action === 'resume' ? t('activity.resumeUnconfirmed') : t('activity.stopUnconfirmed')}</p>}
              {blockedSave?.id === job.id && <p role="alert" className="job-action-error">{blockedSave.message}</p>}
              <div className="job-actions">
                {job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button aria-disabled={openingJobId === job.id || undefined} aria-busy={openingJobId === job.id || undefined} onClick={() => { if (openingJobId !== job.id) onOpen(job); }}><Play size={13}/>{openingJobId === job.id ? t('activity.openingResult') : t('activity.openResult')}</button>}
                {blockedSave?.id === job.id && <button className="job-action-primary" onClick={onReturnToEdits}>{t('activity.returnToEdits')}</button>}
                {job.status === 'completed' && job.resultExport && <button className="job-action-primary" onClick={() => downloadExport(job)}><Download size={13}/>{t('activity.downloadVideo')}</button>}
                {job.status === 'completed' && job.resultExport && project?.id !== job.projectId && <button aria-disabled={openingJobId === job.id || undefined} aria-busy={openingJobId === job.id || undefined} onClick={() => { if (openingJobId !== job.id) onOpen(job); }}>{openingJobId === job.id ? t('activity.openingProject') : t('activity.openProject')}</button>}
                {job.canResume && <button aria-disabled={Boolean(pending) || undefined} aria-busy={pending === 'resume' || undefined} onClick={(event) => { if (!pending) void act(job, 'resume', event.currentTarget); }}><Play size={13}/>{pending === 'resume' ? t('activity.resuming') : t('activity.resume')}</button>}
                {['queued', 'running'].includes(job.status) && <button aria-disabled={Boolean(pending) || stopping || undefined} aria-busy={pending === 'cancel' || undefined} onClick={(event) => { if (!pending && !stopping) void act(job, 'cancel', event.currentTarget); }}><Ban size={13}/>{stopping ? t('activity.stoppingAction') : pending === 'cancel' ? t('activity.requestingStop') : t('activity.cancel')}</button>}
              </div>
            </div>
          </article>;
        })}
        {loadState.loaded && !loadState.loading && !loadState.error && !jobs.length && <div className="review-empty">{t('activity.empty')}</div>}
      </div>
    </section>
  </div>;
}
