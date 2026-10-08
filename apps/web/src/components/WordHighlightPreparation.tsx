import './word-highlight-preparation.css';

export interface WordHighlightPreparationView {
  status: 'idle' | 'preparing' | 'review' | 'applied';
  completed: number;
  total: number;
  ready: number;
  needsReview: number;
  unchecked?: number;
  canceled: boolean;
  interruptedByBusy?: boolean;
  canStart: boolean;
  canApply: boolean;
  canUndo: boolean;
  onStart(): void;
  onCancel(): void;
  onApply(): void;
  onDiscard(): void;
  onReview(): void;
  onUndo(): void;
}

interface Props {
  view: WordHighlightPreparationView;
}

function safeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function WordHighlightPreparation({ view }: Props) {
  const completed = safeCount(view.completed);
  const total = safeCount(view.total);
  const ready = safeCount(view.ready);
  const needsReview = safeCount(view.needsReview);
  const unchecked = safeCount(view.unchecked ?? 0);
  const progressMax = Math.max(1, total);
  const progressValue = Math.min(progressMax, completed);

  if (view.status === 'idle') return <section className="word-highlight-preparation" aria-label="Prepare word highlights">
    <div className="word-highlight-preparation-copy">
      <strong>Prepare word highlights</strong>
      <p>Check the current saved captions with local alignment and prepare usable word timing for review. Nothing changes until you choose Use ready timings.</p>
    </div>
    {view.canceled && <p className="word-highlight-preparation-note" role="status">Preparation was canceled. Your saved word timing is unchanged.</p>}
    <div className="word-highlight-preparation-actions">
      <button type="button" className="primary" disabled={!view.canStart} onClick={view.onStart}>Prepare word highlights</button>
    </div>
    {!view.canStart && <p className="word-highlight-preparation-note">{total === 0
      ? 'All captions already have usable word timing. There is nothing to prepare.'
      : 'Preparation uses local alignment and is available when local timing is ready and no conflicting caption task is running.'}</p>}
  </section>;

  if (view.status === 'preparing') return <section className="word-highlight-preparation" aria-label="Preparing word highlights">
    <div className="word-highlight-preparation-copy">
      <strong>Preparing word highlights</strong>
      <p>Local alignment is checking the current saved wording. You can keep watching the video while it works.</p>
    </div>
    <div className="word-highlight-preparation-progress" role="status" aria-live="polite">
      <div><span>{completed} of {total} captions checked</span><b>{total ? `${Math.min(100, Math.round(completed / total * 100))}%` : '0%'}</b></div>
      <progress aria-label="Word highlight preparation progress" max={progressMax} value={progressValue}/>
    </div>
    <div className="word-highlight-preparation-actions">
      <button type="button" disabled={view.canceled} onClick={view.onCancel}>{view.canceled ? 'Canceling…' : 'Cancel'}</button>
    </div>
  </section>;

  if (view.status === 'review') return <section className="word-highlight-preparation" aria-label="Prepared word timings">
    <div className="word-highlight-preparation-copy">
      <strong>Prepared word timings</strong>
      <p>{view.interruptedByBusy
        ? 'Local word timing is finishing another request. Preparation stopped without marking unchecked captions as failed. Apply any ready results or keep current, then retry preparation once timing is available.'
        : view.canceled
          ? 'Preparation stopped early. Review the prepared results below or keep your current timing.'
          : 'Review the prepared results before changing saved word timing.'}</p>
    </div>
    <div className="word-highlight-preparation-results" role="status" aria-live="polite">
      <span><b>{ready}</b> ready</span>
      <span><b>{needsReview}</b> need review</span>
      {unchecked > 0 && <span><b>{unchecked}</b> unchecked</span>}
    </div>
    {!view.canApply && ready > 0 && <p className="word-highlight-preparation-note">Save any pending edits and finish active caption work before applying. If caption text or timing changed, prepare again.</p>}
    <div className="word-highlight-preparation-actions">
      <button type="button" className="primary" disabled={!view.canApply} onClick={view.onApply}>Use ready timings</button>
      <button type="button" disabled={needsReview + unchecked === 0} onClick={view.onReview}>Review remaining</button>
      <button type="button" onClick={view.onDiscard}>Keep current</button>
    </div>
  </section>;

  return <section className="word-highlight-preparation applied" aria-label="Applied word timings">
    <div className="word-highlight-preparation-copy">
      <strong>Ready timings applied</strong>
      <p>The ready timings were applied together and saved with a History checkpoint. Captions that still need review remain plain.</p>
    </div>
    <div className="word-highlight-preparation-results" role="status" aria-live="polite">
      <span><b>{ready}</b> ready</span>
      <span><b>{needsReview + unchecked}</b> still unresolved</span>
    </div>
    <div className="word-highlight-preparation-actions">
      {view.canStart && needsReview + unchecked > 0 && <button type="button" onClick={view.onStart}>Prepare remaining</button>}
      {needsReview + unchecked > 0 && <button type="button" onClick={view.onReview}>Review remaining</button>}
      <button type="button" disabled={!view.canUndo} onClick={view.onUndo}>Undo batch</button>
    </div>
  </section>;
}
