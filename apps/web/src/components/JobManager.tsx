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

function activityLabel(job: ProcessingJob) {
  if (job.type === 'export-video' && job.status === 'interrupted') {
    if (job.stage === 'checking-export-completion') return 'Checking output';
    if (job.stage === 'export-completion-uncertain') return 'Completion uncertain';
  }
  if (job.status === 'queued') return 'Waiting';
  if (isStopping(job)) return 'Stopping';
  if (job.status === 'running') return 'Working';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'interrupted') return 'Interrupted';
  return 'Needs attention';
}

function jobLabel(job: ProcessingJob) {
  if (job.type === 'transcribe') return 'Generate captions';
  if (job.type === 'export-video') return 'Export captioned video';
  if (job.type === 'refine-proposal') return 'Refine regenerated captions';
  return 'Improve selected captions';
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
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  const entryCard = useRef<HTMLElement | null>(null);
  useModalFocus(open, dialog, onClose, entryCard, getResultFocusTarget);
  const [actionErrors, setActionErrors] = useState<Record<string, { observation: string; message: string }>>({});
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
    const message = action === 'resume' ? 'Could not confirm the resume request.' : 'Could not confirm the stop request.';
    setActionErrors((current) => ({ ...current, [job.id]: { observation: job.status, message } }));
    if (button.isConnected && card === document.activeElement) button.focus({ preventScroll: true });
  }
  const [now, setNow] = useState(Date.now());
  const [exportDirectory, setExportDirectory] = useState('');
  const [exportDirectoryError, setExportDirectoryError] = useState('');
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
        if (!response.ok) throw new Error(`Could not read the export location (${response.status}).`);
        const body = await response.json() as { directory?: string };
        const directory = String(body.directory || '').trim();
        if (!directory) throw new Error('Studio did not report an export location.');
        if (!cancelled) setExportDirectory(directory);
      } catch (error) {
        if (!cancelled) {
          setExportDirectory('');
          setExportDirectoryError(error instanceof Error ? error.message : 'Could not read the export location.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, hasCompletedExport]);

  if (!presence.present) return null;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const runningJobs = activeJobs.filter((job) => job.status === 'running');
  const queueSummary = runningJobs.length
    ? 'Caption and video export jobs update separately.'
    : activeJobs.length
      ? 'Queued work starts automatically.'
      : 'Recent caption and video export jobs.';

  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="activity-title" tabIndex={-1} className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head job-modal-head">
        <div className="job-modal-heading-copy"><strong id="activity-title">Activity</strong><span>{queueSummary}</span></div>
        <button className="job-modal-close" aria-label="Close Activity" title="Close Activity" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="history-toolbar job-toolbar">
        <span role="status" aria-live="polite" aria-atomic="true">{openingJobId ? 'Opening saved result… Close Activity to cancel.' : loadState.loading
          ? loadState.loaded ? 'Refreshing activity…' : 'Loading activity…'
          : loadState.error && !loadState.loaded ? 'Activity unavailable'
          : `${loadState.error ? 'Last loaded: ' : ''}${activeJobs.length} active · ${jobs.length} recent`}</span>
        <button aria-disabled={loadState.loading || undefined} aria-busy={loadState.loading || undefined} onClick={() => { if (!loadState.loading) onRefresh(true); }}><RefreshCw size={13}/>{loadState.error ? 'Retry activity' : 'Refresh'}</button>
      </div>
      {uncertainProject && <p className="job-outcome-message" role="status">Studio lost the reply for <strong>{uncertainProject}</strong>. Check its recent jobs before starting another.</p>}
      {loadState.error && <p className="job-load-error" role="alert">{loadState.error}{loadState.loaded ? ' The last loaded activity is still shown.' : ''}</p>}
      {appearanceReconciliation.value.status === 'error' && jobs.some((job) => job.projectId === project?.id && job.resultExport && job.exportContentFingerprint) && <div className="history-toolbar" role="status"><span>Current appearance could not be compared.</span><button onClick={() => void appearanceReconciliation.refresh()}>Retry appearance comparison</button></div>}
      {hasCompletedExport && <div className="activity-export-location" aria-label="Video export location" aria-live="polite">
        <span>Export folder</span>
        <code title={exportDirectory || undefined}>{exportDirectory || exportDirectoryError || 'Loading location…'}</code>
      </div>}
      <div className="job-list" aria-busy={loadState.loading}>
        {jobs.map((job) => {
          const pending = pendingActions[job.id];
          const stopping = isStopping(job);
          const duration = jobDurationMs(job, now);
          const durationCopy = Number.isFinite(Date.parse(job.startedAt || ''))
            ? job.status === 'completed'
              ? `Took ${formatDuration(duration)}`
              : `${formatDuration(duration)} elapsed`
            : '';
          const failedAction = actionErrors[job.id];
          return <article ref={entryJobId === job.id ? entryCard : undefined} tabIndex={-1} key={job.id} className={`job-${job.status}`} aria-label={`${jobLabel(job)} · ${job.projectTitle}`}>
            <div className="job-status-icon" aria-hidden="true">{icon(job)}</div>
            <div className="job-copy">
              <div className="job-title-line"><strong>{jobLabel(job)}</strong><span title={job.projectTitle}>{job.projectTitle}</span></div>
              <div className="job-meta">
                <span className="job-state">{activityLabel(job)}</span>
                <span className="job-duration">{durationCopy}</span>
              </div>
              <p>{job.message}</p>
              <div className="job-progress-line">
                <div className="job-progress" role="progressbar" aria-label={`${jobLabel(job)} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} aria-valuetext={`${job.progress}% · ${activityLabel(job)}`}><i style={{ width: `${job.progress}%` }}/></div>
                <span className="job-percent" aria-hidden="true">{job.progress}%</span>
              </div>
              {job.error && <em>{job.error}</em>}
              {job.status === 'completed' && job.resultExport && <ExportJobFreshness job={job} project={project} appearance={appearanceReconciliation.value}/>}
              <details className="job-details">
                <summary>Details</summary>
                <dl>
                  <div><dt>Stage</dt><dd>{job.stage.replaceAll('-', ' ')}</dd></div>
                  <div><dt>Updated</dt><dd><time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time></dd></div>
                  {job.resultExport && <div><dt>Video</dt><dd>{job.resultExport.width}×{job.resultExport.height} · {job.resultExport.frameRate.toFixed(job.resultExport.frameRate % 1 ? 2 : 0)} fps · {(job.resultExport.sizeBytes / 1024 / 1024).toFixed(1)} MB</dd></div>}
                </dl>
              </details>
              {failedAction?.observation === job.status && <p role="alert" className="job-action-error">{failedAction.message} Check the job status before trying again.</p>}
              {blockedSave?.id === job.id && <p role="alert" className="job-action-error">{blockedSave.message}</p>}
              <div className="job-actions">
                {job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button aria-disabled={openingJobId === job.id || undefined} aria-busy={openingJobId === job.id || undefined} onClick={() => { if (openingJobId !== job.id) onOpen(job); }}><Play size={13}/>{openingJobId === job.id ? 'Opening result…' : 'Open result'}</button>}
                {blockedSave?.id === job.id && <button className="job-action-primary" onClick={onReturnToEdits}>Return to edits</button>}
                {job.status === 'completed' && job.resultExport && <button className="job-action-primary" onClick={() => downloadExport(job)}><Download size={13}/>Download video</button>}
                {job.status === 'completed' && job.resultExport && project?.id !== job.projectId && <button aria-disabled={openingJobId === job.id || undefined} aria-busy={openingJobId === job.id || undefined} onClick={() => { if (openingJobId !== job.id) onOpen(job); }}>{openingJobId === job.id ? 'Opening project…' : 'Open project to compare'}</button>}
                {job.canResume && <button aria-disabled={Boolean(pending) || undefined} aria-busy={pending === 'resume' || undefined} onClick={(event) => { if (!pending) void act(job, 'resume', event.currentTarget); }}><Play size={13}/>{pending === 'resume' ? 'Resuming…' : 'Resume'}</button>}
                {['queued', 'running'].includes(job.status) && <button aria-disabled={Boolean(pending) || stopping || undefined} aria-busy={pending === 'cancel' || undefined} onClick={(event) => { if (!pending && !stopping) void act(job, 'cancel', event.currentTarget); }}><Ban size={13}/>{stopping ? 'Stopping…' : pending === 'cancel' ? 'Requesting stop…' : 'Cancel'}</button>}
              </div>
            </div>
          </article>;
        })}
        {loadState.loaded && !loadState.loading && !loadState.error && !jobs.length && <div className="review-empty">No jobs yet.</div>}
      </div>
    </section>
  </div>;
}
