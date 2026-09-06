import { useEffect, useRef, type RefObject } from 'react';

/** Keyboard isolation, focus trapping and return focus for Studio's modal surfaces. */
export function useModalFocus(
  open: boolean,
  dialog: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const root = dialog.current;
    if (!open || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((item) => item.getClientRects().length > 0);
    const isTopmost = () => Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) === root;
    const focusFirst = () => (initialFocus?.current || focusable()[0] || root).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss.current();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0] || root;
        const last = items.at(-1) || root;
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const onFocusIn = () => { if (isTopmost() && !root.contains(document.activeElement)) focusFirst(); };
    focusFirst();
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previous?.isConnected) {
        const target = previous.getClientRects().length ? previous : previous.closest('details')?.querySelector('summary');
        target?.focus();
      }
    };
  }, [open, dialog, initialFocus]);
}
