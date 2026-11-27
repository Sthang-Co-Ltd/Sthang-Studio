import { useEffect, useId, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

interface Props {
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  context?: string;
  className?: string;
  onChange(value: number, history: 'discrete' | 'range'): void;
}

/** Reveal the whole numeric control only while this focus still owns the action.
 * Pointer focus on a range must never move the track underneath an active drag. */
function revealFocusedControl(group: HTMLElement, target: HTMLElement) {
  const number = target instanceof HTMLInputElement && target.type === 'number';
  if (!number && !target.matches(':focus-visible')) return;
  queueMicrotask(() => {
    if (!group.isConnected || !target.isConnected || document.activeElement !== target
      || !group.contains(target) || !number && !target.matches(':focus-visible')) return;
    const bounds = group.getBoundingClientRect();
    const stack = group.closest('.workspace')?.querySelector<HTMLElement>(':scope > .toast-stack');
    if (!stack || getComputedStyle(stack).position !== 'fixed') return;
    const toast = stack.getBoundingClientRect();
    if (!toast.height || toast.left >= bounds.right || toast.right <= bounds.left) return;
    const documentScroll = document.scrollingElement;
    if (!(documentScroll instanceof HTMLElement)) return;
    let scrollport = documentScroll;
    for (let node = group.parentElement; node && node !== documentScroll; node = node.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
        scrollport = node; break;
      }
    }
    const viewport = window.visualViewport;
    let top = viewport?.offsetTop ?? 0;
    let bottom = Math.min(viewport ? viewport.offsetTop + viewport.height : window.innerHeight, toast.top - 8);
    if (scrollport !== documentScroll) {
      const port = scrollport.getBoundingClientRect();
      top = Math.max(top, port.top + scrollport.clientTop);
      bottom = Math.min(bottom, port.top + scrollport.clientTop + scrollport.clientHeight);
    }
    const workbench = group.closest('.editor-workbench');
    for (const overlay of [workbench?.querySelector<HTMLElement>('.editor-toolbar'), workbench?.querySelector<HTMLElement>('.stage-column')]) {
      if (!overlay || getComputedStyle(overlay).position !== 'sticky') continue;
      const box = overlay.getBoundingClientRect();
      if (box.left < bounds.right && box.right > bounds.left && box.top <= bounds.top) top = Math.max(top, box.bottom + 8);
    }
    // Respect the real space between sticky evidence and the notice, and the
    // current scrollport's remaining range; never manufacture more room.
    const distance = Math.min(Math.max(0, bounds.bottom - bottom), Math.max(0, bounds.top - top),
      Math.max(0, scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop));
    if (distance > 0) scrollport.scrollBy({ top: distance, behavior: 'instant' });
  });
}

/** A typed value is one undoable edit; the existing slider keeps gesture history. */
export function AppearanceRange({ label, value, defaultValue, min, max, step = 1, unit = '', context, className = '', onChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [feedback, setFeedback] = useState<{ value: number; message: string } | null>(null);
  const cancelled = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const precision = String(step).split('.')[1]?.length || 0;
  useEffect(() => {
    setDraft(String(value));
    // Keep this edit's accepted-value receipt, but drop it after Undo, a preset,
    // or another external value change. Returning later must not revive it.
    setFeedback((current) => current?.value === value ? current : null);
  }, [value]);
  const commit = () => {
    const number = Number(draft);
    if (cancelled.current || !draft.trim() || !Number.isFinite(number)) {
      cancelled.current = false;
      setDraft(String(value));
      setFeedback(null);
      return;
    }
    if (number === value) { setDraft(String(value)); setFeedback(null); return; }
    const bounded = Math.min(max, Math.max(min, number));
    const next = Number((min + Math.round((bounded - min) / step) * step).toFixed(precision));
    setDraft(String(next));
    const accepted = `${next}${unit ? ` ${unit}` : ''}`;
    const message = bounded !== number ? `Adjusted to ${accepted}: the ${number > max ? 'maximum' : 'minimum'}.`
      : next !== number ? `Rounded to ${accepted}: nearest ${step}${unit ? ` ${unit}` : ''} step.` : '';
    setFeedback(message ? { value: next, message } : null);
    if (next !== value) onChange(next, 'discrete');
  };
  const notice = feedback?.value === value ? feedback.message : '';
  const resetLabel = `Reset ${label.toLowerCase()} to ${defaultValue}${unit ? ` ${unit}` : ''}`;
  return <div className={`range-field appearance-number-control ${className}`} onFocusCapture={(event) => {
    if (event.target instanceof HTMLElement) revealFocusedControl(event.currentTarget, event.target);
  }}>
    <div className="appearance-number-heading">
      <label htmlFor={`${id}-range`}>{label}</label>
      <div className="appearance-number-actions">
        <div className="appearance-number-value">
          <input ref={input} type="number" aria-label={`Exact ${label.toLowerCase()}`} aria-describedby={[context ? `${id}-context` : '', notice ? `${id}-feedback` : ''].filter(Boolean).join(' ') || undefined}
            min={min} max={max} step={step} value={draft}
            title={`${min}–${max}${unit ? ` ${unit}` : ''}. Enter to apply; Escape to cancel.`}
            onFocus={(event) => { cancelled.current = false; event.currentTarget.select(); }}
            onChange={(event) => { setDraft(event.target.value); setFeedback(null); }} onBlur={commit}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event) => {
              // Some IMEs omit the native flag on Escape. Keep that composing
              // key away from the workspace close handler without cancelling it.
              if (composing.current && (event.key === 'Enter' || event.key === 'Escape')) event.stopPropagation();
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')
                || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation();
                cancelled.current = event.key === 'Escape';
                event.currentTarget.blur();
              }
            }}/>
          {unit && <span aria-hidden="true">{unit}</span>}
        </div>
        <button type="button" className="appearance-number-reset" aria-label={resetLabel} title={`${resetLabel} (Studio default)`}
          style={{ visibility: value === defaultValue ? 'hidden' : undefined }}
          onClick={() => { setFeedback(null); onChange(defaultValue, 'discrete'); input.current?.focus({ preventScroll: true }); }}><RotateCcw size={13}/></button>
      </div>
    </div>
    <input id={`${id}-range`} type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={value}
      onChange={(event) => { setFeedback(null); onChange(Number(event.target.value), 'range'); }}/>
    {context && <small id={`${id}-context`} className="appearance-number-context">{context}</small>}
    {notice && <small id={`${id}-feedback`} className="appearance-number-feedback" role="status" aria-atomic="true">{notice}</small>}
  </div>;
}
