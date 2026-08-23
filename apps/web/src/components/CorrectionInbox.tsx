import { useMemo, useState } from 'react';
import type { AppProfile, CorrectionEvent } from '@kcs/shared';
import { BookOpenCheck, CirclePlay, Clipboard, X, XCircle, FolderPlus, CheckCheck } from 'lucide-react';

const formatTime = (ms: number) => {
  const total = ms / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`;
};

interface CorrectionInboxProps {
  profile: AppProfile;
  open: boolean;
  busy: boolean;
  onClose(): void;
  onOpenEvent(event: CorrectionEvent): void;
  onAction(event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore'): void;
}

export function CorrectionInbox({ profile, open, busy, onClose, onOpenEvent, onAction }: CorrectionInboxProps) {
  const [showAll, setShowAll] = useState(false);
  const events = useMemo(() => [...profile.correctionEvents]
    .filter((event) => showAll || event.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [profile.correctionEvents, showAll]);
  const pending = profile.correctionEvents.filter((event) => event.status === 'pending').length;

  const copyReport = async (event: CorrectionEvent) => {
    const report = [
      `Spoken / expected: ${event.correctedText}`,
      `Got: ${event.originalText}`,
      `Expected: ${event.correctedText}`,
      `Project: ${event.projectTitle}`,
      `Time: ${formatTime(event.startMs)}–${formatTime(event.endMs)}`,
      event.contextBefore || event.contextAfter ? `Context: … ${event.contextBefore || ''} [${event.correctedText}] ${event.contextAfter || ''} …` : '',
      `Suggested memory: ${event.suggestedVocabularyLine || event.correctedText}`,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = report;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }
  };

  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal correction-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div><strong>Correction Inbox</strong><span>{pending} pending · edits are captured when a caption field loses focus, when you Save, or when you Export.</span></div>
        <button className="icon-btn" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="inbox-toolbar">
        <button className={!showAll ? 'selected' : ''} onClick={() => setShowAll(false)}>Pending ({pending})</button>
        <button className={showAll ? 'selected' : ''} onClick={() => setShowAll(true)}>History ({profile.correctionEvents.length})</button>
        <span>Audio is the “Spoken” evidence—open the project to replay the exact moment.</span>
      </div>
      <div className="correction-list">
        {events.length === 0 && <div className="modal-empty"><CheckCheck size={26}/><strong>Inbox clear</strong><span>Your next text correction will appear here automatically.</span></div>}
        {events.map((event) => <article className={`correction-card status-${event.status}`} key={event.id}>
          <div className="correction-meta"><span>{event.projectTitle}</span><span>{formatTime(event.startMs)}–{formatTime(event.endMs)}</span><b>{event.suggestionKind.replace('-', ' ')}</b></div>
          <div className="correction-pair"><div><label>Got</label><p>{event.originalText}</p></div><div><label>Expected</label><p>{event.correctedText}</p></div></div>
          {(event.contextBefore || event.contextAfter) && <p className="correction-context">… {event.contextBefore || ''} <mark>{event.correctedText}</mark> {event.contextAfter || ''} …</p>}
          <div className="correction-suggestion"><span>Suggested memory</span><code>{event.suggestedVocabularyLine || event.correctedText}</code></div>
          <div className="correction-actions">
            <button onClick={() => onOpenEvent(event)}><CirclePlay size={15}/>Play spoken audio</button>
            <button onClick={() => void copyReport(event)}><Clipboard size={15}/>Copy report</button>
            {event.status === 'pending' && <>
              <button disabled={busy} className="remember" onClick={() => onAction(event, 'remember-global')}><BookOpenCheck size={15}/>Remember globally</button>
              <button disabled={busy} onClick={() => onAction(event, 'add-project')}><FolderPlus size={15}/>This project only</button>
              <button disabled={busy} onClick={() => onAction(event, 'ignore')}><XCircle size={15}/>Ignore</button>
            </>}
            {event.status !== 'pending' && <span className="decision-label">{event.status.replace('-', ' ')}</span>}
          </div>
        </article>)}
      </div>
    </section>
  </div>;
}
