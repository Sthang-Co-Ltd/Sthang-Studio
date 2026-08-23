import { useEffect, useState } from 'react';
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

interface AiSettingsPanelProps {
  settings: LlmSettingsStatus;
  onSave(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  onTest(input: { apiKey?: string; model?: string }): Promise<LlmConnectionTest>;
  onForget(): Promise<LlmSettingsStatus>;
}

export function AiSettingsPanel({ settings, onSave, onTest, onForget }: AiSettingsPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model);
  const [fallbackModel, setFallbackModel] = useState(settings.fallbackModel);
  const [showKey, setShowKey] = useState(false);
  const [working, setWorking] = useState<'save' | 'test' | 'forget' | ''>('');
  const [result, setResult] = useState<LlmConnectionTest | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setModel(settings.model);
    setFallbackModel(settings.fallbackModel);
  }, [settings.model, settings.fallbackModel]);

  const resetFeedback = () => { setError(''); setMessage(''); setResult(null); };

  const pasteKey = async () => {
    resetFeedback();
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error('Clipboard is empty.');
      setApiKey(value);
      setMessage('API key pasted. Test it or save the settings.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Clipboard access was blocked. Use Ctrl+V inside the field.');
    }
  };

  const save = async () => {
    resetFeedback();
    if (!settings.configured && !apiKey.trim()) {
      setError('Paste a Gemini API key before saving.');
      return;
    }
    setWorking('save');
    try {
      const connection = await onTest({ apiKey: apiKey.trim() || undefined, model: model.trim() });
      setResult(connection);
      const updated = await onSave({
        apiKey: apiKey.trim() || undefined,
        model: model.trim(),
        fallbackModel: fallbackModel.trim(),
      });
      setApiKey('');
      setShowKey(false);
      setMessage(updated.keySource === 'secure-store'
        ? 'Connected and saved securely for this Windows user. No restart is needed.'
        : 'Connection verified and model settings saved. The environment key remains active.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not verify and save AI settings.');
    } finally {
      setWorking('');
    }
  };

  const test = async () => {
    resetFeedback();
    setWorking('test');
    try {
      const next = await onTest({ apiKey: apiKey.trim() || undefined, model: model.trim() });
      setResult(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Gemini connection test failed.');
    } finally {
      setWorking('');
    }
  };

  const forget = async () => {
    if (!window.confirm('Forget the API key saved by Sthang Studio on this Windows account? Your Google AI Studio key itself will not be deleted.')) return;
    resetFeedback();
    setWorking('forget');
    try {
      const updated = await onForget();
      setApiKey('');
      setMessage(updated.configured
        ? 'The securely saved key was removed. Sthang Studio is now using the environment key.'
        : 'The securely saved key was removed. Add another key before generating captions.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not forget the saved API key.');
    } finally {
      setWorking('');
    }
  };

  const sourceLabel = settings.keySource === 'secure-store'
    ? 'Windows protected storage'
    : settings.keySource === 'environment'
      ? 'apps/server/.env or environment'
      : 'No key configured';

  return <div className="ai-settings-body">
    <div className={`ai-connection-card ${settings.configured ? 'configured' : 'missing'}`}>
      <div className="ai-connection-icon">{settings.configured ? <CheckCircle2 size={22}/> : <KeyRound size={22}/>}</div>
      <div className="ai-connection-copy">
        <strong>{settings.configured ? 'Gemini is ready' : 'Connect Gemini to generate captions'}</strong>
        <span>{settings.configured ? `${settings.maskedKey} · ${sourceLabel}` : 'Paste your Gemini API key once. You will not need to edit an .env file.'}</span>
      </div>
      <div className={`ai-status-pill ${settings.configured ? 'ready' : 'setup'}`}>{settings.configured ? 'Connected' : 'Setup needed'}</div>
    </div>

    <div className="ai-settings-grid">
      <section className="ai-settings-section">
        <div className="ai-section-title"><div><strong>Gemini API key</strong><span>The key stays behind Sthang Studio’s local backend and is never returned to the browser after saving.</span></div><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Get a key <ExternalLink size={13}/></a></div>
        <label className="ai-key-field">
          <span>{settings.configured ? 'Replace current key' : 'API key'}</span>
          <div>
            <KeyRound size={16}/>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); resetFeedback(); }}
              placeholder={settings.configured ? `Current: ${settings.maskedKey} · paste only to replace` : 'Paste Gemini API key'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="button" title={showKey ? 'Hide typed key' : 'Show typed key'} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
            <button type="button" title="Paste from clipboard" onClick={() => void pasteKey()}><ClipboardPaste size={15}/></button>
          </div>
        </label>
        <div className="secure-storage-note"><ShieldCheck size={16}/><div><strong>{settings.secureStorageLabel}</strong><span>{settings.secureStorageAvailable ? 'The saved secret is tied to your Windows user account. Profile exports never include it.' : 'Use a server environment variable on this platform.'}</span></div></div>
      </section>

      <section className="ai-settings-section">
        <div className="ai-section-title"><div><strong>Models</strong><span>Keep the recommended defaults, or enter another Gemini model ID later without touching source files.</span></div></div>
        <div className="ai-model-grid">
          <label><span>Primary model</span><input list="gemini-model-options" value={model} onChange={(event) => { setModel(event.target.value); resetFeedback(); }}/></label>
          <label><span>Fallback model <em>optional</em></span><input list="gemini-model-options" value={fallbackModel} onChange={(event) => { setFallbackModel(event.target.value); resetFeedback(); }} placeholder="Leave blank to disable"/></label>
          <datalist id="gemini-model-options"><option value="gemini-3.7-flash"/><option value="gemini-3.6-flash"/></datalist>
        </div>
        <p className="ai-model-help">The fallback uses the same key and runs only when the primary model remains temporarily unavailable after automatic retries.</p>
      </section>
    </div>

    {result && <div className={`ai-test-result ${result.level}`}>
      {result.level === 'success' ? <CheckCircle2 size={17}/> : <TriangleAlert size={17}/>}<div><strong>{result.level === 'success' ? 'Connection verified' : 'Connection reached Google with a warning'}</strong><span>{result.message} · {result.latencyMs} ms</span></div>
    </div>}
    {message && <div className="ai-inline-message success"><CheckCircle2 size={15}/><span>{message}</span></div>}
    {error && <div className="ai-inline-message error"><TriangleAlert size={15}/><span>{error}</span></div>}

    <div className="ai-settings-actions">
      {settings.canForgetSecureKey && <button className="danger-quiet" disabled={!!working} onClick={() => void forget()}>{working === 'forget' ? <LoaderCircle className="spin" size={15}/> : <Trash2 size={15}/>}Forget saved key</button>}
      <span>{settings.updatedAt ? `Last saved ${new Date(settings.updatedAt).toLocaleString()}` : 'Not yet saved in the app'}</span>
      <button disabled={!!working || (!settings.configured && !apiKey.trim())} onClick={() => void test()}>{working === 'test' ? <LoaderCircle className="spin" size={15}/> : <Wifi size={15}/>}Test only</button>
      <button className="primary" disabled={!!working} onClick={() => void save()}>{working === 'save' ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save & connect</button>
    </div>
  </div>;
}
