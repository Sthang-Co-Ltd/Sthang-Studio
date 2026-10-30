import { useEffect, useId, useRef, useState } from 'react';
import type { CaptionGenerationModel } from '@kcs/shared';
import './generation-options.css';

const labels = { automatic: 'Automatic', 'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-3.6-flash': 'Gemini 3.6 Flash' };

export function GenerationOptions({ value = 'automatic', disabled, saving, expandAfterError, onChange }: {
  value?: CaptionGenerationModel;
  disabled: boolean;
  saving: boolean;
  expandAfterError: boolean;
  onChange: (value: CaptionGenerationModel) => Promise<boolean>;
}) {
  const id = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [pending, setPending] = useState<CaptionGenerationModel | null>(null);
  const choice = pending ?? value;
  useEffect(() => { if (expandAfterError && disclosure.current) disclosure.current.open = true; }, [expandAfterError]);
  return <details className="generation-options" ref={disclosure}>
    <summary>AI options <span>{labels[choice]}</span></summary>
    <div className="generation-options-body">
      <label htmlFor={id}>Caption model</label>
      <select id={id} value={choice} disabled={disabled || saving || pending !== null} aria-describedby={`${id}-help ${id}-status`} onChange={(event) => {
        const next = event.target.value as CaptionGenerationModel;
        setPending(next);
        void onChange(next).finally(() => setPending(null));
      }}>
        <option value="automatic">Automatic</option>
        <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
      </select>
      <p id={`${id}-help`}>For this project only. {choice === 'automatic' ? 'Uses your default model and existing fallback rules.' : 'Uses only this model for new caption generation and regeneration.'} Global settings stay unchanged.</p>
      <span id={`${id}-status`} role="status">{saving || pending ? 'Saving choice…' : 'Saved for this project'}</span>
    </div>
  </details>;
}
