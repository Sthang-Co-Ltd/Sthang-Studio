import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { historyLabelKey, historySourceKey } from '../server-labels';
import { useRef } from 'react';
import type { ProjectHistoryEntry } from '@kcs/shared';
import { History, LoaderCircle, RotateCcw, X } from 'lucide-react';
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
  const { locale, t, tn } = useI18n();
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  useModalFocus(open, dialog, onClose);
  if (!presence.present) return null;
  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="history-title" tabIndex={-1} className="modal history-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head history-modal-head">
        <div className="history-heading-row"><History size={18}/><div className="history-heading-copy"><strong id="history-title">{t('history.title')}</strong><span>{t('history.help')}</span></div></div>
        <button className="history-modal-close" aria-label={t('history.close')} onClick={onClose}><X size={17}/></button>
      </div>
      <div className="history-toolbar"><span role="status" aria-live="polite" aria-atomic="true">{loadState.loading ? <><LoaderCircle size={14} className="spin"/>{loadState.loaded ? t('history.refreshing') : t('history.loading')}</> : loadState.loaded ? tn('history.savedVersions', entries.length) : t('history.unavailable')}</span><button disabled={busy || loadState.loading && !loadState.loaded} aria-disabled={loadState.loading || undefined} aria-busy={loadState.loading || undefined} onClick={() => { if (!busy && !loadState.loading) onRefresh(); }}>{loadState.error ? t('history.retry') : t('history.refresh')}</button></div>
      {loadState.error && <p className="history-load-error" role="alert">{loadState.error}{loadState.loaded ? t('history.lastLoadedWarning') : ''}</p>}
      <div className="history-list" aria-busy={loadState.loading}>
        {entries.map((entry) => {
          const labelKey = historyLabelKey(entry.label);
          const sourceKey = historySourceKey(entry.source);
          const label = labelKey ? t(labelKey) : entry.label;
          const date = formatInterfaceDate(locale, entry.createdAt, { time: true });
          return <article key={entry.id}>
            <div className="history-copy">
              <strong data-server-text={labelKey ? undefined : true}>{label}</strong>
              <time dateTime={entry.createdAt}>{date}</time>
              <span data-server-text={sourceKey ? undefined : true}>{sourceKey ? t(sourceKey) : entry.source.replaceAll('-', ' ')}</span>
              <small>{t('history.captionSummary', { captions: entry.captionCount, approved: entry.approvedCount })}</small>
              <details>
                <summary>{t('history.locks')}</summary>
                <small>{t('history.lockSummary', { textLocks: entry.textLockedCount, timingLocks: entry.timingLockedCount })}</small>
              </details>
            </div>
            <button aria-label={t('history.restoreVersion', { label, date })} disabled={busy} onClick={() => onRestore(entry.id)}><RotateCcw size={14}/>{t('history.restore')}</button>
          </article>;
        })}
        {loadState.loaded && !entries.length && !loadState.loading && !loadState.error && <div className="review-empty">{t('history.empty')}</div>}
      </div>
    </section>
  </div>;
}
