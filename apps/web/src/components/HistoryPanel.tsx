import { useRef } from 'react';
import type { ProjectHistoryEntry } from '@kcs/shared';
import { CheckCircle2, Clock3, History, LockKeyhole, RotateCcw, X } from 'lucide-react';
import { useModalFocus } from '../use-modal-focus';
import './history-panel.css';

interface Props {
  open: boolean;
  entries: ProjectHistoryEntry[];
  busy: boolean;
  onClose(): void;
  onRefresh(): void;
  onRestore(id: string): void;
}

export function HistoryPanel({ open, entries, busy, onClose, onRefresh, onRestore }: Props) {
  const dialog = useRef<HTMLElement | null>(null);
  useModalFocus(open, dialog, onClose);
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="history-title" tabIndex={-1} className="modal history-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head history-modal-head">
        <div className="history-heading-row"><History size={18}/><div className="history-heading-copy"><strong id="history-title">Project history</strong><span>Checkpoints saved before edits, regeneration, and timing changes</span></div></div>
        <button className="history-modal-close" aria-label="Close history" onClick={onClose}><X size={17}/></button>
      </div>
      <div className="history-toolbar"><span>{entries.length} saved version{entries.length === 1 ? '' : 's'}</span><button onClick={onRefresh}>Refresh</button></div>
      <div className="history-list">
        {entries.map((entry) => <article key={entry.id}>
          <div className="history-icon"><Clock3 size={15}/></div>
          <div className="history-copy"><strong>{entry.label}</strong><span>{new Date(entry.createdAt).toLocaleString()} · {entry.source.replaceAll('-', ' ')}</span><small>{entry.captionCount} captions · {entry.approvedCount} approved · {entry.textLockedCount} text locks · {entry.timingLockedCount} timing locks</small></div>
          <div className="history-badges">{entry.approvedCount > 0 && <i><CheckCircle2 size={10}/>{entry.approvedCount}</i>}{entry.textLockedCount + entry.timingLockedCount > 0 && <i><LockKeyhole size={10}/>{entry.textLockedCount + entry.timingLockedCount}</i>}</div>
          <button aria-label={`Restore ${entry.label} saved ${new Date(entry.createdAt).toLocaleString()}`} disabled={busy} onClick={() => onRestore(entry.id)}><RotateCcw size={14}/>Restore</button>
        </article>)}
        {!entries.length && <div className="review-empty">History appears after a meaningful edit or automatic change.</div>}
      </div>
    </section>
  </div>;
}
