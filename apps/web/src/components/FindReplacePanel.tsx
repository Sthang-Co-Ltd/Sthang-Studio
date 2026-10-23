import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { Replace, Search, ShieldPlus, X } from 'lucide-react';
import { applyReplacementPlan, planReplacement, type MatchMode } from '../find-replace';
import { useModalFocus } from '../use-modal-focus';

interface FindReplacePanelProps {
  open: boolean;
  captions: CaptionSegment[];
  selectedIds: string[];
  initialSearch?: string;
  onClose(): void;
  onApply(captions: CaptionSegment[], message: string): void;
  onRemember(line: string, scope: 'project' | 'global'): Promise<void>;
}

type Scope = 'project' | 'selection';

export function FindReplacePanel({ open, captions, selectedIds, initialSearch, onClose, onApply, onRemember }: FindReplacePanelProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [mode, setMode] = useState<MatchMode>('literal');
  const [scope, setScope] = useState<Scope>('project');
  const [remember, setRemember] = useState<'none' | 'project' | 'global'>('none');
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const dialog = useRef<HTMLElement | null>(null);
  const find = useRef<HTMLInputElement | null>(null);
  useModalFocus(open, dialog, onClose, find);

  useEffect(() => {
    if (!open) return;
    if (initialSearch) setQuery(initialSearch);
    setError('');
  }, [open, initialSearch]);

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

  if (!open) return null;

  const apply = async () => {
    setError('');
    if (!query) { setError('Enter text to find.'); return; }
    if (preview.error || !preview.changed) return;
    onApply(applyReplacementPlan(captions, preview), `Updated ${preview.changed} caption${preview.changed === 1 ? '' : 's'}${preview.locked ? `; ${preview.locked} locked match${preview.locked === 1 ? '' : 'es'} preserved` : ''}.`);
    if (remember !== 'none' && replacement.trim()) {
      const line = query.trim() && query.trim() !== replacement.trim() ? `${replacement.trim()} | ${query.trim()}` : replacement.trim();
      try { await onRemember(line, remember); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Correction applied, but memory could not be saved.'); return; }
    }
    onClose();
  };

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="find-replace-title" tabIndex={-1} className="modal find-replace-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><Search size={18}/><div><strong id="find-replace-title">Find & Correct Everywhere</strong><span>Preview every occurrence. Locked text stays unchanged.</span></div></div><button aria-label="Close find and correct" onClick={onClose}><X size={17}/></button></div>
      <div className="find-grid">
        <label><span>Find</span><input ref={find} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ថេរ៉ា or GPT-4o Mini"/></label>
        <label><span>Replace with</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Terra or GPT 5.6 Luna"/></label>
        <label><span>Match</span><select value={mode} onChange={(event) => setMode(event.target.value as MatchMode)}><option value="literal">Case-sensitive text</option><option value="case-insensitive">Ignore Latin case</option><option value="regex">Regular expression</option></select></label>
        <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="project">Entire project</option><option value="selection" disabled={!selectedIds.length}>Selected captions ({selectedIds.length})</option></select></label>
      </div>
      <div className="replace-memory">
        <ShieldPlus size={16}/><div><strong>Remember this correction?</strong><span>Save reusable aliases in a project or global glossary. Use protected terms for distinct names.</span></div>
        <select value={remember} disabled={mode === 'regex'} title={mode === 'regex' ? 'Regex patterns cannot be saved as glossary rules.' : undefined} onChange={(event) => setRemember(event.target.value as typeof remember)}><option value="none">Do not remember</option><option value="project">Add to project glossary</option><option value="global">Add to global glossary</option></select>
      </div>
      <div className="find-summary" aria-live="polite"><b>{preview.count}</b><span>match{preview.count === 1 ? '' : 'es'} in {preview.entries.length} caption{preview.entries.length === 1 ? '' : 's'} · {preview.changed} will change</span>{preview.locked > 0 && <em>{preview.locked} protected by text locks</em>}</div>
      <div className="find-preview">
        {preview.entries.slice(currentPage * 30, (currentPage + 1) * 30).map(({ caption, after, changed }) => <div key={caption.id} className="find-preview-row"><time>{(caption.startMs / 1000).toFixed(1)}s</time><div className="find-preview-copy"><div><b>Before</b><p className="find-before">{caption.text}</p></div><div><b>{caption.textLocked ? 'After · locked, unchanged' : changed ? 'After' : 'After · unchanged'}</b><p className="find-after">{after || <em>Empty caption text</em>}</p></div></div></div>)}
        {!preview.entries.length && <div className="review-empty">{preview.error || (query ? 'No matches found.' : 'Enter text to find matches.')}</div>}
      </div>
      {pageCount > 1 && <nav className="find-preview-pages" aria-label="Replacement preview pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous matches</button><span>Page {currentPage + 1} of {pageCount}</span><button disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next matches</button></nav>}
      {error && <div className="inline-form-error">{error}</div>}
      <div className="modal-actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void apply()} disabled={!preview.changed || Boolean(preview.error)}><Replace size={15}/>Replace editable matches</button></div>
    </section>
  </div>;
}
