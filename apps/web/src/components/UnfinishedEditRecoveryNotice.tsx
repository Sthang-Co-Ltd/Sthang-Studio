import type { CaptionSegment } from '@kcs/shared';
import { Download, RotateCcw } from 'lucide-react';
import type { AccuracyFields } from '../accuracy-context-draft';
import './unfinished-edit-recovery.css';

export function UnfinishedEditRecoveryNotice({ count, savedAt, captions, accuracy, status, working, disabled, onRestore, onDownload, onDiscard }: {
  count: number;
  savedAt: number;
  captions?: CaptionSegment[];
  accuracy?: AccuracyFields;
  status: 'matching' | 'changed' | 'media-changed';
  working: boolean;
  disabled: boolean;
  onRestore(): void;
  onDownload(): void;
  onDiscard(): void;
}) {
  const matching = status === 'matching';
  return <section className="toast unfinished-recovery" aria-label="Unfinished edit recovery">
    <div className="unfinished-recovery-heading"><strong>Unfinished edits found</strong><span>{new Date(savedAt).toLocaleString()}{count > 1 ? ` · ${count} drafts` : ''}</span></div>
    <p>{status === 'media-changed' ? 'This draft belongs to different media. Download it to keep a copy.'
      : status === 'changed' ? 'The saved project has changed. Download this draft to compare your edits.'
      : 'A local draft is available. Restore it for review, or keep a separate copy.'}</p>
    <details><summary>Preview draft</summary><div className="unfinished-recovery-preview">
      {captions && <><strong>{captions.length} captions in draft</strong>{captions.slice(0, 2).map((caption) => <p key={caption.id}>{caption.text.slice(0, 240)}</p>)}</>}
      {accuracy && <><strong>Accuracy context</strong><p>{(accuracy.description || accuracy.vocabulary).slice(0, 360)}</p></>}
    </div></details>
    {matching && disabled && <p className="unfinished-recovery-hint">Finish saving your current work before restoring this draft.</p>}
    <div className="unfinished-recovery-actions">
      {matching && <button className="primary" disabled={disabled || working} onClick={onRestore}><RotateCcw size={15}/>{working ? 'Checking draft…' : 'Restore draft'}</button>}
      <button disabled={working} onClick={onDownload}><Download size={15}/>Download draft</button>
      <button disabled={working} onClick={onDiscard}>Discard draft</button>
    </div>
  </section>;
}
