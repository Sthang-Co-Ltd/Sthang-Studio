import { useEffect, useState } from 'react';
import type { ProcessingJob } from '@kcs/shared';
import { Ban, CheckCircle2, CircleAlert, Clock3, Download, LoaderCircle, Play, RefreshCw, X } from 'lucide-react';
import { JOBS_UPDATED_EVENT } from '../api';
import './job-manager.css';

interface Props {
  open: boolean;
  jobs: ProcessingJob[];
  onClose(): void;
  onRefresh(): void;
  onResume(id: string): void;
  onCancel(id: string): void;
  onOpen(job: ProcessingJob): void;
}

function isStopping(job: ProcessingJob) {
  return job.status === 'running' && job.message.toLocaleLowerCase('en').startsWith('cancellation requested');
}

function activityLabel(job: ProcessingJob) {
  if (job.status === 'queued') return 'Waiting';
  if (isStopping(job)) return 'Stopping';
  if (job.status === 'running') return 'Working';
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'interrupted') return 'Interrupted';
  return 'Needs attention';
}

function jobLabel(job: ProcessingJob) {
  if (job.type === 'transcribe') return 'Full caption generation';
  if (job.type === 'export-video') return 'Captioned video export';
  if (job.type === 'refine-proposal') return 'Regeneration refinement';
  return 'Selected-range regeneration';
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

export function JobManager({ open, jobs, onClose, onRefresh, onResume, onCancel, onOpen }: Props) {
  const [now, setNow] = useState(Date.now());
  const [exportDirectory, setExportDirectory] = useState('');
  const [exportDirectoryError, setExportDirectoryError] = useState('');
  const hasCompletedExport = jobs.some((job) => job.status === 'completed' && Boolean(job.resultExport));

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

  if (!open) return null;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const runningJobs = activeJobs.filter((job) => job.status === 'running');
  const queueSummary = runningJobs.length
    ? 'Caption processing and video exports update independently when both are active.'
    : activeJobs.length
      ? 'Work is queued and will start automatically.'
      : 'Recent caption processing and video exports.';

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head job-modal-head">
        <div className="job-modal-heading-copy"><strong>Activity</strong><span>{queueSummary}</span></div>
        <button className="job-modal-close" aria-label="Close Activity" title="Close Activity" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="history-toolbar job-toolbar"><span>{activeJobs.length} active · {jobs.length} recent</span><button onClick={onRefresh}><RefreshCw size={13}/>Refresh</button></div>
      {hasCompletedExport && <div className="activity-export-location" aria-label="Video export location" aria-live="polite">
        <span>Exports folder</span>
        <code title={exportDirectory || undefined}>{exportDirectory || exportDirectoryError || 'Loading location…'}</code>
      </div>}
      <div className="job-list">
        {jobs.map((job) => {
          const duration = jobDurationMs(job, now);
          const durationCopy = duration > 0
            ? job.status === 'completed'
              ? ` · Took ${formatDuration(duration)}`
              : job.status === 'running'
                ? ` · ${formatDuration(duration)} elapsed`
                : ` · ${formatDuration(duration)}`
            : '';
          return <article key={job.id} className={`job-${job.status}`}>
            <div className="job-status-icon" title={activityLabel(job)}>{icon(job)}</div>
            <div className="job-copy">
              <div className="job-title-line"><strong>{jobLabel(job)}</strong><span>{job.projectTitle}</span></div>
              <p>{job.message}</p>
              <div className="job-progress" aria-label={`${job.progress}% complete`}><i style={{ width: `${job.progress}%` }}/></div>
              <div className="job-meta">
                <small>{activityLabel(job)} · {job.stage.replaceAll('-', ' ')} · {job.progress}%{durationCopy} · {new Date(job.updatedAt).toLocaleTimeString()}</small>
                {job.resultExport && <small>{job.resultExport.width}×{job.resultExport.height} · {job.resultExport.frameRate.toFixed(job.resultExport.frameRate % 1 ? 2 : 0)} fps · {(job.resultExport.sizeBytes / 1024 / 1024).toFixed(1)} MB</small>}
              </div>
              {job.error && <em>{job.error}</em>}
              <div className="job-actions">
                {job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button onClick={() => onOpen(job)}><Play size={13}/>Open result</button>}
                {job.status === 'completed' && job.resultExport && <button className="job-action-primary" onClick={() => downloadExport(job)}><Download size={13}/>Download video</button>}
                {job.canResume && <button onClick={() => onResume(job.id)}><Play size={13}/>Resume</button>}
                {['queued', 'running'].includes(job.status) && <button onClick={() => onCancel(job.id)}><Ban size={13}/>Cancel</button>}
              </div>
            </div>
          </article>;
        })}
        {!jobs.length && <div className="review-empty">No activity yet.</div>}
      </div>
    </section>
  </div>;
}
