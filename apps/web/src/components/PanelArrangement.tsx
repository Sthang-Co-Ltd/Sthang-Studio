import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, GripVertical, PanelsTopLeft, X } from 'lucide-react';
import { EDITOR_LAYOUT_CHANGE, moveEditorPane, PANE_LABELS, visibleEditorPanes, type EditorPane } from '../editor-layout-state';
import { PanelDragGhost } from './PanelHeaderGrip';

interface Props {
  order: EditorPane[];
  open: boolean;
  supported: boolean;
  interactionBusy: boolean;
  geometryKey: string;
  onChange(order: EditorPane[]): boolean;
  onBegin(): boolean;
  onEnd(): void;
  onFeedback(source: EditorPane | null, target: EditorPane | null): void;
}
interface Drag { pane: EditorPane; pointer: number; x: number; y: number; active: boolean; target: number | null; handle: HTMLButtonElement }

export function PanelArrangement({ order, open, supported, interactionBusy, geometryKey, onChange, onBegin, onEnd, onFeedback }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const handles = useRef<Partial<Record<EditorPane, HTMLButtonElement>>>({});
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{ pane: EditorPane; x: number; y: number } | null>(null);
  const [target, setTarget] = useState<EditorPane | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const panes = visibleEditorPanes(order, open);
  const current = useRef({ order, open }); current.current = { order, open };

  function finish(commit: boolean) {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null; setGhost(null); setTarget(null); onFeedback(null, null); onEnd();
    if (gesture.handle.hasPointerCapture(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer);
    if (commit && gesture.active && gesture.target !== null) change(moveEditorPane(current.current.order, current.current.open, gesture.pane, gesture.target), gesture.pane);
    else if (gesture.active) setAnnouncement('Panel move cancelled.');
  }
  const finishRef = useRef(finish); finishRef.current = finish;
  useLayoutEffect(() => {
    finishRef.current(false);
    const panel = popover.current;
    if (panel && typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) {
      if (!window.matchMedia('(min-width: 1200px)').matches) panel.hidePopover();
      else { const rect = trigger.current?.getBoundingClientRect(); if (rect) panel.style.setProperty('--arrange-top', `${rect.bottom + 8}px`); }
    }
  }, [geometryKey, open, order]);
  useEffect(() => { setAnnouncement(''); }, [order, open]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finishRef.current(false); }
    };
    window.addEventListener('keydown', escape, true);
    const blur = () => finishRef.current(false); window.addEventListener('blur', blur);
    window.addEventListener(EDITOR_LAYOUT_CHANGE, blur);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); window.removeEventListener(EDITOR_LAYOUT_CHANGE, blur); const gesture = drag.current; drag.current = null; if (gesture?.handle.hasPointerCapture(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer); };
  }, []);

  function change(next: EditorPane[], focus?: EditorPane) {
    if (drag.current || interactionBusy) return;
    if (next.every((pane, index) => pane === current.current.order[index])) return;
    if (!onChange(next)) return;
    setAnnouncement(`From left: ${visibleEditorPanes(next, open).map((pane) => PANE_LABELS[pane]).join(', ')}.`);
    if (focus) requestAnimationFrame(() => handles.current[focus]?.focus({ preventScroll: true }));
  }

  function targetAt(x: number, y: number) {
    const bounds = strip.current?.getBoundingClientRect();
    if (!bounds || x < bounds.left - 12 || x > bounds.right + 12 || y < bounds.top - 24 || y > bounds.bottom + 24) return null;
    const centers = panes.map((pane) => { const rect = handles.current[pane]!.getBoundingClientRect(); return rect.left + rect.width / 2; });
    return centers.reduce((best, center, index) => Math.abs(x - center) < Math.abs(x - centers[best]) ? index : best, 0);
  }

  return <div className="editor-arrangement" data-editor-layout-control>
    <button ref={trigger} type="button" className="editor-arrange-trigger" popoverTarget={id} disabled={!supported || interactionBusy} onClick={() => {
      const rect = trigger.current?.getBoundingClientRect(); if (rect) popover.current?.style.setProperty('--arrange-top', `${rect.bottom + 8}px`);
    }}
      title={supported ? 'Choose panel positions' : 'Update your browser to rearrange panels with matching keyboard navigation.'}><PanelsTopLeft size={15}/>Arrange panels</button>
    <div ref={popover} id={id} className="editor-arrange-popover" popover="auto" role="region" aria-label="Arrange panels" onToggle={(event) => {
      if ((event.nativeEvent as ToggleEvent).newState === 'open') {
        const rect = trigger.current?.getBoundingClientRect();
        if (rect) event.currentTarget.style.setProperty('--arrange-top', `${rect.bottom + 8}px`);
      } else finish(false);
    }}>
      <div className="editor-arrange-heading"><strong>Arrange panels</strong><button type="button" aria-label="Close panel arrangement" popoverTarget={id} popoverTargetAction="hide"><X size={16}/></button></div>
      <p>Put the preview where you work best.</p>
      <div className="editor-position-presets" role="group" aria-label="Preview position">
        {(['Left', ...(open ? ['Middle'] : []), 'Right']).map((label, index) => <button key={label} type="button" aria-pressed={panes.indexOf('preview') === index}
          onClick={() => { if (drag.current) return; change(moveEditorPane(order, open, 'preview', index)); }}>
          <span className="editor-position-diagram" aria-hidden="true">{panes.map((_, position) => <i key={position} className={position === index ? 'is-preview' : ''}/>)}</span>
          Preview {label.toLowerCase()}
        </button>)}
      </div>
      <p className="editor-arrange-help" id={`${id}-help`}>Drag a panel, use arrow keys, or choose Left and Right.</p>
      <div ref={strip} className="editor-arrange-strip" style={{ gridTemplateColumns: `repeat(${panes.length}, minmax(0, 1fr))` }}>
        {panes.map((pane, index) => <div key={pane} className={`editor-arrange-panel ${ghost?.pane === pane ? 'is-lifted' : ''} ${target === pane ? 'is-drop-target' : ''}`} data-panel={pane}>
          <button type="button" className="editor-panel-grip" ref={(element) => { if (element) handles.current[pane] = element; else delete handles.current[pane]; }}
            aria-label={`Drag ${PANE_LABELS[pane]} panel to reorder`} aria-describedby={`${id}-help`} onKeyDown={(event) => {
              if (drag.current || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              change(moveEditorPane(order, open, pane, event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1)), pane);
            }} onPointerDown={(event) => {
              if (event.button !== 0 || drag.current || !onBegin()) return;
              event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { pane, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, target: index, handle: event.currentTarget };
            }} onPointerMove={(event) => {
              const gesture = drag.current;
              if (!gesture || gesture.pointer !== event.pointerId) return;
              if (!gesture.active && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
              gesture.active = true;
              gesture.target = targetAt(event.clientX, event.clientY);
              const destination = gesture.target === null ? null : panes[gesture.target];
              setGhost({ pane, x: event.clientX, y: event.clientY }); setTarget(destination); onFeedback(pane, destination);
            }} onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current.target = targetAt(event.clientX, event.clientY); finish(true); } }}
            onPointerCancel={(event) => { if (drag.current?.pointer === event.pointerId) finish(false); }}
            onLostPointerCapture={(event) => { if (drag.current?.pointer === event.pointerId) finish(false); }}>
            <GripVertical size={15}/><span>{PANE_LABELS[pane]}</span>
          </button>
          <div className="editor-panel-moves">
            <button type="button" aria-label={`Move ${PANE_LABELS[pane]} panel left`} disabled={index === 0 || !!ghost} onClick={() => change(moveEditorPane(order, open, pane, index - 1), pane)}><ArrowLeft size={12}/>Left</button>
            <button type="button" aria-label={`Move ${PANE_LABELS[pane]} panel right`} disabled={index === panes.length - 1 || !!ghost} onClick={() => change(moveEditorPane(order, open, pane, index + 1), pane)}>Right<ArrowRight size={12}/></button>
          </div>
        </div>)}
      </div>
      {!open && <p>Your tool panel returns to its saved position when opened.</p>}
      <div className="editor-arrange-status" role="status" aria-live="polite">{announcement || `From left: ${panes.map((pane) => PANE_LABELS[pane]).join(', ')}.`}</div>
      {ghost && <PanelDragGhost {...ghost}/>}
    </div>
  </div>;
}
