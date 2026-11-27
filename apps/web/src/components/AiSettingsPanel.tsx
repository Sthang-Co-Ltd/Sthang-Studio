import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Wifi,
} from 'lucide-react';
import type { LlmConnectionTest, LlmSettingsStatus, SaveLlmSettingsInput } from '../api';
import { useStudioConfirm } from './ConfirmationDialog';

type AiSettingsPanelProps = {
  settings: LlmSettingsStatus;
  onSave(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  onTest(input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest>;
} & ({ variant?: 'full'; onForget(): Promise<LlmSettingsStatus> }
  | { variant: 'inline'; onForget?: never });

export function AiSettingsPanel({ settings, onSave, onTest, onForget, variant = 'full' }: AiSettingsPanelProps) {
  const { locale, t } = useI18n();
  const inline = variant === 'inline';
  const keyLabelId = useId();
  const modelOptionsId = useId();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model);
  const [fallbackModel, setFallbackModel] = useState(settings.fallbackModel);
  const [showKey, setShowKey] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(settings.configured);
  const [working, setWorking] = useState<'save' | 'test' | 'forget' | 'paste' | ''>('');
  const [result, setResult] = useState<LlmConnectionTest | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const revisions = useRef({ key: 0, model: 0, fallback: 0 });
  const edited = useRef({ model: false, fallback: false });
  const lifetime = useRef(0);
  const pending = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const pasteButton = useRef<HTMLButtonElement>(null);
  const feedbackTrigger = useRef<HTMLButtonElement | null>(null);
  const { confirm, confirmationDialog } = useStudioConfirm();
  const pasteShortcut = navigator.platform.toLowerCase().includes('mac') ? 'Command+V' : 'Ctrl+V';
  useEffect(() => () => { lifetime.current++; }, []);
  useLayoutEffect(() => {
    const trigger = feedbackTrigger.current;
    if ((error || message || result) && trigger && document.activeElement === trigger) {
      trigger.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }, [error, message, result]);

  useEffect(() => {
    if (!edited.current.model) setModel(settings.model);
    if (!edited.current.fallback) setFallbackModel(settings.fallbackModel);
  }, [settings.model, settings.fallbackModel]);

  const resetFeedback = () => { feedbackTrigger.current = null; setError(''); setMessage(''); setResult(null); };

  const pasteKey = async () => {
    if (pending.current) return;
    pending.current = true;
    const owner = lifetime.current;
    const revision = revisions.current.key;
    setWorking('paste');
    resetFeedback();
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (lifetime.current !== owner || revisions.current.key !== revision) return;
      if (!value) setError(t('setup.ai.clipboardEmpty', { shortcut: pasteShortcut }));
      else {
        revisions.current.key++;
        setApiKey(value);
        setMessage(t('setup.ai.keyPasted'));
      }
    } catch {
      if (lifetime.current === owner && revisions.current.key === revision) {
        setError(t('setup.ai.clipboardUnavailable', { shortcut: pasteShortcut }));
        if (document.activeElement === pasteButton.current) keyInput.current?.focus();
      }
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const save = async (trigger: HTMLButtonElement) => {
    if (pending.current) return;
    resetFeedback();
    feedbackTrigger.current = trigger;
    if (!settings.configured && !apiKey.trim()) {
      setError(t('setup.ai.keyBeforeSaving'));
      return;
    }
    pending.current = true;
    const owner = lifetime.current;
    const submitted = { ...revisions.current };
    const currentDraft = () => Object.keys(submitted).every((field) => submitted[field as keyof typeof submitted] === revisions.current[field as keyof typeof submitted]);
    const input = { apiKey: apiKey.trim() || undefined, model: model.trim(), fallbackModel: fallbackModel.trim() };
    setWorking('save');
    try {
      const connection = await onTest({ apiKey: input.apiKey, model: input.model });
      if (lifetime.current !== owner) return;
      if (currentDraft()) setResult(connection);
      const updated = await onSave(input);
      if (lifetime.current !== owner) return;
      const unchanged = currentDraft();
      if (revisions.current.key === submitted.key) { setApiKey(''); setShowKey(false); }
      if (revisions.current.model === submitted.model) { edited.current.model = false; setModel(updated.model); }
      if (revisions.current.fallback === submitted.fallback) { edited.current.fallback = false; setFallbackModel(updated.fallbackModel); }
      setMessage(!unchanged ? t('setup.ai.earlierSaved') : updated.keySource === 'secure-store'
        ? t('setup.ai.securelySaved')
        : t('setup.ai.environmentActive'));
    } catch (reason) {
      if (lifetime.current === owner) setError(!currentDraft() ? t('setup.ai.earlierSaveFailed') : reason instanceof Error ? reason.message : t('setup.ai.saveFailed'));
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const test = async (trigger: HTMLButtonElement) => {
    if (pending.current) return;
    pending.current = true;
    const owner = lifetime.current;
    const revision = JSON.stringify(revisions.current);
    const current = () => lifetime.current === owner && JSON.stringify(revisions.current) === revision;
    resetFeedback();
    feedbackTrigger.current = trigger;
    setWorking('test');
    try {
      const next = await onTest({ apiKey: apiKey.trim() || undefined, model: model.trim() });
      if (current()) setResult(next);
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : t('setup.ai.testFailed'));
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const forget = async () => {
    if (!onForget || pending.current) return;
    pending.current = true;
    const owner = lifetime.current;
    const accepted = await confirm({ title: t('setup.ai.forgetTitle'), message: t('setup.ai.forgetMessage'), confirmLabel: t('setup.ai.forget'), tone: 'warning' });
    if (!accepted || lifetime.current !== owner) { pending.current = false; return; }
    keyInput.current?.focus({ preventScroll: true });
    keyInput.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    resetFeedback();
    setWorking('forget');
    try {
      const updated = await onForget();
      if (lifetime.current !== owner) return;
      setShowKey(false);
      setMessage(updated.configured
        ? t('setup.ai.environmentRestored')
        : t('setup.ai.removed'));
    } catch (reason) {
      if (lifetime.current === owner) setError(reason instanceof Error ? reason.message : t('setup.ai.forgetFailed'));
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const sourceLabel = settings.keySource === 'secure-store'
    ? settings.secureStorageLabel
    : settings.keySource === 'environment'
      ? t('setup.ai.environmentSource')
      : t('setup.ai.notConfigured');

  return <div className={inline ? 'first-run-ai' : 'ai-settings-body'}>
    {!inline &&
    <div className={`ai-connection-card ${settings.configured ? 'configured' : 'missing'}`}>
      <div className="ai-connection-icon">{settings.configured ? <CheckCircle2 size={22}/> : <KeyRound size={22}/>}</div>
      <div className="ai-connection-copy">
        <strong>{settings.configured ? t('setup.ai.keyAvailable') : t('setup.ai.connect')}</strong>
        <span data-server-text={settings.configured || undefined}>{settings.configured ? t('setup.ai.maskedKey', { key: String(settings.maskedKey), source: sourceLabel }) : t('setup.ai.canImport')}</span>
      </div>
    </div>}

    <div className={inline ? undefined : 'ai-settings-grid'}>
      <section className="ai-settings-section">
        <div className="ai-section-title"><div><strong>{t('setup.ai.keyHeading')}</strong>{!inline && <span>{t('setup.ai.privacy')}</span>}</div><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">{t('setup.ai.getKey')}{' '}<ExternalLink size={13}/></a></div>
        <label className="ai-key-field">
          <span id={keyLabelId}>{settings.configured ? t('setup.ai.replaceKey') : t('setup.ai.key')}</span>
          <div>
            <KeyRound size={16}/>
            <input
              ref={keyInput}
              aria-labelledby={keyLabelId}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => { revisions.current.key++; setApiKey(event.target.value); resetFeedback(); }}
              placeholder={settings.configured ? t('setup.ai.pasteNew') : t('setup.ai.pasteGemini')}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="button" aria-label={showKey ? t('setup.ai.hideKey') : t('setup.ai.showKey')} title={showKey ? t('setup.ai.hideKey') : t('setup.ai.showKey')} onClick={() => setShowKey((value) => !value)}>{inline ? (showKey ? t('setup.ai.hide') : t('setup.ai.show')) : showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
            <button ref={pasteButton} type="button" aria-label={t('setup.ai.pasteClipboard')} title={t('setup.ai.pasteClipboard')} aria-disabled={Boolean(working) || undefined} aria-busy={working === 'paste' || undefined} onClick={() => void pasteKey()}>{inline ? t('setup.ai.paste') : <ClipboardPaste size={15}/>}</button>
          </div>
        </label>
        <div className="secure-storage-note"><ShieldCheck size={16}/><div><strong data-server-text>{settings.secureStorageLabel}</strong>{!inline && <span>{settings.secureStorageAvailable ? t('setup.ai.secureStorage') : t('setup.ai.environmentHelp')}</span>}</div></div>
      </section>

      {!inline && <details className="ai-settings-section ai-model-settings" open={modelsOpen} onToggle={(event) => setModelsOpen(event.currentTarget.open)}>
        <summary>{t('setup.ai.models')}</summary>
        <div className="ai-model-grid">
          <label><span>{t('setup.ai.primary')}</span><input list={modelOptionsId} value={model} onChange={(event) => { revisions.current.model++; edited.current.model = true; setModel(event.target.value); resetFeedback(); }}/></label>
          <label><span>{t('setup.ai.fallback')} <em>{t('setup.ai.optional')}</em></span><input list={modelOptionsId} value={fallbackModel} onChange={(event) => { revisions.current.fallback++; edited.current.fallback = true; setFallbackModel(event.target.value); resetFeedback(); }} placeholder={t('setup.ai.disableFallback')}/></label>
          <datalist id={modelOptionsId}><option value="gemini-3.8-flash"/><option value="gemini-4-hydrogen"/><option value="gemini-3.6-flash"/></datalist>
        </div>
        <details className="ai-model-help"><summary>{t('setup.ai.aboutModels')}</summary><p>{t('setup.ai.modelHelp')}</p></details>
      </details>}
    </div>

    {result && <div className={`ai-test-result ${result.level}`} role="status">
      {result.level === 'success' ? <CheckCircle2 size={17}/> : <TriangleAlert size={17}/>}<div><strong>{result.level === 'success' ? t('setup.ai.testSuccess') : t('setup.ai.testWarning')}</strong><span>{t('setup.ai.testResult', { message: result.message, latency: result.latencyMs })}</span></div>
    </div>}
    {message && <div className="ai-inline-message success" role="status"><CheckCircle2 size={15}/><span>{message}</span></div>}
    {error && <div className="ai-inline-message error" role="alert"><TriangleAlert size={15}/><span>{error}</span></div>}

    <div className="ai-settings-actions">
      {!inline && <>
      {settings.canForgetSecureKey && <button className="danger-quiet" aria-disabled={Boolean(working) || undefined} aria-busy={working === 'forget' || undefined} onClick={() => void forget()}>{working === 'forget' ? <LoaderCircle className="spin" size={15}/> : <Trash2 size={15}/>}{t('setup.ai.forget')}</button>}
      <span>{settings.updatedAt ? t('setup.ai.lastSaved', { date: formatInterfaceDate(locale, settings.updatedAt, { time: true }) }) : t('setup.ai.neverSaved')}</span>
      <button disabled={!settings.configured && !apiKey.trim()} aria-disabled={Boolean(working) || undefined} aria-busy={working === 'test' || undefined} onClick={(event) => void test(event.currentTarget)}>{working === 'test' ? <LoaderCircle className="spin" size={15}/> : <Wifi size={15}/>}{t('setup.ai.testConnection')}</button>
      </>}
      <button className="primary" disabled={!settings.configured && !apiKey.trim()} aria-disabled={Boolean(working) || undefined} aria-busy={working === 'save' || undefined} onClick={(event) => void save(event.currentTarget)}>{working === 'save' ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}{t('setup.ai.testAndSave')}</button>
    </div>
    {confirmationDialog}
  </div>;
}
