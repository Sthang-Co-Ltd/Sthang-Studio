import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import type { TranscriptResult, TranscriptionContext } from '@kcs/shared';
import { config } from '../config.js';
import { resolveGeminiSettings, type ResolvedGeminiSettings } from './llm-settings.js';
import { prepareTimingLocally } from './local-timing.js';
import { currentProcessingRun } from './run-context.js';
import { readRunCheckpoint, writeRunCheckpoint } from './run-checkpoints.js';
import { canonicalizeVocabularyAliases, parseVocabulary, vocabularyHints, type VocabularyEntry } from './vocabulary.js';

const schema = {
  type: 'object',
  properties: {
    language: { type: 'string', description: 'Detected language, normally km-KH with possible English code-switching.' },
    fullText: { type: 'string', description: 'The complete verbatim transcript, preserving exactly what was said.' },
  },
  required: ['language', 'fullText']
};

export interface GeminiTranscriptionGuidance {
  /** The user-reviewed wording to preserve as a strong continuity baseline. */
  acceptedBaselineText?: string;
  /** A previous machine proposal. Useful for avoiding blind repetition on another take. */
  previousProposalText?: string;
  /** Optional user hint such as an exact proper noun, model number, or phrase. */
  accuracyHint?: string;
  /** Different listening instructions for independent/deep-verification passes. */
  variant?: 'standard' | 'alternative' | 'acoustic' | 'contextual';
  passNumber?: number;
}

const systemInstruction = `You are a high-fidelity Cambodian Khmer transcription engine for short-form video.
Your job is VERBATIM transcription, not rewriting.
- Never summarize, paraphrase, modernize, or replace a spoken entity with a more familiar entity.
- Use the WHOLE clip to infer its topic/domain before finalizing ambiguous names. Later context may clarify an earlier proper noun.
- Preserve Khmer as natural Khmer.
- Preserve English words, brands, product names, model names, version numbers, acronyms, and proper nouns in LATIN SCRIPT when they are spoken as those entities.
- Do not phonetically rewrite an English proper noun into Khmer merely because the surrounding sentence is Khmer.
- A protected vocabulary list is a recognition hint, not permission to invent words. Use a protected term only when acoustically/contextually plausible.
- When a protected term is spoken, reproduce its CANONICAL spelling exactly.
- Distinguish similar technology/product names. Never silently substitute a famous model/product for the one actually spoken.
- If an unfamiliar English proper noun is audible, preserve the best acoustically supported Latin-script spelling; do not 'correct' it into a better-known brand/model.
- Pay extra attention to acronyms, decimal/version numbers, model variants, person names, brand names, and short English words embedded in Khmer.
- Return only the requested response schema.`;

function buildPrompt(
  context: TranscriptionContext | undefined,
  entries: VocabularyEntry[],
  guidance: GeminiTranscriptionGuidance | undefined,
) {
  const parts = [
    'Listen to the normalized audio carefully and produce the most accurate verbatim transcript possible.',
    'The speaker is primarily Cambodian Khmer and may naturally code-switch into English.',
    'Do not create caption chunks and do not invent timestamps.',
  ];

  const variant = guidance?.variant || 'standard';
  if (variant === 'alternative') {
    parts.push('This is an independent second listen. Do not merely copy the previous proposal. Re-check ambiguous names, acronyms, numbers, and code-switched English directly against the audio.');
  } else if (variant === 'acoustic') {
    parts.push('Prioritize the acoustic evidence over familiarity. Be conservative: preserve unfamiliar syllables and exact numbers instead of replacing them with a famous or likely term.');
  } else if (variant === 'contextual') {
    parts.push('Use the whole clip and supplied topic context to resolve ambiguous proper nouns, while remaining verbatim and acoustically plausible.');
  }

  if (context?.description?.trim()) {
    parts.push(`\nVIDEO / TOPIC CONTEXT (use only to resolve ambiguous speech; do not add facts):\n${context.description.trim()}`);
  }
  if (entries.length) {
    const rows = entries.map((entry, i) => {
      const aliases = entry.aliases.length ? ` | possible spoken/transcribed aliases: ${entry.aliases.join(' ; ')}` : '';
      return `${i + 1}. CANONICAL: ${entry.canonical}${aliases}`;
    });
    parts.push(`\nPROTECTED VOCABULARY:\n${rows.join('\n')}\nIf the audio plausibly contains one of these terms, use the CANONICAL form exactly. Do not replace it with a different brand/model/name.`);
  }

  const hint = guidance?.accuracyHint?.trim();
  if (hint) {
    parts.push(`\nUSER ACCURACY HINT (high-value evidence; use only when acoustically plausible):\n${hint}`);
  }

  const baseline = guidance?.acceptedBaselineText?.trim();
  if (baseline) {
    parts.push(`\nUSER-ACCEPTED BASELINE — PASS ${Math.max(1, guidance?.passNumber || 1)}:\n${baseline}\nThe user has confirmed that this take contains useful/correct wording. Preserve its exact names, versions, Latin-script entities, and confirmed Khmer wording unless the audio clearly contradicts them. Improve only genuinely uncertain or unsupported parts. Do not regress confirmed terms.`);
  }

  const previous = guidance?.previousProposalText?.trim();
  if (previous && previous !== baseline) {
    parts.push(`\nPREVIOUS MACHINE PROPOSAL (not user-confirmed):\n${previous}\nUse it only as comparison evidence. Do not repeat it blindly; correct it when the audio or user hint supports a better reading.`);
  }

  return parts.join('\n');
}

type HeaderLike = { get?: (name: string) => string | null } | Record<string, unknown>;
type ErrorShape = {
  status?: number;
  statusCode?: number;
  headers?: HeaderLike;
  body?: string;
  rawResponse?: { status?: number; headers?: HeaderLike };
  error?: { httpMeta?: { response?: { status?: number; headers?: HeaderLike } }; error?: { message?: string } };
  cause?: {
    status?: number;
    statusCode?: number;
    headers?: HeaderLike;
    body?: string;
    rawResponse?: { status?: number; headers?: HeaderLike };
  };
  message?: string;
};

export interface GeminiTranscript {
  language: string;
  fullText: string;
  /** Pre-deterministic-alias transcript; useful as a KFA acoustic alignment target. */
  alignmentText: string;
  textModel: string;
  fallbackUsed: boolean;
  attempts: number;
  nativeVocabularyBias: boolean;
  vocabularyTerms: string[];
}

interface PreparedGeminiAudio {
  ai: GoogleGenAI;
  apiKey: string;
  uploaded: { uri: string; mimeType: string };
}

const uploadCacheTtlMs = 30 * 60 * 1000;
const maxPreparedUploads = 16;
const preparedUploads = new Map<string, { expiresAt: number; promise: Promise<PreparedGeminiAudio> }>();

export class GeminiUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

function errorShape(error: unknown): ErrorShape {
  return (error && typeof error === 'object' ? error : {}) as ErrorShape;
}

function statusFromError(error: unknown): number | undefined {
  const e = errorShape(error);
  return e.status ?? e.statusCode ?? e.rawResponse?.status ?? e.error?.httpMeta?.response?.status ?? e.cause?.status ?? e.cause?.statusCode ?? e.cause?.rawResponse?.status;
}

function deepErrorText(error: unknown) {
  const e = errorShape(error);
  return [e.message, e.body, e.cause?.body, e.error?.error?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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
  const e = errorShape(error);
  const candidates = [e.headers, e.rawResponse?.headers, e.error?.httpMeta?.response?.headers, e.cause?.headers, e.cause?.rawResponse?.headers];
  let raw: string | null = null;
  for (const headers of candidates) {
    raw = headerValue(headers, 'retry-after');
    if (raw) break;
  }
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function transientGeminiError(error: unknown): boolean {
  const status = statusFromError(error);
  if (status === 408 || status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  return /high demand|temporar|unavailable|resource[_ ]?exhausted|timeout|timed out|overload|try again/.test(deepErrorText(error));
}

function nativeVocabularyUnsupported(error: unknown) {
  const status = statusFromError(error);
  const text = deepErrorText(error);
  return status === 400 && /transcription[_ ]?config|custom[_ ]?vocabulary|language[_ ]?codes|unknown field|unsupported/.test(text);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

class GeminiRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Headers,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GeminiRestError';
  }
}

type InteractionResult = { outputText: string; nativeVocabularyBias: boolean };

function outputTextFromRestInteraction(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
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

function thinkingGenerationConfig(model: string) {
  return /^gemini-(?:3(?:\.|-|$)|2\.5(?:-|$))/i.test(model)
    ? { thinking_level: config.geminiTranscriptionThinkingLevel }
    : undefined;
}

async function makeNativeVocabularyInteraction(
  apiKey: string,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  hints: string[],
): Promise<InteractionResult> {
  const generationConfig = thinkingGenerationConfig(model);
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      store: false,
      system_instruction: systemInstruction,
      input: [
        { type: 'text', text: prompt },
        { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
      ],
      response_format: { type: 'text', mime_type: 'application/json', schema },
      ...(generationConfig ? { generation_config: generationConfig } : {}),
      transcription_config: {
        custom_vocabulary: hints,
        language_codes: ['km-KH', 'en-US'],
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    let message = `Gemini Interactions REST request failed with HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the HTTP fallback message.
    }
    throw new GeminiRestError(message, response.status, response.headers, body);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Gemini native-vocabulary REST response was not valid JSON.', { cause: error });
  }
  const outputText = outputTextFromRestInteraction(payload);
  if (!outputText) throw new Error('Gemini native-vocabulary REST response did not contain a model text output.');
  return { outputText, nativeVocabularyBias: true };
}

async function makePromptOnlyInteraction(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
): Promise<InteractionResult> {
  const generationConfig = thinkingGenerationConfig(model);
  const interaction = await ai.interactions.create({
    model,
    store: false,
    system_instruction: systemInstruction,
    input: [
      { type: 'text', text: prompt },
      { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema },
    ...(generationConfig ? { generation_config: generationConfig } : {}),
  } as never);
  return { outputText: interaction.output_text || '', nativeVocabularyBias: false };
}

async function makeInteraction(
  ai: GoogleGenAI,
  apiKey: string,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  hints: string[],
  enableNativeBias: boolean,
): Promise<InteractionResult> {
  if (enableNativeBias && hints.length) {
    return makeNativeVocabularyInteraction(apiKey, model, uploaded, prompt, hints);
  }
  return makePromptOnlyInteraction(ai, model, uploaded, prompt);
}

async function createInteractionWithRetry(
  ai: GoogleGenAI,
  apiKey: string,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  hints: string[],
): Promise<{ outputText: string; attempts: number; nativeVocabularyBias: boolean }> {
  let lastError: unknown;
  const maxAttempts = config.geminiMaxRetries + 1;
  let nativeBias = config.geminiNativeVocabularyBias && hints.length > 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`[Gemini] ${model}: context-aware transcription attempt ${attempt}/${maxAttempts}${nativeBias ? ` · ${hints.length} native vocabulary hints` : ''}`);
      try {
        const interaction = await makeInteraction(ai, apiKey, model, uploaded, prompt, hints, nativeBias);
        return { outputText: interaction.outputText, attempts: attempt, nativeVocabularyBias: interaction.nativeVocabularyBias };
      } catch (error) {
        if (nativeBias && nativeVocabularyUnsupported(error)) {
          console.warn('[Gemini] Native custom_vocabulary was not accepted for this request/model. Retrying this attempt with prompt-based vocabulary protection only.');
          nativeBias = false;
          const interaction = await makeInteraction(ai, apiKey, model, uploaded, prompt, hints, false);
          return { outputText: interaction.outputText, attempts: attempt, nativeVocabularyBias: false };
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      if (!transientGeminiError(error) || attempt >= maxAttempts) throw error;
      const exponent = Math.max(0, attempt - 1);
      const exponential = Math.min(config.geminiRetryMaxMs, config.geminiRetryBaseMs * 2 ** exponent);
      const serverDelay = retryAfterMs(error);
      const jitter = Math.floor(Math.random() * 751);
      const delayMs = serverDelay == null
        ? Math.min(config.geminiRetryMaxMs, exponential + jitter)
        : Math.max(serverDelay, exponential) + jitter;
      const statusLabel = status ? `HTTP ${status}` : 'transient error';
      console.warn(`[Gemini] ${model}: ${statusLabel}. Retrying automatically in ${(delayMs / 1000).toFixed(1)}s...`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function parseTranscript(outputText: string, model: string): Pick<TranscriptResult, 'language' | 'fullText'> {
  let parsed: { language?: string; fullText?: string };
  try {
    const cleaned = (outputText || '{}').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as { language?: string; fullText?: string };
  } catch (error) {
    throw new Error(`Gemini ${model} returned malformed transcript JSON.`, { cause: error });
  }
  const fullText = parsed.fullText?.trim();
  if (!fullText) throw new Error(`Gemini ${model} returned an empty transcript.`);
  return { language: parsed.language || 'km-KH', fullText };
}

async function runModel(
  ai: GoogleGenAI,
  apiKey: string,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  entries: VocabularyEntry[],
) {
  const hints = vocabularyHints(entries);
  const result = await createInteractionWithRetry(ai, apiKey, model, uploaded, prompt, hints);
  let transcript: Pick<TranscriptResult, 'language' | 'fullText'>;
  try {
    transcript = parseTranscript(result.outputText, model);
  } catch (error) {
    if (!result.nativeVocabularyBias) throw error;
    console.warn('[Gemini] Native vocabulary response did not match the expected JSON schema. Retrying once with prompt-only protection.');
    const plain = await makeInteraction(ai, apiKey, model, uploaded, prompt, hints, false);
    transcript = parseTranscript(plain.outputText, model);
    return { transcript, attempts: result.attempts + 1, nativeVocabularyBias: false };
  }
  return { transcript, attempts: result.attempts, nativeVocabularyBias: result.nativeVocabularyBias };
}

async function preparedGeminiAudio(audioPath: string, llm: ResolvedGeminiSettings): Promise<PreparedGeminiAudio> {
  if (!llm.apiKey) throw new Error('Gemini is not configured yet. Open Settings → AI connection and add your API key.');
  const stat = await fs.stat(audioPath);
  const keyFingerprint = crypto.createHash('sha256').update(llm.apiKey).digest('hex').slice(0, 16);
  const cacheKey = `${audioPath}:${stat.size}:${Math.round(stat.mtimeMs)}:${keyFingerprint}`;
  const now = Date.now();
  for (const [key, entry] of preparedUploads) {
    if (entry.expiresAt <= now) preparedUploads.delete(key);
  }
  const cached = preparedUploads.get(cacheKey);
  if (cached) return cached.promise;

  const promise = (async () => {
    const ai = new GoogleGenAI({ apiKey: llm.apiKey });
    const uploadedFile = await ai.files.upload({ file: audioPath, config: { mimeType: 'audio/wav' } });
    if (!uploadedFile.uri || !uploadedFile.mimeType) throw new Error('Gemini audio upload did not return a usable URI.');
    return {
      ai,
      apiKey: llm.apiKey,
      uploaded: { uri: uploadedFile.uri, mimeType: uploadedFile.mimeType },
    };
  })();

  preparedUploads.set(cacheKey, { expiresAt: now + uploadCacheTtlMs, promise });
  while (preparedUploads.size > maxPreparedUploads) {
    const oldest = preparedUploads.keys().next().value as string | undefined;
    if (!oldest) break;
    preparedUploads.delete(oldest);
  }
  promise.catch(() => {
    if (preparedUploads.get(cacheKey)?.promise === promise) preparedUploads.delete(cacheKey);
  });
  return promise;
}

async function geminiCheckpointSignature(
  audioPath: string,
  context: TranscriptionContext | undefined,
  guidance: GeminiTranscriptionGuidance | undefined,
  llm: ResolvedGeminiSettings,
) {
  const stat = await fs.stat(audioPath);
  const audioIdentity = Number(stat.ino || 0)
    ? `inode:${Number(stat.dev || 0)}:${Number(stat.ino)}:${stat.size}`
    : `path:${audioPath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  const keyFingerprint = crypto.createHash('sha256').update(llm.apiKey).digest('hex').slice(0, 16);
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 'gemini-job-stage-v1',
    audioIdentity,
    context,
    guidance,
    primaryModel: llm.model,
    fallbackModel: llm.fallbackModel,
    keyFingerprint,
    nativeVocabularyBias: config.geminiNativeVocabularyBias,
    thinkingLevel: config.geminiTranscriptionThinkingLevel,
  })).digest('hex').slice(0, 32);
}

function geminiCheckpointStage(guidance: GeminiTranscriptionGuidance | undefined) {
  return `gemini-${guidance?.variant || 'standard'}`;
}

export async function transcribeTextWithGemini(
  audioPath: string,
  context?: TranscriptionContext,
  guidance?: GeminiTranscriptionGuidance,
): Promise<GeminiTranscript> {
  const llm = await resolveGeminiSettings();
  if (!llm.apiKey) throw new Error('Gemini is not configured yet. Open Settings → AI connection and add your API key.');

  const run = currentProcessingRun();
  // Overlap transcript-independent local acoustic inference with the cloud listen.
  // The helper is fail-open; the later timing stage still retries normally if this
  // speculative preparation cannot be completed.
  if (run) void prepareTimingLocally(audioPath, run.projectId);

  const checkpointSignature = run
    ? await geminiCheckpointSignature(audioPath, context, guidance, llm)
    : '';
  const checkpointStage = geminiCheckpointStage(guidance);
  if (run) {
    const cached = await readRunCheckpoint<GeminiTranscript>(run.projectId, run.runKey, checkpointStage, checkpointSignature);
    if (cached) {
      console.log(`[Gemini] Resumed ${checkpointStage} from the current job checkpoint.`);
      return cached;
    }
  }

  const prepared = await preparedGeminiAudio(audioPath, llm);
  const { ai, uploaded } = prepared;
  const entries = parseVocabulary(context?.vocabulary);
  const prompt = buildPrompt(context, entries, guidance);

  const finish = (raw: Pick<TranscriptResult, 'language' | 'fullText'>, model: string, fallbackUsed: boolean, attempts: number, nativeVocabularyBias: boolean): GeminiTranscript => {
    const alignmentText = raw.fullText;
    const canonicalized = canonicalizeVocabularyAliases(raw.fullText, entries);
    if (canonicalized.replacements) console.log(`[Gemini] Applied ${canonicalized.replacements} user-owned vocabulary alias replacement(s) after transcription.`);
    return {
      language: raw.language,
      fullText: canonicalized.text,
      alignmentText,
      textModel: model,
      fallbackUsed,
      attempts,
      nativeVocabularyBias,
      vocabularyTerms: entries.map((entry) => entry.canonical),
    };
  };

  let completed: GeminiTranscript;
  try {
    const primary = await runModel(ai, prepared.apiKey, llm.model, uploaded, prompt, entries);
    completed = finish(primary.transcript, llm.model, false, primary.attempts, primary.nativeVocabularyBias);
  } catch (primaryError) {
    const fallback = llm.fallbackModel.trim();
    if (!fallback || fallback === llm.model || !transientGeminiError(primaryError)) throw primaryError;
    console.warn(`[Gemini] ${llm.model} remained unavailable after automatic retries. Falling back to ${fallback}.`);
    try {
      const secondary = await runModel(ai, prepared.apiKey, fallback, uploaded, prompt, entries);
      completed = finish(secondary.transcript, fallback, true, secondary.attempts, secondary.nativeVocabularyBias);
    } catch (fallbackError) {
      if (transientGeminiError(fallbackError)) {
        throw new GeminiUnavailableError(
          `Gemini is temporarily overloaded. The app retried ${llm.model} and also tried ${fallback}. Your video and project are safe; wait a minute and click Generate accurate captions again.`,
          fallbackError,
        );
      }
      throw fallbackError;
    }
  }

  if (run) {
    await writeRunCheckpoint(run.projectId, run.runKey, checkpointStage, checkpointSignature, completed);
  }
  return completed;
}
