import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoogleGenAI } from '@google/genai';
import {
  createInteractionWithRetry,
  makePromptOnlyInteraction,
  makeTranscriptionRescueInteraction,
  runGeminiModelChain,
  runModel,
  transcriptionRescueEligible,
} from '../apps/server/src/services/gemini.ts';
import { parseVocabulary } from '../apps/server/src/services/vocabulary.ts';

test('prompt-only interaction disables hidden SDK retries and receives the Studio deadline signal', async () => {
  let requestOptions: Record<string, unknown> | undefined;
  const ai = {
    interactions: {
      create: async (_request: unknown, options?: Record<string, unknown>) => {
        requestOptions = options;
        return { output_text: '{"language":"km-KH","fullText":"សួស្តី"}' };
      },
    },
  } as unknown as GoogleGenAI;

  const result = await makePromptOnlyInteraction(
    ai,
    'gemini-3.7-flash',
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'Transcribe this audio.',
  );

  assert.equal(result.nativeVocabularyBias, false);
  assert.equal(requestOptions?.maxRetries, 0);
  const fetchOptions = requestOptions?.fetchOptions as { signal?: AbortSignal } | undefined;
  assert.ok(fetchOptions?.signal instanceof AbortSignal);
  assert.equal(fetchOptions.signal.aborted, false);
});

test('a 504 fast-fails the current context-aware model instead of consuming more long retries', async () => {
  let calls = 0;
  const ai = {
    interactions: {
      create: async () => {
        calls += 1;
        throw Object.assign(new Error('gateway timeout'), { status: 504 });
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    createInteractionWithRetry(
      ai,
      'gemini-3.7-flash',
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
    ),
    (error: unknown) => (error as { status?: number }).status === 504,
  );
  assert.equal(calls, 1);
});

test('a 429 fast-fails the current context-aware model and is eligible for transcription rescue', async () => {
  let calls = 0;
  const error = Object.assign(new Error('rate limited'), {
    status: 429,
    headers: { 'retry-after': '60' },
  });
  const ai = {
    interactions: {
      create: async () => {
        calls += 1;
        throw error;
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    createInteractionWithRetry(
      ai,
      'gemini-3.7-flash',
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
    ),
    (reason: unknown) => (reason as { status?: number }).status === 429,
  );
  assert.equal(calls, 1, '429 must not honor a long Retry-After on the same context-aware model');
  assert.equal(transcriptionRescueEligible(error), true);
});

test('full generation rate-limit chain is primary once, fallback once, then Transcribe once', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        const model = String(request.model || '');
        calls.push(model);
        if (model === 'gemini-3.7-flash' || model === 'gemini-3.6-flash') {
          throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '60' } });
        }
        if (model === 'gemini-3.5-transcribe') return { output_text: 'សួស្តី Sthang' };
        throw new Error(`Unexpected model ${model}`);
      },
    },
  } as unknown as GoogleGenAI;

  const result = await runGeminiModelChain(
    ai,
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'Transcribe this audio with topic context.',
    parseVocabulary(['Sthang']),
    undefined,
    { model: 'gemini-3.7-flash', fallbackModel: 'gemini-3.6-flash' },
  );

  assert.deepEqual(calls, ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-transcribe']);
  assert.equal(result.textModel, 'gemini-3.5-transcribe');
  assert.equal(result.contextMode, 'vocabulary-only');
});

test('blank fallback stops a 429 after the primary and does not run compatibility rescue', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        calls.push(String(request.model || ''));
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
      [],
      undefined,
      { model: 'gemini-3.7-flash', fallbackModel: '' },
    ),
    /Google is rate-limiting this Gemini key\/project/,
  );
  assert.deepEqual(calls, ['gemini-3.7-flash']);
});

test('guided review never falls through to Transcribe on 429', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        calls.push(String(request.model || ''));
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Review this candidate with context.',
      [],
      { variant: 'alternative', baselineText: 'baseline' },
      { model: 'gemini-3.7-flash', fallbackModel: 'gemini-3.6-flash' },
    ),
    /Google is rate-limiting this Gemini key\/project/,
  );
  assert.deepEqual(calls, ['gemini-3.7-flash', 'gemini-3.6-flash']);
});

test('Transcribe 429 is terminal after exactly three total model calls', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        calls.push(String(request.model || ''));
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
      [],
      undefined,
      { model: 'gemini-3.7-flash', fallbackModel: 'gemini-3.6-flash' },
    ),
    /Google is rate-limiting this Gemini key\/project/,
  );
  assert.deepEqual(calls, ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-transcribe']);
});

test('transcription rescue is one audio-only verbatim request with bounded protected vocabulary', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestOptions: Record<string, unknown> | undefined;
  const ai = {
    interactions: {
      create: async (request: Record<string, unknown>, options?: Record<string, unknown>) => {
        requestBody = request;
        requestOptions = options;
        return { output_text: 'សួស្តី OpenAI' };
      },
    },
  } as unknown as GoogleGenAI;
  const hints = Array.from({ length: 120 }, (_value, index) => `Term ${index + 1}`);

  const result = await makeTranscriptionRescueInteraction(
    ai,
    'gemini-3.5-transcribe',
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    hints,
  );

  assert.equal(result.outputText, 'សួស្តី OpenAI');
  assert.equal(requestBody?.model, 'gemini-3.5-transcribe');
  assert.equal(Object.hasOwn(requestBody || {}, 'system_instruction'), false);
  assert.equal(Object.hasOwn(requestBody || {}, 'response_format'), false);
  assert.deepEqual(requestBody?.input, [{ type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/wav' }]);
  const generationConfig = requestBody?.generation_config as { transcription_config?: Record<string, unknown> } | undefined;
  assert.deepEqual(generationConfig?.transcription_config?.language_codes, ['km-KH', 'en-US']);
  assert.deepEqual(generationConfig?.transcription_config?.mode, { type: 'verbatim' });
  const customVocabulary = generationConfig?.transcription_config?.custom_vocabulary as string[] | undefined;
  assert.equal(customVocabulary?.length, 100);
  assert.deepEqual(customVocabulary, hints.slice(0, 100));
  assert.equal(requestOptions?.maxRetries, 0);
  const fetchOptions = requestOptions?.fetchOptions as { signal?: AbortSignal } | undefined;
  assert.ok(fetchOptions?.signal instanceof AbortSignal);
});

test('a user-configured Gemini Transcribe model uses the dedicated audio-only adapter', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const ai = {
    interactions: {
      create: async (request: Record<string, unknown>) => {
        requestBody = request;
        return { output_text: 'សួស្តី Sthang' };
      },
    },
  } as unknown as GoogleGenAI;

  const result = await runModel(
    ai,
    'gemini-3.5-transcribe',
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'This general-model prompt must not be sent.',
    parseVocabulary(['Sthang']),
  );

  assert.equal(result.transcript.fullText, 'សួស្តី Sthang');
  assert.equal(result.contextMode, 'vocabulary-only');
  assert.deepEqual(requestBody?.input, [{ type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/wav' }]);
  assert.equal(Object.hasOwn(requestBody || {}, 'system_instruction'), false);
  assert.equal(Object.hasOwn(requestBody || {}, 'response_format'), false);
  const generationConfig = requestBody?.generation_config as { transcription_config?: Record<string, unknown> } | undefined;
  assert.deepEqual(generationConfig?.transcription_config?.mode, { type: 'verbatim' });
  assert.deepEqual(generationConfig?.transcription_config?.custom_vocabulary, ['Sthang']);
});

test('a transcription-only model cannot silently ignore guided review instructions', async () => {
  let calls = 0;
  const ai = {
    interactions: {
      create: async () => {
        calls += 1;
        return { output_text: 'unexpected' };
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    runModel(
      ai,
      'gemini-3.5-transcribe',
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Review this candidate with context.',
      parseVocabulary(['Sthang']),
      { variant: 'alternative', baselineText: 'សួស្តី' },
    ),
    /transcription-only and cannot run this context-aware review pass/,
  );
  assert.equal(calls, 0);
});
