import { useRef, useState } from 'react';
import { LoaderCircle, Replace, RotateCcw, X } from 'lucide-react';
import type { MediaReplacementCheckpoint, MediaReplacementMode } from '../api';
import { useModalFocus } from '../use-modal-focus';
import './replace-media-dialog.css';

interface ReplaceProps {
  filename: string;
  captionCount: number;
  working: string;
  error: string;
  onCancel(): void;
  onReplace(mode: MediaReplacementMode): void;
}

export function ReplaceMediaDialog({ filename, captionCount, working, error, onCancel, onReplace }: ReplaceProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<MediaReplacementMode>('preserve');
  const [unchanged, setUnchanged] = useState(false);
  const dismiss = () => { if (!working) onCancel(); };
  useModalFocus(true, dialog, dismiss, cancel);

  return <div className="media-replacement-backdrop" onMouseDown={dismiss}>
    <div ref={dialog} className="media-replacement-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="replace-media-title" aria-describedby="replace-media-description" aria-busy={Boolean(working)} onMouseDown={(event) => event.stopPropagation()}>
      <button className="media-replacement-close" aria-label="Cancel media replacement" disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><Replace size={20}/><h2 id="replace-media-title">Replace media</h2></div>
      <p id="replace-media-description">Choose how to use <strong className="media-replacement-filename">{filename}</strong>.</p>
      <fieldset disabled={Boolean(working)} className="media-replacement-options">
        <legend className="sr-only">What happens to your captions</legend>
        <label className={`media-replacement-option ${mode === 'preserve' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="preserve" checked={mode === 'preserve'} onChange={() => setMode('preserve')}/>
          <span><strong>Keep reviewed captions</strong><small>Keep wording, timing, approvals, locks and appearance. Best for a new visual edit with the same audio timeline.</small></span>
        </label>
        <label className={`media-replacement-option ${mode === 'reset' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="reset" checked={mode === 'reset'} onChange={() => setMode('reset')}/>
          <span><strong>Start over</strong><small>Clear {captionCount ? `${captionCount} caption${captionCount === 1 ? '' : 's'} and the` : 'captions and'} transcript. Generate new captions yourself when ready.</small></span>
        </label>
      </fieldset>
      {mode === 'preserve' && <div className="media-replacement-check">
        <p>Studio checks the audio locally before replacing. Matching duration alone is not enough. Changed speech, cuts, speed or audio timing cannot keep reviewed captions.</p>
        <label><input type="checkbox" checked={unchanged} disabled={Boolean(working)} onChange={(event) => setUnchanged(event.target.checked)}/><span>The audio, cuts and timing are unchanged.</span></label>
      </div>}
      <p className="media-replacement-helper">A local backup keeps the previous media and project for Undo replacement. No captions are generated automatically.</p>
      {error && <p className="media-replacement-error" role="alert">{error}</p>}
      {working && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{working} Stay on this page until the result is confirmed.</span></p>}
      <div className="media-replacement-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>Cancel</button>
        <button className={mode === 'preserve' ? 'primary' : ''} disabled={Boolean(working) || (mode === 'preserve' && !unchanged)} onClick={() => onReplace(mode)}>{mode === 'preserve' ? 'Replace and keep captions' : 'Continue'}</button>
      </div>
    </div>
  </div>;
}

interface RestoreProps {
  checkpoints: MediaReplacementCheckpoint[];
  loading: boolean;
  working: string;
  error: string;
  onCancel(): void;
  onReload(): void;
  onRestore(checkpoint: MediaReplacementCheckpoint): void;
  onDelete(checkpoint: MediaReplacementCheckpoint): void;
}

export function RestoreMediaDialog({ checkpoints, loading, working, error, onCancel, onReload, onRestore, onDelete }: RestoreProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState('');
  const selected = checkpoints.find((item) => item.id === chosen) || checkpoints[0];
  const dismiss = () => { if (!working) onCancel(); };
  useModalFocus(true, dialog, dismiss, cancel);

  return <div className="media-replacement-backdrop" onMouseDown={dismiss}>
    <div ref={dialog} className="media-replacement-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="restore-media-title" aria-describedby="restore-media-description" aria-busy={Boolean(working || loading)} onMouseDown={(event) => event.stopPropagation()}>
      <button className="media-replacement-close" aria-label="Close replacement backups" disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><RotateCcw size={20}/><h2 id="restore-media-title">Undo media replacement</h2></div>
      <p id="restore-media-description">Restore a saved source and its captions, approvals, timing and appearance. Your current saved project becomes another backup.</p>
      <div className="media-replacement-backups">
        {checkpoints.map((item) => <label key={item.id} className={`media-replacement-option ${selected?.id === item.id ? 'selected' : ''}`}>
          <input type="radio" name="replacement-backup" disabled={Boolean(working || loading)} checked={selected?.id === item.id} onChange={() => setChosen(item.id)}/>
          <span><strong className="media-replacement-filename">{item.previousOriginalName}</strong><small>{new Date(item.createdAt).toLocaleString()}{typeof item.retainedBytes === 'number' ? ` · ${(item.retainedBytes / 1024 / 1024).toFixed(1)} MB` : ''}</small></span>
        </label>)}
        {!loading && !checkpoints.length && !error && <p>No saved replacement backups for this project yet.</p>}
      </div>
      <p className="media-replacement-helper">Up to five local backups are kept. Delete an unneeded backup to make room; this does not delete your current project.</p>
      {error && <p className="media-replacement-error" role="alert">{error}</p>}
      {(working || loading) && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{working || 'Loading backups…'}</span></p>}
      <div className="media-replacement-actions media-replacement-backup-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>Close</button>
        {error && <button disabled={Boolean(working || loading)} onClick={onReload}>Refresh backups</button>}
        {selected && <button className="media-replacement-delete" disabled={Boolean(working || loading)} onClick={() => onDelete(selected)}>Delete backup</button>}
        <button className="primary" disabled={!selected || Boolean(working || loading)} onClick={() => selected && onRestore(selected)}>Restore selected backup</button>
      </div>
    </div>
  </div>;
}
