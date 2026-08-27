import { config } from '../config.js';
import { vocabularyHints, type VocabularyEntry } from './vocabulary.js';

interface UploadedAudio {
  uri: string;
  mimeType: string;
}

interface DedicatedTranscriptResult {
  language: string;
  fullText: string;
  model: string;
  attempts: number;
  nativeVocabularyBias: boolean;
}

type HeaderLike = { get?: (name: string) => string | null } | Record<string, unknown>;
type ErrorShape = {
  status?: number;
  statusCode?: number;
  headers?: HeaderLike;
  body?: string;
  message?: string;
};

class GeminiTranscribeRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GeminiTranscribeRestError';
  }
}

function statusFromError(error: unknown): number | undefined {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorShape;
  return e.status ?? e.statusCode;
}

function errorText(error: unknown) {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorShape;
  return [e.message, e.body].filter(Boolean).join(' ').toLowerCase();
}

function headerValue(headers: HeaderLike | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value != null) return String(value);
  }
  return null;
}

function retryAfterMs(error: unknown): number | null {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorShape;
  const raw = headerValue(e.headers, 'retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function transientError(error: unknown) {
  const status = statusFromError(error);
  if (status === 408 || status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  return /high demand|temporar|unavailable|resource[_ ]?exhausted|timeout|timed out|overload|try again/.test(errorText(error));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function outputTextFromInteraction(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const steps = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return '';
  const chunks: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object' || (step as { type?: unknown }).type !== 'model_output') continue;
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string') {
        chunks.push((item as { text: string }).text);
      }
    }
  }
  return chunks.join('');
}

async function requestDedicatedTranscript(
  apiKey: string,
  uploaded: UploadedAudio,
  customVocabulary: string[],
) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: config.geminiTranscribeModel,
      store: false,
      input: [
        { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
      ],
      generation_config: {
        transcription_config: {
          language_codes: ['km-KH', 'en-US'],
          ...(customVocabulary.length ? { custom_vocabulary: customVocabulary } : {}),
          // Keep the primary ASR pass exact. Word timestamps are intentionally
          // omitted because Google documents an accuracy tradeoff when enabled;
          // Sthang Studio keeps KFA as the timing authority.
          mode: { type: 'verbatim' },
        },
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    let message = `Gemini Transcribe request failed with HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the HTTP fallback message.
    }
    throw new GeminiTranscribeRestError(message, response.status, response.headers, body);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Gemini Transcribe response was not valid JSON.', { cause: error });
  }
  const outputText = outputTextFromInteraction(payload).trim();
  if (!outputText) throw new Error('Gemini Transcribe returned an empty transcript.');
  return outputText;
}

export async function transcribeWithDedicatedGemini(
  apiKey: string,
  uploaded: UploadedAudio,
  entries: VocabularyEntry[],
): Promise<DedicatedTranscriptResult> {
  // Google supports up to 1,000 terms but recommends a focused list (typically
  // up to 100) for best recognition quality. Sthang's context normalization also
  // caps user vocabulary entries at 100; aliases are trimmed here to the same
  // practical ASR budget.
  const customVocabulary = vocabularyHints(entries).slice(0, 100);
  const maxAttempts = config.geminiMaxRetries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`[Gemini Transcribe] ${config.geminiTranscribeModel}: verbatim acoustic pass ${attempt}/${maxAttempts}${customVocabulary.length ? ` · ${customVocabulary.length} vocabulary hints` : ''}`);
      const fullText = await requestDedicatedTranscript(apiKey, uploaded, customVocabulary);
      return {
        language: 'km-KH',
        fullText,
        model: config.geminiTranscribeModel,
        attempts: attempt,
        nativeVocabularyBias: customVocabulary.length > 0,
      };
    } catch (error) {
      lastError = error;
      if (!transientError(error) || attempt >= maxAttempts) throw error;
      const exponent = Math.max(0, attempt - 1);
      const exponential = Math.min(config.geminiRetryMaxMs, config.geminiRetryBaseMs * 2 ** exponent);
      const serverDelay = retryAfterMs(error);
      const jitter = Math.floor(Math.random() * 751);
      const delayMs = serverDelay == null
        ? Math.min(config.geminiRetryMaxMs, exponential + jitter)
        : Math.max(serverDelay, exponential) + jitter;
      console.warn(`[Gemini Transcribe] Temporary failure. Retrying automatically in ${(delayMs / 1000).toFixed(1)}s...`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
