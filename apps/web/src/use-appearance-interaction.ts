import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type FocusEvent } from 'react';
import type { CaptionAppearance } from '@kcs/shared';

/** Publish at most once per browser paint, but flush synchronously on every way
 * a slider interaction can finish. Autosave remains owned by the workspace.
 */
export function useAppearanceInteraction(appearance: CaptionAppearance, publish: (value: CaptionAppearance) => void, interaction: (active: boolean) => void) {
  const latest = useRef({ appearance, publish, interaction });
  latest.current = { appearance, publish, interaction };
  const scheduled = useRef<number | undefined>(undefined);
  const active = useRef(false);
  const flush = () => {
    if (scheduled.current !== undefined) cancelAnimationFrame(scheduled.current);
    scheduled.current = undefined;
    latest.current.publish(latest.current.appearance);
  };
  const finish = () => {
    if (!active.current) return;
    flush(); active.current = false; latest.current.interaction(false);
  };
  useEffect(() => {
    scheduled.current = requestAnimationFrame(() => { scheduled.current = undefined; latest.current.publish(latest.current.appearance); });
    return () => { if (scheduled.current !== undefined) cancelAnimationFrame(scheduled.current); };
  }, [appearance, publish]);
  useEffect(() => {
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keyup', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keyup', finish);
      window.removeEventListener('blur', finish);
      flush();
      if (active.current) { active.current = false; latest.current.interaction(false); }
    };
  }, []);
  const isRange = (target: EventTarget) => target instanceof HTMLInputElement && target.type === 'range';
  const begin = () => { if (!active.current) { active.current = true; latest.current.interaction(true); } };
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => { if (isRange(event.target)) begin(); },
    onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
      if (isRange(event.target) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) begin();
    },
    onBlurCapture: (event: FocusEvent<HTMLElement>) => { if (isRange(event.target)) finish(); },
  };
}
