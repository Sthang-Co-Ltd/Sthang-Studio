import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiRequestTimeoutError, withGeminiRequestTimeout } from '../apps/server/src/services/gemini-request-timeout.js';

test('Gemini request timeout aborts a stalled external operation', async () => {
  let observedAbort = false;
  await assert.rejects(
    withGeminiRequestTimeout(20, async (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    })),
    (error: unknown) => error instanceof GeminiRequestTimeoutError && error.timeoutMs === 20,
  );
  assert.equal(observedAbort, true);
});

test('Gemini request timeout leaves completed operations alone', async () => {
  const value = await withGeminiRequestTimeout(1000, async (signal) => {
    assert.equal(signal.aborted, false);
    return 'ok';
  });
  assert.equal(value, 'ok');
});
