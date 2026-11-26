import { useI18n } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import type { CaptionGenerationModel } from '@kcs/shared';
import { Check, ChevronDown } from 'lucide-react';
import './generation-options.css';

const explicitModelLabels = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
} satisfies Record<Exclude<CaptionGenerationModel, 'automatic'>, string>;

function ModelMark({ model }: { model: CaptionGenerationModel }) {
  return model === 'automatic'
    ? <svg aria-hidden="true" className="generation-model-mark" data-model-family="automatic"
        width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
        <rect x={1} y={1} width={10} height={22} rx={2} />
        <rect x={13} y={1} width={10} height={10} rx={2} />
        <rect x={13} y={13} width={10} height={10} rx={2} />
      </svg>
    : <img alt="" className="generation-model-mark" data-model-family="gemini" src="/providers/gemini.png" width={18} height={18} />;
}

export function GenerationOptions({ value = 'automatic', disabled, saving, expandAfterError, onApply }: {
  value?: CaptionGenerationModel;
  disabled: boolean;
  saving: boolean;
  expandAfterError: boolean;
  onApply: (value: CaptionGenerationModel) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const labels = { automatic: t('accuracy.automatic'), ...explicitModelLabels };
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
      <strong>{t('accuracy.aiOptions')}</strong>
      <span className="generation-current-model"><ModelMark model={value} />{labels[value]}</span>
      <ChevronDown className="generation-options-chevron" size={16} aria-hidden="true" />
    </summary>
    <div className="generation-options-body">
      <fieldset disabled={disabled || saving} aria-describedby={`${id}-help ${id}-status`}>
        <legend>{t('accuracy.captionModel')}</legend>
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
      <p id={`${id}-help`}>{choice === 'automatic' ? t('accuracy.automaticHelp') : t('accuracy.explicitModelHelp')}</p>
      <div className="generation-options-footer">
        <span id={`${id}-status`} role="status">
          {changed ? (saving ? t('accuracy.savingModel') : t('accuracy.unappliedModel')) : t('accuracy.modelSaved')}
        </span>
        <button type="button" className="generation-model-apply" aria-disabled={!canApply} onClick={applyModel}>{t('accuracy.applyModel')}</button>
      </div>
    </div>
  </details>;
}
