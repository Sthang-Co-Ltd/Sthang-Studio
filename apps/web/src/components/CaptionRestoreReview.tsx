import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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

const sections = ['beginning', 'middle', 'end'] as const;
type BackupSection = typeof sections[number];

function sampleRange(count: number, section: BackupSection): [number, number] {
  if (count <= 4) return [0, count];
  // Short backups fit across three distinct sections. Longer ones sample up to four cues per section.
  const edgeSize = Math.min(4, Math.round(count / 3));
  if (section === 'beginning') return [0, edgeSize];
  if (section === 'end') return [count - edgeSize, count];
  const size = Math.min(4, count - 2 * edgeSize);
  const start = Math.floor((count - size) / 2);
  return [start, start + size];
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
  const sectionName = useId();
  const [section, setSection] = useState<BackupSection>('beginning');
  const samples = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = samples.current;
    const last = viewport?.lastElementChild;
    if (section === 'end' && viewport && last instanceof HTMLElement) viewport.scrollTop = last.offsetTop;
  }, [section]);
  useEffect(() => { if (heading.current) onReady(heading.current); }, [review.filename, onReady]);
  const captions = review.preview.candidate.captions;
  const [start, end] = sampleRange(captions.length, section);
  return <section className="caption-restore-review" aria-labelledby="caption-restore-title">
    <h3 id="caption-restore-title" ref={heading} tabIndex={-1}>{t('export.restore.title')}</h3>
    <p className="caption-restore-filename">{review.filename}</p>
    <p>{tn('export.restore.replaceSummary', review.currentCount, { incoming: captions.length })}</p>
    <p>{t('export.restore.mediaReminder')}</p>
    {captions.length > 4 && <>
      <fieldset className="caption-restore-sections" aria-label={t('export.restore.chooseSection')}>
        {sections.map((value) => <label key={value}>
          <input type="radio" name={sectionName} checked={section === value} onChange={() => setSection(value)}/>
          <span>{t(`export.restore.${value}`)}</span>
        </label>)}
      </fieldset>
      <p className="caption-restore-range" role="status">{end === start + 1
        ? t('export.restore.singleRange', { first: start + 1, total: captions.length })
        : t('export.restore.range', { first: start + 1, last: end, total: captions.length })}</p>
    </>}
    <div key={section} ref={samples} className="caption-restore-samples" role="region" tabIndex={0} aria-label={t('export.restore.previewLabel')}>
      {captions.slice(start, end).map((caption, index) => <div key={start + index}>
        <span>{formatTimestamp(caption.startMs)} – {formatTimestamp(caption.endMs)}</span>
        <p>{caption.text}</p>
      </div>)}
    </div>
    {review.preview.warnings?.map((warning, index) => <p key={index} className="caption-restore-warning" data-server-text>{warning}</p>)}
    {review.stale && <p className="caption-restore-warning" role="status">{t('export.restore.stale')}</p>}
    {importBlockedReason && <p id={blockedReasonId} className="caption-restore-warning" role="status">{importBlockedReason}</p>}
    <p>{t('export.restore.checkpoint')}</p>
    <div className="caption-restore-actions">
      <button type="button" disabled={busy} onClick={onCancel}><X size={15}/>{t('export.restore.keepCurrent')}</button>
      <button type="button" className="primary" disabled={busy || review.stale || !captions.length || Boolean(importBlockedReason)} aria-describedby={importBlockedReason ? blockedReasonId : undefined} onClick={onApply}><Check size={15}/>{busy ? t('export.restore.replacing') : t('export.restore.apply')}</button>
    </div>
  </section>;
}
