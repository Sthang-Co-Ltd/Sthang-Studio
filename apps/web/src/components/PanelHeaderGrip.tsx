import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';
import { EDITOR_LAYOUT_CHANGE, moveEditorPane, PANE_LABELS, visibleEditorPanes, type EditorPane } from '../editor-layout-state';

interface HeaderContext {
  enabled: boolean;
  bindings(pane: EditorPane): ButtonHTMLAttributes<HTMLButtonElement>;
}
export const PanelHeaderDragContext = createContext<HeaderContext | null>(null);

export function PanelHeaderGrip({ pane, children }: { pane: EditorPane; children: string }) {
  const context = useContext(PanelHeaderDragContext);
  if (!context?.enabled) return <strong>{children}</strong>;
  return <button type="button" className="editor-pane-grip" data-editor-layout-control
    aria-label={`Drag ${children} panel header to reorder`} aria-keyshortcuts="ArrowLeft ArrowRight Home End"
    title="Drag to move this panel. Arrow keys move it left or right." {...context.bindings(pane)}>
    <GripVertical size={14} aria-hidden="true"/><strong>{children}</strong>
  </button>;
}

export function PanelDragGhost({ pane, x, y, portal = false }: { pane: EditorPane; x: number; y: number; portal?: boolean }) {
  const element = <div className="editor-panel-ghost" aria-hidden="true" style={{ left: Math.max(8, Math.min(x + 12, window.innerWidth - 136)), top: Math.max(8, Math.min(y + 12, window.innerHeight - 56)) }}><GripVertical size={15}/>{PANE_LABELS[pane]}</div>;
  return portal ? createPortal(element, document.body) : element;
}

interface PaneBox { node: HTMLElement; rect: DOMRect }
interface Gesture {
  pane: EditorPane; pointer: number; x: number; y: number; offsetX: number; offsetY: number; active: boolean; handle: HTMLButtonElement;
  root: HTMLElement; rootRect: DOMRect; key: string; boxes: Map<EditorPane, PaneBox>; order: EditorPane[]; draft: EditorPane[]; open: boolean;
}
interface Options {
  grid: RefObject<HTMLElement | null>;
  enabled: boolean;
  order: EditorPane[];
  open: boolean;
  geometryKey: string;
  begin(): boolean;
  end(): void;
  change(order: EditorPane[]): boolean;
  feedback(source: EditorPane | null, target: EditorPane | null): void;
}
const paneSelectors = { preview: '.stage-column', captions: '.caption-panel', inspector: '.workspace-inspector' };

/** Move the actual panes using transforms; the committed grid and DOM ancestry stay stable. */
export function usePanelHeaderDrag(options: Options) {
  const current = useRef(options); current.current = options;
  const gesture = useRef<Gesture | null>(null);
  const [pending, setPending] = useState(false);
  const [lifted, setLifted] = useState<EditorPane | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const animations = useRef(new Map<HTMLElement, Animation>());
  const landing = useRef<{ rects: Map<HTMLElement, DOMRect>; source: HTMLElement } | null>(null);

  function stopMotion() {
    for (const [node, animation] of animations.current) { animation.cancel(); node.classList.remove('editor-pane-settling', 'editor-pane-landing'); }
    animations.current.clear();
  }
  function settle(rects: Map<HTMLElement, DOMRect>, source: HTMLElement) {
    stopMotion();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [node, before] of rects) {
      if (!node.isConnected || getComputedStyle(node).display === 'none') continue;
      const after = node.getBoundingClientRect();
      if (!after.width || !after.height) continue;
      const dx = before.left - after.left; const dy = before.top - after.top;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(before.height - after.height) < .5) continue;
      const animation = node.animate([
        { transform: `translate3d(${dx}px,${dy}px,0) scale(${before.width / after.width},${before.height / after.height})`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ], { duration: 180, easing: 'cubic-bezier(.16,1,.3,1)' });
      node.classList.add('editor-pane-settling'); animations.current.set(node, animation);
      if (node === source) node.classList.add('editor-pane-landing');
      const clear = () => { if (animations.current.get(node) === animation) { animations.current.delete(node); node.classList.remove('editor-pane-settling', 'editor-pane-landing'); } };
      animation.onfinish = clear; animation.oncancel = clear;
    }
  }
  function geometryMatches(drag: Gesture) {
    // A pointer release can arrive before ResizeObserver/media-query callbacks.
    // Read current geometry synchronously rather than trusting those notifications.
    if (!current.current.enabled || current.current.geometryKey !== drag.key || !window.matchMedia('(min-width: 1200px)').matches) return false;
    const rect = drag.root.getBoundingClientRect();
    return (['left', 'top', 'width', 'height'] as const).every((key) => Math.abs(rect[key] - drag.rootRect[key]) < .5);
  }
  function validAt(drag: Gesture, x: number, y: number) {
    // Frozen bounds exclude the waveform/gaps and cannot chase the moving source.
    return [...drag.boxes.values()].some(({ rect }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
  }
  function positions(drag: Gesture) {
    let left = drag.boxes.get(visibleEditorPanes(drag.order, drag.open)[0])!.rect.left;
    return new Map(visibleEditorPanes(drag.draft, drag.open).map((pane) => {
      const position = left; left += drag.boxes.get(pane)!.rect.width + 8;
      return [pane, position];
    }));
  }
  function move(drag: Gesture, x: number, y: number) {
    const valid = validAt(drag, x, y);
    if (valid) {
      // Cross a neighbour's midpoint to insert. Its new position provides natural
      // hysteresis, so stationary pointers cannot cause the panels to oscillate.
      for (let step = 0; step < drag.boxes.size - 1; step++) {
        const panes = visibleEditorPanes(drag.draft, drag.open); const index = panes.indexOf(drag.pane);
        const projected = positions(drag);
        const middle = (pane: EditorPane) => projected.get(pane)! + drag.boxes.get(pane)!.rect.width / 2;
        const previous = panes[index - 1]; const next = panes[index + 1];
        const destination = previous && x <= middle(previous) ? index - 1 : next && x >= middle(next) ? index + 1 : index;
        if (destination === index) break;
        drag.draft = moveEditorPane(drag.draft, drag.open, drag.pane, destination);
      }
    }
    const projected = positions(drag); const source = drag.boxes.get(drag.pane)!;
    for (const [pane, { node, rect }] of drag.boxes) {
      node.style.transform = pane === drag.pane ? `translate3d(${drag.offsetX + x - drag.x}px,${drag.offsetY + y - drag.y}px,0)` : `translate3d(${projected.get(pane)! - rect.left}px,0,0)`;
    }
    const root = drag.root.getBoundingClientRect();
    for (const [name, value] of Object.entries({ left: projected.get(drag.pane)! - root.left, top: source.rect.top - root.top, width: source.rect.width, height: source.rect.height })) drag.root.style.setProperty(`--editor-drop-${name}`, `${value}px`);
    drag.root.dataset.headerDragOrder = visibleEditorPanes(drag.draft, drag.open).join(',');
    drag.root.dataset.headerDropValid = String(valid);
  }
  function announce(order: EditorPane[]) {
    setAnnouncement(`From left: ${visibleEditorPanes(order, current.current.open).map((pane) => PANE_LABELS[pane]).join(', ')}.`);
  }
  function finish(commit: boolean, x?: number, y?: number, animate = true) {
    const drag = gesture.current;
    if (!drag) return;
    const matching = geometryMatches(drag);
    const valid = commit && matching && drag.active && x !== undefined && y !== undefined && validAt(drag, x, y);
    if (valid) move(drag, x, y);
    const rects = new Map([...drag.boxes.values()].map(({ node }) => [node, node.getBoundingClientRect()]));
    gesture.current = null; setPending(false); setLifted(null);
    for (const { node } of drag.boxes.values()) { node.classList.remove('editor-pane-floating', 'editor-pane-shifting', 'editor-pane-held'); node.style.removeProperty('transform'); }
    for (const name of ['left', 'top', 'width', 'height']) drag.root.style.removeProperty(`--editor-drop-${name}`);
    delete drag.root.dataset.headerDragOrder; delete drag.root.dataset.headerDropValid;
    current.current.feedback(null, null); current.current.end();
    if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    const source = drag.boxes.get(drag.pane)!.node;
    if (valid && current.current.change(drag.draft)) { landing.current = { rects, source }; announce(drag.draft); }
    else {
      if (animate && matching && (drag.active || Math.hypot(drag.offsetX, drag.offsetY) > .5)) settle(rects, source);
      if (drag.active) setAnnouncement(valid ? 'Panel kept in place.' : 'Panel move cancelled.');
    }
  }
  const finishRef = useRef(finish); finishRef.current = finish;
  useLayoutEffect(() => {
    finishRef.current(false, undefined, undefined, false);
    if (landing.current) { const { rects, source } = landing.current; landing.current = null; settle(rects, source); }
  }, [options.geometryKey, options.enabled, options.order]);
  useEffect(() => {
    const cancel = () => finishRef.current(false);
    const geometry = () => { finishRef.current(false, undefined, undefined, false); landing.current = null; stopMotion(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener(EDITOR_LAYOUT_CHANGE, geometry);
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener(EDITOR_LAYOUT_CHANGE, geometry);
      window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true);
      stopMotion(); const drag = gesture.current; gesture.current = null;
      if (drag) for (const { node } of drag.boxes.values()) { node.classList.remove('editor-pane-floating', 'editor-pane-shifting', 'editor-pane-held'); node.style.removeProperty('transform'); }
      if (drag?.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    };
  }, []);

  function bindings(pane: EditorPane): ButtonHTMLAttributes<HTMLButtonElement> {
    return {
      onPointerDown(event) {
        if (!current.current.enabled || event.button !== 0 || gesture.current) return;
        // Capture the grabbed point before begin() cancels settling. Fractions
        // also preserve the anchor when the inspector is settling in height.
        const presented = event.currentTarget.getBoundingClientRect();
        const fraction = (point: number, start: number, size: number) => size ? Math.max(0, Math.min(1, (point - start) / size)) : .5;
        const grabX = fraction(event.clientX, presented.left, presented.width);
        const grabY = fraction(event.clientY, presented.top, presented.height);
        if (!current.current.begin()) return;
        const { grid, order, open } = current.current; const root = grid.current!;
        const boxes = new Map(visibleEditorPanes(order, open).map((id) => {
          const node = root.querySelector<HTMLElement>(`:scope > ${paneSelectors[id]}`)!;
          return [id, { node, rect: node.getBoundingClientRect() }];
        }));
        const logical = event.currentTarget.getBoundingClientRect();
        const offsetX = event.clientX - logical.left - logical.width * grabX;
        const offsetY = event.clientY - logical.top - logical.height * grabY;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { pane, pointer: event.pointerId, x: event.clientX, y: event.clientY, offsetX, offsetY, active: false, handle: event.currentTarget, root, rootRect: root.getBoundingClientRect(), key: current.current.geometryKey, boxes, order: [...order], draft: [...order], open };
        if (Math.hypot(offsetX, offsetY) > .5) {
          const source = boxes.get(pane)!.node;
          source.classList.add('editor-pane-held'); source.style.transform = `translate3d(${offsetX}px,${offsetY}px,0)`;
        }
        setPending(true);
      },
      onPointerMove(event) {
        const drag = gesture.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (!geometryMatches(drag)) { finish(false, undefined, undefined, false); return; }
        if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        if (!drag.active) {
          drag.active = true; setLifted(pane); current.current.feedback(pane, null);
          for (const [id, { node }] of drag.boxes) node.classList.add(id === pane ? 'editor-pane-floating' : 'editor-pane-shifting');
        }
        move(drag, event.clientX, event.clientY);
      },
      onPointerUp(event) { if (gesture.current?.pointer === event.pointerId) finish(true, event.clientX, event.clientY); },
      onPointerCancel(event) { if (gesture.current?.pointer === event.pointerId) finish(false); },
      onLostPointerCapture(event) { if (gesture.current?.pointer === event.pointerId) finish(false); },
      onKeyDown(event) {
        if (!current.current.enabled || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const { order, open } = current.current;
        const panes = visibleEditorPanes(order, open);
        const index = panes.indexOf(pane);
        const to = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1);
        const next = moveEditorPane(order, open, pane, to);
        if (current.current.change(next)) announce(next);
      },
    };
  }
  return { pending, lifted, announcement, context: { enabled: options.enabled, bindings } };
}
