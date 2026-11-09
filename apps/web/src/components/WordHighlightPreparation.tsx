import './word-highlight-preparation.css';

export interface WordHighlightPreparationView {
  status: 'idle' | 'preparing' | 'applying' | 'complete';
  completed: number;
  total: number;
  applied: number;
  needsReview: number;
  canceled: boolean;
  interruptedByBusy?: boolean;
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
}

export function WordHighlightPreparation({ view, enabled }: { view: WordHighlightPreparationView; enabled: boolean }) {
  if (view.status === 'preparing') return <section className="word-highlight-preparation" aria-label="Preparing word highlights">
    <div className="word-highlight-preparation-copy">
      <strong>Syncing word timing</strong>
      <p>You can keep watching the video.</p>
    </div>
    <div className="word-highlight-preparation-progress" role="status">
      <div><span>{view.completed} of {view.total} captions checked</span></div>
      <progress aria-label="Word highlight preparation progress" max={Math.max(1, view.total)} value={view.completed}/>
    </div>
    <div className="word-highlight-preparation-actions">
      <button type="button" disabled={view.canceled} onClick={view.onCancel}>{view.canceled ? 'Canceling…' : 'Cancel'}</button>
    </div>
  </section>;

  if (view.status === 'applying') return <p className="word-highlight-preparation-note" role="status">Saving word timing…</p>;

  const needsReview = enabled && view.needsReview > 0;
  if (!needsReview && !view.hasUndo) return null;

  return <section className="word-highlight-preparation" aria-label="Word timing actions">
    {view.waiting ? <p className="word-highlight-preparation-note" role="status">Word sync will start after current caption work is saved.</p>
      : view.canceled && enabled ? <p className="word-highlight-preparation-note" role="status">Sync canceled.</p>
      : view.interruptedByBusy && enabled ? <p className="word-highlight-preparation-note" role="status">Timing is busy. Sync remaining captions when it’s ready.</p>
      : view.applied > 0 && <p className="word-highlight-preparation-note" role="status">Updated {view.applied} {view.applied === 1 ? 'caption' : 'captions'}.</p>}
    <div className="word-highlight-preparation-actions">
      {view.waiting && <button type="button" onClick={view.onCancel}>Cancel sync</button>}
      {needsReview && !view.waiting && <button type="button" onClick={view.onReview}>Review remaining ({view.needsReview})</button>}
      {needsReview && view.hasSyncTargets && !view.waiting && <button type="button" disabled={!view.canStart} onClick={view.onStart}>Sync remaining</button>}
      {view.hasUndo && <button type="button" disabled={!view.canUndo} onClick={view.onUndo}>Undo timing changes</button>}
    </div>
  </section>;
}
