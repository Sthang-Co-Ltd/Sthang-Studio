import { useEffect, useRef } from 'react';

/** Count only time when the message is visible and not being read or used. */
export function useToastTimeout(id: string, value: unknown, duration: number, dismiss: () => void) {
  const callback = useRef(dismiss); callback.current = dismiss;
  useEffect(() => {
    if (!value) return;
    const node = () => document.querySelector<HTMLElement>(`[data-toast-timer="${id}"]`);
    let currentNode = node();
    let hovering = Boolean(currentNode?.matches(':hover'));
    let remaining = duration;
    let started = 0;
    let timer: number | undefined;
    const paused = () => {
      const element = node();
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      return document.hidden || !element || hovering || element.contains(document.activeElement)
        || Boolean(modal && !modal.contains(element));
    };
    const update = () => {
      const element = node();
      if (currentNode !== element) { currentNode = element; hovering = Boolean(element?.matches(':hover')); }
      if (paused()) {
        if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; remaining = Math.max(0, remaining - (performance.now() - started)); }
      } else if (timer === undefined) {
        started = performance.now();
        timer = window.setTimeout(() => { timer = undefined; callback.current(); }, remaining);
      }
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const element = node();
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      hovering = event.type === 'pointerover'; update();
    };
    // Focusout fires before activeElement changes; a microtask observes its destination.
    let disposed = false;
    const focus = () => queueMicrotask(() => { if (!disposed) update(); });
    update();
    // A replacement dialog can temporarily suppress the stack. Resume the same
    // remaining reading time when it returns, rather than expiring invisibly.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    document.addEventListener('pointerover', pointer); document.addEventListener('pointerout', pointer);
    document.addEventListener('focusin', focus); document.addEventListener('focusout', focus);
    document.addEventListener('visibilitychange', update);
    return () => {
      disposed = true; window.clearTimeout(timer); observer.disconnect();
      document.removeEventListener('pointerover', pointer); document.removeEventListener('pointerout', pointer);
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus);
      document.removeEventListener('visibilitychange', update);
    };
  }, [id, value, duration]);
}
