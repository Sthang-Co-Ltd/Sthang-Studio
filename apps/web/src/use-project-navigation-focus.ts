import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ProjectNavigationFocusRequest { readonly owner: HTMLElement }
type PendingFocus = { request: ProjectNavigationFocusRequest; release(): void };
type Completion = { request: ProjectNavigationFocusRequest; target(): HTMLElement | null; reveal?(target: HTMLElement): void };

/** One explicit Open/Back action owns one handoff after its destination commits. */
export function useProjectNavigationFocus() {
  const pending = useRef<PendingFocus | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const release = useCallback((request?: ProjectNavigationFocusRequest | null) => {
    const current = pending.current;
    if (!current || request && current.request !== request) return;
    pending.current = null;
    current.release();
  }, []);
  const cancel = useCallback((request: ProjectNavigationFocusRequest | null) => {
    if (request) release(request);
  }, [release]);
  const capture = useCallback((owner: Element | null = document.activeElement): ProjectNavigationFocusRequest | null => {
    release();
    if (!(owner instanceof HTMLElement) || owner === document.body || !owner.isConnected || document.activeElement !== owner) return null;
    const request = { owner };
    const relinquish = () => release(request);
    const onFocus = (event: FocusEvent) => {
      // Disabling or removing the initiating button can leave body active without
      // a new user choice. Subsequent input or focus on another control wins.
      if (event.target !== owner && event.target !== document.body) relinquish();
    };
    pending.current = { request, release: () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', relinquish, true);
      document.removeEventListener('keydown', relinquish, true);
      window.removeEventListener('blur', relinquish);
    } };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', relinquish, true);
    document.addEventListener('keydown', relinquish, true);
    window.addEventListener('blur', relinquish);
    return request;
  }, [release]);
  const complete = useCallback((request: ProjectNavigationFocusRequest | null, target: () => HTMLElement | null, reveal?: (target: HTMLElement) => void) => {
    if (request && pending.current?.request === request) setCompletion({ request, target, reveal });
  }, []);

  useLayoutEffect(() => {
    if (!completion || pending.current?.request !== completion.request) return;
    const { owner } = completion.request;
    const active = document.activeElement;
    // Consume before focusing so no future render can repeat this action.
    release(completion.request);
    if (active !== owner && active !== document.body) return;
    const foreground = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], .new-user-guide')]
      .some((node) => node.getClientRects().length && !node.closest('[inert],[hidden],[aria-hidden="true"]'));
    if (foreground) return;
    const target = completion.target();
    if (!target?.isConnected || !target.getClientRects().length || target.matches(':disabled') || target.closest('[inert],[hidden],[aria-hidden="true"]')) return;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) return;
    if (completion.reveal) completion.reveal(target);
    else target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [completion, release]);
  useLayoutEffect(() => () => release(), [release]);
  return { capture, complete, cancel };
}
