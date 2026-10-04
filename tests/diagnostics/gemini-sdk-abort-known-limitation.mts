// Expected to fail on reviewed Node 22.23.3 / 24.21.0; see maintenance docs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleGenAI } from '@google/genai';
import { config } from '../../apps/server/src/config.js';
import { makePromptOnlyInteraction, makeTranscriptionRescueInteraction } from '../../apps/server/src/services/gemini.js';

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

import { GeminiRequestTimeoutError } from '../../apps/server/src/services/gemini-request-timeout.js';

test('KNOWN LIMITATION: real SDK transport abort propagation under forced GC', async () => {
  assert.equal(typeof globalThis.gc, 'function', 'Run via npm run diagnose:gemini-abort');
  const gcTimer = setInterval(() => globalThis.gc!(), 15);
  let calls = 0;
  let aborts = 0;
  const timeout = config.geminiRequestTimeoutMs;
  config.geminiRequestTimeoutMs = 1000;
  try {
    await offlineSdk(async (client) => {
      await assert.rejects(makePromptOnlyInteraction(client, 'gemini-3.8-flash', uploaded, 'Synthetic fixture.'), GeminiRequestTimeoutError);
    }, async (input, options) => {
      calls += 1;
      const request = input instanceof Request ? input : new Request(input, options);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { aborts += 1; reject(request.signal.reason); };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    });
  } finally {
    config.geminiRequestTimeoutMs = timeout;
    clearInterval(gcTimer);
  }
  assert.equal(calls, 1);
  assert.equal(aborts, 1);
});
