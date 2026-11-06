import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Keep only the dismissed surface's pixels around for its short exit.
 * Callers make the closing subtree inert/hidden to accessibility immediately;
 * logical open state still owns focus, actions, and work. No delayed actions.
 */
export function useSurfacePresence<T extends string>(
  value: T | null,
  surface: RefObject<HTMLElement | null>,
  kind: 'menu' | 'sheet' | 'toast',
) {
  const [retained, setRetained] = useState(value);
  const interrupted = useRef<{ node: HTMLElement; opacity: string; transform: string } | null>(null);
  const present = value !== null || retained !== null;

  useLayoutEffect(() => {
    if (!present) return;
    const node = surface.current;
    if (!node) { setRetained(null); return; }
    if (value !== null) setRetained(value);
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches || typeof node.animate !== 'function') {
      interrupted.current = null;
      if (value === null) setRetained(null);
      return;
    }
    const closed = { opacity: '0', transform: kind === 'sheet' ? 'translateX(10px)' : kind === 'toast' ? 'translateY(4px)' : 'scale(.98)' };
    const visible = { opacity: '1', transform: 'none' };
    const previous = interrupted.current;
    const from = previous?.node === node
      ? { opacity: previous.opacity, transform: previous.transform }
      : value !== null ? closed : visible;
    interrupted.current = null;
    let animation: Animation;
    try {
      animation = node.animate([from, value !== null ? visible : closed], {
        duration: value !== null ? 180 : 140,
        easing: 'cubic-bezier(.16,1,.3,1)',
        fill: 'both',
      });
    } catch {
      // Optional presentation must never leave a utility stuck open.
      if (value === null) setRetained(null);
      return;
    }
    let disposed = false;
    let settled = false;
    const finish = () => {
      if (disposed) return;
      settled = true;
      if (value === null) setRetained(null);
      animation.cancel();
    };
    void animation.finished.then(finish, () => {});
    const reduce = () => { if (preference.matches) finish(); };
    preference.addEventListener('change', reduce);
    return () => {
      disposed = true;
      if (!settled && node.isConnected) {
        const style = getComputedStyle(node);
        interrupted.current = { node, opacity: style.opacity, transform: style.transform };
      }
      animation.cancel();
      preference.removeEventListener('change', reduce);
    };
  }, [value, present, surface, kind]);

  return { present, value: value ?? retained, open: value !== null };
}
