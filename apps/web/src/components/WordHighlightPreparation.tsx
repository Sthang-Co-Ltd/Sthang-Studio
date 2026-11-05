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

  if (view.status === 'idle' && total === 0) return view.canceled
    ? <p className="word-highlight-preparation-note" role="status">Preparation canceled. Saved word timing is unchanged.</p>
    : null;

  if (view.status === 'idle') return <section className="word-highlight-preparation" aria-label="Prepare word highlights">
    <div className="word-highlight-preparation-copy">
      <p>Prepare missing word timing locally. Nothing changes until you choose <b>Use ready timings</b>.</p>
    </div>
    {view.canceled && <p className="word-highlight-preparation-note" role="status">Preparation canceled. Saved word timing is unchanged.</p>}
    <div className="word-highlight-preparation-actions">
      <button type="button" className="primary" disabled={!view.canStart} onClick={view.onStart}>Prepare word highlights</button>
    </div>
    {!view.canStart && <p className="word-highlight-preparation-note">Finish caption work and check that local timing is ready, then try again.</p>}
  </section>;

  if (view.status === 'preparing') return <section className="word-highlight-preparation" aria-label="Preparing word highlights">
    <div className="word-highlight-preparation-copy">
      <strong>Preparing word timings</strong>
      <p>You can keep watching the video.</p>
    </div>
    <div className="word-highlight-preparation-progress" role="status" aria-live="polite">
      <div><span>{completed} of {total} captions checked</span></div>
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
        ? 'Another timing task interrupted preparation. Unchecked captions can be retried later. Saved timing is unchanged.'
        : view.canceled
          ? 'Preparation stopped early. Saved timing is unchanged.'
          : 'Saved timing is unchanged. Use the ready results or keep your current timing.'}</p>
    </div>
    <div className="word-highlight-preparation-results" role="status" aria-live="polite">
      <span><b>{ready}</b> ready</span>
      <span><b>{needsReview}</b> need review</span>
      {unchecked > 0 && <span><b>{unchecked}</b> unchecked</span>}
    </div>
    {!view.canApply && ready > 0 && <p className="word-highlight-preparation-note">Save pending edits and finish caption work before applying. If text or timing changed, prepare again.</p>}
    <div className="word-highlight-preparation-actions">
      <button type="button" className="primary" disabled={!view.canApply} onClick={view.onApply}>Use ready timings</button>
      <button type="button" disabled={needsReview + unchecked === 0} onClick={view.onReview}>Review remaining</button>
      <button type="button" onClick={view.onDiscard}>Keep current</button>
    </div>
  </section>;

  return <section className="word-highlight-preparation applied" aria-label="Applied word timings">
    <div className="word-highlight-preparation-copy">
      <strong>Word timings applied</strong>
      <p>Saved in History. Unresolved captions stay plain.</p>
    </div>
    <div className="word-highlight-preparation-results" role="status" aria-live="polite">
      <span><b>{ready}</b> {ready === 1 ? 'caption updated' : 'captions updated'}</span>
      {needsReview + unchecked > 0 && <span><b>{needsReview + unchecked}</b> still need review</span>}
    </div>
    <div className="word-highlight-preparation-actions">
      {view.canStart && needsReview + unchecked > 0 && <button type="button" onClick={view.onStart}>Prepare remaining</button>}
      {needsReview + unchecked > 0 && <button type="button" onClick={view.onReview}>Review remaining</button>}
      <button type="button" disabled={!view.canUndo} onClick={view.onUndo}>Undo batch</button>
    </div>
  </section>;
}
