import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { Replace, Search, ShieldPlus, X } from 'lucide-react';
import { applyReplacementPlan, planReplacement, type MatchMode } from '../find-replace';
import { findPreviewDiff } from '../find-preview-diff';
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
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [mode, setMode] = useState<MatchMode>('literal');
  const [scope, setScope] = useState<Scope>('project');
  const [remember, setRemember] = useState<'none' | 'project' | 'global'>('none');
  const [error, setError] = useState('');
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
  const close = () => {
    visit.current += 1;
    if (!saving.current) setGlossary(null);
    onClose();
  };
  useModalFocus(open, dialog, close, find);
  useEffect(() => () => { request.current = null; }, []);

  useEffect(() => {
    visit.current += 1;
    if (!open) return;
    if (!saving.current && initialSearch) setQuery(initialSearch);
    setError('');
  }, [open]);

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
    setError('');
    if (!query) { setError('Enter text to find.'); return; }
    if (preview.error || !preview.changed) return;
    const receipt: GlossaryReceipt | null = remember !== 'none' && replacement.trim()
      ? { line: query.trim() && query.trim() !== replacement.trim() ? `${replacement.trim()} | ${query.trim()}` : replacement.trim(), scope: remember, changed: preview.changed, status: 'saving' }
      : null;
    // Claim the action synchronously before applying a self-matching replacement.
    saving.current = true;
    if (receipt) setGlossary(receipt);
    onApply(applyReplacementPlan(captions, preview), `Updated ${preview.changed} caption${preview.changed === 1 ? '' : 's'}${preview.locked ? `; ${preview.locked} locked match${preview.locked === 1 ? '' : 'es'} preserved` : ''}.`);
    if (receipt) { saving.current = false; await saveGlossary(receipt); }
    else { onClose(); saving.current = false; }
  };

  return <div className="modal-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={close}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="find-replace-title" tabIndex={-1} className="modal find-replace-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><Search size={18}/><div><strong id="find-replace-title">Find & Correct Everywhere</strong><span>Preview every occurrence. Locked text stays unchanged.</span></div></div><button aria-label="Close find and correct" onClick={close}><X size={17}/></button></div>
      {!glossary && <>
      <div className="find-grid">
        <label><span>Find</span><input ref={find} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ថេរ៉ា or GPT-4o Mini"/></label>
        <label><span>Replace with</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Terra or GPT 5.6 Luna"/></label>
        <label><span>Match</span><select value={mode} onChange={(event) => setMode(event.target.value as MatchMode)}><option value="literal">Case-sensitive text</option><option value="case-insensitive">Ignore Latin case</option><option value="regex">Regular expression</option></select></label>
        <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="project">Entire project</option><option value="selection" disabled={!selectedIds.length}>Selected captions ({selectedIds.length})</option></select></label>
      </div>
      <div className="replace-memory">
        <ShieldPlus size={16}/><div><strong>Remember this correction?</strong><span>Save reusable aliases in a project or global glossary. Use protected terms for distinct names.</span></div>
        <select aria-label="Remember this correction" value={remember} disabled={mode === 'regex'} title={mode === 'regex' ? 'Regex patterns cannot be saved as glossary rules.' : undefined} onChange={(event) => setRemember(event.target.value as typeof remember)}><option value="none">Do not remember</option><option value="project">Add to project glossary</option><option value="global">Add to global glossary</option></select>
      </div>
      <div className="find-summary" aria-live="polite"><b>{preview.count}</b><span>match{preview.count === 1 ? '' : 'es'} in {preview.entries.length} caption{preview.entries.length === 1 ? '' : 's'} · {preview.changed} will change</span>{preview.locked > 0 && <em>{preview.locked} protected by text locks</em>}</div>
      <div ref={previewList} className="find-preview">
        {visibleEntries.map(({ caption, after, changed, diff }, index) => <div key={caption.id} className="find-preview-row" tabIndex={-1} role="group" aria-label={`Caption preview ${currentPage * 30 + index + 1} of ${preview.entries.length}`}>
          <time>{(caption.startMs / 1000).toFixed(1)}s</time>
          <div className="find-preview-copy">
            <div><b>Before</b><p className="find-before">{diff.before.map((span, index) => span.changed
              ? <del key={index} className="find-preview-removed">{span.text}</del> : span.text)}</p></div>
            <div>
              <b>{caption.textLocked ? 'After · locked, unchanged' : changed ? 'After' : 'After · unchanged'}</b>
              <p className="find-after">{diff.after.map((span, index) => span.changed
                ? <ins key={index} className="find-preview-added">{span.text}</ins> : span.text)}</p>
              {!after && <em className="find-preview-empty">Empty caption text</em>}
            </div>
          </div>
        </div>)}
        {!preview.entries.length && <div className="review-empty">{preview.error || (query ? 'No matches found.' : 'Enter text to find matches.')}</div>}
      </div>
      {pageCount > 1 && <nav className="find-preview-pages" aria-label="Replacement preview pages"><button disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>Previous matches</button><span role="status" aria-live="polite" aria-atomic="true">Page {currentPage + 1} of {pageCount} · Captions {currentPage * 30 + 1}–{Math.min((currentPage + 1) * 30, preview.entries.length)} of {preview.entries.length}</span><button disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}>Next matches</button></nav>}
      {error && <div className="inline-form-error">{error}</div>}
      </>}
      {glossary && <div className="find-glossary-result" tabIndex={-1}>
        <div role="status" aria-live="polite" aria-atomic="true"><strong>{glossary.status === 'failed' ? 'Captions updated; glossary not saved' : glossary.status === 'saving' ? 'Captions updated; saving glossary…' : 'Captions updated; glossary saved'}</strong>
          <p>{glossary.changed} caption{glossary.changed === 1 ? '' : 's'} updated in the editor. {glossary.status === 'failed' ? 'Your edits are kept. Retry saves only the glossary rule.' : glossary.status === 'saving' ? 'The replacement will not be applied again.' : 'The glossary rule was saved.'}</p></div>
        <dl><dt>{glossary.scope === 'global' ? 'Global glossary rule' : 'Project glossary rule'}</dt><dd>{glossary.line}</dd></dl>
      </div>}
      <div className="modal-actions"><button onClick={close}>{glossary ? 'Close' : 'Cancel'}</button>
        {glossary ? <>
          {glossary.status !== 'saving' && <button onClick={() => { setGlossary(null); setError(''); requestAnimationFrame(() => find.current?.focus()); }}>{glossary.status === 'failed' ? 'Continue without saving glossary' : 'New correction'}</button>}
          <button className="primary" disabled={glossary.status !== 'failed'} aria-busy={glossary.status === 'saving' || undefined} onClick={() => void saveGlossary(glossary)}>{glossary.status === 'saving' ? 'Saving glossary…' : glossary.status === 'saved' ? 'Glossary saved' : 'Retry glossary save'}</button>
        </> : <button className="primary" onClick={() => void apply()} disabled={!preview.changed || Boolean(preview.error)}><Replace size={15}/>Replace editable matches</button>}
      </div>
    </section>
  </div>;
}
