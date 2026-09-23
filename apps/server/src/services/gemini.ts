import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import type { TranscriptResult, TranscriptionContext } from '@kcs/shared';
import { config } from '../config.js';
import { resolveGeminiSettings, type ResolvedGeminiSettings } from './llm-settings.js';
import { prepareTimingLocally } from './local-timing.js';
import { currentProcessingRun } from './run-context.js';
import { readRunCheckpoint, writeRunCheckpoint } from './run-checkpoints.js';
import { canonicalizeVocabularyAliases, parseVocabulary, type VocabularyEntry } from './vocabulary.js';
import { GeminiRequestTimeoutError, withGeminiRequestTimeout } from './gemini-request-timeout.js';

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
  contextMode: 'full' | 'vocabulary-only' | 'audio-only';
  vocabularyTerms: string[];
}

interface PreparedGeminiAudio {
  ai: GoogleGenAI;
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

class GeminiGuidanceUnsupportedError extends Error {
  constructor(readonly model: string) {
    super(`${model} is transcription-only and cannot run this context-aware review pass. Choose a general Gemini model for Primary/Fallback in Settings.`);
    this.name = 'GeminiGuidanceUnsupportedError';
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

function longRequestTimeout(error: unknown) {
  return error instanceof GeminiRequestTimeoutError || statusFromError(error) === 504;
}

function rateLimitedGeminiError(error: unknown) {
  return statusFromError(error) === 429;
}

export function transcriptionRescueEligible(error: unknown) {
  const status = statusFromError(error);
  if (error instanceof GeminiRequestTimeoutError) return true;
  if (status === 408 || status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  return status == null && /temporar|unavailable|timeout|timed out|overload|connection|network|fetch failed/.test(deepErrorText(error));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type InteractionResult = { outputText: string; nativeVocabularyBias: boolean };

function thinkingGenerationConfig(model: string) {
  return /^gemini-(?:3(?:\.|-|$)|2\.5(?:-|$))/i.test(model)
    ? { thinking_level: config.geminiTranscriptionThinkingLevel }
    : undefined;
}

function dedicatedTranscriptionModel(model: string) {
  return /^gemini-3\.5-transcribe(?:$|-)/i.test(model.trim());
}

export async function makePromptOnlyInteraction(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
): Promise<InteractionResult> {
  const generationConfig = thinkingGenerationConfig(model);
  return withGeminiRequestTimeout(config.geminiRequestTimeoutMs, async (signal) => {
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
    } as never, {
      // Interactions SDK 2.22 retries transient failures four times by default.
      // Studio already owns the retry/backoff + model-fallback policy, so nested
      // SDK retries make one visible attempt fan out into several hidden requests.
      maxRetries: 0,
      // Tie the SDK transport to Studio's request deadline so a timed-out call
      // cannot continue retrying in the background while the next attempt starts.
      fetchOptions: { signal },
    });
    return { outputText: interaction.output_text || '', nativeVocabularyBias: false };
  });
}

export async function makeTranscriptionRescueInteraction(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  hints: string[],
): Promise<InteractionResult> {
  const customVocabulary = config.geminiNativeVocabularyBias ? hints.slice(0, 100) : [];
  return withGeminiRequestTimeout(config.geminiRequestTimeoutMs, async (signal) => {
    const interaction = await ai.interactions.create({
      model,
      store: false,
      input: [
        { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
      ],
      generation_config: {
        transcription_config: {
          language_codes: ['km-KH', 'en-US'],
          mode: { type: 'verbatim' },
          ...(customVocabulary.length ? { custom_vocabulary: customVocabulary } : {}),
        },
      },
    } as never, {
      maxRetries: 0,
      fetchOptions: { signal },
    });
    const outputText = interaction.output_text?.trim() || '';
    if (!outputText) throw new Error(`Gemini ${model} returned an empty transcription.`);
    return { outputText, nativeVocabularyBias: customVocabulary.length > 0 };
  });
}

function retryFailureLabel(error: unknown) {
  if (error instanceof GeminiRequestTimeoutError) {
    return `local request timeout after ${Math.round(error.timeoutMs / 1000)}s`;
  }
  const status = statusFromError(error);
  return status ? `HTTP ${status}` : 'transient error';
}

export async function createInteractionWithRetry(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
): Promise<{ outputText: string; attempts: number; nativeVocabularyBias: boolean }> {
  let lastError: unknown;
  const maxAttempts = config.geminiMaxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`[Gemini] ${model}: context-aware transcription attempt ${attempt}/${maxAttempts}`);
      const interaction = await makePromptOnlyInteraction(ai, model, uploaded, prompt);
      return { outputText: interaction.outputText, attempts: attempt, nativeVocabularyBias: false };
    } catch (error) {
      lastError = error;
      if (!transientGeminiError(error) || attempt >= maxAttempts) throw error;
      // A 504 (or Studio's own per-request deadline) already consumed the long
      // request budget. A 429 often carries a long Retry-After and is usually a
      // capacity/quota signal rather than a request-quality problem. In both cases
      // fail over immediately instead of spending minutes retrying the same model.
      if (longRequestTimeout(error) || rateLimitedGeminiError(error)) throw error;
      const exponent = Math.max(0, attempt - 1);
      const exponential = Math.min(config.geminiRetryMaxMs, config.geminiRetryBaseMs * 2 ** exponent);
      const serverDelay = retryAfterMs(error);
      const jitter = Math.floor(Math.random() * 751);
      const delayMs = serverDelay == null
        ? Math.min(config.geminiRetryMaxMs, exponential + jitter)
        : Math.max(serverDelay, exponential) + jitter;
      console.warn(`[Gemini] ${model}: ${retryFailureLabel(error)}. Retrying automatically in ${(delayMs / 1000).toFixed(1)}s...`);
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

export async function runModel(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  entries: VocabularyEntry[],
  guidance?: GeminiTranscriptionGuidance,
) {
  if (dedicatedTranscriptionModel(model)) {
    if (guidance) throw new GeminiGuidanceUnsupportedError(model);
    return runTranscriptionModel(ai, model, uploaded, entries, false);
  }
  const result = await createInteractionWithRetry(ai, model, uploaded, prompt);
  const transcript = parseTranscript(result.outputText, model);
  return { transcript, attempts: result.attempts, nativeVocabularyBias: result.nativeVocabularyBias, contextMode: 'full' as const };
}

async function runTranscriptionModel(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  entries: VocabularyEntry[],
  announceRescue: boolean,
) {
  const seen = new Set<string>();
  const hints: string[] = [];
  // Every active canonical term gets priority before aliases consume the
  // recommended 100-term speech-bias budget.
  for (const value of [
    ...entries.map((entry) => entry.canonical),
    ...entries.flatMap((entry) => entry.aliases),
  ]) {
    const term = value.trim();
    const key = term.toLocaleLowerCase('en');
    if (!term || seen.has(key)) continue;
    seen.add(key);
    hints.push(term);
    if (hints.length >= 100) break;
  }
  if (announceRescue) console.warn('[Gemini] Context-aware models are unavailable. Trying one transcription-only compatibility pass.');
  const result = await makeTranscriptionRescueInteraction(ai, model, uploaded, hints);
  return {
    transcript: { language: 'km-KH', fullText: result.outputText } satisfies Pick<TranscriptResult, 'language' | 'fullText'>,
    attempts: 1,
    nativeVocabularyBias: result.nativeVocabularyBias,
    contextMode: result.nativeVocabularyBias ? 'vocabulary-only' as const : 'audio-only' as const,
  };
}

async function runTranscriptionRescue(
  ai: GoogleGenAI,
  model: string,
  uploaded: { uri: string; mimeType: string },
  entries: VocabularyEntry[],
) {
  return runTranscriptionModel(ai, model, uploaded, entries, false);
}

function unavailableMessage(error: unknown, triedCompatibility: boolean) {
  if (rateLimitedGeminiError(error)) {
    return triedCompatibility
      ? 'Google is rate-limiting this Gemini key/project. Studio tried the configured context-aware models and one compatibility transcription pass. Your video and project are safe; use Resume in Activity when capacity returns.'
      : 'Google is rate-limiting this Gemini key/project. Studio stopped instead of waiting through repeated Retry-After delays. Your video and project are safe; use Resume in Activity when capacity returns.';
  }
  return triedCompatibility
    ? 'Gemini is temporarily unavailable. Studio tried the context-aware caption models and one compatibility transcription pass. Your video and project are safe; use Resume in Activity when the service recovers.'
    : 'Gemini is temporarily unavailable. Your video and project are safe; use Resume in Activity when the service recovers.';
}

export async function runGeminiModelChain(
  ai: GoogleGenAI,
  uploaded: { uri: string; mimeType: string },
  prompt: string,
  entries: VocabularyEntry[],
  guidance: GeminiTranscriptionGuidance | undefined,
  llm: Pick<ResolvedGeminiSettings, 'model' | 'fallbackModel'>,
): Promise<GeminiTranscript> {
  const finish = (
    raw: Pick<TranscriptResult, 'language' | 'fullText'>,
    model: string,
    fallbackUsed: boolean,
    attempts: number,
    nativeVocabularyBias: boolean,
    contextMode: GeminiTranscript['contextMode'] = 'full',
  ): GeminiTranscript => {
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
      contextMode,
      vocabularyTerms: entries.map((entry) => entry.canonical),
    };
  };

  const rescueModel = config.geminiTranscriptionRescueModel.trim();
  const runCompatibilityRescue = async (sourceModel: string, sourceError: unknown) => {
    console.warn(`[Gemini] ${sourceModel}: ${retryFailureLabel(sourceError)}. Trying one transcription-only compatibility pass.`);
    try {
      const rescue = await runTranscriptionRescue(ai, rescueModel, uploaded, entries);
      const value = finish(
        rescue.transcript,
        rescueModel,
        true,
        rescue.attempts,
        rescue.nativeVocabularyBias,
        rescue.contextMode,
      );
      console.warn('[Gemini] Compatibility transcription succeeded. Topic description was not applied to this rescue pass.');
      return value;
    } catch (rescueError) {
      if (transientGeminiError(rescueError)) {
        throw new GeminiUnavailableError(unavailableMessage(rescueError, true), rescueError);
      }
      throw rescueError;
    }
  };

  try {
    const primary = await runModel(ai, llm.model, uploaded, prompt, entries, guidance);
    return finish(primary.transcript, llm.model, false, primary.attempts, primary.nativeVocabularyBias, primary.contextMode);
  } catch (primaryError) {
    const fallback = llm.fallbackModel.trim();
    const primaryCanFailOver = transientGeminiError(primaryError) || primaryError instanceof GeminiGuidanceUnsupportedError;
    if (!fallback || fallback === llm.model || !primaryCanFailOver) {
      if (rateLimitedGeminiError(primaryError)) throw new GeminiUnavailableError(unavailableMessage(primaryError, false), primaryError);
      throw primaryError;
    }
    console.warn(`[Gemini] ${llm.model}: ${retryFailureLabel(primaryError)}. Trying configured fallback ${fallback}.`);
    try {
      const secondary = await runModel(ai, fallback, uploaded, prompt, entries, guidance);
      return finish(secondary.transcript, fallback, true, secondary.attempts, secondary.nativeVocabularyBias, secondary.contextMode);
    } catch (fallbackError) {
      const canRescue = !guidance
        && Boolean(rescueModel)
        && rescueModel !== llm.model
        && rescueModel !== fallback
        && transcriptionRescueEligible(fallbackError);
      if (canRescue) return runCompatibilityRescue(fallback, fallbackError);
      if (transientGeminiError(fallbackError)) {
        throw new GeminiUnavailableError(
          rateLimitedGeminiError(fallbackError)
            ? unavailableMessage(fallbackError, false)
            : `Gemini is temporarily unavailable. Studio tried ${llm.model} and ${fallback}. Your video and project are safe; use Resume in Activity when the service recovers.`,
          fallbackError,
        );
      }
      throw fallbackError;
    }
  }
}

function immutableAudioIdentity(audioPath: string, stat: Awaited<ReturnType<typeof fs.stat>>) {
  const inode = Number(stat.ino || 0);
  const device = Number(stat.dev || 0);
  const mtime = Number(stat.mtimeMs).toFixed(3);
  return inode
    ? `inode:${device}:${inode}:${stat.size}:${mtime}`
    : `path:${audioPath}:${stat.size}:${mtime}`;
}

async function preparedGeminiAudio(audioPath: string, llm: ResolvedGeminiSettings): Promise<PreparedGeminiAudio> {
  if (!llm.apiKey) throw new Error('Gemini is not configured yet. Open Settings → AI connection and add your API key.');
  const stat = await fs.stat(audioPath);
  const keyFingerprint = crypto.createHash('sha256').update(llm.apiKey).digest('hex').slice(0, 16);
  const cacheKey = `${immutableAudioIdentity(audioPath, stat)}:${keyFingerprint}`;
  const now = Date.now();
  for (const [key, entry] of preparedUploads) {
    if (entry.expiresAt <= now) preparedUploads.delete(key);
  }
  const cached = preparedUploads.get(cacheKey);
  if (cached) return cached.promise;

  const promise = (async () => {
    const ai = new GoogleGenAI({
      apiKey: llm.apiKey,
      httpOptions: { timeout: config.geminiRequestTimeoutMs },
    });
    const uploadedFile = await withGeminiRequestTimeout(config.geminiRequestTimeoutMs, (signal) => ai.files.upload({
      file: audioPath,
      config: {
        mimeType: 'audio/wav',
        abortSignal: signal,
      },
    }));
    if (!uploadedFile.uri || !uploadedFile.mimeType) throw new Error('Gemini audio upload did not return a usable URI.');
    return {
      ai,
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
  const audioIdentity = immutableAudioIdentity(audioPath, stat);
  const keyFingerprint = crypto.createHash('sha256').update(llm.apiKey).digest('hex').slice(0, 16);
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 'gemini-job-stage-v2',
    audioIdentity,
    context,
    guidance,
    primaryModel: llm.model,
    fallbackModel: llm.fallbackModel,
    transcriptionRescueModel: llm.fallbackModel.trim() ? config.geminiTranscriptionRescueModel : '',
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

  let prepared: PreparedGeminiAudio;
  try {
    prepared = await preparedGeminiAudio(audioPath, llm);
  } catch (error) {
    if (transientGeminiError(error)) {
      throw new GeminiUnavailableError(
        rateLimitedGeminiError(error)
          ? unavailableMessage(error, false)
          : 'Gemini did not respond in time while preparing the audio. Your video and project are safe; use Resume in Activity when the service recovers.',
        error,
      );
    }
    throw error;
  }
  const { ai, uploaded } = prepared;
  const entries = parseVocabulary(context?.vocabulary);
  const prompt = buildPrompt(context, entries, guidance);

  const completed = await runGeminiModelChain(ai, uploaded, prompt, entries, guidance, llm);

  if (run) {
    await writeRunCheckpoint(run.projectId, run.runKey, checkpointStage, checkpointSignature, completed);
  }
  return completed;
}
