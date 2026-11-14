import { useId } from 'react';
import type { CaptionAppearance, CaptionSegment } from '@kcs/shared';
import { Download, RotateCcw } from 'lucide-react';
import type { AccuracyFields } from '../accuracy-context-draft';
import type { RecoveryStatus } from '../unfinished-edit-recovery';
import './unfinished-edit-recovery.css';

export function UnfinishedEditRecoveryNotice({ count, savedAt, entries, selectedKey, onSelect, captions, accuracy, appearance, status, working, disabled, restoreBlockedReason, onRestore, onCancel, onDownload, onDiscard }: {
  count: number;
  savedAt: number;
  entries: { key: string; savedAt: number; label: string }[];
  selectedKey: string;
  onSelect(key: string): void;
  captions?: CaptionSegment[];
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
  const matching = status === 'matching';
  const restoreBlockedId = useId();
  return <section className="toast unfinished-recovery" aria-label="Unfinished edit recovery">
    <div className="unfinished-recovery-heading"><strong>Unfinished edits found</strong><span>{new Date(savedAt).toLocaleString()}{count > 1 ? ` · ${count} drafts` : ''}</span></div>
    <p role="status" aria-atomic="true">{entries.length > 1 && <span className="sr-only">Selected draft: {new Date(savedAt).toLocaleString()}, {entries.find((entry) => entry.key === selectedKey)?.label}. </span>}{status === 'media-changed' ? 'This draft belongs to different media. Download it to keep a copy.'
      : status === 'changed' ? 'The saved project has changed. Download this draft to compare your edits.'
      : status === 'already-saved' ? 'This appearance already matches the saved project. Keep a copy or discard this recovery draft.'
      : 'A local draft is available. Restore it for review, or keep a separate copy.'}</p>
    <details><summary>Preview draft</summary>
      {entries.length > 1 && <label className="unfinished-recovery-selector">Recovery draft
        <select value={selectedKey} onChange={(event) => onSelect(event.target.value)}>
          {entries.map((entry) => <option key={entry.key} value={entry.key}>{new Date(entry.savedAt).toLocaleString()} · {entry.label}</option>)}
        </select>
      </label>}
      <div className="unfinished-recovery-preview">
      {captions && <><strong>{captions.length} captions in draft</strong>{captions.slice(0, 2).map((caption) => <p key={caption.id}>{caption.text.slice(0, 240)}</p>)}</>}
      {accuracy && <><strong>Accuracy context</strong><p>{(accuracy.description || accuracy.vocabulary).slice(0, 360)}</p></>}
      {appearance && <><strong>Caption appearance</strong><p>{appearance.fontFamily} · {appearance.bold ? 'Bold' : 'Regular'} · Size {appearance.fontSize1080} · Text {appearance.textColor}</p></>}
    </div></details>
    {matching && disabled && <p id={restoreBlockedId} className="unfinished-recovery-hint">{restoreBlockedReason}</p>}
    <div className="unfinished-recovery-actions">
      {matching && <button className="primary" disabled={disabled || working} aria-describedby={disabled ? restoreBlockedId : undefined} onClick={onRestore}><RotateCcw size={15}/>{working ? 'Checking draft…' : 'Restore draft'}</button>}
      {working && <button onClick={onCancel}>Cancel check</button>}
      <button disabled={working} onClick={onDownload}><Download size={15}/>Download draft</button>
      <button disabled={working} onClick={onDiscard}>Discard draft</button>
    </div>
  </section>;
}
