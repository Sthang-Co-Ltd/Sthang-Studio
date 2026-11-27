import { useEffect, useRef, useState } from 'react';
import { isProfileImport } from '@kcs/shared';
import type { AppProfile, ProjectStorageStatus, SystemDoctorReport, TopicPack, TranscriptionContext } from '@kcs/shared';
import type { LlmConnectionTest, LlmSettingsStatus, SaveLlmSettingsInput } from '../api';
import { Download, FileUp, HeartPulse, KeyRound, PackagePlus, Play, Save, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { uniqueContextLines } from '../accuracy-context-draft';
import { CopyReportButton } from './CopyReportButton';
import { AiSettingsPanel } from './AiSettingsPanel';
import { useStudioConfirm } from './ConfirmationDialog';
import { ContributorSettings } from './ContributorSettings';
import { useModalFocus } from '../use-modal-focus';
import { useSurfacePresence } from '../use-surface-presence';
import { ProjectStoragePanel } from './ProjectStoragePanel';
import './contribution.css';
import { InterfaceLanguageField } from '../i18n/language-controls';
import { useI18n, type Locale } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { doctorCheckKey, doctorTimingFixKey } from '../i18n/messages/en/system';

export type SettingsTab = 'ai' | 'profile' | 'privacy' | 'doctor';

interface ProfileDoctorProps {
  languageSaving: boolean;
  onInterfaceLanguage(locale: Locale): void;
  open: boolean;
  initialTab: SettingsTab;
  llmSettings: LlmSettingsStatus | null;
  profile: AppProfile | null;
  aiLoadFailed: boolean;
  profileLoadFailed: boolean;
  onRetryLoad(): void;
  doctor: SystemDoctorReport | null;
  doctorLoadState: 'idle' | 'loading' | 'ready' | 'error';
  doctorError: string;
  doctorErrorIsServerText: boolean;
  busy: boolean;
  currentContext: TranscriptionContext | null;
  onClose(): void;
  onSave(patch: Partial<AppProfile>, feedback?: 'toast' | 'inline'): Promise<AppProfile | null>;
  onImport(profile: AppProfile): Promise<boolean>;
  onRunDoctor(): void;
  onApplyPack(pack: TopicPack): boolean;
  onSaveLlm(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  onTestLlm(input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest>;
  onForgetLlm(): Promise<LlmSettingsStatus>;
  storageStatus?: ProjectStorageStatus | null;
  storageChecking?: boolean;
  storageError?: string;
  onRecheckStorage?(): void;
}

export function ProfileDoctor({
  languageSaving,
  onInterfaceLanguage,
  open,
  initialTab,
  llmSettings,
  profile,
  aiLoadFailed,
  profileLoadFailed,
  onRetryLoad,
  doctor,
  doctorLoadState,
  doctorError,
  doctorErrorIsServerText,
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
  const { locale, t, tn, tr } = useI18n();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [glossary, setGlossary] = useState(profile?.defaultVocabulary.join('\n') || '');
  const [packName, setPackName] = useState('');
  const [working, setWorking] = useState<'glossary' | 'pack' | 'pack-delete' | 'import' | ''>('');
  const [glossaryFeedback, setGlossaryFeedback] = useState({ error: false, message: '' });
  const [packFeedback, setPackFeedback] = useState({ error: false, message: '' });
  const [packDeleteFeedback, setPackDeleteFeedback] = useState({ error: false, message: '' });
  const [importFeedback, setImportFeedback] = useState({ error: false, message: '' });
  const [retryImport, setRetryImport] = useState<File | null>(null);
  const glossaryEdited = useRef(false);
  const currentProfile = useRef(profile);
  currentProfile.current = profile;
  const glossaryRevision = useRef(0);
  const packRevision = useRef(0);
  const pending = useRef(false);
  const retryLoadPending = useRef(false);
  const mounted = useRef(true);
  const contextKey = useRef('');
  contextKey.current = JSON.stringify(currentContext);
  const importRef = useRef<HTMLInputElement | null>(null);
  const importButton = useRef<HTMLButtonElement | null>(null);
  const focusAppliedPack = useRef(false);
  const { confirm, confirmationDialog } = useStudioConfirm();
  const topicPacksHeading = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const presence = useSurfacePresence(open ? 'sheet' : null, dialog, 'sheet');
  useModalFocus(open, dialog, onClose, undefined, () => {
    if (!focusAppliedPack.current) return null;
    focusAppliedPack.current = false;
    return document.querySelector<HTMLElement>('.workspace-inspector:not([hidden]) #accuracy-context-description');
  });

  useEffect(() => { if (profile && !glossaryEdited.current) setGlossary(profile.defaultVocabulary.join('\n')); }, [profile?.defaultVocabulary]);
  const unavailableSection = tab === 'ai' ? !llmSettings : tab !== 'doctor' && !profile;
  const loadFailed = tab === 'ai' ? aiLoadFailed : profileLoadFailed;
  useEffect(() => { if (!loadFailed) retryLoadPending.current = false; }, [loadFailed]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  if (!presence.present) return null;
  const doctorLoading = doctorLoadState === 'loading';
  const doctorStale = doctorLoading || doctorLoadState === 'error';
  const doctorSummary = doctor?.overall === 'ok' ? t('system.overall.ok')
    : doctor?.overall === 'warning' ? t('system.overall.warning') : t('system.overall.error');

  const saveGlossary = async () => {
    if (pending.current || busy) return;
    const revision = glossaryRevision.current;
    const startingVocabulary = JSON.stringify(profile?.defaultVocabulary);
    const submitted = uniqueContextLines(glossary.split(/\r?\n/));
    pending.current = true; setWorking('glossary'); setGlossaryFeedback({ error: false, message: '' });
    try {
      const saved = await onSave({ defaultVocabulary: submitted }, 'inline');
      if (!mounted.current) return;
      if (!saved) throw new Error('save');
      if (JSON.stringify(uniqueContextLines(saved.defaultVocabulary)) !== JSON.stringify(submitted)) {
        setGlossaryFeedback({ error: true, message: t('settings.glossary.truncated') });
        return;
      }
      if (glossaryRevision.current === revision) {
        const latest = currentProfile.current?.defaultVocabulary;
        const newerAcknowledgement = latest && JSON.stringify(latest) !== startingVocabulary
          && JSON.stringify(latest) !== JSON.stringify(saved.defaultVocabulary);
        glossaryEdited.current = false;
        setGlossary((newerAcknowledgement ? latest : saved.defaultVocabulary).join('\n'));
        setGlossaryFeedback({ error: false, message: newerAcknowledgement
          ? t('settings.glossary.newerChoices')
          : t('settings.glossary.saved') });
      } else setGlossaryFeedback({ error: false, message: t('settings.glossary.newerDraft') });
    } catch { if (mounted.current) setGlossaryFeedback({ error: true, message: t('settings.glossary.failed') }); }
    finally { pending.current = false; if (mounted.current) setWorking(''); }
  };
  const createPack = async () => {
    if (!profile || !currentContext || !packName.trim() || pending.current || busy) return;
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
    setPackDeleteFeedback({ error: false, message: '' });
    try {
      const saved = await onSave({ topicPacks: [...profile.topicPacks, pack] }, 'inline');
      if (!mounted.current) return;
      const accepted = saved?.topicPacks.find((item) => item.id === pack.id);
      if (!accepted || accepted.name !== pack.name || accepted.description !== pack.description.trim()
        || JSON.stringify(uniqueContextLines(accepted.vocabulary)) !== JSON.stringify(uniqueContextLines(pack.vocabulary))) throw new Error('save');
      if (packRevision.current === revision && contextKey.current === submittedContext) {
        setPackName(''); setPackFeedback({ error: false, message: t('settings.packs.saved', { name: accepted.name }) });
      }
    } catch { if (mounted.current) setPackFeedback({ error: true, message: t('settings.packs.failed', { name: pack.name }) }); }
    finally { pending.current = false; if (mounted.current) setWorking(''); }
  };
  const removePack = async (id: string, button: HTMLButtonElement) => {
    if (!profile || pending.current || busy) return;
    const pack = profile.topicPacks.find((item) => item.id === id);
    if (!pack) return;
    pending.current = true;
    // Move only the activating control's focus before that row can disappear.
    if (document.activeElement === button) {
      topicPacksHeading.current?.focus({ preventScroll: true });
      topicPacksHeading.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    }
    setWorking('pack-delete');
    setPackFeedback({ error: false, message: '' });
    setPackDeleteFeedback({ error: false, message: t('settings.packs.deleting', { name: pack.name }) });
    try {
      const saved = await onSave({ topicPacks: profile.topicPacks.filter((item) => item.id !== id) }, 'inline');
      if (!mounted.current) return;
      if (!saved || saved.topicPacks.some((item) => item.id === id)) throw new Error('delete');
      setPackDeleteFeedback({ error: false, message: t('settings.packs.deleted', { name: pack.name }) });
    } catch {
      if (mounted.current) setPackDeleteFeedback({ error: true, message: t('settings.packs.deleteFailed', { name: pack.name }) });
    } finally {
      pending.current = false;
      if (mounted.current) setWorking('');
    }
  };
  const importFile = async (file?: File, retryTrigger?: HTMLButtonElement) => {
    if (!file || pending.current || busy) return;
    pending.current = true;
    let parsed: AppProfile;
    try {
      const value = JSON.parse(await file.text());
      if (!isProfileImport(value)) throw new Error('invalid');
      parsed = value as AppProfile;
    } catch {
      setRetryImport(null);
      setImportFeedback({ error: true, message: t('settings.profileImport.invalid') });
      pending.current = false; return;
    }
    try {
      if (!mounted.current || !importRef.current?.closest('[aria-modal="true"]')) return;
      if (file !== retryImport && !await confirm({
        title: t('settings.profileImport.confirmTitle'),
        message: t('settings.profileImport.confirmMessage', { file: file.name }),
        confirmLabel: t('settings.profileImport.confirm'), cancelLabel: t('settings.profileImport.cancel'), tone: 'warning',
      })) return;
      if (!mounted.current || !importRef.current?.closest('[aria-modal="true"]')) return;
      if (retryTrigger && document.activeElement === retryTrigger) {
        importButton.current?.focus({ preventScroll: true });
        importButton.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
      setWorking('import'); setRetryImport(null); setImportFeedback({ error: false, message: '' });
      if (!await onImport(parsed)) throw new Error('import');
      if (mounted.current) setImportFeedback({ error: false, message: glossaryEdited.current ? t('settings.profileImport.savedWithDraft') : t('settings.profileImport.saved') });
    } catch {
      if (mounted.current) {
        setRetryImport(file);
        setImportFeedback({ error: true, message: t('settings.profileImport.failed') });
      }
    } finally { pending.current = false; if (mounted.current) setWorking(''); }
  };

  return <div className="modal-backdrop profile-settings-backdrop studio-sheet" data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined} onMouseDown={onClose}>
    <section ref={dialog} role="dialog" aria-modal={open || undefined} aria-labelledby="settings-title" tabIndex={-1} className="modal profile-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div><strong id="settings-title">{t('settings.title')}</strong></div>
        <button className="icon-btn" aria-label={t('settings.close')} onClick={onClose}><X size={18}/></button>
      </div>
      <div className="modal-tabs settings-tabs" role="group" aria-label={t('settings.sections')}>
        <button aria-pressed={tab === 'ai'} className={tab === 'ai' ? 'selected' : ''} onClick={() => setTab('ai')}><KeyRound size={14}/>{t('settings.tabs.ai')}</button>
        <button aria-pressed={tab === 'profile'} className={tab === 'profile' ? 'selected' : ''} onClick={() => setTab('profile')}><UserRound size={14}/>{t('settings.tabs.profile')}</button>
        <button aria-pressed={tab === 'privacy'} className={tab === 'privacy' ? 'selected' : ''} onClick={() => setTab('privacy')}><ShieldCheck size={14}/>{t('settings.tabs.privacy')}</button>
        <button aria-pressed={tab === 'doctor'} className={tab === 'doctor' ? 'selected' : ''} onClick={() => setTab('doctor')}><HeartPulse size={14}/>{t('settings.tabs.doctor')}</button>
      </div>
      {unavailableSection && <div className="modal-empty settings-availability">
        <strong role={loadFailed ? 'alert' : 'status'}>{loadFailed ? t('settings.loadFailed') : t('settings.loading')}</strong>
        {loadFailed && <button type="button" onClick={() => {
          if (retryLoadPending.current) return;
          retryLoadPending.current = true;
          // Keep focus in the persistent shell when the retry button disappears.
          dialog.current?.focus({ preventScroll: true });
          onRetryLoad();
        }}>{t('settings.retry')}</button>}
      </div>}

      {tab === 'ai' && llmSettings && <AiSettingsPanel settings={llmSettings} onSave={onSaveLlm} onTest={onTestLlm} onForget={onForgetLlm}/>}
      {tab === 'profile' && profile && <div className="profile-body">
        <div className="profile-stats"><div><b>{profile.defaultVocabulary.length}</b><span>{t('settings.profile.keyTerms')}</span></div><div><b>{profile.correctionRules.length}</b><span>{t('settings.profile.rules')}</span></div><div><b>{profile.correctionEvents.length}</b><span>{t('settings.profile.events')}</span></div><div><b>{profile.topicPacks.length}</b><span>{t('settings.profile.packs')}</span></div></div>
        <label className="context-field"><span id="profile-glossary-label">{t('settings.glossary.label')}</span><textarea rows={9} value={glossary} aria-labelledby="profile-glossary-label" aria-describedby={glossaryFeedback.message ? 'profile-glossary-feedback' : undefined} onChange={(event) => { glossaryEdited.current = true; glossaryRevision.current++; setGlossary(event.target.value); setGlossaryFeedback({ error: false, message: '' }); }} placeholder={'CapCut | ខេបខាត់\nTikTok | តិកតុក\nបាយសាច់ជ្រូក\nសៀមរាប'}/></label>
        {glossaryFeedback.message && <p id="profile-glossary-feedback" className="profile-form-feedback" role={glossaryFeedback.error ? 'alert' : 'status'}>{glossaryFeedback.message}</p>}
        <div className="profile-actions"><button disabled={busy || Boolean(working)} aria-busy={working === 'glossary' || undefined} onClick={() => void saveGlossary()}><Save size={15}/>{working === 'glossary' ? t('settings.glossary.saving') : t('settings.glossary.save')}</button><a href="/api/profile/export" download><Download size={15}/>{t('settings.profileExport')}</a><button ref={importButton} aria-disabled={busy || Boolean(working) || undefined} aria-busy={working === 'import' || undefined} onClick={() => { if (!busy && !pending.current) importRef.current?.click(); }}><FileUp size={15}/>{working === 'import' ? t('settings.profileImport.importing') : t('settings.profileImport.open')}</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file); }}/></div>
        {importFeedback.message && <div className="profile-form-feedback profile-import-feedback" role={importFeedback.error ? 'alert' : 'status'}><span>{importFeedback.message}</span>{importFeedback.error && <>{retryImport && <button disabled={busy || Boolean(working)} onClick={(event) => void importFile(retryImport, event.currentTarget)}>{t('settings.profileImport.retry')}</button>}<button disabled={busy || Boolean(working)} onClick={() => importRef.current?.click()}>{t('settings.profileImport.chooseAnother')}</button></>}</div>}

        <div className="topic-pack-section">
          <div className="section-title"><div><strong ref={topicPacksHeading} className="topic-packs-heading" role="heading" aria-level={3} tabIndex={-1}>{t('settings.packs.title')}</strong><span>{t('settings.packs.description')}</span></div></div>
          {currentContext && <div className="pack-create"><label><span>{t('settings.packs.name')}</span><input aria-describedby={packFeedback.message ? 'profile-pack-feedback' : undefined} maxLength={80} value={packName} onChange={(event) => { packRevision.current++; setPackName(event.target.value); setPackFeedback({ error: false, message: '' }); }} placeholder={t('settings.packs.example')}/></label><button disabled={!packName.trim() || busy || Boolean(working)} aria-busy={working === 'pack' || undefined} onClick={() => void createPack()}><PackagePlus size={15}/>{working === 'pack' ? t('settings.packs.saving') : t('settings.packs.save')}</button></div>}
          {packFeedback.message && <p id="profile-pack-feedback" className="profile-form-feedback" role={packFeedback.error ? 'alert' : 'status'}>{packFeedback.message}</p>}
          {packDeleteFeedback.message && <p className="profile-form-feedback" role={packDeleteFeedback.error ? 'alert' : 'status'}>{packDeleteFeedback.message}</p>}
          {!currentContext && profile.topicPacks.length > 0 && <p id="profile-pack-apply-help" className="muted-copy">{t('settings.packs.openProject')}</p>}
          <div className="pack-list">{profile.topicPacks.length === 0 && <span className="muted-copy">{t('settings.packs.empty')}</span>}{profile.topicPacks.map((pack) => <div className="pack-card" key={pack.id}><div><strong>{pack.name}</strong><span>{tn('settings.packs.summary', pack.vocabulary.length, { description: pack.description || t('settings.packs.noDescription') })}</span></div><button disabled={!currentContext || busy || Boolean(working)} aria-label={t('settings.packs.applyLabel', { name: pack.name })} aria-describedby={!currentContext ? 'profile-pack-apply-help' : undefined} onClick={() => { focusAppliedPack.current = onApplyPack(pack); }}><Play size={14}/>{t('settings.packs.apply')}</button><button disabled={busy || Boolean(working)} className="danger-quiet" aria-label={t('settings.packs.deleteLabel', { name: pack.name })} title={t('settings.packs.deleteLabel', { name: pack.name })} onClick={(event) => void removePack(pack.id, event.currentTarget)}><Trash2 size={14}/></button></div>)}</div>
        </div>
        <InterfaceLanguageField saving={languageSaving} onChange={onInterfaceLanguage}/>
      </div>}
      {tab === 'privacy' && profile && <ContributorSettings profile={profile} busy={busy} onSave={(patch) => onSave(patch, 'inline')}/>}
      {tab === 'doctor' && <div className="doctor-body">
        <ProjectStoragePanel status={storageStatus} checking={storageChecking} error={storageError} onRecheck={onRecheckStorage}/>
        <div className="doctor-intro"><HeartPulse size={24}/><div><strong>{t('settings.tabs.doctor')}</strong><span>{t('system.description')}</span></div><button className="primary" aria-disabled={busy || doctorLoading || undefined} aria-busy={doctorLoading || undefined} aria-describedby={`system-check-status${doctorLoadState === 'error' ? ' system-check-error' : ''}`} onClick={() => { if (!busy && !doctorLoading) onRunDoctor(); }}>{doctorLoading ? t('system.running') : doctorLoadState === 'error' ? t('system.retry') : t('system.run')}</button></div>
        <p id="system-check-status" className="profile-form-feedback" role="status" aria-live="polite" aria-atomic="true">{doctorLoading ? (doctor ? t('system.checkingWithReport') : t('system.checking')) : doctorLoadState === 'ready' ? t('system.complete') : ''}</p>
        {doctorLoadState === 'error' && <p id="system-check-error" className="profile-form-feedback" role="alert">{tr(doctor ? 'system.failureWithReport' : 'system.failureWithoutReport', { error: doctorError || t('system.failure') },
          { b: (text) => <span data-server-text={Boolean(doctorError && doctorErrorIsServerText) || undefined}>{text}</span> })}</p>}
        {!doctor && doctorLoadState === 'idle' && <div className="modal-empty"><HeartPulse size={28}/><strong>{t('system.empty')}</strong><span>{t('system.help')}</span></div>}
        {doctor && <>
          <div className={`doctor-summary doctor-${doctor.overall}`}><strong>{doctorStale ? t('system.stale', { summary: doctorSummary }) : doctorSummary}</strong><span data-server-text>{t('system.environment', { date: formatInterfaceDate(locale, doctor.generatedAt, { time: true }), platform: doctor.environment.platform, node: doctor.environment.node })}</span><CopyReportButton label={t('system.copy')} text={JSON.stringify(doctor, null, 2)}/></div>
          <div className="doctor-checks">{doctor.checks.map((item) => {
            const labelKey = doctorCheckKey(item.id);
            const fixKey = doctorTimingFixKey(item.id, doctor.environment.platform, item.fix);
            return <div className={`doctor-check check-${item.status}`} key={item.id}><i/>
              <div><strong data-server-text={labelKey ? undefined : true}>{labelKey ? t(labelKey) : item.label}</strong><span data-server-text>{item.detail}</span>{item.fix && <em data-server-text={fixKey ? undefined : true}>{fixKey ? t(fixKey) : item.fix}</em>}</div>
            </div>;
          })}</div>
        </>}
      </div>}
      {confirmationDialog}
    </section>
  </div>;
}
