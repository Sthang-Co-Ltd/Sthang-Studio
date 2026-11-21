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

export function GenerationOptions({ value = 'automatic', disabled, saving, expandAfterError, onApply }: {
  value?: CaptionGenerationModel;
  disabled: boolean;
  saving: boolean;
  expandAfterError: boolean;
  onApply: (value: CaptionGenerationModel) => Promise<boolean>;
}) {
  const id = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<CaptionGenerationModel | null>(null);
  const choice = draft ?? value;
  const changed = choice !== value;
  const canApply = changed && !disabled && !saving;
  useEffect(() => { if (expandAfterError && disclosure.current) disclosure.current.open = true; }, [expandAfterError]);

  async function applyModel() {
    if (!canApply) return;
    if (await onApply(choice)) setDraft(null);
  }

  return <details className="generation-options" ref={disclosure}>
    <summary>
      <strong>AI options</strong>
      <span className="generation-current-model"><ModelMark model={value} />{labels[value]}</span>
      <ChevronDown className="generation-options-chevron" size={16} aria-hidden="true" />
    </summary>
    <div className="generation-options-body">
      <fieldset disabled={disabled || saving} aria-describedby={`${id}-help ${id}-status`}>
        <legend>Caption model</legend>
        {(Object.keys(labels) as CaptionGenerationModel[]).map((model) => (
          <label className="generation-model-choice" key={model}>
            <input type="radio" name={id} value={model} checked={choice === model}
              onChange={() => setDraft(model === value ? null : model)} />
            <ModelMark model={model} />
            {labels[model]}
            {choice === model && <Check className="generation-model-check" size={16} aria-hidden="true" />}
          </label>
        ))}
      </fieldset>
      <p id={`${id}-help`}>For this project only. {choice === 'automatic' ? 'Uses your default model and existing fallback rules.' : 'Uses only this model for new caption generation and regeneration.'} Global settings stay unchanged.</p>
      <div className="generation-options-footer">
        <span id={`${id}-status`} role="status">
          {changed ? (saving ? 'Saving choice…' : 'Choice not applied') : 'Saved for this project'}
        </span>
        <button type="button" className="generation-model-apply" aria-disabled={!canApply} onClick={applyModel}>Apply model</button>
      </div>
    </div>
  </details>;
}
