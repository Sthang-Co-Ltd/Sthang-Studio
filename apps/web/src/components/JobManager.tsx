import { useEffect } from 'react';
import type { ProcessingJob } from '@kcs/shared';
import { Ban, CheckCircle2, CircleAlert, Clock3, Download, LoaderCircle, Play, RefreshCw, X } from 'lucide-react';
import { JOBS_UPDATED_EVENT } from '../api';

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

export function JobManager({ open, jobs, onClose, onRefresh, onResume, onCancel, onOpen }: Props) {
  useEffect(() => {
    const refresh = () => onRefresh();
    window.addEventListener(JOBS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(JOBS_UPDATED_EVENT, refresh);
  }, [onRefresh]);

  if (!open) return null;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const runningJobs = activeJobs.filter((job) => job.status === 'running');
  const queueSummary = runningJobs.length
    ? 'Caption processing and video exports update independently when both are active.'
    : activeJobs.length
      ? 'Work is queued and will start automatically.'
      : 'Recent caption processing and video exports.';
  const headerIcon = runningJobs.length
    ? <LoaderCircle className="spin" size={18}/>
    : activeJobs.length
      ? <Clock3 size={18}/>
      : <CheckCircle2 size={18}/>;

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div>{headerIcon}<div><strong>Activity</strong><span>{queueSummary}</span></div></div><button onClick={onClose}><X size={17}/></button></div>
      <div className="history-toolbar"><span>{activeJobs.length} active · {jobs.length} recent</span><button onClick={onRefresh}><RefreshCw size={13}/>Refresh</button></div>
      <div className="job-list">
        {jobs.map((job) => <article key={job.id} className={`job-${job.status}`}>
          <div className="job-status-icon" title={activityLabel(job)}>{icon(job)}</div>
          <div className="job-copy"><div><strong>{jobLabel(job)}</strong><span>{job.projectTitle}</span></div><p>{job.message}</p><div className="job-progress"><i style={{ width: `${job.progress}%` }}/></div><small>{activityLabel(job)} · {job.stage.replaceAll('-', ' ')} · {job.progress}% · {new Date(job.updatedAt).toLocaleTimeString()}</small>{job.resultExport && <small>{job.resultExport.width}×{job.resultExport.height} · {job.resultExport.frameRate.toFixed(job.resultExport.frameRate % 1 ? 2 : 0)} fps · {(job.resultExport.sizeBytes / 1024 / 1024).toFixed(1)} MB</small>}{job.error && <em>{job.error}</em>}</div>
          <div className="job-actions">{job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button onClick={() => onOpen(job)}><Play size={13}/>Open result</button>}{job.status === 'completed' && job.resultExport && <button onClick={() => downloadExport(job)}><Download size={13}/>Download video</button>}{job.canResume && <button onClick={() => onResume(job.id)}><Play size={13}/>Resume</button>}{['queued', 'running'].includes(job.status) && <button onClick={() => onCancel(job.id)}><Ban size={13}/>Cancel</button>}</div>
        </article>)}
        {!jobs.length && <div className="review-empty">No activity yet.</div>}
      </div>
    </section>
  </div>;
}
