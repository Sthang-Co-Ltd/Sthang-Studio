import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/** Keyboard ownership stays inside a logically open menu, including during exit motion. */
export function useMenuKeyboard(openKey: string | null, menu: RefObject<HTMLElement | null>, trigger: () => HTMLElement | null | undefined, close: () => void) {
  const openingEdge = useRef<'first' | 'last'>('first');
  const search = useRef({ text: '', time: 0 });
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
  const focus = (item: HTMLButtonElement | undefined) => {
    if (!item) return;
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((node) => { node.tabIndex = node === item ? 0 : -1; });
    item.focus({ preventScroll: true });
    // Scroll only the popup, never the caption list or evidence canvas.
    const panel = menu.current;
    if (panel) {
      const bounds = panel.getBoundingClientRect(); const target = item.getBoundingClientRect();
      if (target.top < bounds.top) panel.scrollTop -= bounds.top - target.top;
      else if (target.bottom > bounds.bottom) panel.scrollTop += target.bottom - bounds.bottom;
    }
  };
  useLayoutEffect(() => {
    if (!openKey) return;
    const enabled = items();
    search.current = { text: '', time: 0 };
    focus(openingEdge.current === 'last' ? enabled.at(-1) : enabled[0]);
    openingEdge.current = 'first';
  }, [openKey]);
  return {
    openAt: (edge: 'first' | 'last', key = openKey) => { openingEdge.current = edge; if (openKey && openKey === key) { const enabled = items(); focus(edge === 'last' ? enabled.at(-1) : enabled[0]); } },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!openKey || event.defaultPrevented || event.nativeEvent.isComposing || document.querySelector('[aria-modal="true"]')) return;
      if (event.key === 'Tab') {
        trigger()?.focus({ preventScroll: true }); close();
        return; // Native Tab proceeds to the adjacent page control after dismissal.
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const enabled = items();
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
      else if (event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
      else if (event.key === 'Home') next = enabled[0];
      else if (event.key === 'End') next = enabled.at(-1);
      else if (event.key.length === 1 && event.key !== ' ') {
        const now = Date.now();
        const previous = now - search.current.time < 700 ? search.current.text : '';
        const text = previous + event.key.toLocaleLowerCase();
        search.current = { text, time: now };
        const prefix = [...text].every((letter) => letter === text[0]) ? text[0] : text;
        const candidates = [...enabled.slice(index + 1), ...enabled.slice(0, index + 1)];
        next = candidates.find((item) => (item.getAttribute('data-menu-label') || item.textContent || '').trim().toLocaleLowerCase().startsWith(prefix));
      } else return;
      event.preventDefault(); event.stopPropagation();
      focus(next);
    },
  };
}
