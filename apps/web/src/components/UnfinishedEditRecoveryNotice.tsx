import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { memo, useId, useState } from 'react';
import { findPreviewDiff } from '../find-preview-diff';
import { formatTimestamp } from '../timestamp';
import type { CaptionAppearance, CaptionSegment } from '@kcs/shared';
import { Download, RotateCcw } from 'lucide-react';
import type { AccuracyFields } from '../accuracy-context-draft';
import type { RecoveryStatus } from '../unfinished-edit-recovery';
import './unfinished-edit-recovery.css';

const RecoveryCaptions = memo(function RecoveryCaptions({ saved, draft }: { saved?: CaptionSegment[]; draft: CaptionSegment[] }) {
  const { t } = useI18n();
  const originals = new Map(saved?.map(cue => [cue.id, cue]));
  const recovered = new Map(draft.map(cue => [cue.id, cue]));
  const changed = draft.find(cue => {
    const prior = originals.get(cue.id);
    return !prior || prior.text !== cue.text || prior.startMs !== cue.startMs || prior.endMs !== cue.endMs
      || Boolean(prior.textLocked) !== Boolean(cue.textLocked) || Boolean(prior.timingLocked) !== Boolean(cue.timingLocked);
  });
  const removed = saved?.find(cue => !recovered.has(cue.id));
  const isRemoval = removed && (!changed || removed.startMs < changed.startMs);
  const after = isRemoval ? undefined : changed;
  const before = isRemoval ? removed : after && originals.get(after.id);
  const diff = findPreviewDiff(before?.text ?? '', after?.text ?? '', !!before && !!after);
  return <><strong>{t('dialogs.draft.captionsInDraft', { count: draft.length })}</strong>
    {saved && (before || after) ? <dl className="recovery-caption-pair">
      {([{ cue: before, spans: diff.before, label: 'savedCaption', missing: 'addedCaption' },
        { cue: after, spans: diff.after, label: 'draftCaption', missing: 'removedCaption' }] as const).map(({ cue, spans, label, missing }) =>
        <div key={label}><dt>{t(`dialogs.draft.${label}`)}</dt><dd>{cue ? <>
          <small>{formatTimestamp(cue.startMs)} – {formatTimestamp(cue.endMs)}</small>
          <p>{spans.map((span, i) => span.changed ? <mark key={i}>{span.text}</mark> : span.text)}</p>
          {(['textLocked', 'timingLocked'] as const).map(lock =>
            Boolean(before?.[lock]) !== Boolean(after?.[lock]) && <label key={lock} className="recovery-lock">
              <input type="checkbox" disabled checked={Boolean(cue[lock])}/>{t(`editor.row.${lock}`)}
            </label>)}
        </> : t(`dialogs.draft.${missing}`)}</dd></div>)}
    </dl> : draft.slice(0, 2).map(cue => <p key={cue.id}>{cue.text}</p>)}
  </>;
});

export function UnfinishedEditRecoveryNotice({ count, savedAt, entries, selectedKey, onSelect, captions, savedCaptions, accuracy, appearance, status, working, disabled, restoreBlockedReason, onRestore, onCancel, onDownload, onDiscard }: {
  count: number;
  savedAt: number;
  entries: { key: string; savedAt: number; label: string }[];
  selectedKey: string;
  onSelect(key: string): void;
  captions?: CaptionSegment[];
  savedCaptions?: CaptionSegment[];
  accuracy?: AccuracyFields;
  appearance?: CaptionAppearance;
  status: RecoveryStatus;
  working: boolean;
  disabled: boolean;
  restoreBlockedReason: string;
  onRestore(): void;
  onCancel(): void;
  onDownload(): void;
  onDiscard(): void;
}) {
  const { locale, t } = useI18n();
  const dateAndTime = (value: number) => formatInterfaceDate(locale, value, { time: true });
  const matching = status === 'matching';
  const [previewOpen, setPreviewOpen] = useState(false);
  const restoreBlockedId = useId();
  return <section className="toast unfinished-recovery" aria-label={t('dialogs.draft.label')}>
    <div className="unfinished-recovery-heading"><strong>{t('dialogs.draft.title')}</strong><span>{count > 1 ? t('dialogs.draft.draftCount', { date: dateAndTime(savedAt), count }) : dateAndTime(savedAt)}</span></div>
    <p role="status" aria-atomic="true">{entries.length > 1 && <span className="sr-only">{t('dialogs.draft.selected', { date: dateAndTime(savedAt), label: entries.find((entry) => entry.key === selectedKey)?.label ?? '' })}</span>}{status === 'media-changed' ? t('dialogs.draft.differentMedia')
      : status === 'changed' ? t('dialogs.draft.projectChanged')
      : status === 'already-saved' ? t('dialogs.draft.appearanceAlreadySaved')
      : t('dialogs.draft.available')}</p>
    <details onToggle={event => setPreviewOpen(event.currentTarget.open)}><summary>{t('dialogs.draft.preview')}</summary>
      {entries.length > 1 && <label className="unfinished-recovery-selector">{t('dialogs.draft.selector')}
        <select value={selectedKey} onChange={(event) => onSelect(event.target.value)}>
          {entries.map((entry) => <option key={entry.key} value={entry.key}>{t('dialogs.draft.datedOption', { date: dateAndTime(entry.savedAt), label: entry.label })}</option>)}
        </select>
      </label>}
      <div className="unfinished-recovery-preview">
      {captions && previewOpen && <RecoveryCaptions saved={matching ? savedCaptions : undefined} draft={captions}/>}
      {accuracy && <><strong>{t('dialogs.draft.accuracy')}</strong><p>{(accuracy.description || accuracy.vocabulary).slice(0, 360)}</p></>}
      {appearance && <><strong>{t('dialogs.draft.appearance')}</strong><p>{t('dialogs.draft.appearanceSummary', { font: appearance.fontFamily, weight: t(appearance.bold ? 'appearance.workspace.bold' : 'appearance.workspace.regular'), size: appearance.fontSize1080, color: appearance.textColor })}</p></>}
    </div></details>
    {matching && disabled && <p id={restoreBlockedId} className="unfinished-recovery-hint">{restoreBlockedReason}</p>}
    <div className="unfinished-recovery-actions">
      {matching && <button className="primary" disabled={disabled || working} aria-describedby={disabled ? restoreBlockedId : undefined} onClick={onRestore}><RotateCcw size={15}/>{working ? t('dialogs.draft.checking') : t('dialogs.draft.restore')}</button>}
      {working && <button onClick={onCancel}>{t('dialogs.draft.cancelCheck')}</button>}
      <button disabled={working} onClick={onDownload}><Download size={15}/>{t('dialogs.draft.download')}</button>
      <button disabled={working} onClick={onDiscard}>{t('dialogs.discardDraft.confirm')}</button>
    </div>
  </section>;
}
