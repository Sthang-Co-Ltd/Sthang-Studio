import { useRef } from 'react';
import type { ProjectHistoryEntry } from '@kcs/shared';
import { CheckCircle2, Clock3, History, LoaderCircle, LockKeyhole, RotateCcw, X } from 'lucide-react';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';
import './history-panel.css';

interface Props {
  open: boolean;
  entries: ProjectHistoryEntry[];
  busy: boolean;
  loadState: { loading: boolean; loaded: boolean; error: string };
  onClose(): void;
  onRefresh(): void;
  onRestore(id: string): void;
}

export function HistoryPanel({ open, entries, busy, loadState, onClose, onRefresh, onRestore }: Props) {
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  useModalFocus(open, dialog, onClose);
  if (!presence.present) return null;
  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="history-title" tabIndex={-1} className="modal history-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head history-modal-head">
        <div className="history-heading-row"><History size={18}/><div className="history-heading-copy"><strong id="history-title">Project history</strong><span>Checkpoints saved before edits, regeneration, and timing changes</span></div></div>
        <button className="history-modal-close" aria-label="Close history" onClick={onClose}><X size={17}/></button>
      </div>
      <div className="history-toolbar"><span role="status" aria-live="polite" aria-atomic="true">{loadState.loading ? <><LoaderCircle size={14} className="spin"/>{loadState.loaded ? 'Refreshing history…' : 'Loading history…'}</> : loadState.loaded ? `${entries.length} saved version${entries.length === 1 ? '' : 's'}` : 'History unavailable'}</span><button disabled={busy || loadState.loading && !loadState.loaded} onClick={onRefresh}>{loadState.error ? 'Retry history' : 'Refresh'}</button></div>
      {loadState.error && <p className="history-load-error" role="alert">{loadState.error}{loadState.loaded ? ' The last loaded history is still shown.' : ''}</p>}
      <div className="history-list" aria-busy={loadState.loading}>
        {entries.map((entry) => <article key={entry.id}>
          <div className="history-icon"><Clock3 size={15}/></div>
          <div className="history-copy"><strong>{entry.label}</strong><span>{new Date(entry.createdAt).toLocaleString()} · {entry.source.replaceAll('-', ' ')}</span><small>{entry.captionCount} captions · {entry.approvedCount} approved · {entry.textLockedCount} text locks · {entry.timingLockedCount} timing locks</small></div>
          <div className="history-badges">{entry.approvedCount > 0 && <i><CheckCircle2 size={10}/>{entry.approvedCount}</i>}{entry.textLockedCount + entry.timingLockedCount > 0 && <i><LockKeyhole size={10}/>{entry.textLockedCount + entry.timingLockedCount}</i>}</div>
          <button aria-label={`Restore ${entry.label} saved ${new Date(entry.createdAt).toLocaleString()}`} disabled={busy} onClick={() => onRestore(entry.id)}><RotateCcw size={14}/>Restore</button>
        </article>)}
        {loadState.loaded && !entries.length && !loadState.loading && !loadState.error && <div className="review-empty">History appears after a meaningful edit or automatic change.</div>}
      </div>
    </section>
  </div>;
}
