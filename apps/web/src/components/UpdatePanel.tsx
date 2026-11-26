import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { api, type UpdateStatus, type UpdateSafetySnapshot } from '../api';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';
import './updates.css';

const SESSION_CHECK_KEY = 'sthang:updates-checked:v1';
let startupCheckStarted = false;

interface Props {
  open: boolean;
  safety: UpdateSafetySnapshot;
  onClose: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function UpdatePanel({ open, safety, onClose, onError, onNotice }: Props) {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [working, setWorking] = useState<'check' | 'download' | 'install' | ''>('');
  const [checkError, setCheckError] = useState('');
  const operation = useRef(false);
  const wasOpen = useRef(false);
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  // The close button becomes disabled during checks; root focus stays stable.
  useModalFocus(open, dialog, () => { if (!operation.current && !working) onClose(); }, dialog);

  const check = useCallback(async (options: { announce: boolean; surfaceError: boolean }) => {
    if (operation.current) return;
    operation.current = true;
    setWorking('check');
    setCheckError('');
    try {
      const next = await api.updateStatus();
      setStatus(next);
      if (options.announce) {
        if (next.status === 'available') onNotice(t('updates.reviewOffer', { version: next.offer.version }));
        else if (next.status === 'up-to-date') onNotice(t('updates.upToDateNotice'));
        else onNotice(next.message);
      } else if (next.status === 'available') {
        onNotice(t('updates.openToReview', { version: next.offer.version }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('updates.checkError');
      setCheckError(message);
      if (options.surfaceError) onError(message);
    } finally {
      operation.current = false;
      setWorking('');
    }
  }, [onError, onNotice, t]);

  useEffect(() => {
    if (startupCheckStarted) return;
    try {
      if (sessionStorage.getItem(SESSION_CHECK_KEY) === '1') {
        startupCheckStarted = true;
        return;
      }
      sessionStorage.setItem(SESSION_CHECK_KEY, '1');
    } catch {
      // The module-level guard still enforces one check for this loaded Studio session.
    }
    startupCheckStarted = true;
    void check({ announce: false, surfaceError: false });
  }, [check]);

  useEffect(() => {
    if (open && !wasOpen.current) void check({ announce: false, surfaceError: true });
    wasOpen.current = open;
  }, [open, check]);

  const unsafeReasons = useMemo(() => {
    const reasons: string[] = [];
    if (safety.dirty) reasons.push(t('updates.saveChanges'));
    if (safety.textEditing) reasons.push(t('updates.finishTextEdit'));
    if (safety.reviewMode) reasons.push(t('updates.leaveReview'));
    if (safety.proposalOpen) reasons.push(t('updates.finishComparison'));
    if (safety.busy) reasons.push(t('updates.waitForStudio'));
    if (safety.activeJobs > 0) reasons.push(t('updates.waitForJobs'));
    return reasons;
  }, [safety, t]);

  if (!presence.present) return null;
  const offer = status?.status === 'available' ? status.offer : null;
  const unsafe = unsafeReasons.length > 0;
  const lastFailure = status?.lastFailure;
  const checkAgain = (trigger: HTMLButtonElement) => {
    if (operation.current) return;
    if (document.activeElement === trigger) {
      // The manual action may disappear or become disabled during the check.
      // Move focus now; completion must not take it from a newer interaction.
      dialog.current?.focus({ preventScroll: true });
      dialog.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    }
    void check({ announce: true, surfaceError: true });
  };

  const downloadUpdate = async () => {
    if (!offer || unsafe || operation.current) return;
    if (!window.confirm(t('updates.confirmDownload', { version: offer.version }))) return;
    operation.current = true;
    setWorking('download');
    try {
      await api.downloadUpdate(offer.manifestDigest, safety);
      setStatus((current) => current?.status === 'available'
        ? { ...current, offer: { ...current.offer, downloaded: true } }
        : current);
      onNotice(t('updates.downloaded', { version: offer.version }));
    } catch (error) {
      onError(error instanceof Error ? error.message : t('updates.downloadError'));
    } finally {
      operation.current = false;
      setWorking('');
    }
  };

  const installUpdate = async () => {
    if (!offer || !offer.downloaded || unsafe || operation.current) return;
    if (!window.confirm(t('updates.confirmInstall', { version: offer.version }))) return;
    operation.current = true;
    setWorking('install');
    try {
      await api.installUpdate(offer.manifestDigest, safety);
      onNotice(t('updates.installingNotice'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('updates.installError');
      onError(message);
      operation.current = false;
      setWorking('');
      if (error instanceof Error && /different Studio update|no longer newer/i.test(error.message)) void check({ announce: false, surfaceError: false });
    }
  };

  return <div className="update-overlay studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="update-panel" role="dialog" aria-modal={open || undefined} aria-labelledby="update-title">
      <header>
        <div><ShieldCheck size={19}/><div><strong id="update-title">{t('updates.title')}</strong><span>{t('updates.help')}</span></div></div>
        <button aria-label={t('updates.close')} onClick={onClose} disabled={!!working}><X size={17}/></button>
      </header>
      <div className="update-content">
        {lastFailure && <div className="update-failure"><TriangleAlert size={18}/><div><strong>{t('updates.rollback')}</strong><span data-server-text>{lastFailure.message}</span></div></div>}
        {working === 'check' && <div className="update-state"><LoaderCircle className="spin" size={20}/><strong>{t('updates.checking')}</strong><span>{t('updates.currentVersionAvailable')}</span></div>}
        {!working && checkError && <div className="update-state"><TriangleAlert size={20}/><strong>{t('updates.unavailable')}</strong><span>{checkError}</span></div>}
        {!working && !checkError && status?.status === 'disabled' && <div className="update-state"><ShieldCheck size={20}/><strong>{t('updates.disabled')}</strong><span data-server-text>{status.message}</span></div>}
        {!working && !checkError && status?.status === 'up-to-date' && <div className="update-state"><CheckCircle2 size={20}/><strong>{t('updates.upToDate')}</strong><span>{t('updates.installedVersion', { version: status.currentVersion })}</span></div>}
        {!checkError && offer && <>
          <div className="update-version"><div><span>{t('updates.available')}</span><strong>{offer.version}</strong><small>{formatInterfaceDate(locale, offer.publishedAt)}</small></div><ShieldCheck size={28}/></div>
          <div className="update-notes"><strong>{t('updates.releaseNotes')}</strong><pre data-server-text>{offer.releaseNotes}</pre></div>
          {unsafe && <div className="update-safety"><strong>{t('updates.finishWork')}</strong><span>{unsafeReasons.join(' ')}</span></div>}
          <div className="update-actions">
            <button onClick={(event) => checkAgain(event.currentTarget)} disabled={!!working}><RefreshCw size={15}/>{t('updates.checkAgain')}</button>
            {!offer.downloaded
              ? <button className="primary" onClick={() => void downloadUpdate()} disabled={!!working || unsafe}>{working === 'download' ? <LoaderCircle className="spin" size={15}/> : <Download size={15}/>}{t('updates.download')}</button>
              : <button className="primary" onClick={() => void installUpdate()} disabled={!!working || unsafe}>{working === 'install' ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>}{t('updates.install')}</button>}
          </div>
        </>}
        {!working && (!offer || Boolean(checkError)) && <div className="update-actions"><button onClick={(event) => checkAgain(event.currentTarget)}><RefreshCw size={15}/>{t('updates.checkAgain')}</button></div>}
      </div>
      <footer>{t('updates.recoveryHelp')}</footer>
    </section>
  </div>;
}
