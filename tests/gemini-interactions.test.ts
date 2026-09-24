import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoogleGenAI } from '@google/genai';
import { config } from '../apps/server/src/config.ts';
import {
  buildTranscriptionRecognitionHints,
  createInteractionWithRetry,
  GeminiLanguageMismatchError,
  implausibleEnglishOnlyKhmerRescue,
  inferTranscriptLanguageFromText,
  khmerTranscriptScriptIssue,
  makePromptOnlyInteraction,
  makeTranscriptionRescueInteraction,
  runGeminiModelChain,
  runModel,
  transcriptionRescueEligible,
} from '../apps/server/src/services/gemini.ts';
import { contextRecognitionHints, parseVocabulary } from '../apps/server/src/services/vocabulary.ts';

async function withExperimentalTranscribeRescue<T>(run: () => Promise<T>) {
  const previous = config.geminiTranscriptionRescueEnabled;
  config.geminiTranscriptionRescueEnabled = true;
  try {
    return await run();
  } finally {
    config.geminiTranscriptionRescueEnabled = previous;
  }
}

test('Accuracy description extracts only bounded exact recognition hints from user text', () => {
  const description = 'This video compares GPT 5.6 Luna and Terra. Preserve the exact model names.';
  const hints = contextRecognitionHints(description);
  assert.deepEqual(hints, ['GPT 5.6 Luna', 'Terra']);
  for (const hint of hints) assert.equal(description.includes(hint), true, `${hint} must be an exact user-authored substring`);
  assert.equal(hints.includes('This'), false);
  assert.equal(hints.includes('Preserve'), false);

  const quoted = 'The speaker mentions “សុខ ដារ៉ា” and `Claude Opus 5.5`.';
  assert.deepEqual(contextRecognitionHints(quoted).slice(0, 2), ['សុខ ដារ៉ា', 'Claude Opus 5.5']);
  assert.deepEqual(contextRecognitionHints('This video is about how people use software for work today.'), []);
});

test('Transcribe recognition hints prioritize all explicit canonicals and aliases before Accuracy-derived hints', () => {
  const entries = parseVocabulary([
    'Alpha | A1 | A2',
    'Beta | B1 | B2',
    'Gamma | G1 | G2',
  ]);
  const merged = buildTranscriptionRecognitionHints(entries, ['GPT 5.6 Luna', 'Terra'], 11);
  assert.deepEqual(merged.hints, ['Alpha', 'Beta', 'Gamma', 'A1', 'A2', 'B1', 'B2', 'G1', 'G2', 'GPT 5.6 Luna', 'Terra']);
  assert.equal(merged.descriptionHintsUsed, 2);

  const noRoom = buildTranscriptionRecognitionHints(entries, ['GPT 5.6 Luna'], 9);
  assert.deepEqual(noRoom.hints, ['Alpha', 'Beta', 'Gamma', 'A1', 'A2', 'B1', 'B2', 'G1', 'G2']);
  assert.equal(noRoom.descriptionHintsUsed, 0, 'derived hints must never evict explicit user-authored aliases');

  const deduped = buildTranscriptionRecognitionHints(parseVocabulary(['Terra']), ['Terra', 'GPT 5.6 Luna'], 100);
  assert.deepEqual(deduped.hints, ['Terra', 'GPT 5.6 Luna']);
  assert.equal(deduped.descriptionHintsUsed, 1);
});

test('prompt-only interaction disables hidden SDK retries and receives the Studio deadline signal', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestOptions: Record<string, unknown> | undefined;
  const ai = {
    interactions: {
      create: async (request: Record<string, unknown>, options?: Record<string, unknown>) => {
        requestBody = request;
        requestOptions = options;
        return { output_text: '{"language":"km-KH","fullText":"សួស្តី"}' };
      },
    },
  } as unknown as GoogleGenAI;

  const result = await makePromptOnlyInteraction(
    ai,
    'gemini-3.8-flash',
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'Transcribe this audio.',
  );

  assert.equal(result.nativeVocabularyBias, false);
  assert.equal(requestBody?.model, 'gemini-3.8-flash');
  assert.equal(typeof requestBody?.system_instruction, 'string');
  assert.deepEqual(requestBody?.input, [
    { type: 'text', text: 'Transcribe this audio.' },
    { type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/wav' },
  ]);
  assert.equal(Object.hasOwn(requestBody || {}, 'response_format'), true);
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

test('default full generation rate-limit chain stops after 3.8 then 3.7 without Transcribe', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: Record<string, unknown>) => {
        const model = String(request.model || '');
        calls.push(model);
        throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '60' } });
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio with topic context.',
      parseVocabulary(['Sthang']),
      undefined,
      { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.7-flash' },
      contextRecognitionHints('This video compares GPT 5.6 Luna and Terra. Preserve the exact model names.'),
    ),
    /Google is rate-limiting this Gemini key\/project/,
  );

  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash']);
});

test('experimental rescue opt-in runs one strict-Khmer Transcribe pass with Accuracy hints', async () => {
  const calls: string[] = [];
  let transcribeRequest: Record<string, unknown> | undefined;
  const ai = {
    interactions: {
      create: async (request: Record<string, unknown>) => {
        const model = String(request.model || '');
        calls.push(model);
        if (model === 'gemini-3.8-flash' || model === 'gemini-3.7-flash') {
          throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '60' } });
        }
        if (model === 'gemini-3.5-transcribe') {
          transcribeRequest = request;
          return { output_text: 'សួស្តី Sthang GPT 5.6 Luna Terra' };
        }
        throw new Error(`Unexpected model ${model}`);
      },
    },
  } as unknown as GoogleGenAI;

  const result = await withExperimentalTranscribeRescue(() => runGeminiModelChain(
    ai,
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'Transcribe this audio with topic context.',
    parseVocabulary(['Sthang']),
    undefined,
    { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.7-flash' },
    contextRecognitionHints('This video compares GPT 5.6 Luna and Terra. Preserve the exact model names.'),
  ));

  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-transcribe']);
  assert.equal(result.textModel, 'gemini-3.5-transcribe');
  assert.equal(result.contextMode, 'vocabulary-only');
  assert.equal(result.descriptionHintsUsed, 2);
  const generationConfig = transcribeRequest?.generation_config as { transcription_config?: Record<string, unknown> } | undefined;
  assert.deepEqual(generationConfig?.transcription_config?.language_codes, ['km-KH']);
  assert.deepEqual(generationConfig?.transcription_config?.custom_vocabulary, ['Sthang', 'GPT 5.6 Luna', 'Terra']);
  assert.equal(Object.hasOwn(transcribeRequest || {}, 'system_instruction'), false);
  assert.deepEqual(transcribeRequest?.input, [{ type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/wav' }]);
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

test('opted-in Transcribe 429 is terminal after exactly three total model calls', async () => {
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
    withExperimentalTranscribeRescue(() => runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
      [],
      undefined,
      { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.7-flash' },
    )),
    /Google is rate-limiting this Gemini key\/project/,
  );
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-transcribe']);
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
  assert.deepEqual(generationConfig?.transcription_config?.language_codes, []);
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
    undefined,
    contextRecognitionHints('This clip compares GPT 5.6 Luna with Sthang.'),
  );

  assert.equal(result.transcript.fullText, 'សួស្តី Sthang');
  assert.equal(result.transcript.language, 'km-KH');
  assert.equal(result.contextMode, 'vocabulary-only');
  assert.deepEqual(requestBody?.input, [{ type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/wav' }]);
  assert.equal(Object.hasOwn(requestBody || {}, 'system_instruction'), false);
  assert.equal(Object.hasOwn(requestBody || {}, 'response_format'), false);
  const generationConfig = requestBody?.generation_config as { transcription_config?: Record<string, unknown> } | undefined;
  assert.deepEqual(generationConfig?.transcription_config?.language_codes, []);
  assert.deepEqual(generationConfig?.transcription_config?.mode, { type: 'verbatim' });
  assert.deepEqual(generationConfig?.transcription_config?.custom_vocabulary, ['Sthang', 'GPT 5.6 Luna']);
  assert.equal(result.descriptionHintsUsed, 1);
});

test('Transcribe rescue infers transcript language from returned script instead of hard-coding Khmer', () => {
  assert.equal(inferTranscriptLanguageFromText('សួស្តី OpenAI'), 'km-KH');
  assert.equal(inferTranscriptLanguageFromText('Hello from OpenAI'), 'en-US');
  assert.equal(inferTranscriptLanguageFromText('12345'), 'und');
});

test('Khmer-first script guard rejects English-only and Thai/Lao contamination while preserving valid code-switching', () => {
  assert.equal(implausibleEnglishOnlyKhmerRescue('This is a completely English transcript returned for a Khmer-first video.', 'km'), true);
  assert.equal(implausibleEnglishOnlyKhmerRescue('ខ្ញុំកំពុងនិយាយអំពី OpenAI GPT-5', 'km'), false);
  assert.equal(implausibleEnglishOnlyKhmerRescue('OpenAI GPT-5', 'km'), true);
  assert.equal(implausibleEnglishOnlyKhmerRescue('This is a normal English-only source clip.', 'en'), false);
  assert.equal(khmerTranscriptScriptIssue('ខ្ញុំនិយាយ OpenAI GPT-5', [], 'km'), null);
  assert.equal(khmerTranscriptScriptIssue('ខ្ញុំនិយាយ ภาษาไทย', [], 'km'), 'thai-lao-contamination');
  assert.equal(khmerTranscriptScriptIssue('ខ្ញុំនិយាយ ພາສາລາວ', [], 'km'), 'thai-lao-contamination');
  assert.equal(khmerTranscriptScriptIssue('ภาษาไทย', [], 'km'), 'thai-lao-contamination');
  assert.equal(khmerTranscriptScriptIssue('ພາສາລາວ', [], 'km'), 'thai-lao-contamination');
  const protectedTerms = parseVocabulary(['Bangkok | กรุงเทพฯ', 'Vientiane | ວຽງຈັນ']);
  assert.equal(khmerTranscriptScriptIssue('ខ្ញុំទៅ กรุงเทพฯ និង ວຽງຈັນ', protectedTerms, 'km'), null);
  assert.equal(khmerTranscriptScriptIssue('ខ្ញុំទៅ กรุงเทพฯ ប៉ុន្តែមាន ภาษาไทย ផ្សេងទៀត', protectedTerms, 'km'), 'thai-lao-contamination');
});

test('manually selected Transcribe may auto-detect a genuine English source', async () => {
  let calls = 0;
  const ai = {
    interactions: {
      create: async () => {
        calls += 1;
        return { output_text: 'Hello world' };
      },
    },
  } as unknown as GoogleGenAI;

  const result = await runModel(
    ai,
    'gemini-3.5-transcribe',
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'This general-model prompt must not be sent.',
    [],
  );
  assert.equal(result.transcript.language, 'en-US');
  assert.equal(calls, 1);
});

test('manually selected Transcribe may return genuine English through the full model chain', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        calls.push(String(request.model || ''));
        return { output_text: 'Hello world from OpenAI' };
      },
    },
  } as unknown as GoogleGenAI;

  const result = await runGeminiModelChain(
    ai,
    { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
    'This prompt is intentionally ignored by the dedicated model.',
    [],
    undefined,
    { model: 'gemini-3.5-transcribe', fallbackModel: '' },
  );
  assert.equal(result.fullText, 'Hello world from OpenAI');
  assert.equal(result.language, 'en-US');
  assert.deepEqual(calls, ['gemini-3.5-transcribe']);
});

test('opted-in Khmer compatibility rescue fails closed on substantial English-only output', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        const model = String(request.model || '');
        calls.push(model);
        if (model === 'gemini-3.8-flash' || model === 'gemini-3.7-flash') {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }
        return { output_text: 'This is a fully English transcription of the entire source clip and should not be published.' };
      },
    },
  } as unknown as GoogleGenAI;

  await assert.rejects(
    withExperimentalTranscribeRescue(() => runGeminiModelChain(
      ai,
      { uri: 'https://example.test/audio', mimeType: 'audio/wav' },
      'Transcribe this audio.',
      [],
      undefined,
      { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.7-flash' },
    )),
    (error: unknown) => error instanceof GeminiLanguageMismatchError
      && /AI transcription returned English-only text/.test(error.message),
  );
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-transcribe']);
});

test('Khmer-first general Gemini output rejects unexpected Thai/Lao script before failover or persistence', async () => {
  const calls: string[] = [];
  const ai = {
    interactions: {
      create: async (request: { model?: string }) => {
        calls.push(String(request.model || ''));
        return { output_text: '{"language":"km-KH","fullText":"សួស្តី ภาษาไทย"}' };
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
      { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.7-flash' },
    ),
    (error: unknown) => error instanceof GeminiLanguageMismatchError
      && /unexpected Thai\/Lao script/.test(error.message),
  );
  assert.deepEqual(calls, ['gemini-3.8-flash']);
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
