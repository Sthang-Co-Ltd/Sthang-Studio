import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCaptionPreviewDiagnostics, type CaptionPreviewDiagnosticSnapshot } from '../apps/server/src/services/caption-preview-diagnostics.js';

const snapshot: CaptionPreviewDiagnosticSnapshot = {
  input: { captions: [], timesMs: [1400] }, startedAt: 'synthetic-start', finishedAt: 'synthetic-end', completed: false,
};

test('preview diagnostics await retention of the original snapshot', async () => {
  let captured: CaptionPreviewDiagnosticSnapshot | undefined;
  await captureCaptionPreviewDiagnostics({ async capture(value) { await Promise.resolve(); captured = value; } }, snapshot);
  assert.equal(captured, snapshot);
});

test('failed retention is reported without replacing the renderer outcome', async () => {
  let failures = 0;
  await assert.doesNotReject(captureCaptionPreviewDiagnostics({
    async capture() { throw new Error('Synthetic retention failure.'); },
    captureFailed() { failures += 1; },
  }, snapshot));
  assert.equal(failures, 1);
});

test('a failed diagnostic failure observer cannot escape into rendering', async () => {
  await assert.doesNotReject(captureCaptionPreviewDiagnostics({
    capture() { throw new Error('Synthetic capture failure.'); },
    captureFailed() { throw new Error('Synthetic failure observer failure.'); },
  }, snapshot));
});
