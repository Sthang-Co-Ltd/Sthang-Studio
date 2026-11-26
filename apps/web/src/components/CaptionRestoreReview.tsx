import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../i18n';
import { Check, X } from 'lucide-react';
import type { HandoffRestorePreview } from '../caption-handoff-client';
import { formatTimestamp } from '../timestamp';
import './caption-restore-review.css';

export interface CaptionRestoreReviewState {
  filename: string;
  preview: HandoffRestorePreview;
  currentCount: number;
  stale: boolean;
}

export function CaptionRestoreReview({ review, busy, importBlockedReason, onReady, onApply, onCancel }: {
  review: CaptionRestoreReviewState;
  busy: boolean;
  importBlockedReason: string;
  onReady(heading: HTMLHeadingElement): void;
  onApply(): void;
  onCancel(): void;
}) {
  const { t, tn } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  const blockedReasonId = useId();
  useEffect(() => { if (heading.current) onReady(heading.current); }, [review.filename, onReady]);
  const captions = review.preview.candidate.captions;
  return <section className="caption-restore-review" aria-labelledby="caption-restore-title">
    <h3 id="caption-restore-title" ref={heading} tabIndex={-1}>{t('export.restore.title')}</h3>
    <p className="caption-restore-filename">{review.filename}</p>
    <p>{tn('export.restore.replaceSummary', review.currentCount, { incoming: captions.length })}</p>
    <p>{t('export.restore.mediaReminder')}</p>
    <div className="caption-restore-samples" aria-label={t('export.restore.previewLabel')}>
      {captions.slice(0, 4).map((caption, index) => <div key={index}>
        <span>{formatTimestamp(caption.startMs)} – {formatTimestamp(caption.endMs)}</span>
        <p>{caption.text}</p>
      </div>)}
      {captions.length > 4 && <p>{t('export.restore.moreCaptions', { count: captions.length - 4 })}</p>}
    </div>
    {review.preview.warnings?.map((warning, index) => <p key={index} className="caption-restore-warning">{warning}</p>)}
    {review.stale && <p className="caption-restore-warning" role="status">{t('export.restore.stale')}</p>}
    {importBlockedReason && <p id={blockedReasonId} className="caption-restore-warning" role="status">{importBlockedReason}</p>}
    <p>{t('export.restore.checkpoint')}</p>
    <div className="caption-restore-actions">
      <button type="button" disabled={busy} onClick={onCancel}><X size={15}/>{t('export.restore.keepCurrent')}</button>
      <button type="button" className="primary" disabled={busy || review.stale || !captions.length || Boolean(importBlockedReason)} aria-describedby={importBlockedReason ? blockedReasonId : undefined} onClick={onApply}><Check size={15}/>{busy ? t('export.restore.replacing') : t('export.restore.apply')}</button>
    </div>
  </section>;
}
