import { useI18n } from '../i18n';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';
import { StudioBrand } from './Brand';
import { createUploadRecoveryStore, matchingUploadFile, uploadTitle, UPLOAD_RECOVERY_PREFIX, type UploadRecoveryEntry, type UploadFileDetails } from '../upload-recovery';
import './upload-feedback.css';

// These are candidate-file hints, never a claim that the bytes can be decoded.
// Keep unfamiliar containers on the existing import path; rule out only clear
// non-media selections, including when the browser supplies no MIME type.
const mediaExtension = /\.(?:3g2|3gp|aac|ac3|aif|aiff|amr|ape|au|avi|caf|flac|flv|m2ts|m4a|m4b|m4v|mka|mkv|mov|mp2|mp3|mp4|mpeg|mpg|mts|oga|ogg|ogv|opus|ts|vob|wav|webm|wma|wmv)$/i;
const nonMediaExtension = /\.(?:7z|avif|bat|bmp|bz2|cmd|css|csv|doc|docx|eot|exe|gif|gz|heic|htm|html|ico|jpeg|jpg|js|json|md|msi|odt|otf|pdf|png|ppt|pptx|ps1|rar|rtf|srt|svg|tar|tif|tiff|tsv|ttf|ttml|txt|vtt|webp|woff|woff2|xls|xlsx|xml|zip)$/i;
const nonMediaMime = /^(?:image\/|text\/|font\/|application\/(?:pdf|json|xml|javascript|(?:x-)?zip|(?:x-)?rar|x-7z-compressed|gzip|x-tar|x-msdownload|x-msi|msword|vnd\.(?:ms-|openxmlformats-officedocument|oasis\.opendocument)))/i;
function clearlyNonMedia(file: File) {
  return !/^(?:audio|video)\//i.test(file.type) && !mediaExtension.test(file.name)
    && (nonMediaExtension.test(file.name) || nonMediaMime.test(file.type));
}
function fileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files') || event.dataTransfer.files.length > 0;
}

export interface UploadRecoveryProject { id: string; title: string }
export type UploadResult = { state: 'opened' }
  | { state: 'not-created'; message: string; retryable?: boolean; serverText?: boolean }
  | { state: 'uncertain'; message: string; project?: UploadRecoveryProject };
export type UploadRecoveryResult = { state: 'found'; project: UploadRecoveryProject; message?: string }
  | { state: 'uncertain'; message: string };
interface UploadAttempt { file: File | null; title: string; id: string; details: UploadFileDetails; entry: UploadRecoveryEntry | null; retryRejection?: string }
const restoredAttempt = (entry: UploadRecoveryEntry): UploadAttempt => ({ file: null, title: uploadTitle(entry.metadata.name), id: entry.metadata.id, details: entry.metadata, entry });
const restoredResult = (message: string): Exclude<UploadResult, { state: 'opened' }> => ({ state: 'uncertain', message });
interface UploadProps {
  onUpload(file: File, title: string, attemptId: string): Promise<UploadResult>;
  onCheckAttempt?(attemptId: string): Promise<UploadRecoveryResult>;
  onOpenRecovered?(projectId: string): void | Promise<boolean | void>;
  busy: boolean;
  disabled?: boolean;
  disabledReason?: string;
  beforeDropzone?: ReactNode;
}

export function Upload({ onUpload, onCheckAttempt, onOpenRecovered, busy, disabled = false, disabledReason = '', beforeDropzone }: UploadProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const originalFile = useRef<HTMLInputElement>(null);
  const dropzone = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const submitting = useRef(false);
  const [recoveryStore] = useState(() => createUploadRecoveryStore(() => { try { return window.localStorage; } catch { return null; } }));
  const [initialRecovery] = useState(() => recoveryStore.read());
  const [reminders, setReminders] = useState(initialRecovery.entries);
  const [storageError, setStorageError] = useState(initialRecovery.errorMessage ? t(initialRecovery.errorMessage.key, initialRecovery.errorMessage.params) : initialRecovery.error);
  const [attempt, setAttempt] = useState<UploadAttempt | null>(() => initialRecovery.entries[0] ? restoredAttempt(initialRecovery.entries[0]) : null);
  const attemptRef = useRef(attempt); attemptRef.current = attempt;
  const actionRevision = useRef(0);
  const reselectOwner = useRef<{ id: string; revision: number; trigger: HTMLButtonElement } | null>(null);
  const [reselectionNotice, setReselectionNotice] = useState('');
  const [recovery, setRecovery] = useState<Exclude<UploadResult, { state: 'opened' }> | null>(() => initialRecovery.entries.length ? restoredResult(t('home.upload.earlierNeedsCheck')) : null);
  const [recovering, setRecovering] = useState<'check' | 'open' | ''>('');
  const recoveryPending = useRef<{ revision: number; action: 'check' | 'open' } | null>(null);
  const mounted = useRef(true);
  const reviewingUpload = recovery?.state === 'uncertain';
  const blocked = busy || disabled || recovery?.state === 'uncertain' || Boolean(recovering);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const [drag, setDrag] = useState(false);
  const [validation, setValidation] = useState('');
  const statusId = useId();
  const recoveryId = useId();
  const feedback = disabledReason || validation;
  const clearDrag = () => { dragDepth.current = 0; setDrag(false); };
  const refreshReminders = () => {
    const read = recoveryStore.read(); setReminders(read.entries);
    if (read.error) setStorageError(read.errorMessage ? t(read.errorMessage.key, read.errorMessage.params) : read.error);
    return read;
  };
  const activate = (next: UploadAttempt | null) => {
    actionRevision.current++; attemptRef.current = next; setAttempt(next); setReselectionNotice(''); setValidation('');
  };
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(UPLOAD_RECOVERY_PREFIX)) return;
      const read = refreshReminders(); const current = attemptRef.current;
      if (!read.error && current?.entry && !recoveryStore.isCurrent(current.entry)) {
        if (recoveryPending.current?.action === 'open') return; // Finish the deliberate navigation; never launch another upload beside it.
        if (current.file) {
          attemptRef.current = { ...current, entry: null }; setAttempt(attemptRef.current);
          setStorageError(t('home.upload.reminderRemoved'));
        } else {
          if (document.activeElement?.closest('.upload-recovery')) dropzone.current?.focus({ preventScroll: true });
          activate(null); recoveryPending.current = null; setRecovery(null); setRecovering('');
        }
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [recoveryStore]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (submitting.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  useEffect(() => {
    const clear = () => { dragDepth.current = 0; setDrag(false); };
    const leaveDocument = (event: globalThis.DragEvent) => {
      const edge = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
      if (!event.relatedTarget && edge && (event.target === document || event.target === document.documentElement || event.target === document.body)) clear();
    };
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    document.addEventListener('dragleave', leaveDocument);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
      document.removeEventListener('dragleave', leaveDocument);
      window.removeEventListener('blur', clear);
    };
  }, []);
  useEffect(() => { if (blocked) clearDrag(); }, [blocked]);
  const submit = async (next: UploadAttempt) => {
    if (!next.file || next.retryRejection || busy || disabled || submitting.current || recoveryPending.current) return;
    submitting.current = true;
    // Rejecting this transfer cannot settle an earlier lost acknowledgement for
    // the same immutable attempt. Keep its exact saved-result check available.
    const priorUncertain = attemptRef.current?.id === next.id && recovery?.state === 'uncertain' ? recovery : null;
    let captured = next;
    if (!captured.entry) {
      const saved = recoveryStore.keep(captured.details, captured.id);
      captured = { ...captured, entry: saved.entry }; setStorageError(saved.errorMessage ? t(saved.errorMessage.key, saved.errorMessage.params) : saved.error); refreshReminders();
    }
    activate(captured); const revision = actionRevision.current;
    setRecovery(null);
    try {
      const result = await onUpload(next.file, next.title, next.id);
      if (result.state === 'opened') { if (captured.entry) recoveryStore.remove(captured.entry); }
      else if (mounted.current && revision === actionRevision.current && attemptRef.current?.id === captured.id) {
        if (result.state === 'not-created' && result.retryable === false) {
          attemptRef.current = { ...attemptRef.current, retryRejection: result.message };
          setAttempt(attemptRef.current);
        }
        setRecovery(result.state === 'not-created' && priorUncertain
          ? { ...priorUncertain, message: t('home.upload.retryNotApplied') }
          : result);
      }
    } catch {
      if (mounted.current && revision === actionRevision.current) setRecovery({ state: 'uncertain', message: t('home.upload.couldNotConfirm') });
    } finally { submitting.current = false; }
  };
  const recover = async (action: 'check' | 'open') => {
    if (!attempt || busy || disabled || submitting.current || recoveryPending.current) return;
    const captured = attempt; const revision = actionRevision.current;
    const ownsResult = () => mounted.current && revision === actionRevision.current && attemptRef.current?.id === captured.id
      && (!captured.entry || recoveryStore.ownership(captured.entry) !== 'changed');
    const pending = { revision, action }; recoveryPending.current = pending; setRecovering(action);
    try {
      if (action === 'open') {
        if (recovery?.state === 'uncertain' && recovery.project) {
          const opened = await onOpenRecovered?.(recovery.project.id);
          if (opened === true && captured.entry) recoveryStore.remove(captured.entry);
        }
      } else if (onCheckAttempt) {
        const result = await onCheckAttempt(attempt.id);
        if (ownsResult()) setRecovery(result.state === 'found'
          ? { state: 'uncertain', project: result.project, message: result.message || t('home.upload.savedContinue') }
          : result);
      }
    } catch {
      if (ownsResult()) setRecovery({ state: 'uncertain', message: t('home.upload.checkFailed') });
    } finally {
      if (recoveryPending.current === pending) recoveryPending.current = null;
      if (mounted.current && revision === actionRevision.current) setRecovering('');
    }
  };
  const accept = (files: File[]) => {
    clearDrag();
    if (blockedRef.current || submitting.current || !files.length) return;
    if (files.length !== 1) { setValidation(t('home.upload.chooseOne')); return; }
    const file = files[0];
    if (clearlyNonMedia(file)) { setValidation(t('home.upload.unsupported')); return; }
    void submit({ file, title: uploadTitle(file.name), id: `upload_${crypto.randomUUID().replaceAll('-', '')}`, details: file, entry: null });
  };
  return <><div className="empty-stage">
    <StudioBrand variant="hero" moduleLabel="CAPTIONS" moduleDescriptor=""/>
    <h1>{t('home.upload.title')}</h1>
    <p className="lead">{t('home.upload.lead')}</p>
    {beforeDropzone}
    <button ref={dropzone} tabIndex={blocked ? -1 : 0} aria-label={reviewingUpload ? t('home.upload.recoveryInProgress') : t('home.upload.choose')} aria-describedby={[feedback ? statusId : '', recovery ? recoveryId : ''].filter(Boolean).join(' ') || undefined} aria-busy={busy || undefined} aria-disabled={blocked || undefined}
      className={`dropzone ${reviewingUpload ? 'recovering-upload' : ''} ${drag && !blocked?'drag':''}`} onClick={()=>{ if (!blockedRef.current && !submitting.current) ref.current?.click(); }}
      onDragEnter={event=>{
        if (blockedRef.current || submitting.current || !fileDrag(event)) return;
        event.preventDefault(); dragDepth.current++; setDrag(true);
      }}
      onDragOver={event=>{
        if (!fileDrag(event)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = blockedRef.current || submitting.current ? 'none' : 'copy';
        if (!blockedRef.current && !submitting.current) { dragDepth.current = Math.max(1, dragDepth.current); setDrag(true); }
      }}
      onDragLeave={event=>{
        if (!dragDepth.current) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        const target = event.relatedTarget;
        if (target instanceof Node && event.currentTarget.contains(target)) { dragDepth.current = Math.max(1, dragDepth.current); return; }
        if (target instanceof Node || !dragDepth.current) clearDrag();
      }}
      onDrop={event=>{event.preventDefault();accept(Array.from(event.dataTransfer.files));}}>
      {!reviewingUpload && <FileUp className="upload-file-icon" size={34}/>}
      <strong>{busy ? t('home.upload.uploading') : reviewingUpload ? t('home.upload.finishReviewing') : drag ? t('home.upload.drop') : t('home.upload.choose')}</strong>
      {!busy && !reviewingUpload && <span>{t(drag ? 'home.upload.formats' : 'home.upload.dragOrChoose')}</span>}
    </button>
    <p id={statusId} className={`upload-validation${disabledReason ? ' upload-availability' : ''}`} role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
    {storageError && <p className="upload-storage-feedback" role="status">{storageError}</p>}
    {attempt && recovery && <section id={recoveryId} className="upload-recovery" aria-labelledby={`${recoveryId}-title`}>
      <div role={recovery.state === 'not-created' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
        <strong id={`${recoveryId}-title`}>{recovery.state === 'not-created' ? t('home.upload.notApplied') : recovery.project ? t('home.upload.found') : t('home.upload.unconfirmed')}</strong>
        <p data-server-text={(recovery.state === 'not-created' && recovery.serverText) || undefined}>{recovery.message}</p><p className="upload-recovery-filename">{attempt.details.name}</p>
        {attempt.retryRejection && attempt.retryRejection !== recovery.message && <p data-server-text>{attempt.retryRejection}</p>}
      </div>
      <div className="upload-recovery-actions">
        {recovery.state === 'uncertain' && recovery.project && onOpenRecovered && <button type="button" className="upload-recovery-primary" aria-disabled={busy || disabled || Boolean(recovering) || undefined} aria-busy={recovering === 'open' || undefined} onClick={() => void recover('open')}>{recovering === 'open' ? t('home.upload.openingSaved') : t('home.upload.openSaved')}</button>}
        {recovery.state === 'uncertain' && onCheckAttempt && <button type="button" aria-disabled={busy || disabled || Boolean(recovering) || undefined} aria-busy={recovering === 'check' || undefined} onClick={() => void recover('check')}>{recovering === 'check' ? t('home.upload.checkingSaved') : t('home.upload.checkSaved')}</button>}
        {!(recovery.state === 'uncertain' && recovery.project) && !attempt.file && <button type="button" disabled={busy || disabled || Boolean(recovering)} onClick={event => {
          if (busy || disabled || submitting.current || recoveryPending.current) return;
          reselectOwner.current = { id: attempt.id, revision: actionRevision.current, trigger: event.currentTarget }; originalFile.current?.click();
        }}>{t('home.upload.chooseOriginal')}</button>}
        {!(recovery.state === 'uncertain' && recovery.project) && attempt.file && <button type="button" disabled={busy || disabled || Boolean(recovering) || Boolean(attempt.retryRejection) || recovery.state === 'not-created' && recovery.retryable === false} onClick={event => {
          if (busy || disabled || submitting.current || recoveryPending.current || attempt.retryRejection || recovery.state === 'not-created' && recovery.retryable === false) return;
          if (document.activeElement === event.currentTarget) dropzone.current?.focus({ preventScroll: true });
          void submit(attempt);
        }}>{t('home.upload.retry')}</button>}
        <button type="button" disabled={busy || disabled || Boolean(recovering)} onClick={() => {
          if (busy || disabled || submitting.current || recoveryPending.current) return;
          dropzone.current?.focus({ preventScroll: true }); activate(null); setRecovery(null); refreshReminders();
        }}>{t('home.upload.startAnother')}</button>
        {attempt.entry && <button type="button" disabled={busy || disabled || Boolean(recovering)} onClick={() => {
          if (busy || disabled || submitting.current || recoveryPending.current) return;
          if (!recoveryStore.remove(attempt.entry!)) { setStorageError(t('home.upload.forgetFailed')); return; }
          dropzone.current?.focus({ preventScroll: true }); activate(null); setRecovery(null); refreshReminders();
        }}>{t('home.upload.forget')}</button>}
      </div>
      {reselectionNotice && <p className="upload-reselection-feedback" role="status">{reselectionNotice}</p>}
      {recovery.state === 'uncertain' && !recovery.project && <p>{t('home.upload.newAttempt')}</p>}
    </section>}
    {reminders.some((entry) => entry.metadata.id !== attempt?.id) && <details className="upload-earlier-recoveries">
      <summary>{t('home.upload.earlierReminders', { count: reminders.filter((entry) => entry.metadata.id !== attempt?.id).length })}</summary>
      <p>{t('home.upload.earlierHelp')}</p>
      <label>{t('home.upload.earlierLabel')}<select aria-label={t('home.upload.earlierLabel')} value="" disabled={busy || disabled || submitting.current || Boolean(recovering)} onChange={event => {
        const entry = reminders.find((item) => item.metadata.id === event.target.value); if (!entry || busy || disabled || submitting.current || recoveryPending.current) return;
        activate(restoredAttempt(entry)); setRecovery(restoredResult(t('home.upload.earlierNeedsCheck')));
      }}><option value="">{t('home.upload.chooseEarlier')}</option>{reminders.filter((entry) => entry.metadata.id !== attempt?.id).map((entry) => <option key={entry.key} value={entry.metadata.id}>{entry.metadata.name}</option>)}</select></label>
    </details>}
    <input ref={ref} hidden disabled={blocked} type="file" accept="video/*,audio/*" onChange={event=>{
      const files = Array.from(event.currentTarget.files || []);
      event.currentTarget.value = '';
      accept(files);
    }}/>
  </div><input ref={originalFile} className="upload-original-file" hidden disabled={busy || disabled || Boolean(recovering)} type="file" accept="video/*,audio/*" onChange={event => {
    const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = '';
    const owner = reselectOwner.current; reselectOwner.current = null; const current = attemptRef.current;
    if (!owner || !current || owner.id !== current.id || owner.revision !== actionRevision.current || busy || disabled || submitting.current || recoveryPending.current || !files.length) return;
    if (files.length !== 1 || !matchingUploadFile(files[0], current.details)) { setValidation(t('home.upload.fileMismatch')); return; }
    if (document.activeElement === owner.trigger) dropzone.current?.focus({ preventScroll: true });
    activate({ ...current, file: files[0] }); setReselectionNotice(t('home.upload.fileMatches'));
  }}/></>;
}
