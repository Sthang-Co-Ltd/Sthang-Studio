import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleGenAI } from '@google/genai';
import { config } from '../apps/server/src/config.js';
import { makePromptOnlyInteraction, makeTranscriptionRescueInteraction } from '../apps/server/src/services/gemini.js';

const uploaded = { uri: 'https://example.invalid/synthetic-audio', mimeType: 'audio/wav' };
const responseText = '{"language":"km-KH","fullText":"សួស្តី"}';

async function offlineSdk(run: (client: GoogleGenAI) => Promise<void>, transport: typeof fetch) {
  const original = globalThis.fetch;
  // No live provider requests or real credentials are permitted in this test.
  globalThis.fetch = transport;
  try {
    await run(new GoogleGenAI({ apiKey: 'non-secret-offline-fixture', httpOptions: { fetch: transport } }));
  } finally {
    globalThis.fetch = original;
  }
}

test('real GenAI SDK preserves Studio request/privacy shapes without network', async () => {
  const requests: Record<string, unknown>[] = [];
  const vocabulary = config.geminiNativeVocabularyBias;
  config.geminiNativeVocabularyBias = true;
  try {
    await offlineSdk(async (client) => {
      const prompt = await makePromptOnlyInteraction(client, 'gemini-3.8-flash', uploaded, 'Transcribe synthetic audio.');
      const rescue = await makeTranscriptionRescueInteraction(client, 'gemini-3.5-transcribe', uploaded, ['Sthang'], ['km-KH']);
      assert.equal(prompt.outputText, responseText);
      assert.equal(rescue.outputText, responseText);
      assert.equal(rescue.nativeVocabularyBias, true);
    }, async (input, options) => {
      const request = input instanceof Request ? input : new Request(input, options);
      assert.equal(request.method, 'POST');
      requests.push(JSON.parse(await request.text()));
      return new Response(JSON.stringify({ id: 'offline-id', object: 'interaction', status: 'completed', model: 'gemini-3.8-flash', output_text: responseText, outputs: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
  } finally {
    config.geminiNativeVocabularyBias = vocabulary;
  }
  assert.equal(requests.length, 2);
  for (const body of requests) assert.equal(body.store, false);
  assert.deepEqual(requests[0].input, [
    { type: 'text', text: 'Transcribe synthetic audio.' },
    { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
  ]);
  assert.equal((requests[0].response_format as Record<string, unknown>).mime_type, 'application/json');
  assert.deepEqual(requests[1].input, [{ type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType }]);
  assert.deepEqual(requests[1].generation_config, { transcription_config: {
    language_codes: ['km-KH'], mode: { type: 'verbatim' }, custom_vocabulary: ['Sthang'],
  } });
});

test('real GenAI SDK performs one transport attempt for a transient provider response', async () => {
  let calls = 0;
  await offlineSdk(async (client) => {
    await assert.rejects(makePromptOnlyInteraction(client, 'gemini-3.8-flash', uploaded, 'Synthetic fixture.'));
  }, async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 503, message: 'offline test unavailable' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(calls, 1, 'Studio owns retries; the SDK must not add hidden attempts');
});

// Strict transport-abort propagation is an explicitly known inherited Node
// Request.clone limitation under GC. Run npm run diagnose:gemini-abort; do not
// mistake this stable request/retry suite for proof of transport cancellation.
