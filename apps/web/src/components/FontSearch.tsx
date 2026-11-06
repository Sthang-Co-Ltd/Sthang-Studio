import { useEffect, useId, useRef, useState } from 'react';
import type { VideoExportFontCapability } from '@kcs/shared';

export function FontSearch({ query, onQueryChange, options, selected, count, onSelect }: {
  query: string;
  onQueryChange(value: string): void;
  options: VideoExportFontCapability[];
  selected: string;
  count: number;
  onSelect(name: string): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const identity = options.map((option) => `${option.source}:${option.name}`).join('\0');
  const open = expanded && Boolean(query.trim());
  useEffect(() => { setActive(0); }, [query, identity]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [active, open, id]);
  const choose = (name: string) => { onSelect(name); setExpanded(false); input.current?.focus({ preventScroll: true }); };
  return <div className="appearance-font-search-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false); }}>
    <input ref={input} className="appearance-font-search" type="search" role="combobox" aria-label="Find Khmer font" aria-autocomplete="list" aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? `${id}-results` : undefined} aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      value={query} onFocus={() => setExpanded(true)} onChange={(event) => { setExpanded(true); setActive(0); onQueryChange(event.target.value); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && query.trim() && options.length) {
          event.preventDefault(); event.stopPropagation();
          setExpanded(true);
          setActive((current) => open ? (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : event.key === 'ArrowUp' ? options.length - 1 : 0);
        } else if (event.key === 'Enter' && open && options[active]) {
          event.preventDefault(); event.stopPropagation(); choose(options[active].name);
        } else if (event.key === 'Escape' && (open || query)) {
          event.preventDefault(); event.stopPropagation();
          if (open) setExpanded(false); else onQueryChange('');
        }
      }} placeholder={`Find among ${count} installed Khmer fonts…`}/>
    {open && <div id={`${id}-results`} className="appearance-font-search-results" role="listbox" aria-label="Matching Khmer fonts">
      {options.length ? options.map((font, index) => <button type="button" role="option" id={`${id}-${index}`} aria-selected={index === active} tabIndex={-1}
        key={`${font.source}:${font.name}`} className={font.name === selected ? 'selected' : ''}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(font.name)}>
        <span>{font.name}</span><small>{font.source === 'studio-imported' ? 'Added to Studio' : 'Installed'} · {font.boldAvailable ? 'Regular + Bold' : 'Regular only'}</small>
      </button>) : <div className="appearance-font-search-empty" role="status">No matching Khmer fonts</div>}
    </div>}
  </div>;
}
