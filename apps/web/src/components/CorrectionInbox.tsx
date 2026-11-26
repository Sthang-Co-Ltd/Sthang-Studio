import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppProfile, CorrectionEvent } from '@kcs/shared';
import { BookOpenCheck, CirclePlay, X, XCircle, FolderPlus, CheckCheck } from 'lucide-react';
import { CopyReportButton } from './CopyReportButton';
import { useModalFocus } from '../use-modal-focus';
import { formatTimestamp } from '../timestamp';
import { useSurfacePresence } from '../use-surface-presence';
import './correction-inbox.css';

const formatTime = (ms: number) => {
  const total = ms / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`;
};

const suggestionLabels = {
  'phonetic-alias': 'inbox.phoneticAlias',
  'protected-term': 'inbox.protectedTerm',
  'formatting': 'inbox.formatting',
  'review': 'inbox.review',
} as const;

const decisionLabels = {
  'remembered-global': 'inbox.rememberedGlobal',
  'added-project': 'inbox.addedProject',
  'ignored': 'inbox.ignored',
} as const;

interface CorrectionInboxProps {
  profile: AppProfile;
  open: boolean;
  busy: boolean;
  openingId: string | null;
  readError: { id: string; message: string } | null;
  blockedSave?: { id: string; message: string };
  onReturnToEdits(): void;
  onFilterChange(): void;
  getAudioFocusTarget(): HTMLElement | null;
  onClose(): void;
  onOpenEvent(event: CorrectionEvent): void;
  onAction(event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore'): void | Promise<void>;
}

export function CorrectionInbox({ profile, open, busy, openingId, readError, blockedSave, onReturnToEdits, onFilterChange, getAudioFocusTarget, onClose, onOpenEvent, onAction }: CorrectionInboxProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const pendingFilter = useRef<HTMLButtonElement | null>(null);
  const request = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const actionFocus = useRef<{
    token: symbol; id: string; order: string[]; history: boolean;
    card: HTMLElement; button: HTMLButtonElement;
  } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [settled, setSettled] = useState<symbol | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  useModalFocus(open, dialog, onClose, undefined, getAudioFocusTarget);
  const [showAll, setShowAll] = useState(false);
  const events = useMemo(() => [...profile.correctionEvents]
    .filter((event) => showAll || event.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [profile.correctionEvents, showAll]);
  const pending = profile.correctionEvents.filter((event) => event.status === 'pending').length;

  useEffect(() => {
    mounted.current = true;
    const yieldFocus = (event: FocusEvent) => {
      const intent = actionFocus.current;
      if (!intent || event.target === intent.card) return;
      // Removing the resolved card can leave focus on the document until the
      // action's next commit. Deliberate focus anywhere else cancels the handoff.
      if (event.target === document.body && !intent.card.isConnected) return;
      actionFocus.current = null;
    };
    document.addEventListener('focusin', yieldFocus);
    return () => {
      mounted.current = false;
      actionFocus.current = null;
      document.removeEventListener('focusin', yieldFocus);
    };
  }, []);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) setShowAll(pending === 0 && profile.correctionEvents.length > 0);
    wasOpen.current = open;
  }, [open, pending, profile.correctionEvents.length]);
  useLayoutEffect(() => { actionFocus.current = null; }, [open]);
  useLayoutEffect(() => {
    const intent = actionFocus.current;
    if (!intent || settled !== intent.token) return;
    actionFocus.current = null;
    if (!open || showAll !== intent.history || Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) !== dialog.current) return;
    const active = document.activeElement;
    if (active !== intent.card && !(active === document.body && !intent.card.isConnected)) return;
    const unresolved = profile.correctionEvents.some((event) => event.id === intent.id && event.status === 'pending');
    const retainedCard = cards.current.get(intent.id);
    const position = intent.order.indexOf(intent.id);
    const nextCard = [...intent.order.slice(position + 1), ...intent.order.slice(0, position).reverse()]
      .map((id) => cards.current.get(id)).find(Boolean);
    const target = unresolved && intent.button.isConnected && !intent.button.disabled ? intent.button
      : retainedCard || nextCard || pendingFilter.current;
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[inert], [aria-hidden="true"]')) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'instant', block: target.tagName === 'ARTICLE' ? 'start' : 'nearest', inline: 'nearest' });
  }, [settled, profile.correctionEvents, open, showAll]);

  const decide = async (event: CorrectionEvent, action: 'remember-global' | 'add-project' | 'ignore', button: HTMLButtonElement) => {
    if (!open || busy || openingId || request.current) return;
    const token = Symbol('correction action');
    request.current = token;
    const card = cards.current.get(event.id);
    if (card && document.activeElement === button) {
      actionFocus.current = { token, id: event.id, order: events.map((item) => item.id), history: showAll, card, button };
      card.focus({ preventScroll: true });
    }
    setWorking(event.id);
    try { await onAction(event, action); }
    catch { /* The action owner reports mutation failures; a pending row remains retryable. */ }
    finally {
      if (request.current === token) {
        request.current = null;
        if (mounted.current) { setWorking(null); setSettled(token); }
      }
    }
  };
  const changeFilter = (history: boolean) => { actionFocus.current = null; if (showAll !== history) onFilterChange(); setShowAll(history); };

  const reportText = (event: CorrectionEvent) => [
      t('inbox.reportBefore', { text: event.originalText }),
      t('inbox.reportAfter', { text: event.correctedText }),
      t('inbox.reportProject', { title: event.projectTitle }),
      t('inbox.reportTime', { start: formatTime(event.startMs), end: formatTime(event.endMs) }),
      event.contextBefore || event.contextAfter ? t('inbox.reportContext', { before: event.contextBefore || '', text: event.correctedText, after: event.contextAfter || '' }) : '',
      t('inbox.reportSuggestion', { text: event.suggestedVocabularyLine || event.correctedText }),
    ].filter(Boolean).join('\n');

  if (!presence.present) return null;
  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="correction-inbox-title" tabIndex={-1} className="modal correction-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div><strong id="correction-inbox-title">{t('inbox.title')}</strong><span>{t('inbox.help')}</span></div>
        <button className="icon-btn" aria-label={t('inbox.close')} onClick={onClose}><X size={18}/></button>
      </div>
      <div className="inbox-toolbar">
        <button ref={pendingFilter} aria-pressed={!showAll} className={!showAll ? 'selected' : ''} onClick={() => changeFilter(false)}>{t('inbox.pending', { count: pending })}</button>
        <button aria-pressed={showAll} className={showAll ? 'selected' : ''} onClick={() => changeFilter(true)}>{t('inbox.resolved', { count: profile.correctionEvents.length })}</button>
      </div>
      <div className="correction-list">
        {events.length === 0 && <div className="modal-empty"><CheckCheck size={26}/><strong>{showAll ? t('inbox.noHistory') : t('inbox.clear')}</strong><span>{t('inbox.emptyHelp')}</span></div>}
        {events.map((event) => <article className={`correction-card status-${event.status}`} key={event.id}
          ref={(element) => { if (element) cards.current.set(event.id, element); else cards.current.delete(event.id); }}
          tabIndex={-1} aria-label={t('inbox.correctionAt', { time: formatTimestamp(event.startMs), project: event.projectTitle })} aria-busy={working === event.id || openingId === event.id || undefined}>
          <div className="correction-meta"><span>{event.projectTitle}</span><span>{formatTimestamp(event.startMs)} – {formatTimestamp(event.endMs)}</span><b data-server-text={!Object.hasOwn(suggestionLabels, event.suggestionKind) || undefined}>{Object.hasOwn(suggestionLabels, event.suggestionKind) ? t(suggestionLabels[event.suggestionKind]) : event.suggestionKind.replace('-', ' ')}</b></div>
          <div className="correction-pair"><div><label>{t('inbox.before')}</label><p>{event.originalText}</p></div><div><label>{t('inbox.after')}</label><p>{event.correctedText}</p></div></div>
          {(event.contextBefore || event.contextAfter) && <p className="correction-context">… {event.contextBefore || ''} <mark>{event.correctedText}</mark> {event.contextAfter || ''} …</p>}
          <div className="correction-suggestion"><span>{t('inbox.suggestion')}</span><code>{event.suggestedVocabularyLine || event.correctedText}</code></div>
          {readError?.id === event.id && <p className="correction-read-error" role="alert">{readError.message}</p>}
          {blockedSave?.id === event.id && <p className="correction-read-error" role="alert">{blockedSave.message}</p>}
          <div className="correction-actions">
            <button aria-disabled={Boolean(openingId || working || busy) || undefined}
              onClick={() => { if (!openingId && !working && !busy) onOpenEvent(event); }}>
              <CirclePlay size={15}/>{openingId === event.id ? t('inbox.openingAudio') : t('inbox.reviewAudio')}</button>
            {blockedSave?.id === event.id && <button className="remember" onClick={onReturnToEdits}>{t('inbox.returnToEdits')}</button>}
            <CopyReportButton text={reportText(event)}/>
            {event.status === 'pending' && <>
              <button disabled={busy || Boolean(working || openingId)} className="remember" onClick={(click) => void decide(event, 'remember-global', click.currentTarget)}><BookOpenCheck size={15} aria-hidden="true"/>{t('inbox.rememberGlobal')}</button>
              <button disabled={busy || Boolean(working || openingId)} onClick={(click) => void decide(event, 'add-project', click.currentTarget)}><FolderPlus size={15} aria-hidden="true"/>{t('inbox.rememberProject')}</button>
              <button disabled={busy || Boolean(working || openingId)} onClick={(click) => void decide(event, 'ignore', click.currentTarget)}><XCircle size={15}/>{t('inbox.ignore')}</button>
            </>}
            {event.status !== 'pending' && <span className="decision-label" data-server-text={!Object.hasOwn(decisionLabels, event.status) || undefined}>{Object.hasOwn(decisionLabels, event.status) ? t(decisionLabels[event.status]) : event.status.replace('-', ' ')}</span>}
          </div>
        </article>)}
      </div>
    </section>
  </div>;
}
