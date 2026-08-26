import type { ProcessingJob } from '@kcs/shared';
import { Ban, CheckCircle2, CircleAlert, Clock3, LoaderCircle, Play, RefreshCw, X } from 'lucide-react';

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

function icon(job: ProcessingJob) {
  if (job.status === 'queued') return <Clock3 size={16}/>;
  if (job.status === 'running') return <LoaderCircle className="spin" size={16}/>;
  if (job.status === 'completed') return <CheckCircle2 size={16}/>;
  if (job.status === 'cancelled') return <Ban size={16}/>;
  return <CircleAlert size={16}/>;
}

export function JobManager({ open, jobs, onClose, onRefresh, onResume, onCancel, onOpen }: Props) {
  if (!open) return null;
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const runningJobs = activeJobs.filter((job) => job.status === 'running');
  const queueSummary = runningJobs.length
    ? 'Processing is active. Progress updates automatically.'
    : activeJobs.length
      ? 'Work is queued and will start automatically.'
      : 'Recent processing jobs and saved checkpoints.';

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div>{activeJobs.length ? <LoaderCircle className="spin" size={18}/> : <CheckCircle2 size={18}/>}<div><strong>Processing queue</strong><span>{queueSummary}</span></div></div><button onClick={onClose}><X size={17}/></button></div>
      <div className="history-toolbar"><span>{activeJobs.length} active · {jobs.length} recent</span><button onClick={onRefresh}><RefreshCw size={13}/>Refresh</button></div>
      <div className="job-list">
        {jobs.map((job) => <article key={job.id} className={`job-${job.status}`}>
          <div className="job-status-icon" title={activityLabel(job)}>{icon(job)}</div>
          <div className="job-copy"><div><strong>{job.type === 'transcribe' ? 'Full caption generation' : 'Selected-range regeneration'}</strong><span>{job.projectTitle}</span></div><p>{job.message}</p><div className="job-progress"><i style={{ width: `${job.progress}%` }}/></div><small>{activityLabel(job)} · {job.stage.replaceAll('-', ' ')} · {job.progress}% · {new Date(job.updatedAt).toLocaleTimeString()}</small>{job.error && <em>{job.error}</em>}</div>
          <div className="job-actions">{job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button onClick={() => onOpen(job)}><Play size={13}/>Open result</button>}{job.canResume && <button onClick={() => onResume(job.id)}><Play size={13}/>Resume</button>}{['queued', 'running'].includes(job.status) && <button onClick={() => onCancel(job.id)}><Ban size={13}/>Cancel</button>}</div>
        </article>)}
        {!jobs.length && <div className="review-empty">No processing jobs yet.</div>}
      </div>
    </section>
  </div>;
}
