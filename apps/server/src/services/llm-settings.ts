import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

export type LlmKeySource = 'secure-store' | 'environment' | 'none';

interface StoredLlmMetadata {
  version: 1;
  provider: 'gemini';
  model?: string;
  fallbackModel?: string;
  keyLast4?: string;
  updatedAt?: string;
}

export interface ResolvedGeminiSettings {
  provider: 'gemini';
  configured: boolean;
  apiKey: string;
  keySource: LlmKeySource;
  model: string;
  fallbackModel: string;
  secureStorageAvailable: boolean;
  secureStorageLabel: string;
  environmentFallbackAvailable: boolean;
}

export interface PublicLlmSettings {
  provider: 'gemini';
  configured: boolean;
  keySource: LlmKeySource;
  maskedKey: string | null;
  model: string;
  fallbackModel: string;
  secureStorageAvailable: boolean;
  secureStorageLabel: string;
  environmentFallbackAvailable: boolean;
  canForgetSecureKey: boolean;
  updatedAt: string | null;
}

export interface LlmConnectionTest {
  ok: boolean;
  level: 'success' | 'warning';
  provider: 'gemini';
  model: string;
  latencyMs: number;
  message: string;
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const settingsDir = process.platform === 'win32'
  ? path.join(localAppData, 'Sthang Studio')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sthang-studio');
const metadataFile = path.join(settingsDir, 'llm-settings.json');
const secretFile = path.join(settingsDir, 'gemini-key.dpapi');
const resolvedSettingsCacheTtlMs = 5 * 60 * 1000;
let resolvedSettingsCache: { value: ResolvedGeminiSettings; expiresAt: number } | null = null;

const encryptScript = [
  "$ErrorActionPreference='Stop'",
  '$plain=[Console]::In.ReadToEnd()',
  'if([string]::IsNullOrWhiteSpace($plain)){throw "API key is empty"}',
  '$secure=ConvertTo-SecureString $plain -AsPlainText -Force',
  '$encrypted=ConvertFrom-SecureString $secure',
  '[Console]::Out.Write($encrypted)',
].join(';');

const decryptScript = [
  "$ErrorActionPreference='Stop'",
  '$encrypted=[Console]::In.ReadToEnd()',
  '$secure=ConvertTo-SecureString $encrypted',
  '$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}',
].join(';');

function validConfiguredKey(value: string | undefined | null) {
  const key = value?.trim() || '';
  return key.length >= 20 && !/your_google_ai_studio_api_key_here/i.test(key);
}

function validateKeyInput(value: string) {
  const key = value.trim();
  if (key.length < 20) throw new Error('That API key looks too short. Paste the complete Gemini API key.');
  if (key.length > 512) throw new Error('That API key is unexpectedly long. Paste only the Gemini API key value.');
  if (/\s/.test(key)) throw new Error('The API key contains spaces or line breaks. Paste the key again without extra whitespace.');
  if (/your_google_ai_studio_api_key_here/i.test(key)) throw new Error('Replace the placeholder with a real Gemini API key.');
  return key;
}

function normalizeModel(value: unknown, fallback: string, allowEmpty = false) {
  if (value == null) return fallback;
  const model = String(value).trim();
  if (!model && allowEmpty) return '';
  if (!model) return fallback;
  if (model.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error('Model names may contain only letters, numbers, dots, underscores, colons, slashes and hyphens.');
  }
  return model.replace(/^models\//, '');
}

function maskKey(key: string) {
  const last = key.slice(-4);
  return `••••••••${last}`;
}

function invalidateResolvedSettingsCache() {
  resolvedSettingsCache = null;
}

async function readMetadata(): Promise<StoredLlmMetadata> {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as Partial<StoredLlmMetadata>;
    return {
      version: 1,
      provider: 'gemini',
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      fallbackModel: typeof parsed.fallbackModel === 'string' ? parsed.fallbackModel : undefined,
      keyLast4: typeof parsed.keyLast4 === 'string' ? parsed.keyLast4 : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.warn('[AI settings] Could not read local settings metadata:', error instanceof Error ? error.message : error);
    return { version: 1, provider: 'gemini' };
  }
}

async function writeMetadata(metadata: StoredLlmMetadata) {
  await fs.mkdir(settingsDir, { recursive: true });
  const temp = `${metadataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, metadataFile);
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Windows secure storage exited with code ${code}.`));
    });
    child.stdin.end(input);
  });
}

async function readSecureKey(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  let encrypted: string;
  try {
    encrypted = (await fs.readFile(secretFile, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!encrypted) return null;
  const decrypted = (await runPowerShell(decryptScript, encrypted)).trim();
  return validConfiguredKey(decrypted) ? decrypted : null;
}

async function writeSecureKey(apiKey: string) {
  if (process.platform !== 'win32') {
    throw new Error('Secure in-app API key storage is currently available on Windows. Use GEMINI_API_KEY in the server environment on this platform.');
  }
  const key = validateKeyInput(apiKey);
  const encrypted = await runPowerShell(encryptScript, key);
  if (!encrypted) throw new Error('Windows returned an empty encrypted secret. The API key was not saved.');
  await fs.mkdir(settingsDir, { recursive: true });
  const temp = `${secretFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, encrypted, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, secretFile);
}

export async function resolveGeminiSettings(): Promise<ResolvedGeminiSettings> {
  const cached = resolvedSettingsCache;
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value };

  const metadata = await readMetadata();
  let secureKey: string | null = null;
  try {
    secureKey = await readSecureKey();
  } catch (error) {
    console.warn('[AI settings] Windows could not decrypt the saved Gemini key. Falling back to GEMINI_API_KEY if available:', error instanceof Error ? error.message : error);
  }
  const environmentKey = validConfiguredKey(config.geminiApiKey) ? config.geminiApiKey.trim() : '';
  const apiKey = secureKey || environmentKey;
  const resolved: ResolvedGeminiSettings = {
    provider: 'gemini',
    configured: Boolean(apiKey),
    apiKey,
    keySource: secureKey ? 'secure-store' : environmentKey ? 'environment' : 'none',
    model: normalizeModel(metadata.model, config.geminiModel),
    fallbackModel: normalizeModel(metadata.fallbackModel, config.geminiFallbackModel, true),
    secureStorageAvailable: process.platform === 'win32',
    secureStorageLabel: process.platform === 'win32'
      ? 'Windows user-protected storage (DPAPI)'
      : 'Environment variable only on this platform',
    environmentFallbackAvailable: Boolean(environmentKey),
  };
  resolvedSettingsCache = { value: resolved, expiresAt: Date.now() + resolvedSettingsCacheTtlMs };
  return { ...resolved };
}

export async function publicLlmSettings(): Promise<PublicLlmSettings> {
  const metadata = await readMetadata();
  const resolved = await resolveGeminiSettings();
  return {
    provider: 'gemini',
    configured: resolved.configured,
    keySource: resolved.keySource,
    maskedKey: resolved.configured ? maskKey(resolved.apiKey) : null,
    model: resolved.model,
    fallbackModel: resolved.fallbackModel,
    secureStorageAvailable: resolved.secureStorageAvailable,
    secureStorageLabel: resolved.secureStorageLabel,
    environmentFallbackAvailable: resolved.environmentFallbackAvailable,
    canForgetSecureKey: resolved.keySource === 'secure-store',
    updatedAt: metadata.updatedAt || null,
  };
}

export async function saveLlmSettings(input: { apiKey?: unknown; model?: unknown; fallbackModel?: unknown }): Promise<PublicLlmSettings> {
  const current = await readMetadata();
  const model = normalizeModel(input.model, current.model || config.geminiModel);
  const fallbackModel = normalizeModel(input.fallbackModel, current.fallbackModel ?? config.geminiFallbackModel, true);
  let keyLast4 = current.keyLast4;
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const key = validateKeyInput(input.apiKey);
    await writeSecureKey(key);
    keyLast4 = key.slice(-4);
  }
  await writeMetadata({
    version: 1,
    provider: 'gemini',
    model,
    fallbackModel,
    keyLast4,
    updatedAt: new Date().toISOString(),
  });
  invalidateResolvedSettingsCache();
  return publicLlmSettings();
}

export async function forgetSecureGeminiKey(): Promise<PublicLlmSettings> {
  if (process.platform === 'win32') await fs.rm(secretFile, { force: true });
  const metadata = await readMetadata();
  await writeMetadata({ ...metadata, keyLast4: undefined, updatedAt: new Date().toISOString() });
  invalidateResolvedSettingsCache();
  return publicLlmSettings();
}

function redactSecret(value: string, secret: string) {
  let redacted = value;
  if (secret) redacted = redacted.split(secret).join('[key hidden]');
  return redacted.replace(/AIza[\w-]{20,}/g, '[key hidden]');
}

function friendlyGeminiError(status: number, body: string, secret = '') {
  let message = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    message = redactSecret(parsed.error?.message || '', secret);
  } catch {
    // Keep the status-specific fallback below.
  }
  if (status === 400 || status === 401 || status === 403) {
    return message || 'Google rejected this API key. Check that it is a Gemini API key and that it has not been revoked or blocked.';
  }
  if (status === 404) return message || 'The selected Gemini model was not found for this API key.';
  if (status === 429) return message || 'The key is recognized, but Google is currently rate-limiting requests for this project.';
  if (status >= 500) return message || 'Google is temporarily unavailable. The key may still be valid; try the test again shortly.';
  return message || `Gemini connection test failed with HTTP ${status}.`;
}

export async function testGeminiConnection(input?: { apiKey?: unknown; model?: unknown }): Promise<LlmConnectionTest> {
  const resolved = await resolveGeminiSettings();
  const candidate = typeof input?.apiKey === 'string' && input.apiKey.trim()
    ? validateKeyInput(input.apiKey)
    : resolved.apiKey;
  if (!candidate) throw new Error('Add a Gemini API key before testing the connection.');
  const model = normalizeModel(input?.model, resolved.model);
  const started = Date.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
    method: 'GET',
    headers: { 'x-goog-api-key': candidate, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  const latencyMs = Date.now() - started;
  if (response.ok) {
    return {
      ok: true,
      level: 'success',
      provider: 'gemini',
      model,
      latencyMs,
      message: `Connected to Gemini. ${model} is available for this key.`,
    };
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      ok: true,
      level: 'warning',
      provider: 'gemini',
      model,
      latencyMs,
      message: friendlyGeminiError(response.status, body, candidate),
    };
  }
  throw new Error(friendlyGeminiError(response.status, body, candidate));
}
