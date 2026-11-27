import { useI18n } from '../i18n';
import { useEffect, useRef } from 'react';
import { CheckCheck, FileOutput } from 'lucide-react';
import './review-completion.css';

interface Props {
  reviewed: boolean;
  exportDisabled: boolean;
  onShowAll(): void;
  onExport(): void;
}

export function ReviewCompletion({ reviewed, exportDisabled, onShowAll, onExport }: Props) {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The last approved row/decision may have disappeared. Recover keyboard
    // focus only when it was lost; never take it from another working control.
    if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
  }, []);
  return <section className="review-completion" aria-labelledby="review-completion-title">
    <div className="review-completion-copy" role="status">
      <CheckCheck size={20} aria-hidden="true"/>
      <div><h2 id="review-completion-title" ref={heading} tabIndex={-1}>
        {reviewed ? t('review.completion.reviewed') : t('review.completion.noRisks')}
      </h2><p>{reviewed ? t('review.completion.reviewedHelp') : t('review.completion.noRisksHelp')}</p></div>
    </div>
    <div className="review-completion-actions">
      <button type="button" onClick={onShowAll}>{t('review.completion.showAll')}</button>
      <button type="button" className="primary" disabled={exportDisabled} onClick={onExport}><FileOutput size={15}/>{t('review.completion.export')}</button>
    </div>
  </section>;
}
