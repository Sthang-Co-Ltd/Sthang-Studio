import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useSurfacePresence } from '../use-surface-presence';
import { focusPreservingCaptionViewport } from '../caption-field-viewport';

export interface ToastLayoutState { hasContent: boolean; hasPersistentRecovery: boolean; hasSaveFailure: boolean }
const emptyLayout: ToastLayoutState = { hasContent: false, hasPersistentRecovery: false, hasSaveFailure: false };

/** Presentation may linger briefly; dismissed actions become inert immediately. */
function ToastSlot({ open, children, onExited, restoreFocus }: { open: boolean; children: ReactNode; onExited(): void; restoreFocus(): void }) {
  const shell = useRef<HTMLDivElement | null>(null);
  const presence = useSurfacePresence(open ? 'toast' : null, shell, 'toast');
  useLayoutEffect(() => () => {
    if (open && shell.current?.contains(document.activeElement)) restoreFocus();
  }, [open, restoreFocus]);
  useEffect(() => { if (!open && !presence.present) onExited(); }, [open, presence.present, onExited]);
  if (!presence.present) return null;
  return <div ref={shell} className="toast-slot" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined}>
    <div className="toast-slot-body">{children}</div>
  </div>;
}

export function ToastStack({ children, onLayoutChange }: { children: ReactNode; onLayoutChange?: (state: ToastLayoutState) => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const reportedLayout = useRef<string | null>(null);
  const current = useMemo(() => Children.toArray(children).filter(isValidElement), [children]);
  const latest = useRef(current); latest.current = current;
  const [previous, setPrevious] = useState(current);
  const [retained, setRetained] = useState(current);
  if (previous !== current) {
    const next = [...current];
    retained.forEach((child, index) => {
      if (!current.some((item) => item.key === child.key)) next.splice(Math.min(index, next.length), 0, child);
    });
    setPrevious(current); setRetained(next);
  }
  const [restoreFocus] = useState(() => () => {
    const target = returnTo.current;
    if (target?.isConnected && target.getClientRects().length && !target.closest('[inert],[hidden],[aria-hidden="true"]') && !target.matches(':disabled')) {
      focusPreservingCaptionViewport(target);
    }
  });
  const reportLayout = useCallback(() => {
    const element = root.current;
    if (!element || !onLayoutChange) return;
    // Observe only the small notice stack, including retained exit animations.
    // Ancestor :has() rules made every caption edit restyle the entire editor.
    const hasSaveFailure = Boolean(element.querySelector('.save-failure'));
    const next = { hasContent: element.childElementCount > 0, hasSaveFailure,
      hasPersistentRecovery: hasSaveFailure || Boolean(element.querySelector('.unfinished-recovery,.recovery-storage-error')) };
    const signature = `${next.hasContent}:${next.hasPersistentRecovery}:${next.hasSaveFailure}`;
    if (signature === reportedLayout.current) return;
    reportedLayout.current = signature;
    onLayoutChange(next);
  }, [onLayoutChange]);
  // Publish committed content before a menu ResizeObserver can see a temporary
  // fixed overlay. App still captures caption visibility before changing layout.
  useLayoutEffect(() => { reportLayout(); });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !onLayoutChange) return;
    reportLayout();
    // Presence animations can remove content in a child-only commit.
    const observer = new MutationObserver(reportLayout);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => { observer.disconnect(); reportedLayout.current = null; onLayoutChange(emptyLayout); };
  }, [onLayoutChange, reportLayout]);
  useEffect(() => {
    const remember = () => {
      const target = document.activeElement;
      if (target instanceof HTMLElement && target !== document.body && !root.current?.contains(target)) returnTo.current = target;
    };
    remember(); document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);
  return <div ref={root} className="toast-stack" aria-live="polite" aria-atomic="false">
    {retained.map((child: ReactElement) => {
      const visible = current.find((item) => item.key === child.key);
      return <ToastSlot key={child.key} open={Boolean(visible)} restoreFocus={restoreFocus}
        onExited={() => { if (!latest.current.some((item) => item.key === child.key)) setRetained((items) => items.filter((item) => item.key !== child.key)); }}>
        {visible || child}
      </ToastSlot>;
    })}
  </div>;
}
