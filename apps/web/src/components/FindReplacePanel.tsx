import { useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { Replace, Search, X } from 'lucide-react';
import { applyReplacementPlan, planReplacement, type MatchMode } from '../find-replace';
import { findPreviewDiff } from '../find-preview-diff';
import { formatTimestamp } from '../timestamp';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';

interface FindReplacePanelProps {
  open: boolean;
  captions: CaptionSegment[];
  selectedIds: string[];
  initialSearch?: string;
  onClose(): void;
  onApply(captions: CaptionSegment[], message: string): void;
  onRemember(line: string, scope: 'project' | 'global'): Promise<boolean>;
}

type Scope = 'project' | 'selection';
type GlossaryReceipt = { line: string; scope: 'project' | 'global'; changed: number; status: 'saving' | 'failed' | 'saved' };

export function FindReplacePanel({ open, captions, selectedIds, initialSearch, onClose, onApply, onRemember }: FindReplacePanelProps) {
  const { t, tn, tr } = useI18n();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [mode, setMode] = useState<MatchMode>('literal');
  const [scope, setScope] = useState<Scope>('project');
  const [remember, setRemember] = useState<'none' | 'project' | 'global'>('none');
  const [missingQuery, setMissingQuery] = useState(false);
  const [page, setPage] = useState(0);
  const [glossary, setGlossary] = useState<GlossaryReceipt | null>(null);
  const saving = useRef(false);
  const request = useRef<object | null>(null);
  const visit = useRef(0);
  const isOpen = useRef(open);
  isOpen.current = open;
  const previewList = useRef<HTMLDivElement | null>(null);
  const pageFocusPending = useRef(false);
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  const find = useRef<HTMLInputElement | null>(null);
  const queryRevision = useRef(0);
  const openingSelection = useRef<{ visit: number; revision: number; value: string } | null>(null);
  const patternErrorId = useId();
  const selectOpeningQuery = () => {
    const pending = openingSelection.current;
    const input = find.current;
    if (!pending || !input || input.value !== pending.value) return;
    openingSelection.current = null;
    if (isOpen.current && pending.visit === visit.current && pending.revision === queryRevision.current && document.activeElement === input) input.select();
  };
  const close = () => {
    visit.current += 1;
    if (!saving.current) setGlossary(null);
    onClose();
  };
  useModalFocus(open, dialog, close, find);
  useEffect(() => () => { request.current = null; }, []);

  useEffect(() => {
    visit.current += 1;
    openingSelection.current = null;
    if (!open) return;
    const seededQuery = !saving.current && initialSearch ? initialSearch : query;
    if (!glossary) openingSelection.current = { visit: visit.current, revision: queryRevision.current, value: seededQuery };
    if (!saving.current && initialSearch) setQuery(initialSearch);
    setMissingQuery(false);
    // The existing value may already be committed. A changed seed is selected
    // by the layout effect below, after React updates the input's exact value.
    selectOpeningQuery();
  }, [open]);
  useLayoutEffect(selectOpeningQuery, [open, query, Boolean(glossary)]);

  useEffect(() => {
    if (mode === 'regex' && remember !== 'none') setRemember('none');
  }, [mode, remember]);

  const targetIds = useMemo(() => {
    if (!open || scope !== 'selection') return null;
    return new Set(selectedIds);
  }, [open, scope, selectedIds]);
  const preview = useMemo(() => {
    if (open && query && import.meta.env.DEV) {
      (window as unknown as { __STHANG_TEST_HOOKS__?: { onFindReplaceScan?: (captionCount: number) => void } }).__STHANG_TEST_HOOKS__?.onFindReplaceScan?.(captions.length);
    }
    return planReplacement(open ? captions : [], query, replacement, mode, targetIds);
  }, [open, captions, mode, query, replacement, targetIds]);
  useEffect(() => setPage(0), [query, replacement, mode, scope, open, targetIds]);
  const pageCount = Math.max(1, Math.ceil(preview.entries.length / 30));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleEntries = useMemo(() => preview.entries.slice(currentPage * 30, (currentPage + 1) * 30).map((entry) => ({
    ...entry, diff: findPreviewDiff(entry.caption.text, entry.after, entry.changed && !entry.caption.textLocked),
  })), [preview, currentPage]);
  useLayoutEffect(() => {
    const list = previewList.current;
    if (!open || !list) { pageFocusPending.current = false; return; }
    list.scrollTop = 0;
    if (pageFocusPending.current) {
      pageFocusPending.current = false;
      list.querySelector<HTMLElement>('.find-preview-row')?.focus({ preventScroll: true });
      list.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [open, currentPage, query, replacement, mode, scope, targetIds, Boolean(glossary)]);
  useLayoutEffect(() => {
    if (open && glossary && document.activeElement === document.body) {
      dialog.current?.querySelector<HTMLElement>('.find-glossary-result')?.focus({ preventScroll: true });
    }
  }, [open, glossary]);
  const changePage = (next: number) => { pageFocusPending.current = true; setPage(next); };

  const saveGlossary = async (receipt: GlossaryReceipt) => {
    if (saving.current) return;
    saving.current = true;
    const token = {};
    request.current = token;
    const startedInVisit = visit.current;
    setGlossary({ ...receipt, status: 'saving' });
    let saved = false;
    try { saved = await onRemember(receipt.line, receipt.scope); }
    catch { /* Caption edits already succeeded; expose a glossary-only retry. */ }
    if (request.current !== token) return;
    saving.current = false;
    request.current = null;
    if (!isOpen.current) { setGlossary(null); return; }
    setGlossary({ ...receipt, status: saved ? 'saved' : 'failed' });
    if (saved && visit.current === startedInVisit) { setGlossary(null); onClose(); }
  };

  if (!presence.present) return null;

  const apply = async () => {
    if (!isOpen.current || saving.current || glossary) return;
    setMissingQuery(false);
    if (!query) { setMissingQuery(true); return; }
    if (preview.error || !preview.changed) return;
    const receipt: GlossaryReceipt | null = remember !== 'none' && replacement.trim()
      ? { line: query.trim() && query.trim() !== replacement.trim() ? `${replacement.trim()} | ${query.trim()}` : replacement.trim(), scope: remember, changed: preview.changed, status: 'saving' }
      : null;
    // Claim the action synchronously before applying a self-matching replacement.
    saving.current = true;
    if (receipt) setGlossary(receipt);
    onApply(applyReplacementPlan(captions, preview), tn(preview.locked === 0 ? 'find.updated'
      : preview.locked === 1 ? 'find.updatedWithLockedMatch' : 'find.updatedWithLockedMatches', preview.changed, { locked: preview.locked }));
    if (receipt) { saving.current = false; await saveGlossary(receipt); }
    else { onClose(); saving.current = false; }
  };

  const summaryKey = preview.count === 1
    ? preview.entries.length === 1 ? 'find.oneMatchInOneCaption' : 'find.oneMatchInCaptions'
    : preview.entries.length === 1 ? 'find.matchesInOneCaption' : 'find.matchesInCaptions';

  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={close}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="find-replace-title" tabIndex={-1} className="modal find-replace-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><Search size={18}/><div><strong id="find-replace-title">{t('find.title')}</strong><span>{t('find.help')}</span></div></div><button aria-label={t('find.closeLabel')} onClick={close}><X size={17}/></button></div>
      {!glossary && <>
      <div className="find-grid">
        <label><span>{t('find.find')}</span><input ref={find} value={query} aria-invalid={Boolean(preview.error) || undefined} aria-describedby={preview.error ? patternErrorId : undefined} onChange={(event) => { queryRevision.current += 1; openingSelection.current = null; setQuery(event.target.value); }} placeholder={t('find.findPlaceholder')}/></label>
        <label><span>{t('find.replaceWith')}</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t('find.replacePlaceholder')}/></label>
      </div>
      <div className="find-grid find-match-options">
        <label><span>{t('find.match')}</span><select value={mode} onChange={(event) => setMode(event.target.value as MatchMode)}><option value="literal">{t('find.literal')}</option><option value="case-insensitive">{t('find.caseInsensitive')}</option><option value="regex">{t('find.regex')}</option></select></label>
        <label><span>{t('find.scope')}</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="project">{t('find.entireProject')}</option><option value="selection" disabled={!selectedIds.length}>{t('find.selectedCaptions', { count: selectedIds.length })}</option></select></label>
      </div>
      <div className="find-summary" aria-live="polite">{tr(summaryKey, { matches: preview.count, captions: preview.entries.length, changed: preview.changed }, {})
        .map((part, index) => typeof part === 'string' ? (part && <span key={index}>{part}</span>) : part)}{preview.locked > 0 && <em>{t('find.lockedMatches', { count: preview.locked })}</em>}</div>
      <div ref={previewList} className="find-preview">
        {visibleEntries.map(({ caption, after, changed, diff }, index) => <div key={caption.id} className="find-preview-row" tabIndex={-1} role="group" aria-label={t('find.captionPreview', { index: currentPage * 30 + index + 1, count: preview.entries.length })}>
          <time>{formatTimestamp(caption.startMs)}</time>
          <div className="find-preview-copy">
            <div><b>{t('find.before')}</b><p className="find-before">{diff.before.map((span, index) => span.changed
              ? <del key={index} className="find-preview-removed">{span.text}</del> : span.text)}</p></div>
            <div>
              <b>{caption.textLocked ? t('find.afterLocked') : changed ? t('find.after') : t('find.afterUnchanged')}</b>
              <p className="find-after">{diff.after.map((span, index) => span.changed
                ? <ins key={index} className="find-preview-added">{span.text}</ins> : span.text)}</p>
              {!after && <em className="find-preview-empty">{t('find.emptyCaption')}</em>}
            </div>
          </div>
        </div>)}
        {!preview.entries.length && <div className="review-empty" id={preview.error ? patternErrorId : undefined} role={preview.error ? 'alert' : undefined}>{preview.errorKey ? t(preview.errorKey) : query ? t('find.noMatches') : t('find.queryHelp')}</div>}
      </div>
      {pageCount > 1 && <nav className="find-preview-pages" aria-label={t('find.pages')}><button disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>{t('find.previous')}</button><span role="status" aria-live="polite" aria-atomic="true">{t('find.previewPage', { page: currentPage + 1, pages: pageCount, start: currentPage * 30 + 1, end: Math.min((currentPage + 1) * 30, preview.entries.length), count: preview.entries.length })}</span><button disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}>{t('find.next')}</button></nav>}
      <div className="replace-memory find-rule-choice">
        <label htmlFor={patternErrorId + '-remember'}>{t('find.remember')}</label>
        <select id={patternErrorId + '-remember'} value={remember} disabled={mode === 'regex'} title={mode === 'regex' ? t('find.regexRememberUnavailable') : undefined} onChange={(event) => setRemember(event.target.value as typeof remember)}><option value="none">{t('find.noMemory')}</option><option value="project">{t('find.rememberProject')}</option><option value="global">{t('find.rememberGlobal')}</option></select>
      </div>
      {missingQuery && <div className="inline-form-error">{t('find.missingQuery')}</div>}
      </>}
      {glossary && <div className="find-glossary-result" tabIndex={-1}>
        <div role="status" aria-live="polite" aria-atomic="true"><strong>{glossary.status === 'failed' ? t('find.glossaryFailedTitle') : glossary.status === 'saving' ? t('find.glossarySavingTitle') : t('find.glossarySavedTitle')}</strong>
          <p>{tn(glossary.status === 'failed' ? 'find.glossaryFailed'
            : glossary.status === 'saving' ? 'find.glossarySaving' : 'find.glossarySaved', glossary.changed)}</p></div>
        <dl><dt>{glossary.scope === 'global' ? t('find.globalRule') : t('find.projectRule')}</dt><dd>{glossary.line}</dd></dl>
      </div>}
      <div className="modal-actions"><button onClick={close}>{glossary ? t('find.close') : t('find.cancel')}</button>
        {glossary ? <>
          {glossary.status !== 'saving' && <button onClick={() => { setGlossary(null); setMissingQuery(false); requestAnimationFrame(() => find.current?.focus()); }}>{glossary.status === 'failed' ? t('find.continueWithoutGlossary') : t('find.newCorrection')}</button>}
          <button className="primary" disabled={glossary.status !== 'failed'} aria-busy={glossary.status === 'saving' || undefined} onClick={() => void saveGlossary(glossary)}>{glossary.status === 'saving' ? t('find.savingGlossary') : glossary.status === 'saved' ? t('find.savedGlossary') : t('find.retryGlossary')}</button>
        </> : <button className="primary" onClick={() => void apply()} disabled={!preview.changed || Boolean(preview.error)}><Replace size={15}/>{!replacement && preview.changed > 0 ? t('find.removeMatches') : t('find.replaceMatches')}</button>}
      </div>
    </section>
  </div>;
}
