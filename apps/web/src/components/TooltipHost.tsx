import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Hint = { target: HTMLElement; text: string; shortcut: string };
/** One noninteractive hint; the real controls keep their layout and focus. */
export function TooltipHost() {
  const id = useId();
  const bubble = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const active = useRef<Hint | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let dismissed: HTMLElement | null = null;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;
    let pending: HTMLElement | null = null;
    const trigger = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
    const available = (target: HTMLElement) => {
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      const menu = [...document.querySelectorAll('[role="menu"]')].find((item) => (!modal || modal.contains(item)) && item.getClientRects().length && !item.closest('[inert],[hidden],[aria-hidden="true"]'));
      return target.isConnected && Boolean(target.dataset.tooltip) && target.getAttribute('aria-expanded') !== 'true' && Boolean(target.getClientRects().length) && !target.closest('[inert],[hidden],[aria-hidden="true"]')
        && (!modal || modal.contains(target)) && (!menu || menu.contains(target));
    };
    const hide = () => {
      window.clearTimeout(showTimer); window.clearTimeout(hideTimer); pending = null;
      active.current = null; setHint(null); setPosition(null);
    };
    const show = (target: HTMLElement | null, immediate = false) => {
      window.clearTimeout(hideTimer);
      if (!target || dismissed === target || !available(target)) return;
      if (active.current?.target === target || pending === target && !immediate) return;
      window.clearTimeout(showTimer); pending = target;
      showTimer = window.setTimeout(() => {
        pending = null;
        if (!available(target) || dismissed === target || (hovered !== target && focused !== target)) return;
        const text = target.dataset.tooltip;
        if (!text) return;
        const shortcut = (target.dataset.tooltipShortcut || '').replace(/Ctrl/g, navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl');
        const next = { target, text, shortcut };
        active.current = next; setPosition(null); setHint(next);
      }, immediate ? 0 : 450);
    };
    const leave = () => {
      window.clearTimeout(showTimer); pending = null;
      hideTimer = window.setTimeout(() => {
        if (hovered === active.current?.target || focused === active.current?.target || bubble.current?.matches(':hover')) return;
        hide(); show(focused || hovered);
      }, 100);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (event.target instanceof Node && bubble.current?.contains(event.target)) { window.clearTimeout(hideTimer); return; }
      const next = trigger(event.target);
      if (next === hovered) return;
      hovered = next;
      if (dismissed !== next) dismissed = null;
      if (next) show(next); else leave();
    };
    const out = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const next = trigger(event.relatedTarget);
      if (next === hovered && next) return;
      hovered = next;
      if (event.relatedTarget instanceof Node && bubble.current?.contains(event.relatedTarget)) { window.clearTimeout(hideTimer); return; }
      if (next) show(next); else leave();
    };
    const focusIn = (event: FocusEvent) => {
      const next = trigger(event.target);
      focused = next?.matches(':focus-visible') ? next : null;
      if (dismissed !== focused) dismissed = null;
      show(focused, true);
    };
    const focusOut = (event: FocusEvent) => {
      const next = trigger(event.relatedTarget);
      focused = next?.matches(':focus-visible') ? next : null;
      if (!focused) leave();
    };
    const dismiss = () => { dismissed = active.current?.target || pending || hovered || focused; hide(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        // A hint still waiting for its hover delay has no visible surface to
        // dismiss. It must never take Escape from an open menu or dialog.
        if (active.current && available(active.current.target)) { event.preventDefault(); event.stopPropagation(); }
        if (active.current || pending) dismiss();
      }
    };
    const observer = new MutationObserver(() => { if (active.current && !available(active.current.target)) hide(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-modal', 'aria-expanded', 'data-tooltip'] });
    document.addEventListener('pointerover', over); document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focusIn); document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss);
    return () => {
      window.clearTimeout(showTimer); window.clearTimeout(hideTimer); observer.disconnect();
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focusIn); document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss);
    };
  }, []);
  useLayoutEffect(() => {
    if (!hint || !bubble.current) return;
    const anchor = hint.target.getBoundingClientRect();
    const bounds = bubble.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, anchor.left + anchor.width / 2 - bounds.width / 2));
    const below = anchor.bottom + 8;
    const top = below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 8);
    setPosition({ left, top });
    const tokens = new Set((hint.target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    const existed = tokens.has(id); tokens.add(id); hint.target.setAttribute('aria-describedby', [...tokens].join(' '));
    return () => {
      if (existed) return;
      const remaining = (hint.target.getAttribute('aria-describedby') || '').split(/\s+/).filter((value) => value && value !== id);
      if (remaining.length) hint.target.setAttribute('aria-describedby', remaining.join(' ')); else hint.target.removeAttribute('aria-describedby');
    };
  }, [hint, id]);
  if (!hint) return null;
  return createPortal(<div ref={bubble} id={id} role="tooltip" className="studio-tooltip" style={{ left: position?.left || 0, top: position?.top || 0, visibility: position ? 'visible' : 'hidden' }}>
    <span>{hint.text}</span>{hint.shortcut && <kbd aria-hidden="true">{hint.shortcut}</kbd>}
  </div>, document.body);
}
