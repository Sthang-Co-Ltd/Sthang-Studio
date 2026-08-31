import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { validateSubmission } from '../infra/contribution-worker/src/index.mjs';

function waveBytes() {
  const bytes = Buffer.alloc(64);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(56, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(20, 40);
  return bytes;
}

function validPayload(overrides = {}) {
  const audio = waveBytes();
  return {
    schemaVersion: 1,
    contributorId: 'contributor_12345678',
    candidateId: 'a'.repeat(32),
    captionStartMs: 1000,
    captionEndMs: 2200,
    clipStartMs: 820,
    clipEndMs: 2380,
    originalText: 'ខុស',
    correctedText: 'ត្រូវ',
    sourceTimingSource: 'stt',
    sourceTextModel: 'model-a',
    sourceEngineVersion: '0.8.0',
    appVersion: '0.8.0',
    audioDurationMs: 1560,
    audioSha256: crypto.createHash('sha256').update(audio).digest('hex'),
    audioBase64: audio.toString('base64'),
    ...overrides,
  };
}

test('contribution worker accepts only bounded generated-caption correction evidence', async () => {
  const sample = await validateSubmission(validPayload());
  assert.equal(sample.originalText, 'ខុស');
  assert.equal(sample.correctedText, 'ត្រូវ');
  assert.equal(sample.sourceTimingSource, 'stt');
  assert.equal(sample.audio.length, 64);
});

test('contribution worker rejects manual caption evidence and unchanged text', async () => {
  await assert.rejects(() => validateSubmission(validPayload({ sourceTimingSource: 'manual' })), /generated evidence/);
  await assert.rejects(() => validateSubmission(validPayload({ correctedText: 'ខុស' })), /must change text/);
});

test('contribution worker rejects tampered audio and clips that do not contain the caption', async () => {
  await assert.rejects(() => validateSubmission(validPayload({ audioSha256: 'b'.repeat(64) })), /audio hash mismatch/);
  await assert.rejects(() => validateSubmission(validPayload({ clipStartMs: 1200 })), /contain caption range/);
});
