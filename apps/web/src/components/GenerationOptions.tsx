import { useEffect, useId, useRef, useState } from 'react';
import type { CaptionGenerationModel } from '@kcs/shared';
import { Check, ChevronDown, WandSparkles } from 'lucide-react';
import './generation-options.css';

const labels = {
  automatic: 'Automatic',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
} satisfies Record<CaptionGenerationModel, string>;

function ModelMark({ model }: { model: CaptionGenerationModel }) {
  return model === 'automatic'
    ? <WandSparkles aria-hidden="true" className="generation-model-mark" data-model-family="automatic" size={18} />
    : <img alt="" className="generation-model-mark" data-model-family="gemini" src="/providers/gemini.png" width={18} height={18} />;
}

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

  function choose(next: CaptionGenerationModel, input: HTMLInputElement) {
    if (document.activeElement === input) {
      const summary = disclosure.current?.querySelector('summary');
      summary?.focus({ preventScroll: true });
      summary?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    setPending(next);
    void onChange(next).finally(() => setPending(null));
  }

  return <details className="generation-options" ref={disclosure}>
    <summary>
      <strong>AI options</strong>
      <span className="generation-current-model"><ModelMark model={choice} />{labels[choice]}</span>
      <ChevronDown className="generation-options-chevron" size={16} aria-hidden="true" />
    </summary>
    <div className="generation-options-body">
      <fieldset disabled={disabled || saving || pending !== null} aria-describedby={`${id}-help ${id}-status`}>
        <legend>Caption model</legend>
        {(Object.keys(labels) as CaptionGenerationModel[]).map((model) => (
          <label className="generation-model-choice" key={model}>
            <input type="radio" name={id} value={model} checked={choice === model}
              onChange={(event) => choose(model, event.currentTarget)} />
            <ModelMark model={model} />
            {labels[model]}
            {choice === model && <Check className="generation-model-check" size={16} aria-hidden="true" />}
          </label>
        ))}
      </fieldset>
      <p id={`${id}-help`}>For this project only. {choice === 'automatic' ? 'Uses your default model and existing fallback rules.' : 'Uses only this model for new caption generation and regeneration.'} Global settings stay unchanged.</p>
      <span id={`${id}-status`} role="status">{saving || pending ? 'Saving choice…' : 'Saved for this project'}</span>
    </div>
  </details>;
}
