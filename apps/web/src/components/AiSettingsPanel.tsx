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
      if (!value) setError(`Clipboard is empty. Copy your key, then paste it into the API key field with ${pasteShortcut}.`);
      else {
        revisions.current.key++;
        setApiKey(value);
        setMessage('API key pasted. Test or save your settings.');
      }
    } catch {
      if (lifetime.current === owner && revisions.current.key === revision) {
        setError(`Clipboard access is unavailable. Paste your key into the API key field with ${pasteShortcut}.`);
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
      setError('Paste a Gemini API key before saving.');
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
      setMessage(!unchanged ? 'Earlier AI settings saved. Your newer edits are still unsaved.' : updated.keySource === 'secure-store'
        ? 'AI settings saved securely on this computer. No restart needed.'
        : 'Model settings saved. The environment key remains active.');
    } catch (reason) {
      if (lifetime.current === owner) setError(!currentDraft() ? 'The earlier save failed. Your current entries are kept; try again.' : reason instanceof Error ? reason.message : 'Could not verify and save AI settings. Your entries are kept; try again.');
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
      if (current()) setError(reason instanceof Error ? reason.message : 'Gemini connection test failed.');
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const forget = async () => {
    if (!onForget || pending.current) return;
    pending.current = true;
    const owner = lifetime.current;
    const accepted = await confirm({ title: 'Forget saved key?', message: 'Remove the API key saved by Studio on this computer. Your Google AI Studio key itself will not be deleted, and any typed replacement stays in this form.', confirmLabel: 'Forget saved key', tone: 'warning' });
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
        ? 'Saved key removed. Studio now uses the environment key.'
        : 'Saved key removed. Add another key to generate captions.');
    } catch (reason) {
      if (lifetime.current === owner) setError(reason instanceof Error ? reason.message : 'Could not forget the saved API key.');
    } finally {
      pending.current = false;
      if (lifetime.current === owner) setWorking('');
    }
  };

  const sourceLabel = settings.keySource === 'secure-store'
    ? settings.secureStorageLabel
    : settings.keySource === 'environment'
      ? 'apps/server/.env or environment'
      : 'No key configured';

  return <div className={inline ? 'first-run-ai' : 'ai-settings-body'}>
    {!inline &&
    <div className={`ai-connection-card ${settings.configured ? 'configured' : 'missing'}`}>
      <div className="ai-connection-icon">{settings.configured ? <CheckCircle2 size={22}/> : <KeyRound size={22}/>}</div>
      <div className="ai-connection-copy">
        <strong>{settings.configured ? 'Gemini key available' : 'Connect Gemini to generate captions'}</strong>
        <span>{settings.configured ? `${settings.maskedKey} · ${sourceLabel}` : 'You can import media and edit captions before connecting.'}</span>
      </div>
    </div>}

    <div className={inline ? undefined : 'ai-settings-grid'}>
      <section className="ai-settings-section">
        <div className="ai-section-title"><div><strong>Gemini API key</strong>{!inline && <span>The key stays behind Studio's local service and is never returned to your browser after saving.</span>}</div><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Get a key <ExternalLink size={13}/></a></div>
        <label className="ai-key-field">
          <span id={keyLabelId}>{settings.configured ? 'Replace current key' : 'API key'}</span>
          <div>
            <KeyRound size={16}/>
            <input
              ref={keyInput}
              aria-labelledby={keyLabelId}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => { revisions.current.key++; setApiKey(event.target.value); resetFeedback(); }}
              placeholder={settings.configured ? 'Paste new key' : 'Paste Gemini API key'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="button" aria-label={showKey ? 'Hide typed key' : 'Show typed key'} title={showKey ? 'Hide typed key' : 'Show typed key'} onClick={() => setShowKey((value) => !value)}>{inline ? (showKey ? 'Hide' : 'Show') : showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
            <button ref={pasteButton} type="button" aria-label="Paste from clipboard" title="Paste from clipboard" aria-disabled={Boolean(working) || undefined} aria-busy={working === 'paste' || undefined} onClick={() => void pasteKey()}>{inline ? 'Paste' : <ClipboardPaste size={15}/>}</button>
          </div>
        </label>
        <div className="secure-storage-note"><ShieldCheck size={16}/><div><strong>{settings.secureStorageLabel}</strong>{!inline && <span>{settings.secureStorageAvailable ? 'Your operating-system account protects the saved key. Profile exports exclude it.' : 'Set a server environment variable on this platform.'}</span>}</div></div>
      </section>

      {!inline && <details className="ai-settings-section ai-model-settings" open={modelsOpen} onToggle={(event) => setModelsOpen(event.currentTarget.open)}>
        <summary>Model settings</summary>
        <div className="ai-model-grid">
          <label><span>Primary model</span><input list={modelOptionsId} value={model} onChange={(event) => { revisions.current.model++; edited.current.model = true; setModel(event.target.value); resetFeedback(); }}/></label>
          <label><span>Fallback model <em>optional</em></span><input list={modelOptionsId} value={fallbackModel} onChange={(event) => { revisions.current.fallback++; edited.current.fallback = true; setFallbackModel(event.target.value); resetFeedback(); }} placeholder="Leave blank to disable"/></label>
          <datalist id={modelOptionsId}><option value="gemini-3.8-flash"/><option value="gemini-4-hydrogen"/><option value="gemini-3.6-flash"/></datalist>
        </div>
        <details className="ai-model-help"><summary>About these models</summary><p>Recommended: Gemini 3.8 Flash with 3.6 Flash as fallback. Gemini 4 Hydrogen is also an option. These caption models use low thinking. Google routes 3.7 Flash to 3.8, so it cannot serve as a separate fallback. The fallback uses the same key if the primary is temporarily unavailable. Leave the fallback blank to disable automatic failover. Gemini Transcribe is experimental and outside the automatic chain.</p></details>
      </details>}
    </div>

    {result && <div className={`ai-test-result ${result.level}`} role="status">
      {result.level === 'success' ? <CheckCircle2 size={17}/> : <TriangleAlert size={17}/>}<div><strong>{result.level === 'success' ? 'API key and model lookup checked' : 'Connection reached Google with a warning'}</strong><span>{result.message} · {result.latencyMs} ms</span></div>
    </div>}
    {message && <div className="ai-inline-message success" role="status"><CheckCircle2 size={15}/><span>{message}</span></div>}
    {error && <div className="ai-inline-message error" role="alert"><TriangleAlert size={15}/><span>{error}</span></div>}

    <div className="ai-settings-actions">
      {!inline && <>
      {settings.canForgetSecureKey && <button className="danger-quiet" aria-disabled={Boolean(working) || undefined} aria-busy={working === 'forget' || undefined} onClick={() => void forget()}>{working === 'forget' ? <LoaderCircle className="spin" size={15}/> : <Trash2 size={15}/>}Forget saved key</button>}
      <span>{settings.updatedAt ? `Last saved ${new Date(settings.updatedAt).toLocaleString()}` : 'No settings saved yet'}</span>
      <button disabled={!settings.configured && !apiKey.trim()} aria-disabled={Boolean(working) || undefined} aria-busy={working === 'test' || undefined} onClick={(event) => void test(event.currentTarget)}>{working === 'test' ? <LoaderCircle className="spin" size={15}/> : <Wifi size={15}/>}Test connection</button>
      </>}
      <button className="primary" disabled={!settings.configured && !apiKey.trim()} aria-disabled={Boolean(working) || undefined} aria-busy={working === 'save' || undefined} onClick={(event) => void save(event.currentTarget)}>{working === 'save' ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Test &amp; save</button>
    </div>
    {confirmationDialog}
  </div>;
}
