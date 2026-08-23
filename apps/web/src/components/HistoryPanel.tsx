import type { ProjectHistoryEntry } from '@kcs/shared';
import { CheckCircle2, Clock3, History, LockKeyhole, RotateCcw, X } from 'lucide-react';

interface Props {
  open: boolean;
  entries: ProjectHistoryEntry[];
  busy: boolean;
  onClose(): void;
  onRefresh(): void;
  onRestore(id: string): void;
}

export function HistoryPanel({ open, entries, busy, onClose, onRefresh, onRestore }: Props) {
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal history-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><History size={18}/><div><strong>Project history</strong><span>Persistent checkpoints before edits, regeneration and timing operations</span></div></div><button onClick={onClose}><X size={17}/></button></div>
      <div className="history-toolbar"><span>{entries.length} recoverable versions</span><button onClick={onRefresh}>Refresh</button></div>
      <div className="history-list">
        {entries.map((entry) => <article key={entry.id}>
          <div className="history-icon"><Clock3 size={15}/></div>
          <div className="history-copy"><strong>{entry.label}</strong><span>{new Date(entry.createdAt).toLocaleString()} · {entry.source.replaceAll('-', ' ')}</span><small>{entry.captionCount} captions · {entry.approvedCount} approved · {entry.textLockedCount} text locks · {entry.timingLockedCount} timing locks</small></div>
          <div className="history-badges">{entry.approvedCount > 0 && <i><CheckCircle2 size={10}/>{entry.approvedCount}</i>}{entry.textLockedCount + entry.timingLockedCount > 0 && <i><LockKeyhole size={10}/>{entry.textLockedCount + entry.timingLockedCount}</i>}</div>
          <button disabled={busy} onClick={() => onRestore(entry.id)}><RotateCcw size={14}/>Restore</button>
        </article>)}
        {!entries.length && <div className="review-empty">History appears after the first meaningful edit or automatic operation.</div>}
      </div>
    </section>
  </div>;
}
