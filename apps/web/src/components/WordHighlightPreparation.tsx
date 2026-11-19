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

const pauseCopy = {
  connection: 'Word sync paused because the connection was interrupted.',
  unavailable: 'Word sync paused because local timing is unavailable.',
  'project-changed': 'The saved project changed. Reload it to continue.',
  edits: 'Word sync will continue after the next caption save.',
  busy: 'Word sync will continue when caption processing is free.',
} as const;

export function WordHighlightPreparation({ view, enabled, actionFocusTarget }: {
  view: WordHighlightPreparationView; enabled: boolean; actionFocusTarget: RefObject<HTMLElement | null>;
}) {
  const act = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    if (document.activeElement === event.currentTarget && actionFocusTarget.current?.isConnected) {
      actionFocusTarget.current.focus({ preventScroll: true });
      actionFocusTarget.current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    action();
  };

  const counts = view.counts;
  const coverage = [
    counts['full-individual'] && `Highlighting ${counts['full-individual']} ${counts['full-individual'] === 1 ? 'caption' : 'captions'}`,
    counts['full-with-groups'] && `${counts['full-with-groups']} with words lit together`,
    counts.partial && `${counts.partial} partly`,
    counts.none && `${counts.none} plain`,
  ].filter(Boolean).join(' · ');
  const copy = view.status === 'checking' ? `Checking captions… ${view.completed} of ${view.total}`
    : view.status === 'preparing-audio' ? 'Preparing audio…'
    : view.status === 'arming' || view.status === 'publishing' ? 'Saving word highlights…'
    : view.pauseReason ? pauseCopy[view.pauseReason]
    : view.status === 'waiting-for-save' ? 'Word sync will continue after your edits are saved.'
    : '';
  const canReview = enabled && view.exceptions > 0 && !view.running;
  if (!enabled && !view.running && !view.hasUndo) return null;

  return <section className="word-highlight-preparation" aria-label="Word highlight results">
    <div role="status">
      {copy && <p className="word-highlight-preparation-note">{copy}</p>}
      {enabled && !view.running && <p className="word-highlight-preparation-note">{coverage || 'No spoken captions'}</p>}
    </div>
    {view.status === 'checking' && <div className="word-highlight-preparation-progress">
      <progress aria-label="Word highlight preparation progress" max={Math.max(1, view.total)} value={view.completed}/>
    </div>}
    <div className="word-highlight-preparation-actions">
      {view.running && <button type="button" onClick={(event) => act(event, view.onCancel)}>Cancel</button>}
      {view.pauseReason === 'unavailable' && <button type="button" onClick={view.onOpenSetup}>Check timing setup</button>}
      {view.pauseReason === 'project-changed' && <button type="button" onClick={view.onReloadProject}>Reload saved project</button>}
      {enabled && !view.armed && !view.running && <button type="button" disabled={!view.canStart}
        onClick={(event) => act(event, view.onStart)}>Apply to all captions</button>}
      {canReview && <button type="button" onClick={view.onReview}>Review remaining ({view.exceptions})</button>}
      {canReview && view.armed && view.hasSyncTargets && <button type="button" disabled={!view.canStart || view.pauseReason === 'project-changed'}
        onClick={(event) => act(event, view.onStart)}>Sync remaining</button>}
      {view.hasUndo && <button type="button" disabled={!view.canUndo} onClick={(event) => act(event, view.onUndo)}>Undo</button>}
    </div>
  </section>;
}
