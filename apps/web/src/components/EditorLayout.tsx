import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { PanelArrangement } from './PanelArrangement';
import { PanelHeaderDragContext, PanelHeaderGrip, usePanelHeaderDrag } from './PanelHeaderGrip';
import { isFocusPreservingCaptionViewport, revealFocusedCaptionField, revealFocusedCaptionRow } from '../caption-field-viewport';
import { DEFAULT_EDITOR_LAYOUT, EDITOR_LAYOUT_CHANGE, EDITOR_LAYOUT_KEY, LEGACY_EDITOR_LAYOUT_KEY, PANE_LABELS, editorGeometry, editorResizeBounds, parseEditorLayout, resizeEditorBoundary, visibleEditorPanes, type EditorLayoutPreference, type EditorPane } from '../editor-layout-state';
import './editor-layout.css';

const TimingDock = createContext<HTMLElement | null>(null);
export const useTimingDock = () => useContext(TimingDock);
function readLayout() {
  try { return parseEditorLayout(localStorage.getItem(EDITOR_LAYOUT_KEY)) ?? parseEditorLayout(localStorage.getItem(LEGACY_EDITOR_LAYOUT_KEY), true) ?? structuredClone(DEFAULT_EDITOR_LAYOUT); }
  catch { return structuredClone(DEFAULT_EDITOR_LAYOUT); }
}
function persist(value: EditorLayoutPreference) { try { localStorage.setItem(EDITOR_LAYOUT_KEY, JSON.stringify(value)); } catch { /* Optional local preference. */ } }
const notifyGeometry = () => window.dispatchEvent(new Event(EDITOR_LAYOUT_CHANGE));
interface Props {
  preview: ReactNode; toolbar: ReactNode; captions: ReactNode; children: ReactNode;
  tool: string | null; title: string; open: boolean; onClose?: () => void;
  getCloseFocusTarget?: (fallback: HTMLButtonElement | null) => HTMLElement | null;
}
interface ResizeGesture {
  pointer: number; handle: HTMLDivElement; x: number; left: EditorPane; right: EditorPane;
  preference: EditorLayoutPreference; geometry: ReturnType<typeof editorGeometry>; open: boolean;
}

/** Content never changes parent or DOM position. Grid and reading flow own the arrangement. */
export function EditorLayout({ preview, toolbar, captions, children, tool, title, open, onClose, getCloseFocusTarget }: Props) {
  const workbench = useRef<HTMLDivElement | null>(null);
  const [captionListFocused, setCaptionListFocused] = useState(false);
  const captionFocus = useRef(false);
  const nativeFocusReveal = useRef<{ frame: number; field: HTMLElement; list: HTMLElement; owner: HTMLElement } | null>(null);
  const grid = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(window.innerWidth - 24);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const [preference, setPreference] = useState(readLayout);
  const current = useRef(preference); current.current = preference;
  const [supported] = useState(() => CSS.supports('reading-flow', 'source-order') && CSS.supports('reading-order', '1') && typeof HTMLElement.prototype.showPopover === 'function');
  const order = supported ? preference.order : DEFAULT_EDITOR_LAYOUT.order;
  const panes = visibleEditorPanes(order, open);
  const geometry = editorGeometry(width, open, preference);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const resize = useRef<ResizeGesture | null>(null);
  const [resizing, setResizing] = useState(false);
  const arranging = useRef<'popover' | 'header' | null>(null);
  const [feedback, setFeedback] = useState<{ source: EditorPane | null; target: EditorPane | null }>({ source: null, target: null });
  const geometryKey = `${width}:${wide}:${open}:${tool}`;

  function trackCaptionFocus(target: EventTarget | null) {
    const next = target instanceof Element && Boolean(target.closest('.caption-list')) && Boolean(workbench.current?.contains(target));
    if (next === captionFocus.current) return;
    captionFocus.current = next;
    setCaptionListFocused(next);
  }
  function cancelNativeFocusReveal() {
    if (nativeFocusReveal.current) cancelAnimationFrame(nativeFocusReveal.current.frame);
    nativeFocusReveal.current = null;
  }
  function finishNativeCaptionFocus(target: EventTarget | null) {
    cancelNativeFocusReveal();
    if (!(target instanceof HTMLElement)) return;
    const row = target.hasAttribute('data-caption-id');
    if (!row && !window.matchMedia('(max-width: 1199px)').matches) return;
    if (!row && !(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && !['checkbox', 'range'].includes(target.type))) return;
    if (isFocusPreservingCaptionViewport(target)) return;
    const list = target.closest<HTMLElement>('.caption-list');
    const owner = workbench.current;
    if (!list || !owner || !owner.contains(target)) return;
    // Native focus can scroll before its padding class is committed. Complete
    // that one reveal after layout; later manual browsing schedules no frame.
    const queued = { frame: 0, field: target, list, owner };
    queued.frame = requestAnimationFrame(() => {
      if (nativeFocusReveal.current !== queued) return;
      nativeFocusReveal.current = null;
      if (row) { revealFocusedCaptionRow(queued.field, queued.list, queued.owner); return; }
      const rect = queued.field.getBoundingClientRect();
      const port = queued.owner.getBoundingClientRect();
      const top = port.top + queued.owner.clientTop;
      // Respect a return-focus caller that kept a manually browsed field
      // completely outside the outer viewport with preventScroll.
      if (rect.bottom <= top || rect.top >= top + queued.owner.clientHeight) return;
      revealFocusedCaptionField(queued.field, queued.list, queued.owner);
    });
    nativeFocusReveal.current = queued;
  }
  useLayoutEffect(() => () => cancelNativeFocusReveal(), []);
  // A focused row can disappear without a blur event during Review. Checking
  // the active element is bounded by its ancestry, regardless of list length.
  useLayoutEffect(() => { trackCaptionFocus(document.activeElement); });

  function update(next: EditorLayoutPreference, save = false) { current.current = next; setPreference(next); if (save) persist(next); }
  function finishResize(commit: boolean) {
    const gesture = resize.current;
    if (!gesture) return;
    resize.current = null; setResizing(false);
    if (commit) persist(current.current); else update(gesture.preference);
    if (gesture.handle.hasPointerCapture(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer);
  }
  const finishRef = useRef(finishResize); finishRef.current = finishResize;
  useLayoutEffect(() => {
    if (!grid.current) return;
    // Some live browser sessions suppress observer deliveries. Keep geometry
    // correct at mount and viewport changes without waiting for the observer.
    const measure = () => {
      notifyGeometry();
      const measured = grid.current?.getBoundingClientRect().width;
      if (measured && Number.isFinite(measured)) setWidth(measured);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(grid.current);
    window.addEventListener('resize', measure);
    const query = window.matchMedia('(min-width: 1200px)');
    const change = () => { notifyGeometry(); setWide(query.matches); };
    query.addEventListener('change', change);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !resize.current || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); finishRef.current(false);
    };
    const blur = () => finishRef.current(false);
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', blur);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); query.removeEventListener('change', change); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); const gesture = resize.current; resize.current = null; if (gesture?.handle.hasPointerCapture(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer); };
  }, []);
  useLayoutEffect(() => { finishRef.current(false); notifyGeometry(); }, [geometryKey]);

  function reset() { finishResize(false); notifyGeometry(); update(structuredClone(DEFAULT_EDITOR_LAYOUT), true); }
  function arrange(next: EditorPane[]) {
    if (resize.current || arranging.current || next.every((pane, index) => pane === current.current.order[index])) return false;
    notifyGeometry(); update({ ...current.current, order: next }, true); return true;
  }
  function beginReorder(owner: 'popover' | 'header') {
    if (resize.current || arranging.current) return false;
    if (owner === 'header') {
      const popup = grid.current?.parentElement?.querySelector<HTMLDivElement>('.editor-arrange-popover:popover-open');
      popup?.hidePopover();
    }
    arranging.current = owner; notifyGeometry(); return true;
  }
  function endReorder(owner: 'popover' | 'header') { if (arranging.current === owner) arranging.current = null; }
  const headerDrag = usePanelHeaderDrag({ grid, enabled: wide && supported, order, open, geometryKey,
    begin: () => beginReorder('header'), end: () => endReorder('header'), change: arrange,
    feedback: (source, target) => setFeedback({ source, target }),
  });
  const docked = wide && open && tool === 'timeline';
  const previewIndex = panes.indexOf('preview');
  const middle = previewIndex === 1 && panes.length === 3;
  const column = (pane: EditorPane) => Math.max(0, panes.indexOf(pane)) * 2 + 1;
  const dockStart = middle ? column('captions') : previewIndex === 0 ? 3 : 1;
  const dockEnd = middle ? column('captions') + 1 : previewIndex === 0 ? 6 : 4;
  const tracks = panes.map((pane) => pane === 'captions' ? 'minmax(360px,1fr)' : `${geometry.widths[pane]}px`).join(' 8px ');

  function divider(index: number) {
    const left = panes[index]; const right = panes[index + 1];
    const bounds = right ? editorResizeBounds(geometry, open, left, right) : { minimum: 0, maximum: 0 };
    // React's numeric style serializer adds px to this new integer-only CSS property.
    return <div className="editor-divider" data-boundary={index} data-editor-layout-control role="separator" aria-orientation="vertical"
      aria-label={right ? `Resize ${PANE_LABELS[left]} and ${PANE_LABELS[right]}` : 'Resize panels'} tabIndex={0}
      aria-valuemin={right ? Math.round(geometry.widths[left] + bounds.minimum) : 0}
      aria-valuemax={right ? Math.round(geometry.widths[left] + bounds.maximum) : 0}
      aria-valuenow={right ? Math.round(geometry.widths[left]) : 0}
      aria-valuetext={right ? `${PANE_LABELS[left]} ${Math.round(geometry.widths[left])} pixels, ${PANE_LABELS[right]} ${Math.round(geometry.widths[right])} pixels` : undefined}
      hidden={!right} style={{ gridColumn: index * 2 + 2, order: index * 2 + 1, readingOrder: String(index * 2 + 1) } as CSSProperties}
      title="Drag or use Left and Right to move the divider. Shift makes larger steps. Double-click to reset."
      onDoubleClick={reset} onPointerDown={(event) => {
        if (!right || event.button !== 0 || resize.current || arranging.current) return;
        event.preventDefault(); notifyGeometry(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        resize.current = { pointer: event.pointerId, handle: event.currentTarget, x: event.clientX, left, right, preference: current.current, geometry, open };
        setResizing(true);
      }} onPointerMove={(event) => {
        const gesture = resize.current;
        if (!gesture || gesture.pointer !== event.pointerId) return;
        update(resizeEditorBoundary(gesture.preference, gesture.geometry, gesture.open, gesture.left, gesture.right, event.clientX - gesture.x));
      }} onPointerUp={(event) => { if (resize.current?.pointer === event.pointerId) finishResize(true); }}
      onPointerCancel={(event) => { if (resize.current?.pointer === event.pointerId) finishResize(false); }}
      onLostPointerCapture={(event) => { if (resize.current?.pointer === event.pointerId) finishResize(false); }}
      onKeyDown={(event) => {
        if (!right || resize.current || arranging.current || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')
          || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[aria-modal="true"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          || event.shiftKey && !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); notifyGeometry();
        const delta = event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum : (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 48 : 16);
        update(resizeEditorBoundary(current.current, geometry, open, left, right, delta), true);
      }}><span/></div>;
  }

  return <div ref={workbench} className={`editor-workbench ${captionListFocused ? 'caption-list-focused' : ''}`}
    onFocusCapture={(event) => { trackCaptionFocus(event.target); finishNativeCaptionFocus(event.target); }}
    onBlurCapture={(event) => { cancelNativeFocusReveal(); trackCaptionFocus(event.relatedTarget); }}>
    <span id="panel-reorder-hint" hidden>Use Left or Right arrow, Home or End to move this panel.</span>
    <div className={`editor-toolbar${toolbar ? '' : ' editor-toolbar-empty'}`}>{toolbar}<div className="editor-layout-controls" data-editor-layout-control>
      <PanelArrangement order={order} open={open} supported={supported} geometryKey={geometryKey} interactionBusy={headerDrag.pending || resizing}
        onChange={arrange} onBegin={() => beginReorder('popover')}
        onEnd={() => endReorder('popover')} onFeedback={(source, target) => setFeedback({ source, target })}/>
      <button type="button" className="editor-reset-layout" onClick={reset}><RotateCcw size={14}/>Reset layout</button>
    </div></div>
    <PanelHeaderDragContext.Provider value={headerDrag.context}><TimingDock.Provider value={docked ? dock : null}>
      <section ref={grid} className={`editor-grid refined-editor ${open ? 'inspector-open' : 'inspector-closed'} ${tool === 'timeline' ? 'timing-layout' : ''} ${resizing ? 'is-resizing' : ''} ${headerDrag.lifted ? 'is-header-dragging' : ''}`}
        data-preview-position={previewIndex} data-reorder-source={feedback.source ?? undefined} data-reorder-target={feedback.target ?? undefined}
        style={{ '--editor-columns': tracks, '--editor-preview-column': column('preview'), '--editor-captions-column': column('captions'), '--editor-inspector-column': column('inspector'),
          '--editor-preview-order': panes.indexOf('preview') * 2, '--editor-captions-order': panes.indexOf('captions') * 2, '--editor-inspector-order': panes.indexOf('inspector') * 2,
          '--editor-dock-start': dockStart, '--editor-dock-end': dockEnd, '--editor-inspector-row': docked && middle ? '1 / -1' : '1' } as CSSProperties}>
        <div className="stage-column"><div className="editor-preview-label"><PanelHeaderGrip pane="preview">Preview</PanelHeaderGrip></div>{preview}</div>
        {divider(0)}
        {captions}
        {divider(1)}
        <aside className="workspace-inspector" hidden={!open} aria-label={`${title} workspace`}>
          <div className="inspector-heading" tabIndex={-1} role="group" aria-label={`${title} workspace`}><PanelHeaderGrip pane="inspector">{title}</PanelHeaderGrip>{onClose && <button type="button" data-workspace-close onClick={() => {
            const returnTo = grid.current?.parentElement?.querySelector<HTMLButtonElement>('.workspace-tool-strip button[aria-pressed="true"]')
              || grid.current?.closest('main')?.querySelector<HTMLButtonElement>('.stage-rail button[aria-pressed="true"]') || null;
            onClose();
            requestAnimationFrame(() => {
              const target = getCloseFocusTarget ? getCloseFocusTarget(returnTo) : returnTo;
              if (target?.isConnected) target.focus();
            });
          }}><X size={14}/>Close tool</button>}</div>
          <div className="inspector-content">{children}</div>
        </aside>
        <div ref={setDock} className="editor-timing-dock" hidden={!docked} role="region" aria-label="Audio timing workspace"/>
        <div className="editor-panel-placeholder" hidden={!headerDrag.lifted} aria-hidden="true"><span>{headerDrag.lifted && PANE_LABELS[headerDrag.lifted]}</span></div>
      </section>
    </TimingDock.Provider></PanelHeaderDragContext.Provider>
    <span className="editor-layout-announcement" role="status" aria-live="polite">{headerDrag.announcement}</span>
  </div>;
}
