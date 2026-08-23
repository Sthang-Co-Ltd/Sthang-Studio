import { useEffect, useMemo, useState } from 'react';
import type { CaptionSegment } from '@kcs/shared';
import { Replace, Search, ShieldPlus, X } from 'lucide-react';

interface FindReplacePanelProps {
  open: boolean;
  captions: CaptionSegment[];
  selectedIds: string[];
  initialSearch?: string;
  onClose(): void;
  onApply(captions: CaptionSegment[], message: string): void;
  onRemember(line: string, scope: 'project' | 'global'): Promise<void>;
}

type MatchMode = 'literal' | 'case-insensitive' | 'regex';
type Scope = 'project' | 'selection';

function buildRegex(query: string, mode: MatchMode) {
  if (mode === 'regex') return new RegExp(query, 'gu');
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, mode === 'case-insensitive' ? 'giu' : 'gu');
}

export function FindReplacePanel({ open, captions, selectedIds, initialSearch, onClose, onApply, onRemember }: FindReplacePanelProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [mode, setMode] = useState<MatchMode>('literal');
  const [scope, setScope] = useState<Scope>('project');
  const [remember, setRemember] = useState<'none' | 'project' | 'global'>('none');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (initialSearch) setQuery(initialSearch);
    setError('');
  }, [open, initialSearch]);

  useEffect(() => {
    if (mode === 'regex' && remember !== 'none') setRemember('none');
  }, [mode, remember]);

  const targetIds = useMemo(() => scope === 'selection' ? new Set(selectedIds) : null, [scope, selectedIds]);
  const preview = useMemo(() => {
    if (!query) return { captions: [] as CaptionSegment[], count: 0, locked: 0, regex: null as RegExp | null };
    try {
      const regex = buildRegex(query, mode);
      let count = 0;
      let locked = 0;
      const matched = captions.filter((caption) => {
        if (targetIds && !targetIds.has(caption.id)) return false;
        regex.lastIndex = 0;
        const hits = [...caption.text.matchAll(regex)].length;
        if (!hits) return false;
        count += hits;
        if (caption.textLocked) locked += hits;
        return true;
      });
      return { captions: matched, count, locked, regex };
    } catch {
      return { captions: [] as CaptionSegment[], count: 0, locked: 0, regex: null as RegExp | null };
    }
  }, [captions, mode, query, targetIds]);

  if (!open) return null;

  const apply = async () => {
    setError('');
    if (!query) { setError('Enter text to find.'); return; }
    let regex: RegExp;
    try { regex = buildRegex(query, mode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Invalid regular expression'); return; }
    let changed = 0;
    const next = captions.map((caption) => {
      if (targetIds && !targetIds.has(caption.id)) return caption;
      regex.lastIndex = 0;
      if (caption.textLocked || !regex.test(caption.text)) return caption;
      regex.lastIndex = 0;
      const text = caption.text.replace(regex, replacement);
      if (text === caption.text) return caption;
      changed += 1;
      return { ...caption, text, approved: false };
    });
    if (!changed) { setError(preview.locked ? 'Every match is text-locked. Unlock it first.' : 'No editable matches found.'); return; }
    onApply(next, `Corrected ${changed} caption${changed === 1 ? '' : 's'}${preview.locked ? `; ${preview.locked} locked match${preview.locked === 1 ? '' : 'es'} preserved` : ''}.`);
    if (remember !== 'none' && replacement.trim()) {
      const line = query.trim() && query.trim() !== replacement.trim() ? `${replacement.trim()} | ${query.trim()}` : replacement.trim();
      try { await onRemember(line, remember); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Correction applied, but memory could not be saved.'); return; }
    }
    onClose();
  };

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal find-replace-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><Search size={18}/><div><strong>Find & Correct Everywhere</strong><span>Preview every occurrence before changing it. Text locks are always respected.</span></div></div><button onClick={onClose}><X size={17}/></button></div>
      <div className="find-grid">
        <label><span>Find</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ថេរ៉ា or GPT-4o Mini"/></label>
        <label><span>Replace with</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Terra or GPT 5.6 Luna"/></label>
        <label><span>Match</span><select value={mode} onChange={(event) => setMode(event.target.value as MatchMode)}><option value="literal">Exact literal</option><option value="case-insensitive">Ignore Latin case</option><option value="regex">Regular expression</option></select></label>
        <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="project">Entire project</option><option value="selection" disabled={!selectedIds.length}>Selected captions ({selectedIds.length})</option></select></label>
      </div>
      <div className="replace-memory">
        <ShieldPlus size={16}/><div><strong>Remember for later?</strong><span>Safe aliases can become project/global vocabulary. Different product names should usually be protected terms, not universal aliases.</span></div>
        <select value={remember} disabled={mode === 'regex'} title={mode === 'regex' ? 'Regex replacements are not saved as glossary rules.' : undefined} onChange={(event) => setRemember(event.target.value as typeof remember)}><option value="none">Do not remember</option><option value="project">Add to project glossary</option><option value="global">Add to global glossary</option></select>
      </div>
      <div className="find-summary"><b>{preview.count}</b><span>matches in {preview.captions.length} captions</span>{preview.locked > 0 && <em>{preview.locked} protected by text locks</em>}</div>
      <div className="find-preview">
        {preview.captions.slice(0, 30).map((caption) => <div key={caption.id}><time>{(caption.startMs / 1000).toFixed(1)}s</time><p>{caption.text}</p>{caption.textLocked && <span>Locked</span>}</div>)}
        {preview.captions.length > 30 && <small>+ {preview.captions.length - 30} more captions</small>}
        {!preview.captions.length && <div className="review-empty">No matches yet.</div>}
      </div>
      {error && <div className="inline-form-error">{error}</div>}
      <div className="modal-actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void apply()} disabled={!preview.count}><Replace size={15}/>Replace editable matches</button></div>
    </section>
  </div>;
}
