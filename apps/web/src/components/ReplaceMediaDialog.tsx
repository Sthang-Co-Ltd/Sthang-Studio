import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Replace, RotateCcw, X } from 'lucide-react';
import type { MediaReplacementCheckpoint, MediaReplacementMode, PreserveAudioConfirmation } from '../api';
import { useModalFocus } from '../use-modal-focus';
import './replace-media-dialog.css';

interface SourceCheck {
  previousName: string;
  checking: boolean;
  run(): void;
}
function SourceCheckAction({ check, returnFocus }: { check: SourceCheck; returnFocus(): void }) {
  return <button className="primary" disabled={check.checking} onClick={() => { returnFocus(); check.run(); }}>
    {check.checking ? 'Checking saved source…' : 'Check saved source'}
  </button>;
}
const unconfirmedMessage = 'Studio could not confirm the saved source. Check which media is saved before trying again.';
function MediaChangeMessage({ check, error }: { check?: SourceCheck; error: string }) {
  if (check?.checking) return <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/>Checking which media is saved…</p>;
  if (check || error) return <p className="media-replacement-error" role="alert">{check ? unconfirmedMessage : error}</p>;
  return null;
}

interface ReplaceProps {
  filename: string;
  captionCount: number;
  working: string;
  error: string;
  sourceCheck?: SourceCheck;
  preserveAudioConfirmation?: PreserveAudioConfirmation;
  onCancel(): void;
  onModeChange(): void;
  onReplace(mode: MediaReplacementMode, audioChangeConfirmation?: string): void;
}

export function ReplaceMediaDialog({ filename, captionCount, working, error, sourceCheck, preserveAudioConfirmation, onCancel, onModeChange, onReplace }: ReplaceProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const audioAcceptance = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<MediaReplacementMode>('preserve');
  const [audioChangeAccepted, setAudioChangeAccepted] = useState(false);
  const [confirmationExpired, setConfirmationExpired] = useState(() => Boolean(preserveAudioConfirmation && Date.parse(preserveAudioConfirmation.expiresAt) <= Date.now()));
  useEffect(() => {
    setAudioChangeAccepted(false);
    const expiresAt = preserveAudioConfirmation ? Date.parse(preserveAudioConfirmation.expiresAt) : 0;
    setConfirmationExpired(Boolean(preserveAudioConfirmation && expiresAt <= Date.now()));
    if (!preserveAudioConfirmation || expiresAt <= Date.now()) return;
    const timer = window.setTimeout(() => {
      const checkbox = audioAcceptance.current;
      const target = cancel.current;
      if (checkbox && document.activeElement === checkbox && dialog.current?.isConnected
        && Array.from(document.querySelectorAll('[aria-modal="true"]')).at(-1) === dialog.current
        && target && !target.disabled) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      }
      setAudioChangeAccepted(false);
      setConfirmationExpired(true);
    }, Math.min(expiresAt - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preserveAudioConfirmation?.token, preserveAudioConfirmation?.expiresAt]);
  const chooseMode = (next: MediaReplacementMode) => {
    setMode(next);
    setAudioChangeAccepted(false);
    onModeChange();
  };
  const needsAudioAcceptance = mode === 'preserve' && Boolean(preserveAudioConfirmation) && !confirmationExpired;
  const dismiss = () => { if (!working) onCancel(); };
  useModalFocus(true, dialog, dismiss, working ? dialog : cancel);

  return <div className="media-replacement-backdrop" onMouseDown={dismiss}>
    <div ref={dialog} className="media-replacement-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="replace-media-title" aria-describedby="replace-media-description" aria-busy={Boolean(working)} onMouseDown={(event) => event.stopPropagation()}>
      <button className="media-replacement-close" aria-label="Cancel media replacement" disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><Replace size={20}/><h2 id="replace-media-title">Replace media</h2></div>
      <p id="replace-media-description">{sourceCheck ? <>Previous source <strong className="media-replacement-filename">{sourceCheck.previousName}</strong></> : <>Replace current media with <strong className="media-replacement-filename">{filename}</strong>. Choose what to keep.</>}</p>
      {!sourceCheck && <><fieldset disabled={Boolean(working)} className="media-replacement-options">
        <legend className="sr-only">What happens to your captions</legend>
        <label className={`media-replacement-option ${mode === 'preserve' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="preserve" checked={mode === 'preserve'} onChange={() => chooseMode('preserve')}/>
          <span><strong>Keep reviewed captions</strong><small>Keep caption text, caption and word timing, approvals, locks, and appearance. Studio checks the new audio first.</small></span>
        </label>
        <label className={`media-replacement-option ${mode === 'reset' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="reset" checked={mode === 'reset'} onChange={() => chooseMode('reset')}/>
          <span><strong>Start over</strong><small>Clear {captionCount ? `${captionCount} caption${captionCount === 1 ? '' : 's'}, approvals, locks, and the` : 'captions, approvals, locks, and the'} transcript. Generate new captions when ready.</small></span>
        </label>
      </fieldset>
      {mode === 'preserve' && <div className="media-replacement-check">
        {preserveAudioConfirmation ? <div className="media-replacement-audio-warning" role="status">
          <h3>Keep old timing with different audio?</h3>
          <p>The new audio differs. Caption and word times will stay unchanged. You must check their alignment against the new audio.</p>
          {confirmationExpired ? <p>The audio check expired. Check the replacement again before continuing.</p> : <label><input ref={audioAcceptance} type="checkbox" checked={audioChangeAccepted} disabled={Boolean(working)} onChange={(event) => setAudioChangeAccepted(event.target.checked)}/><span>I accept the existing times and will check their alignment.</span></label>}
        </div> : <p>Changes in volume, music, or sound effects may need confirmation. The new media must have the same duration.</p>}
      </div>}
      <p className="media-replacement-helper">Studio backs up the previous media and project so you can undo the replacement. No captions are generated automatically.</p></>}
      <MediaChangeMessage check={sourceCheck} error={error}/>
      {working && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{working} Stay on this page until the result is confirmed.</span></p>}
      <div className="media-replacement-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>Cancel</button>
        {sourceCheck ? <SourceCheckAction check={sourceCheck} returnFocus={() => cancel.current?.focus()}/> : <button className={mode === 'preserve' ? 'primary' : ''} disabled={Boolean(working) || (needsAudioAcceptance && !audioChangeAccepted)} onClick={() => onReplace(mode, needsAudioAcceptance && audioChangeAccepted ? preserveAudioConfirmation?.token : undefined)}>{mode === 'reset' ? 'Continue' : confirmationExpired ? 'Check replacement again' : needsAudioAcceptance ? 'Replace and keep existing times' : 'Replace and keep captions'}</button>}
      </div>
    </div>
  </div>;
}

interface RestoreProps {
  checkpoints: MediaReplacementCheckpoint[];
  loading: boolean;
  working: string;
  error: string;
  sourceCheck?: SourceCheck;
  onCancel(): void;
  onReload(): void;
  onRestore(checkpoint: MediaReplacementCheckpoint): void;
  onDelete(checkpoint: MediaReplacementCheckpoint): void;
}

export function RestoreMediaDialog({ checkpoints, loading, working, error, sourceCheck, onCancel, onReload, onRestore, onDelete }: RestoreProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState('');
  const selected = checkpoints.find((item) => item.id === chosen) || checkpoints[0];
  const dismiss = () => { if (!working) onCancel(); };
  useModalFocus(true, dialog, dismiss, working ? dialog : cancel);
  const reload = () => {
    if (working || loading) return;
    // Refresh disappears when the previous read error clears. Keep a visible
    // keyboard target now; a late read must not take focus from newer actions.
    cancel.current?.focus({ preventScroll: true });
    cancel.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    onReload();
  };

  return <div className="media-replacement-backdrop" onMouseDown={dismiss}>
    <div ref={dialog} className="media-replacement-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="restore-media-title" aria-describedby="restore-media-description" aria-busy={Boolean(working || loading)} onMouseDown={(event) => event.stopPropagation()}>
      <button className="media-replacement-close" aria-label="Close replacement backups" disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><RotateCcw size={20}/><h2 id="restore-media-title">Undo media replacement</h2></div>
      <p id="restore-media-description">{sourceCheck ? <>Previous source <strong className="media-replacement-filename">{sourceCheck.previousName}</strong></> : 'Restore saved media with its captions, approvals, timing, and appearance. Your current saved project becomes another backup.'}</p>
      {!sourceCheck && <><div className="media-replacement-backups">
        {checkpoints.map((item) => <label key={item.id} className={`media-replacement-option ${selected?.id === item.id ? 'selected' : ''}`}>
          <input type="radio" name="replacement-backup" disabled={Boolean(working || loading)} checked={selected?.id === item.id} onChange={() => setChosen(item.id)}/>
          <span><strong className="media-replacement-filename">{item.previousOriginalName}</strong><small>{new Date(item.createdAt).toLocaleString()}{typeof item.retainedBytes === 'number' ? ` · ${(item.retainedBytes / 1024 / 1024).toFixed(1)} MB` : ''}</small></span>
        </label>)}
        {!loading && !checkpoints.length && !error && <p>No replacement backups yet.</p>}
      </div>
      <p className="media-replacement-helper">Studio keeps up to five local backups. Delete one to make room; your current project stays intact.</p></>}
      <MediaChangeMessage check={sourceCheck} error={error}/>
      {(working || loading) && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{working || 'Loading backups…'}</span></p>}
      <div className="media-replacement-actions media-replacement-backup-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>Close</button>
        {sourceCheck ? <SourceCheckAction check={sourceCheck} returnFocus={() => cancel.current?.focus()}/> : <>{error && <button disabled={Boolean(working || loading)} onClick={reload}>Refresh backups</button>}
        {selected && <button className="media-replacement-delete" disabled={Boolean(working || loading)} onClick={() => onDelete(selected)}>Delete backup</button>}
        <button className="primary" disabled={!selected || Boolean(working || loading)} onClick={() => selected && onRestore(selected)}>Restore selected backup</button></>}
      </div>
    </div>
  </div>;
}
