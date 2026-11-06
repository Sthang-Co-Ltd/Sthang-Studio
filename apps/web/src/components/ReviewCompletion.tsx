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
        {reviewed ? 'All flagged captions reviewed' : 'No automatic risks detected'}
      </h2><p>{reviewed ? 'The Review queue is clear. You can check all captions or continue to Export.' : 'There are no flagged captions in this review profile. You can still check the wording against your video.'}</p></div>
    </div>
    <div className="review-completion-actions">
      <button type="button" onClick={onShowAll}>Show all captions</button>
      <button type="button" className="primary" disabled={exportDisabled} onClick={onExport}><FileOutput size={15}/>Continue to Export</button>
    </div>
  </section>;
}
