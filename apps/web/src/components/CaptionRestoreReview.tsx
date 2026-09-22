import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import type { HandoffRestorePreview } from '../caption-handoff-client';
import './caption-restore-review.css';

export interface CaptionRestoreReviewState {
  filename: string;
  preview: HandoffRestorePreview;
  currentCount: number;
  stale: boolean;
}

export function CaptionRestoreReview({ review, busy, onApply, onCancel }: {
  review: CaptionRestoreReviewState;
  busy: boolean;
  onApply(): void;
  onCancel(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [review.filename]);
  const captions = review.preview.candidate.captions;
  const stamp = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
  return <section className="caption-restore-review" aria-labelledby="caption-restore-title">
    <h3 id="caption-restore-title" ref={heading} tabIndex={-1}>Review caption data</h3>
    <p className="caption-restore-filename">{review.filename}</p>
    <p>Replace the current {review.currentCount} caption{review.currentCount === 1 ? '' : 's'} with {captions.length} caption{captions.length === 1 ? '' : 's'} from this file. The video, audio, and current appearance stay as they are.</p>
    <p>Use the same source footage and playback speed. Caption data starts at source time zero; it does not identify or contain the source video.</p>
    <div className="caption-restore-samples" aria-label="Caption import preview">
      {captions.slice(0, 4).map((caption, index) => <div key={index}>
        <span>{stamp(caption.startMs)} → {stamp(caption.endMs)}</span>
        <p>{caption.text}</p>
      </div>)}
      {captions.length > 4 && <p>And {captions.length - 4} more captions.</p>}
    </div>
    {review.preview.warnings?.map((warning, index) => <p key={index} className="caption-restore-warning">{warning}</p>)}
    {review.stale && <p className="caption-restore-warning" role="status">The project changed after this preview. Keep your current captions and open the file again to review the latest state.</p>}
    <p>Studio saves a History checkpoint first. Imported captions will need review. The file’s appearance settings are retained in the file for reference, but will not replace your current style.</p>
    <div className="caption-restore-actions">
      <button type="button" disabled={busy} onClick={onCancel}><X size={15}/>Keep current captions</button>
      <button type="button" className="primary" disabled={busy || review.stale || !captions.length} onClick={onApply}><Check size={15}/>{busy ? 'Restoring…' : 'Replace captions'}</button>
    </div>
  </section>;
}
