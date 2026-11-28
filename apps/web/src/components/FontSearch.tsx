import { useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { VideoExportFontCapability } from '@kcs/shared';
import { FontSpecimen } from './FontSpecimen';

export function FontSearch({ projectId, sampleCaptionText, bold, query, onQueryChange, options, selected, count, onSelect }: {
  projectId: string;
  sampleCaptionText?: string;
  bold: boolean;
  query: string;
  onQueryChange(value: string): void;
  options: VideoExportFontCapability[];
  selected: string;
  count: number;
  onSelect(name: string): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const [sample, setSample] = useState('');
  function openSearch() {
    if (!expanded) setSample(sampleCaptionText?.trim() || t('appearance.fontSearch.sample'));
    setExpanded(true);
  }
  const candidate = options[active];
  const previewBold = Boolean(bold && candidate?.boldAvailable);
  const identity = options.map((option) => `${option.source}:${option.name}`).join('\0');
  const open = expanded && Boolean(query.trim());
  const hasResults = options.length > 0;
  useLayoutEffect(() => {
    // Bring the sample and the first choices into view when typing near the phone keyboard.
    if (open) results.current?.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [open, hasResults]);
  useEffect(() => { setActive(0); }, [query, identity]);
  useEffect(() => {
    const list = results.current;
    const row = list?.children[active];
    if (!open || !list || !row) return;
    const bounds = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [active, open, id]);
  const choose = (name: string) => { onSelect(name); setExpanded(false); input.current?.focus({ preventScroll: true }); };
  return <div className="appearance-font-search-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false); }}>
    <input ref={input} className="appearance-font-search" type="search" role="combobox" aria-label={t('appearance.fontSearch.label')} aria-autocomplete="list" aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? `${id}-results` : undefined} aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      value={query} onFocus={openSearch} onChange={(event) => { openSearch(); setActive(0); onQueryChange(event.target.value); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && query.trim() && options.length) {
          event.preventDefault(); event.stopPropagation();
          openSearch();
          setActive((current) => open ? (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : event.key === 'ArrowUp' ? options.length - 1 : 0);
        } else if (event.key === 'Enter' && open && options[active]) {
          event.preventDefault(); event.stopPropagation(); choose(options[active].name);
        } else if (event.key === 'Escape' && (open || query)) {
          event.preventDefault(); event.stopPropagation();
          if (open) setExpanded(false); else onQueryChange('');
        }
      }} placeholder={count > 24 ? t('appearance.fontSearch.placeholder', { count }) : t('appearance.fontSearch.label')}/>
    {open && candidate && <FontSpecimen key={JSON.stringify([projectId, candidate.name, previewBold, sample])}
      projectId={projectId} family={candidate.name} bold={previewBold} text={sample}/>}
    {open && <div ref={results} id={`${id}-results`} className="appearance-font-search-results" role="listbox" aria-label={t('appearance.fontSearch.results')}>
      {options.length ? options.map((font, index) => <button type="button" role="option" id={`${id}-${index}`} aria-selected={index === active} tabIndex={-1}
        key={`${font.source}:${font.name}`} className={font.name === selected ? 'selected' : ''}
        onPointerMove={(event) => { if (event.pointerType === 'mouse' && index !== active) setActive(index); }}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(font.name)}>
        <span>{font.name}</span><small>{font.source === 'studio-imported'
          ? font.boldAvailable ? t('appearance.fontSearch.addedRegularBold') : t('appearance.fontSearch.addedRegular')
          : font.boldAvailable ? t('appearance.fontSearch.installedRegularBold') : t('appearance.fontSearch.installedRegular')}</small>
      </button>) : <div className="appearance-font-search-empty" role="status">{t('appearance.fontSearch.empty')}</div>}
    </div>}
  </div>;
}
