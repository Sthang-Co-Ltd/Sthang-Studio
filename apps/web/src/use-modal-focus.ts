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
    let composingTarget: HTMLElement | null = null;
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((item) => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest('[inert], [aria-hidden="true"]'));
    const isTopmost = () => Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) === root;
    const focusFirst = () => {
      const preferred = initialFocus?.current;
      (preferred && !preferred.matches(':disabled') && preferred.getClientRects().length ? preferred : focusable()[0] || root).focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost() || event.defaultPrevented) return;
      if (composingTarget && (!composingTarget.isConnected || !composingTarget.contains(document.activeElement))) composingTarget = null;
      if (composingTarget || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        if (event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss.current();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0] || root;
        const last = items.at(-1) || root;
        if (!items.length) { event.preventDefault(); root.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root || !root.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root || !root.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const onCompositionStart = (event: CompositionEvent) => {
      if (isTopmost() && event.target instanceof HTMLElement && root.contains(event.target)) composingTarget = event.target;
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (event.target === composingTarget) composingTarget = null;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (composingTarget && event.target instanceof Node && composingTarget.contains(event.target)
        && !(event.relatedTarget instanceof Node && composingTarget.contains(event.relatedTarget))) composingTarget = null;
    };
    const onFocusIn = () => { if (isTopmost() && !root.contains(document.activeElement)) focusFirst(); };
    focusFirst();
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    root.addEventListener('compositionstart', onCompositionStart, true);
    root.addEventListener('compositionend', onCompositionEnd, true);
    root.addEventListener('focusout', onFocusOut, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('compositionstart', onCompositionStart, true);
      root.removeEventListener('compositionend', onCompositionEnd, true);
      root.removeEventListener('focusout', onFocusOut, true);
      if (previous?.isConnected) {
        const target = previous.getClientRects().length ? previous : previous.closest('details')?.querySelector('summary');
        target?.focus();
      }
    };
  }, [open, dialog, initialFocus]);
}
