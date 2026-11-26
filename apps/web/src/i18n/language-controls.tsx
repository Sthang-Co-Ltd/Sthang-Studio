import { languageNames, switchPrompt } from './bilingual';
import { useI18n, type Locale } from './index';

interface LanguageControlsProps {
  saving: boolean;
  onChange(locale: Locale): void;
}

export function InterfaceLanguageSwitch({ saving, onChange, ready = true }: LanguageControlsProps & { ready?: boolean }) {
  const { locale, t } = useI18n();
  return <div className="interface-language-switch" role="group" aria-label={t('common.language')}>
    {(['en', 'km'] as const).map((choice) => <button
      key={choice} type="button" lang={choice} aria-pressed={locale === choice}
      aria-busy={saving || undefined} aria-disabled={saving || undefined} disabled={!ready}
      onClick={() => onChange(choice)}
    >{languageNames[choice]}</button>)}
  </div>;
}

export function InterfaceLanguageField(props: LanguageControlsProps) {
  const { t } = useI18n();
  return <div className="interface-language-field">
    <strong>{t('common.interfaceLanguage')}</strong>
    <InterfaceLanguageSwitch {...props}/>
  </div>;
}

export function InterfaceLanguagePrompt({ saving, onChange }: LanguageControlsProps) {
  return <div className="interface-language-prompt">
    <p><span lang="km">{switchPrompt.questionKm}</span> <span lang="en">{switchPrompt.questionEn}</span></p>
    <div>
      <button type="button" className="primary" aria-busy={saving || undefined} aria-disabled={saving || undefined} onClick={() => onChange('km')}><span lang="km">{switchPrompt.chooseKm}</span></button>
      <button type="button" aria-busy={saving || undefined} aria-disabled={saving || undefined} onClick={() => onChange('en')}>{switchPrompt.chooseEn}</button>
    </div>
  </div>;
}
