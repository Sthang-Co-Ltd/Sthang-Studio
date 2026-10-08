import test from 'node:test';
import assert from 'node:assert/strict';
import { alignGeminiToTiming } from '../apps/server/src/services/alignment.js';
import { rebuildDiagnostics } from '../apps/server/src/services/transcript.js';
import type { TimingResult, TimingWord } from '../apps/server/src/services/timing-types.js';

function timing(engine: TimingResult['engine'], words: TimingWord[]): TimingResult {
  return {
    transcript: words.map((word) => word.text).join(' '),
    engine,
    provider: 'local',
    model: 'diagnostic-fixture',
    directAlignment: engine === 'kfa-local',
    words,
  };
}

test('regeneration preserves reviewed confidence counts for exact KFA versus fallback timestamps', () => {
  const words = [
    { text: 'ខ្មែរ', startMs: 120, endMs: 410, confidence: 0.03 },
    { text: 'AI', startMs: 450, endMs: 720, confidence: 0.98 },
  ];
  for (const engine of ['kfa-local', 'faster-whisper-local'] as const) {
    const aligned = alignGeminiToTiming('ខ្មែរ AI', timing(engine, words), 1_000);
    const rebuilt = rebuildDiagnostics(aligned.tokens, aligned.diagnostics, 1_000);
    assert.equal(rebuilt.lowConfidenceTokens, engine === 'kfa-local' ? 0 : 2);
    assert.equal(rebuilt.lowConfidenceTokens, aligned.diagnostics.lowConfidenceTokens);
    assert.equal(rebuilt.anchoredTokens, 2);
    assert.equal(rebuilt.interpolatedTokens, 0);
    assert.equal(rebuilt.alignmentCoverage, 1);
    assert.deepEqual([rebuilt.engine, rebuilt.directAlignment], [aligned.diagnostics.engine, aligned.diagnostics.directAlignment]);
  }
});

test('regeneration counts each split or interpolation once without inflating anchored coverage', () => {
  const aligned = alignGeminiToTiming('hello missing world', timing('kfa-local', [
    { text: 'hellos', startMs: 100, endMs: 400, confidence: 0.04 },
    { text: 'world', startMs: 900, endMs: 1_200, confidence: 0.04 },
  ]), 1_500);
  assert.deepEqual(aligned.tokens.map((word) => word.timingSource), ['stt-split', 'interpolated', 'stt']);
  const rebuilt = rebuildDiagnostics(aligned.tokens, aligned.diagnostics, 1_500);
  assert.equal(rebuilt.lowConfidenceTokens, 2);
  assert.equal(rebuilt.lowConfidenceTokens, aligned.diagnostics.lowConfidenceTokens);
  assert.equal(rebuilt.interpolatedTokens, 1);
  assert.equal(rebuilt.anchoredTokens, 2);
  assert.equal(rebuilt.alignmentCoverage, 2 / 3);
});
