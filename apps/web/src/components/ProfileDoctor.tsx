import { useEffect, useRef, useState } from 'react';
import type { AppProfile, ProjectStorageStatus, SystemDoctorReport, TopicPack, TranscriptionContext } from '@kcs/shared';
import type { LlmConnectionTest, LlmSettingsStatus, SaveLlmSettingsInput } from '../api';
import { Download, FileUp, HeartPulse, KeyRound, PackagePlus, Play, Save, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { uniqueContextLines } from '../accuracy-context-draft';
import { CopyReportButton } from './CopyReportButton';
import { AiSettingsPanel } from './AiSettingsPanel';
import { ContributorSettings } from './ContributorSettings';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';
import { ProjectStoragePanel } from './ProjectStoragePanel';
import './contribution.css';

export type SettingsTab = 'ai' | 'profile' | 'privacy' | 'doctor';

interface ProfileDoctorProps {
  open: boolean;
  initialTab: SettingsTab;
  llmSettings: LlmSettingsStatus;
  profile: AppProfile;
  doctor: SystemDoctorReport | null;
  busy: boolean;
  currentContext: TranscriptionContext | null;
  onClose(): void;
  onSave(patch: Partial<AppProfile>, feedback?: 'toast' | 'inline'): Promise<AppProfile | null>;
  onImport(profile: AppProfile): Promise<boolean>;
  onRunDoctor(): void;
  onApplyPack(pack: TopicPack): void;
  onSaveLlm(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  onTestLlm(input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest>;
  onForgetLlm(): Promise<LlmSettingsStatus>;
  storageStatus?: ProjectStorageStatus | null;
  storageChecking?: boolean;
  storageError?: string;
  onRecheckStorage?(): void;
}

export function ProfileDoctor({
  open,
  initialTab,
  llmSettings,
  profile,
  doctor,
  busy,
  currentContext,
  onClose,
  onSave,
  onImport,
  onRunDoctor,
  onApplyPack,
  onSaveLlm,
  onTestLlm,
  onForgetLlm,
  storageStatus = null, storageChecking = false, storageError = '', onRecheckStorage,
}: ProfileDoctorProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [glossary, setGlossary] = useState(profile.defaultVocabulary.join('\n'));
  const [packName, setPackName] = useState('');
  const [working, setWorking] = useState<'glossary' | 'pack' | 'import' | ''>('');
  const [glossaryFeedback, setGlossaryFeedback] = useState({ error: false, message: '' });
  const [packFeedback, setPackFeedback] = useState({ error: false, message: '' });
  const [importFeedback, setImportFeedback] = useState({ error: false, message: '' });
  const [retryImport, setRetryImport] = useState<File | null>(null);
  const glossaryEdited = useRef(false);
  const glossaryRevision = useRef(0);
  const packRevision = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const contextKey = useRef('');
  contextKey.current = JSON.stringify(currentContext);
  const importRef = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  useModalFocus(open, dialog, onClose);

  useEffect(() => { if (!glossaryEdited.current) setGlossary(profile.defaultVocabulary.join('\n')); }, [profile.defaultVocabulary]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  if (!presence.present) return null;

  const saveGlossary = async () => {
    if (pending.current || busy) return;
    const revision = glossaryRevision.current;
    const submitted = uniqueContextLines(glossary.split(/\r?\n/));
    pending.current = true; setWorking('glossary'); setGlossaryFeedback({ error: false, message: '' });
    try {
      const saved = await onSave({ defaultVocabulary: submitted }, 'inline');
      if (!mounted.current) return;
      if (!saved) throw new Error('save');
      if (JSON.stringify(uniqueContextLines(saved.defaultVocabulary)) !== JSON.stringify(submitted)) {
        setGlossaryFeedback({ error: true, message: 'Some glossary terms were not saved. Shorten the list or long terms, then try again.' });
        return;
      }
      if (glossaryRevision.current === revision) {
        glossaryEdited.current = false;
        setGlossary(saved.defaultVocabulary.join('\n'));
        setGlossaryFeedback({ error: false, message: 'Glossary saved.' });
      } else setGlossaryFeedback({ error: false, message: 'Earlier glossary saved. Your newer glossary edits are still unsaved.' });
    } catch { if (mounted.current) setGlossaryFeedback({ error: true, message: 'Could not save the glossary. Your text is kept; try again.' }); }
    finally { pending.current = false; if (mounted.current) setWorking(''); }
  };
  const createPack = async () => {
    if (!currentContext || !packName.trim() || pending.current || busy) return;
    const revision = packRevision.current;
    const submittedContext = contextKey.current;
    const now = new Date().toISOString();
    const pack: TopicPack = {
      id: crypto.randomUUID(),
      name: packName.trim(),
      description: currentContext.description,
      vocabulary: currentContext.vocabulary,
      createdAt: now,
      updatedAt: now,
    };
    pending.current = true; setWorking('pack'); setPackFeedback({ error: false, message: '' });
    try {
      const saved = await onSave({ topicPacks: [...profile.topicPacks, pack] }, 'inline');
      if (!mounted.current) return;
      const accepted = saved?.topicPacks.find((item) => item.id === pack.id);
      if (!accepted || accepted.name !== pack.name || accepted.description !== pack.description.trim()
        || JSON.stringify(uniqueContextLines(accepted.vocabulary)) !== JSON.stringify(uniqueContextLines(pack.vocabulary))) throw new Error('save');
      if (packRevision.current === revision && contextKey.current === submittedContext) {
        setPackName(''); setPackFeedback({ error: false, message: `Saved topic pack “${accepted.name}”.` });
      }
    } catch { if (mounted.current) setPackFeedback({ error: true, message: `Could not save topic pack “${pack.name}”. Your name and current context are kept; try again.` }); }
    finally { pending.current = false; if (mounted.current) setWorking(''); }
  };
  const removePack = (id: string) => onSave({ topicPacks: profile.topicPacks.filter((pack) => pack.id !== id) });
  const importFile = async (file?: File) => {
    if (!file || pending.current || busy) return;
    pending.current = true; setWorking('import'); setRetryImport(null); setImportFeedback({ error: false, message: '' });
    let parsed: AppProfile;
    try {
      const value = JSON.parse(await file.text());
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
        || !Array.isArray(value.defaultVocabulary) || value.defaultVocabulary.some((line: unknown) => typeof line !== 'string')) throw new Error('invalid');
      parsed = value as AppProfile;
    } catch {
      setImportFeedback({ error: true, message: 'This file is not a readable Studio profile. Choose a JSON file created by Export profile. Your settings and drafts are unchanged.' });
      pending.current = false; setWorking(''); return;
    }
    try {
      if (!await onImport(parsed)) throw new Error('import');
      if (mounted.current) setImportFeedback({ error: false, message: glossaryEdited.current ? 'Profile imported. Your unsaved glossary text is still in the form.' : 'Profile imported.' });
    } catch {
      if (mounted.current) {
        setRetryImport(file);
        setImportFeedback({ error: true, message: 'Could not confirm the profile import. Your form drafts are kept. Retry this file or choose another.' });
      }
    } finally { pending.current = false; if (mounted.current) setWorking(''); }
  };

  return <div className="modal-backdrop profile-settings-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="settings-title" tabIndex={-1} className="modal profile-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div><strong id="settings-title">Settings</strong><span>Manage AI, your profile, privacy, and system checks.</span></div>
        <button className="icon-btn" aria-label="Close settings" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="modal-tabs settings-tabs"><button className={tab === 'ai' ? 'selected' : ''} onClick={() => setTab('ai')}><KeyRound size={14}/>AI connection</button><button className={tab === 'profile' ? 'selected' : ''} onClick={() => setTab('profile')}><UserRound size={14}/>Profile</button><button className={tab === 'privacy' ? 'selected' : ''} onClick={() => setTab('privacy')}><ShieldCheck size={14}/>Privacy</button><button className={tab === 'doctor' ? 'selected' : ''} onClick={() => setTab('doctor')}><HeartPulse size={14}/>System check</button></div>

      {tab === 'ai' ? <AiSettingsPanel settings={llmSettings} onSave={onSaveLlm} onTest={onTestLlm} onForget={onForgetLlm}/> : tab === 'profile' ? <div className="profile-body">
        <div className="profile-stats"><div><b>{profile.defaultVocabulary.length}</b><span>global terms</span></div><div><b>{profile.correctionRules.length}</b><span>approved rules</span></div><div><b>{profile.correctionEvents.length}</b><span>correction events</span></div><div><b>{profile.topicPacks.length}</b><span>topic packs</span></div></div>
        <label className="context-field"><span id="profile-glossary-label">Global protected vocabulary</span><textarea rows={9} value={glossary} aria-labelledby="profile-glossary-label" aria-describedby={glossaryFeedback.message ? 'profile-glossary-feedback' : undefined} onChange={(event) => { glossaryEdited.current = true; glossaryRevision.current++; setGlossary(event.target.value); setGlossaryFeedback({ error: false, message: '' }); }} placeholder={'GPT 5.6 Luna\nTerra | ថេរ៉ា\nCapCut'}/></label>
        {glossaryFeedback.message && <p id="profile-glossary-feedback" className="profile-form-feedback" role={glossaryFeedback.error ? 'alert' : 'status'}>{glossaryFeedback.message}</p>}
        <div className="profile-actions"><button disabled={busy || Boolean(working)} aria-busy={working === 'glossary' || undefined} onClick={() => void saveGlossary()}><Save size={15}/>{working === 'glossary' ? 'Saving glossary…' : 'Save glossary'}</button><a href="/api/profile/export" download><Download size={15}/>Export profile</a><button disabled={busy || Boolean(working)} onClick={() => importRef.current?.click()}><FileUp size={15}/>{working === 'import' ? 'Importing…' : 'Import profile'}</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file); }}/></div>
        {importFeedback.message && <div className="profile-form-feedback profile-import-feedback" role={importFeedback.error ? 'alert' : 'status'}><span>{importFeedback.message}</span>{importFeedback.error && <>{retryImport && <button disabled={busy || Boolean(working)} onClick={() => void importFile(retryImport)}>Retry import</button>}<button disabled={busy || Boolean(working)} onClick={() => importRef.current?.click()}>Choose another profile</button></>}</div>}

        <div className="topic-pack-section">
          <div className="section-title"><div><strong>Topic packs</strong><span>Reuse the current context and vocabulary in other projects.</span></div></div>
          {currentContext && <div className="pack-create"><input aria-label="Topic pack name" aria-describedby={packFeedback.message ? 'profile-pack-feedback' : undefined} maxLength={80} value={packName} onChange={(event) => { packRevision.current++; setPackName(event.target.value); setPackFeedback({ error: false, message: '' }); }} placeholder="Example: AI / Coding"/><button disabled={!packName.trim() || busy || Boolean(working)} aria-busy={working === 'pack' || undefined} onClick={() => void createPack()}><PackagePlus size={15}/>{working === 'pack' ? 'Saving topic pack…' : 'Save context as pack'}</button></div>}
          {packFeedback.message && <p id="profile-pack-feedback" className="profile-form-feedback" role={packFeedback.error ? 'alert' : 'status'}>{packFeedback.message}</p>}
          <div className="pack-list">{profile.topicPacks.length === 0 && <span className="muted-copy">No topic packs yet.</span>}{profile.topicPacks.map((pack) => <div className="pack-card" key={pack.id}><div><strong>{pack.name}</strong><span>{pack.vocabulary.length} terms · {pack.description || 'No description'}</span></div><button onClick={() => onApplyPack(pack)}><Play size={14}/>Apply</button><button disabled={busy || Boolean(working)} className="danger-quiet" aria-label={`Delete topic pack ${pack.name}`} title={`Delete topic pack ${pack.name}`} onClick={() => void removePack(pack.id)}><Trash2 size={14}/></button></div>)}</div>
        </div>
      </div> : tab === 'privacy' ? <ContributorSettings profile={profile} busy={busy} onSave={async (patch) => { await onSave(patch); }}/> : <div className="doctor-body">
        <ProjectStoragePanel status={storageStatus} checking={storageChecking} error={storageError} onRecheck={onRecheckStorage}/>
        <div className="doctor-intro"><HeartPulse size={24}/><div><strong>System check</strong><span>Checks the app, media tools, caption timing, AI connection, and local storage. The report excludes your API key.</span></div><button className="primary" disabled={busy} onClick={onRunDoctor}>Run checks</button></div>
        {!doctor && <div className="modal-empty"><HeartPulse size={28}/><strong>No report yet</strong><span>Run checks after setup or if caption generation fails.</span></div>}
        {doctor && <>
          <div className={`doctor-summary doctor-${doctor.overall}`}><strong>{doctor.overall === 'ok' ? 'System checks passed' : doctor.overall === 'warning' ? 'Ready with warnings' : 'Setup needs attention'}</strong><span>{new Date(doctor.generatedAt).toLocaleString()} · {doctor.environment.platform} · Node {doctor.environment.node}</span><CopyReportButton label="Copy diagnostic report" text={JSON.stringify(doctor, null, 2)}/></div>
          <div className="doctor-checks">{doctor.checks.map((item) => <div className={`doctor-check check-${item.status}`} key={item.id}><i/>
            <div><strong>{item.label}</strong><span>{item.detail}</span>{item.fix && <em>{item.fix}</em>}</div>
          </div>)}</div>
        </>}
      </div>}
    </section>
  </div>;
}
