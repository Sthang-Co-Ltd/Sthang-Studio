import type { ProcessingJob } from '@kcs/shared';
import { Ban, CheckCircle2, CircleAlert, LoaderCircle, Play, RefreshCw, X } from 'lucide-react';

interface Props {
  open: boolean;
  jobs: ProcessingJob[];
  onClose(): void;
  onRefresh(): void;
  onResume(id: string): void;
  onCancel(id: string): void;
  onOpen(job: ProcessingJob): void;
}

function icon(job: ProcessingJob) {
  if (job.status === 'running' || job.status === 'queued') return <LoaderCircle className="spin" size={16}/>;
  if (job.status === 'completed') return <CheckCircle2 size={16}/>;
  if (job.status === 'cancelled') return <Ban size={16}/>;
  return <CircleAlert size={16}/>;
}

export function JobManager({ open, jobs, onClose, onRefresh, onResume, onCancel, onOpen }: Props) {
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal job-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><LoaderCircle size={18}/><div><strong>Processing queue</strong><span>Jobs survive browser refreshes; interrupted work can reuse saved checkpoints</span></div></div><button onClick={onClose}><X size={17}/></button></div>
      <div className="history-toolbar"><span>{jobs.filter((job) => ['queued', 'running'].includes(job.status)).length} active · {jobs.length} recent</span><button onClick={onRefresh}><RefreshCw size={13}/>Refresh</button></div>
      <div className="job-list">
        {jobs.map((job) => <article key={job.id} className={`job-${job.status}`}>
          <div className="job-status-icon">{icon(job)}</div>
          <div className="job-copy"><div><strong>{job.type === 'transcribe' ? 'Full caption generation' : 'Selected-range regeneration'}</strong><span>{job.projectTitle}</span></div><p>{job.message}</p><div className="job-progress"><i style={{ width: `${job.progress}%` }}/></div><small>{job.stage.replaceAll('-', ' ')} · {job.progress}% · {new Date(job.updatedAt).toLocaleTimeString()}</small>{job.error && <em>{job.error}</em>}</div>
          <div className="job-actions">{job.status === 'completed' && (job.proposalId || job.resultProjectId) && <button onClick={() => onOpen(job)}><Play size={13}/>Open result</button>}{job.canResume && <button onClick={() => onResume(job.id)}><Play size={13}/>Resume</button>}{['queued', 'running'].includes(job.status) && <button onClick={() => onCancel(job.id)}><Ban size={13}/>Cancel</button>}</div>
        </article>)}
        {!jobs.length && <div className="review-empty">No processing jobs yet.</div>}
      </div>
    </section>
  </div>;
}
