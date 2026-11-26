import { useI18n } from '../i18n';
import type { MouseEvent, RefObject } from 'react';
import type { Coverage } from '@kcs/shared';
import type { WordHighlightProgress } from '../word-highlight-apply';
import './word-highlight-preparation.css';

export interface WordHighlightPreparationView extends WordHighlightProgress {
  running: boolean;
  armed: boolean;
  counts: Record<Coverage, number>;
  exceptions: number;
  hasSyncTargets: boolean;
  canStart: boolean;
  hasUndo: boolean;
  canUndo: boolean;
  onToggle(enabled: boolean): void;
  onStart(): void;
  onCancel(): void;
  onReview(): void;
  onUndo(): void;
  onOpenSetup(): void;
  onReloadProject(): void;
}

export function WordHighlightPreparation({ view, enabled, actionFocusTarget }: {
  view: WordHighlightPreparationView; enabled: boolean; actionFocusTarget: RefObject<HTMLElement | null>;
}) {
  const { t, tn } = useI18n();
  const act = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    if ((document.activeElement === event.currentTarget || document.activeElement === document.body) && actionFocusTarget.current?.isConnected) {
      actionFocusTarget.current.focus({ preventScroll: true });
      actionFocusTarget.current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    action();
  };

  const counts = view.counts;
  const coverage = [
    counts['full-individual'] && tn('appearance.highlight.coverageIndividual', counts['full-individual']),
    counts['full-with-groups'] && t('appearance.highlight.coverageGroup', { count: counts['full-with-groups'] }),
    counts.partial && t('appearance.highlight.coveragePartial', { count: counts.partial }),
    counts.none && t('appearance.highlight.coverageNone', { count: counts.none }),
  ].filter(Boolean).join(' · ');
  const copy = view.status === 'checking' ? t('appearance.highlight.checking', { completed: view.completed, total: view.total })
    : view.status === 'preparing-audio' ? t('appearance.highlight.preparingAudio')
    : view.status === 'arming' || view.status === 'publishing' ? t('appearance.highlight.saving')
    : view.pauseReason ? t(`appearance.highlight.pause.${view.pauseReason}`)
    : view.status === 'waiting-for-save' ? t('appearance.highlight.waitingForSave')
    : '';
  const canReview = enabled && view.exceptions > 0 && !view.running;
  if (!enabled && !view.running && !view.hasUndo) return null;

  return <section className="word-highlight-preparation" aria-label={t('appearance.highlight.results')}>
    <div role="status">
      {copy && <p className="word-highlight-preparation-note">{copy}</p>}
      {enabled && !view.running && <p className="word-highlight-preparation-note">{coverage || t('appearance.highlight.noSpokenCaptions')}</p>}
    </div>
    {view.status === 'checking' && <div className="word-highlight-preparation-progress">
      <progress aria-label={t('appearance.highlight.progress')} max={Math.max(1, view.total)} value={view.completed}/>
    </div>}
    <div className="word-highlight-preparation-actions">
      {view.running && <button type="button" onClick={(event) => act(event, view.onCancel)}>{t('appearance.highlight.cancel')}</button>}
      {view.pauseReason === 'unavailable' && <button type="button" onClick={view.onOpenSetup}>{t('appearance.highlight.checkSetup')}</button>}
      {view.pauseReason === 'project-changed' && <button type="button" onClick={view.onReloadProject}>{t('appearance.highlight.reloadProject')}</button>}
      {enabled && !view.armed && !view.running && <button type="button" disabled={!view.canStart}
        onClick={(event) => act(event, view.onStart)}>{t('appearance.highlight.applyAll')}</button>}
      {canReview && <button type="button" onClick={view.onReview}>{t('appearance.highlight.reviewRemaining', { count: view.exceptions })}</button>}
      {canReview && view.armed && view.hasSyncTargets && <button type="button" disabled={!view.canStart || view.pauseReason === 'project-changed'}
        onClick={(event) => act(event, view.onStart)}>{t('appearance.highlight.syncRemaining')}</button>}
      {view.hasUndo && <button type="button" disabled={!view.canUndo} onClick={(event) => act(event, view.onUndo)}>{t('appearance.undo')}</button>}
    </div>
  </section>;
}
