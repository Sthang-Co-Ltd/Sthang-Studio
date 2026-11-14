import type { MouseEvent, RefObject } from 'react';
import type { WordHighlightBatchPause } from '../word-highlight-batch';
import './word-highlight-preparation.css';

export interface WordHighlightPreparationView {
  status: 'idle' | 'preparing' | 'applying' | 'complete';
  completed: number;
  total: number;
  applied: number;
  needsReview: number;
  canceled: boolean;
  interruptedByBusy?: boolean;
  pauseReason?: WordHighlightBatchPause;
  checkingReadiness?: boolean;
  waiting: boolean;
  hasSyncTargets: boolean;
  canStart: boolean;
  hasUndo: boolean;
  canUndo: boolean;
  onToggle(enabled: boolean): void;
  onStart(): void;
  onCancel(): void;
  onReview(): void;
  onUndo(): void;
  onOpenSetup?(): void;
  onReloadProject?(): void;
}

export function WordHighlightPreparation({ view, enabled, actionFocusTarget }: { view: WordHighlightPreparationView; enabled: boolean; actionFocusTarget: RefObject<HTMLElement | null> }) {
  const act = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    if (document.activeElement === event.currentTarget) {
      const target = actionFocusTarget.current;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    }
    action();
  };
  if (view.status === 'preparing') return <section className="word-highlight-preparation" aria-label="Preparing word highlights">
    <div className="word-highlight-preparation-copy">
      <strong>{view.checkingReadiness ? 'Checking word timing setup' : 'Syncing word timing'}</strong>
      <p>You can keep watching the video.</p>
    </div>
    <div className="word-highlight-preparation-progress" role="status">
      {view.checkingReadiness ? <span>Checking local timing before retrying. No captions are being synced yet.</span> : <>
        <div><span>{view.completed} of {view.total} captions checked</span></div>
        <progress aria-label="Word highlight preparation progress" max={Math.max(1, view.total)} value={view.completed}/>
      </>}
    </div>
    <div className="word-highlight-preparation-actions">
      <button type="button" disabled={view.canceled} onClick={(event) => act(event, view.onCancel)}>{view.canceled ? 'Canceling…' : 'Cancel'}</button>
    </div>
  </section>;

  if (view.status === 'applying') return <p className="word-highlight-preparation-note" role="status">Saving word timing…</p>;

  const needsReview = enabled && view.needsReview > 0;
  if (!needsReview && !view.hasUndo) return null;

  return <section className="word-highlight-preparation" aria-label="Word timing actions">
    {view.waiting ? <p className="word-highlight-preparation-note" role="status">Word sync will start after current caption work is saved.</p>
      : view.pauseReason ? <p className="word-highlight-preparation-note" role="status">{
        view.pauseReason === 'connection' ? 'Word sync paused because the connection was interrupted. Your current timing is kept. Sync remaining captions when Studio is available.'
          : view.pauseReason === 'unavailable' ? 'Word sync is paused because local timing is unavailable. Check timing setup, then choose Sync remaining to recheck and continue.'
            : view.pauseReason === 'project-changed' ? 'Word sync stopped because the saved captions or source need checking. Your current timing is kept. Reload the saved project before syncing again.'
              : view.pauseReason === 'edits' ? 'Word sync stopped because you started editing. Your newer edits are kept. Save them before syncing remaining captions.'
                : 'Timing is busy. Sync remaining captions when it’s ready.'
      }</p>
      : view.canceled && enabled ? <p className="word-highlight-preparation-note" role="status">Sync canceled.</p>
      : view.interruptedByBusy && enabled ? <p className="word-highlight-preparation-note" role="status">Timing is busy. Sync remaining captions when it’s ready.</p>
      : null}
    {view.applied > 0 && <p className="word-highlight-preparation-note" role="status">Updated {view.applied} {view.applied === 1 ? 'caption' : 'captions'}.</p>}
    <div className="word-highlight-preparation-actions">
      {view.waiting && <button type="button" onClick={(event) => act(event, view.onCancel)}>Cancel sync</button>}
      {view.pauseReason === 'unavailable' && view.onOpenSetup && <button type="button" onClick={view.onOpenSetup}>Check timing setup</button>}
      {view.pauseReason === 'project-changed' && view.onReloadProject && <button type="button" onClick={view.onReloadProject}>Reload saved project</button>}
      {needsReview && !view.waiting && <button type="button" onClick={view.onReview}>Review remaining ({view.needsReview})</button>}
      {needsReview && view.hasSyncTargets && !view.waiting && <button type="button" disabled={!view.canStart || view.pauseReason === 'project-changed'} onClick={(event) => act(event, view.onStart)}>Sync remaining</button>}
      {view.hasUndo && <button type="button" disabled={!view.canUndo} onClick={(event) => act(event, view.onUndo)}>Undo timing changes</button>}
    </div>
  </section>;
}
