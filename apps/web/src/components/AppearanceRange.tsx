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

/** A typed value is one undoable edit; the existing slider keeps gesture history. */
export function AppearanceRange({ label, value, defaultValue, min, max, step = 1, unit = '', context, className = '', onChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [feedback, setFeedback] = useState<{ value: number; message: string } | null>(null);
  const cancelled = useRef(false);
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
    const message = bounded !== number ? `Adjusted to ${accepted} — the ${number > max ? 'maximum' : 'minimum'}.`
      : next !== number ? `Rounded to ${accepted} — nearest ${step}${unit ? ` ${unit}` : ''} step.` : '';
    setFeedback(message ? { value: next, message } : null);
    if (next !== value) onChange(next, 'discrete');
  };
  const notice = feedback?.value === value ? feedback.message : '';
  const resetLabel = `Reset ${label.toLowerCase()} to ${defaultValue}${unit ? ` ${unit}` : ''}`;
  return <div className={`range-field appearance-number-control ${className}`}>
    <div className="appearance-number-heading">
      <label htmlFor={`${id}-range`}>{label}</label>
      <div className="appearance-number-actions">
        <div className="appearance-number-value">
          <input ref={input} type="number" aria-label={`Exact ${label.toLowerCase()}`} aria-describedby={[context ? `${id}-context` : '', notice ? `${id}-feedback` : ''].filter(Boolean).join(' ') || undefined}
            min={min} max={max} step={step} value={draft}
            title={`${min}–${max}${unit ? ` ${unit}` : ''}. Enter to apply; Escape to cancel.`}
            onFocus={(event) => { cancelled.current = false; event.currentTarget.select(); }}
            onChange={(event) => { setDraft(event.target.value); setFeedback(null); }} onBlur={commit}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
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
