import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { api, type UpdateStatus, type UpdateSafetySnapshot } from '../api';
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
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [working, setWorking] = useState<'check' | 'download' | 'install' | ''>('');
  const [checkError, setCheckError] = useState('');
  const operation = useRef(false);
  const wasOpen = useRef(false);

  const check = useCallback(async (options: { announce: boolean; surfaceError: boolean }) => {
    if (operation.current) return;
    operation.current = true;
    setWorking('check');
    setCheckError('');
    try {
      const next = await api.updateStatus();
      setStatus(next);
      if (options.announce) {
        if (next.status === 'available') onNotice(`Sthang Studio ${next.offer.version} is available. Review it before downloading.`);
        else if (next.status === 'up-to-date') onNotice('Sthang Studio is up to date.');
        else onNotice(next.message);
      } else if (next.status === 'available') {
        onNotice(`Sthang Studio ${next.offer.version} is available. Open Check for updates when your work is saved.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Studio could not check for updates. Your installed version is unchanged.';
      setCheckError(message);
      if (options.surfaceError) onError(message);
    } finally {
      operation.current = false;
      setWorking('');
    }
  }, [onError, onNotice]);

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
    if (safety.dirty) reasons.push('Save caption changes.');
    if (safety.textEditing) reasons.push('Finish the current text edit.');
    if (safety.reviewMode) reasons.push('Leave Review.');
    if (safety.proposalOpen) reasons.push('Close or finish the regeneration comparison.');
    if (safety.busy) reasons.push('Wait for the current Studio action to finish.');
    if (safety.activeJobs > 0) reasons.push('Wait for caption processing to finish or cancel it.');
    return reasons;
  }, [safety]);

  if (!open) return null;
  const offer = status?.status === 'available' ? status.offer : null;
  const unsafe = unsafeReasons.length > 0;
  const lastFailure = status?.lastFailure;

  const downloadUpdate = async () => {
    if (!offer || unsafe || operation.current) return;
    if (!window.confirm(`Download and verify Sthang Studio ${offer.version}? Nothing will be installed yet.`)) return;
    operation.current = true;
    setWorking('download');
    try {
      await api.downloadUpdate(offer.manifestDigest, safety);
      setStatus((current) => current?.status === 'available'
        ? { ...current, offer: { ...current.offer, downloaded: true } }
        : current);
      onNotice(`Studio ${offer.version} is downloaded and verified. Install it when your work is saved.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The update could not be downloaded. Your installed version is unchanged.');
    } finally {
      operation.current = false;
      setWorking('');
    }
  };

  const installUpdate = async () => {
    if (!offer || !offer.downloaded || unsafe || operation.current) return;
    if (!window.confirm(`Install Sthang Studio ${offer.version} now? Studio will close, verify the staged release again, prepare dependencies, restart, and roll back automatically if health checks fail.`)) return;
    operation.current = true;
    setWorking('install');
    try {
      await api.installUpdate(offer.manifestDigest, safety);
      onNotice('Studio is closing to finish the verified update.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The update could not be installed. Your installed version is unchanged.';
      onError(message);
      operation.current = false;
      setWorking('');
      if (/different Studio update|no longer newer/i.test(message)) void check({ announce: false, surfaceError: false });
    }
  };

  return <div className="update-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
    <section className="update-panel" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <header>
        <div><ShieldCheck size={19}/><div><strong id="update-title">Studio updates</strong><span>Signed releases, installed only with your confirmation</span></div></div>
        <button aria-label="Close updates" onClick={onClose} disabled={!!working}><X size={17}/></button>
      </header>
      <div className="update-content">
        {lastFailure && <div className="update-failure"><TriangleAlert size={18}/><div><strong>The previous update was rolled back</strong><span>{lastFailure.message}</span></div></div>}
        {working === 'check' && <div className="update-state"><LoaderCircle className="spin" size={20}/><strong>Checking for a signed update…</strong><span>Your current Studio version remains available.</span></div>}
        {!working && checkError && <div className="update-state"><TriangleAlert size={20}/><strong>Update status is unavailable</strong><span>{checkError}</span></div>}
        {!working && !checkError && status?.status === 'disabled' && <div className="update-state"><ShieldCheck size={20}/><strong>Updates are not enabled in this build</strong><span>{status.message}</span></div>}
        {!working && !checkError && status?.status === 'up-to-date' && <div className="update-state"><CheckCircle2 size={20}/><strong>Studio is up to date</strong><span>Installed version {status.currentVersion}</span></div>}
        {!checkError && offer && <>
          <div className="update-version"><div><span>Available version</span><strong>{offer.version}</strong><small>{new Date(offer.publishedAt).toLocaleDateString()}</small></div><ShieldCheck size={28}/></div>
          <div className="update-notes"><strong>What changed</strong><pre>{offer.releaseNotes}</pre></div>
          {unsafe && <div className="update-safety"><strong>Finish current work before updating</strong><span>{unsafeReasons.join(' ')}</span></div>}
          <div className="update-actions">
            <button onClick={() => void check({ announce: true, surfaceError: true })} disabled={!!working}><RefreshCw size={15}/>Check again</button>
            {!offer.downloaded
              ? <button className="primary" onClick={() => void downloadUpdate()} disabled={!!working || unsafe}>{working === 'download' ? <LoaderCircle className="spin" size={15}/> : <Download size={15}/>}Download &amp; verify</button>
              : <button className="primary" onClick={() => void installUpdate()} disabled={!!working || unsafe}>{working === 'install' ? <LoaderCircle className="spin" size={15}/> : <ShieldCheck size={15}/>}Install &amp; restart</button>}
          </div>
        </>}
        {!working && !offer && <div className="update-actions"><button onClick={() => void check({ announce: true, surfaceError: true })}><RefreshCw size={15}/>Check again</button></div>}
      </div>
      <footer>Updates are staged and verified before the active version changes. The GitHub Release download remains the manual recovery path.</footer>
    </section>
  </div>;
}
