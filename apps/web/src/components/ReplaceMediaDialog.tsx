import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
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
  const { t } = useI18n();
  return <button className="primary" disabled={check.checking} onClick={() => { returnFocus(); check.run(); }}>
    {check.checking ? t('dialogs.media.checkingSavedSource') : t('dialogs.media.checkSavedSource')}
  </button>;
}
function MediaChangeMessage({ check, error, errorIsServerText }: { check?: SourceCheck; error: string; errorIsServerText?: boolean }) {
  const { t } = useI18n();
  if (check?.checking) return <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/>{t('dialogs.media.checkingWhichSource')}</p>;
  if (check || error) return <p className="media-replacement-error" role="alert" data-server-text={(!check && errorIsServerText) || undefined}>{check ? t('dialogs.media.sourceUnconfirmed') : error}</p>;
  return null;
}

interface ReplaceProps {
  current: { originalName: string; size?: number };
  replacement: { name: string; size?: number };
  captionCount: number;
  working: string;
  error: string;
  errorIsServerText?: boolean;
  sourceCheck?: SourceCheck;
  preserveAudioConfirmation?: PreserveAudioConfirmation;
  onCancel(): void;
  onModeChange(): void;
  onReplace(mode: MediaReplacementMode, audioChangeConfirmation?: string): void;
}

export function ReplaceMediaDialog({ current, replacement, captionCount, working, error, errorIsServerText, sourceCheck, preserveAudioConfirmation, onCancel, onModeChange, onReplace }: ReplaceProps) {
  const { locale, t, tn, tr } = useI18n();
  const bytes = new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'short' });
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
      <button className="media-replacement-close" aria-label={t('dialogs.media.cancelReplacement')} disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><Replace size={20}/><h2 id="replace-media-title">{t('dialogs.media.replaceTitle')}</h2></div>
      <p id="replace-media-description">{sourceCheck ? tr('dialogs.media.previousSource', { filename: sourceCheck.previousName }, { b: (name) => <strong className="media-replacement-filename">{name}</strong> }) : t('dialogs.media.replaceDescription')}</p>
      {!sourceCheck && <dl className="replacement-files">
        {([{ label: 'dialogs.media.currentFootage', name: current.originalName, size: current.size },
          { label: 'dialogs.media.replacementFootage', name: replacement.name, size: replacement.size }] as const).map(file =>
          <div key={file.label}><dt>{t(file.label)}</dt><dd><bdi>{file.name}</bdi>
            <small>{typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? bytes.format(file.size) : t('dialogs.media.sizeUnavailable')}</small>
          </dd></div>)}
      </dl>}
      {!sourceCheck && <><fieldset disabled={Boolean(working)} className="media-replacement-options">
        <legend className="sr-only">{t('dialogs.media.options')}</legend>
        <label className={`media-replacement-option ${mode === 'preserve' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="preserve" checked={mode === 'preserve'} onChange={() => chooseMode('preserve')}/>
          <span><strong>{t('dialogs.media.keepCaptions')}</strong><small>{t('dialogs.media.keepCaptionsDescription')}</small></span>
        </label>
        <label className={`media-replacement-option ${mode === 'reset' ? 'selected' : ''}`}>
          <input type="radio" name="media-replacement-mode" value="reset" checked={mode === 'reset'} onChange={() => chooseMode('reset')}/>
          <span><strong>{t('dialogs.media.reset')}</strong><small>{captionCount ? tn('dialogs.media.resetCount', captionCount) : t('dialogs.media.resetDescription')}</small></span>
        </label>
      </fieldset>
      {mode === 'preserve' && <div className="media-replacement-check">
        {preserveAudioConfirmation ? <div className="media-replacement-audio-warning" role="status">
          <h3>{t('dialogs.media.differentAudio')}</h3>
          <p>{t('dialogs.media.differentAudioDescription')}</p>
          {confirmationExpired ? <p>{t('dialogs.media.expired')}</p> : <label><input ref={audioAcceptance} type="checkbox" checked={audioChangeAccepted} disabled={Boolean(working)} onChange={(event) => setAudioChangeAccepted(event.target.checked)}/><span>{t('dialogs.media.acceptExistingTimes')}</span></label>}
        </div> : <p>{t('dialogs.media.durationHelp')}</p>}
      </div>}
      <p className="media-replacement-helper">{t('dialogs.media.replaceHelp')}</p></>}
      <MediaChangeMessage check={sourceCheck} error={error} errorIsServerText={errorIsServerText}/>
      {working && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{t('dialogs.media.working', { status: working })}</span></p>}
      <div className="media-replacement-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>{t('common.cancel')}</button>
        {sourceCheck ? <SourceCheckAction check={sourceCheck} returnFocus={() => cancel.current?.focus()}/> : <button className={mode === 'preserve' ? 'primary' : ''} disabled={Boolean(working) || (needsAudioAcceptance && !audioChangeAccepted)} onClick={() => onReplace(mode, needsAudioAcceptance && audioChangeAccepted ? preserveAudioConfirmation?.token : undefined)}>{mode === 'reset' ? t('dialogs.media.continue') : confirmationExpired ? t('dialogs.media.checkAgain') : needsAudioAcceptance ? t('dialogs.media.replaceKeepTimes') : t('dialogs.media.replaceKeepCaptions')}</button>}
      </div>
    </div>
  </div>;
}

interface RestoreProps {
  checkpoints: MediaReplacementCheckpoint[];
  loading: boolean;
  working: string;
  error: string;
  errorIsServerText?: boolean;
  sourceCheck?: SourceCheck;
  onCancel(): void;
  onReload(): void;
  onRestore(checkpoint: MediaReplacementCheckpoint): void;
  onDelete(checkpoint: MediaReplacementCheckpoint): void;
}

export function RestoreMediaDialog({ checkpoints, loading, working, error, errorIsServerText, sourceCheck, onCancel, onReload, onRestore, onDelete }: RestoreProps) {
  const { locale, t, tr } = useI18n();
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
      <button className="media-replacement-close" aria-label={t('dialogs.media.closeBackups')} disabled={Boolean(working)} onClick={dismiss}><X size={18}/></button>
      <div className="media-replacement-title"><RotateCcw size={20}/><h2 id="restore-media-title">{t('dialogs.media.undoTitle')}</h2></div>
      <p id="restore-media-description">{sourceCheck ? tr('dialogs.media.previousSource', { filename: sourceCheck.previousName }, { b: (name) => <strong className="media-replacement-filename">{name}</strong> }) : t('dialogs.media.restoreDescription')}</p>
      {!sourceCheck && <><div className="media-replacement-backups">
        {checkpoints.map((item) => <label key={item.id} className={`media-replacement-option ${selected?.id === item.id ? 'selected' : ''}`}>
          <input type="radio" name="replacement-backup" disabled={Boolean(working || loading)} checked={selected?.id === item.id} onChange={() => setChosen(item.id)}/>
          <span><strong className="media-replacement-filename">{item.previousOriginalName}</strong><small>{typeof item.retainedBytes === 'number' ? t('dialogs.media.backupDateAndSize', { date: formatInterfaceDate(locale, item.createdAt, { time: true }), size: (item.retainedBytes / 1024 / 1024).toFixed(1) }) : formatInterfaceDate(locale, item.createdAt, { time: true })}</small></span>
        </label>)}
        {!loading && !checkpoints.length && !error && <p>{t('dialogs.media.noBackups')}</p>}
      </div>
      <p className="media-replacement-helper">{t('dialogs.media.backupHelp')}</p></>}
      <MediaChangeMessage check={sourceCheck} error={error} errorIsServerText={errorIsServerText}/>
      {(working || loading) && <p className="media-replacement-progress" role="status"><LoaderCircle size={16} className="spin"/><span>{working || t('dialogs.media.loadingBackups')}</span></p>}
      <div className="media-replacement-actions media-replacement-backup-actions">
        <button ref={cancel} disabled={Boolean(working)} onClick={dismiss}>{t('dialogs.media.close')}</button>
        {sourceCheck ? <SourceCheckAction check={sourceCheck} returnFocus={() => cancel.current?.focus()}/> : <>{error && <button disabled={Boolean(working || loading)} onClick={reload}>{t('dialogs.media.refreshBackups')}</button>}
        {selected && <button className="media-replacement-delete" disabled={Boolean(working || loading)} onClick={() => onDelete(selected)}>{t('dialogs.deleteBackup.confirm')}</button>}
        <button className="primary" disabled={!selected || Boolean(working || loading)} onClick={() => selected && onRestore(selected)}>{t('dialogs.media.restoreSelected')}</button></>}
      </div>
    </div>
  </div>;
}
