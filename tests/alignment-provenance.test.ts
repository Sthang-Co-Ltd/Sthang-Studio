import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptionWordTiming } from '@kcs/shared';
import { alignGeminiToTiming } from '../apps/server/src/services/alignment.js';
import { segmentTimedTokens } from '../apps/server/src/services/segmenter.js';
import { toSrt } from '../apps/server/src/services/srt.js';
import type { TimingResult, TimingWord } from '../apps/server/src/services/timing-types.js';
import type { VocabularyEntry } from '../apps/server/src/services/vocabulary.js';

function timing(words: TimingWord[], overrides: Partial<TimingResult> = {}): TimingResult {
  return {
    transcript: words.map((word) => word.text).join(' '),
    words,
    engine: 'kfa-local',
    provider: 'local',
    model: 'fixture-timing',
    directAlignment: true,
    ...overrides,
  };
}

function oneCaption(result: ReturnType<typeof alignGeminiToTiming>) {
  const captions = segmentTimedTokens(result.tokens, { mode: 'phrase' });
  assert.equal(captions.length, 1);
  return captions[0];
}

test('direct KFA exact 1:1 stays ready while raw path score is not exposed as ASR confidence', () => {
  const input = timing([{ text: 'ខ្មែរ', startMs: 120, endMs: 520, confidence: 0.08 }]);
  const before = structuredClone(input);
  const result = alignGeminiToTiming('ខ្មែរ', input, 2_000);

  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].timingSource, 'stt');
  assert.equal(result.tokens[0].confidence, undefined);
  assert.equal(result.tokens[0].alignmentScore, 1);
  assert.deepEqual([result.tokens[0].startMs, result.tokens[0].endMs], [120, 520]);
  assert.equal(resolveCaptionWordTiming(oneCaption(result)).state, 'ready');
  assert.equal(result.diagnostics.lowConfidenceTokens, 0);
  assert.equal(result.diagnostics.directAlignment, true);
  assert.deepEqual(input, before, 'alignment must not erase raw timing diagnostics from the worker result');
});

test('direct KFA exact 1:N union stays trusted only with coherent anchor continuity', () => {
  const exact = alignGeminiToTiming('notebook', timing([
    { text: 'note', startMs: 100, endMs: 300, confidence: 0.05 },
    { text: 'book', startMs: 350, endMs: 650, confidence: 0.09 },
  ]), 2_000);
  assert.equal(exact.tokens[0].timingSource, 'stt');
  assert.equal(exact.tokens[0].confidence, undefined);
  assert.deepEqual([exact.tokens[0].startMs, exact.tokens[0].endMs], [100, 650]);
  assert.equal(resolveCaptionWordTiming(oneCaption(exact)).state, 'ready');

  for (const words of [
    [
      { text: 'note', startMs: 100, endMs: 250, confidence: 0.9 },
      { text: 'book', startMs: 500, endMs: 800, confidence: 0.9 },
    ],
    [
      { text: 'note', startMs: 100, endMs: 500, confidence: 0.9 },
      { text: 'book', startMs: 380, endMs: 700, confidence: 0.9 },
    ],
  ] satisfies TimingWord[][]) {
    const suspicious = alignGeminiToTiming('notebook', timing(words), 2_000);
    assert.equal(suspicious.tokens[0].timingSource, 'stt-split');
    assert.deepEqual([suspicious.tokens[0].startMs, suspicious.tokens[0].endMs], [words[0].startMs, words[1].endMs]);
    assert.equal(resolveCaptionWordTiming(oneCaption(suspicious)).state, 'partial');
  }
});

test('one measured direct KFA orthographic span can cover four to eight displayed tokens without inventing trusted internal anchors', () => {
  for (const chunks of [
    ['one', 'two', 'three', 'four'],
    ['ខ្មែរ', 'AI', 'one', 'two'],
    ['one', 'two', 'three', 'four', 'five', 'six'],
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
  ]) {
    const display = chunks.join(' ');
    const measured = chunks.join('');
    const aligned = alignGeminiToTiming(display, timing([
      { text: measured, startMs: 100, endMs: 900, confidence: 0.05 },
    ]), 1_200);

    assert.deepEqual(aligned.tokens.map((token) => token.text), chunks);
    assert.ok(aligned.tokens.every((token) => token.timingSource === 'stt-split'), display);
    assert.equal(aligned.tokens[0].startMs, 100, display);
    assert.equal(aligned.tokens.at(-1)?.endMs, 900, display);
    assert.ok(aligned.tokens.every((token) => token.startMs >= 100 && token.endMs <= 900), display);
    assert.equal(aligned.diagnostics.interpolatedTokens, 0, display);
    assert.equal(aligned.diagnostics.lowConfidenceTokens, chunks.length, display);
    // Phrase mode legitimately groups long captions into several cues. This
    // regression is about the single acoustic anchor, not caption-size policy.
    const cues = segmentTimedTokens(aligned.tokens, { mode: 'single-line', maxChars: 200 });
    assert.equal(cues.length, 1, display);
    assert.equal(resolveCaptionWordTiming(cues[0]).state, 'partial', display);
  }
});

test('wider direct KFA merges require exact whole-span text and do not upgrade fuzzy or ASR fallback evidence', () => {
  const display = 'one two three four';
  assert.throws(() => alignGeminiToTiming(display, timing([
    { text: 'onetwothreefours', startMs: 100, endMs: 900, confidence: 0.98 },
  ]), 1_200), /Timing alignment was too weak/, 'a wholly unmatched fuzzy KFA compound must not fabricate a trustworthy SRT');

  const fallback = alignGeminiToTiming(display, timing([
    { text: 'onetwothreefour', startMs: 100, endMs: 900, confidence: 0.98 },
  ], { engine: 'faster-whisper-local', directAlignment: false }), 1_200);
  assert.ok(fallback.tokens.every((token) => token.timingSource !== 'stt'), 'ASR fallback cannot certify words');
  assert.equal(resolveCaptionWordTiming(oneCaption(fallback)).state, 'partial');
});

test('a fuzzy direct KFA word must not absorb a genuinely missing neighboring word into one acoustic interval', () => {
  const input = timing([
    { text: 'hellos', startMs: 100, endMs: 400, confidence: 0.04 },
    { text: 'world', startMs: 900, endMs: 1_200, confidence: 0.04 },
  ]);
  const aligned = alignGeminiToTiming('hello missing world', input, 1_500);
  assert.deepEqual(aligned.tokens.map((token) => token.timingSource), ['stt-split', 'interpolated', 'stt']);
  assert.equal(aligned.tokens[0].startMs, 100);
  assert.equal(aligned.tokens[0].endMs, 400);
  assert.ok(aligned.tokens[1].startMs >= aligned.tokens[0].endMs);
  assert.ok(aligned.tokens[1].endMs <= aligned.tokens[2].startMs);
  assert.equal(aligned.diagnostics.lowConfidenceTokens, 2);
  assert.equal(aligned.diagnostics.interpolatedTokens, 1);
});

test('direct KFA fuzzy 1:1 and fuzzy 1:N anchors keep timestamps but require review', () => {
  const fuzzyOne = alignGeminiToTiming('boat', timing([
    { text: 'boats', startMs: 140, endMs: 500, confidence: 0.99 },
  ]), 2_000);
  assert.equal(fuzzyOne.tokens[0].alignmentScore, 0.8);
  assert.equal(fuzzyOne.tokens[0].timingSource, 'stt-split');
  assert.equal(fuzzyOne.diagnostics.lowConfidenceTokens, 1);
  assert.deepEqual([fuzzyOne.tokens[0].startMs, fuzzyOne.tokens[0].endMs], [140, 500]);
  assert.equal(resolveCaptionWordTiming(oneCaption(fuzzyOne)).state, 'partial');

  const fuzzyUnion = alignGeminiToTiming('oneword', timing([
    { text: 'one', startMs: 200, endMs: 420, confidence: 0.99 },
    { text: 'work', startMs: 440, endMs: 760, confidence: 0.99 },
  ]), 2_000);
  assert.ok((fuzzyUnion.tokens[0].alignmentScore ?? 0) > 0.55);
  assert.ok((fuzzyUnion.tokens[0].alignmentScore ?? 1) < 1);
  assert.equal(fuzzyUnion.tokens[0].timingSource, 'stt-split');
  assert.equal(fuzzyUnion.diagnostics.lowConfidenceTokens, 1);
  assert.deepEqual([fuzzyUnion.tokens[0].startMs, fuzzyUnion.tokens[0].endMs], [200, 760]);
  assert.equal(resolveCaptionWordTiming(oneCaption(fuzzyUnion)).state, 'partial');
});

test('faster-whisper fallback 1:1 stays timed but is review-required and keeps calibrated probability', () => {
  const input = timing([{ text: 'hello', startMs: 250, endMs: 700, confidence: 0.92 }], {
    engine: 'faster-whisper-local',
    model: 'fixture-whisper',
    directAlignment: false,
    fallbackReason: 'fixture KFA failure',
  });
  const result = alignGeminiToTiming('hello', input, 2_000);
  assert.equal(result.tokens[0].timingSource, 'stt-split');
  assert.equal(result.tokens[0].confidence, 0.92);
  assert.equal(result.tokens[0].alignmentScore, 1);
  assert.deepEqual([result.tokens[0].startMs, result.tokens[0].endMs], [250, 700]);

  const caption = oneCaption(result);
  assert.equal(caption.text, 'hello');
  assert.equal(resolveCaptionWordTiming(caption).state, 'partial');
  assert.match(toSrt([caption]), /00:00:00,250 --> 00:00:00,700\nhello/u);
  assert.equal(result.diagnostics.engine, 'faster-whisper-local');
  assert.equal(result.diagnostics.model, 'fixture-whisper');
  assert.equal(result.diagnostics.directAlignment, false);
  assert.equal(result.diagnostics.fallbackReason, 'fixture KFA failure');
  assert.equal(result.diagnostics.alignmentCoverage, 1);
  assert.equal(result.diagnostics.lowConfidenceTokens, 1);
});

test('faster-whisper engine without legacy directAlignment metadata is still fallback evidence', () => {
  const fallback = alignGeminiToTiming('legacy', timing([
    { text: 'legacy', startMs: 100, endMs: 500, confidence: 0.88 },
  ], {
    engine: 'faster-whisper-local',
    directAlignment: undefined,
  }), 1_000);
  assert.equal(fallback.tokens[0].timingSource, 'stt-split');
  assert.equal(resolveCaptionWordTiming(oneCaption(fallback)).state, 'partial');

  const legacyKfa = alignGeminiToTiming('legacy', timing([
    { text: 'legacy', startMs: 100, endMs: 500, confidence: 0.88 },
  ], {
    directAlignment: undefined,
  }), 1_000);
  assert.equal(legacyKfa.tokens[0].timingSource, 'stt');
  assert.equal(legacyKfa.tokens[0].confidence, 0.88);
});

test('direct KFA derived splits and missing words remain review evidence without losing safe timing', () => {
  const derived = alignGeminiToTiming('alpha', timing([
    { text: 'alpha', startMs: 100, endMs: 450, confidence: 0.03, derived: true },
  ]), 1_500);
  assert.equal(derived.tokens[0].timingSource, 'stt-split');
  assert.equal(derived.diagnostics.lowConfidenceTokens, 1);
  assert.equal(derived.tokens[0].confidence, undefined);
  assert.equal(resolveCaptionWordTiming(oneCaption(derived)).state, 'partial');

  const missing = alignGeminiToTiming('alpha missing beta', timing([
    { text: 'alpha', startMs: 100, endMs: 400, confidence: 0.08 },
    { text: 'beta', startMs: 900, endMs: 1_200, confidence: 0.09 },
  ]), 1_500);
  assert.deepEqual(missing.tokens.map((token) => token.timingSource), ['stt', 'interpolated', 'stt']);
  assert.equal(missing.tokens[1].confidence, 0.35);
  assert.equal(missing.tokens[1].alignmentScore, 0);
  assert.ok(missing.tokens[1].startMs >= missing.tokens[0].endMs);
  assert.ok(missing.tokens[1].endMs <= missing.tokens[2].startMs);
  assert.equal(missing.diagnostics.anchoredTokens, 2);
  assert.equal(missing.diagnostics.interpolatedTokens, 1);
  assert.equal(missing.diagnostics.alignmentCoverage, 2 / 3);
});

test('mixed Khmer/Latin punctuation remains exact and direct KFA punctuation variants stay trusted', () => {
  const result = alignGeminiToTiming('ខ្មែរ AI!', timing([
    { text: 'ខ្មែរ', startMs: 120, endMs: 500, confidence: 0.04 },
    { text: 'AI', startMs: 560, endMs: 900, confidence: 0.06 },
  ]), 1_500);
  assert.deepEqual(result.tokens.map((token) => token.text), ['ខ្មែរ', 'AI!']);
  assert.deepEqual(result.tokens.map((token) => token.timingSource), ['stt', 'stt']);
  assert.deepEqual(result.tokens.map((token) => token.confidence), [undefined, undefined]);
  const caption = oneCaption(result);
  assert.equal(caption.text, 'ខ្មែរ AI!');
  assert.equal(resolveCaptionWordTiming(caption).state, 'ready');
});

test('explicit vocabulary equivalence may trust exact direct KFA unions but never upgrades fallback ASR', () => {
  const vocabulary: VocabularyEntry[] = [{ canonical: 'AI', aliases: ['អេអាយ'] }];
  const direct = alignGeminiToTiming('AI', timing([
    { text: 'អេ', startMs: 100, endMs: 280, confidence: 0.05 },
    { text: 'អាយ', startMs: 300, endMs: 560, confidence: 0.06 },
  ]), 1_000, vocabulary);
  assert.equal(direct.tokens[0].alignmentScore, 1);
  assert.equal(direct.tokens[0].timingSource, 'stt');
  assert.equal(resolveCaptionWordTiming(oneCaption(direct)).state, 'ready');

  const fallback = alignGeminiToTiming('AI', timing([
    { text: 'អេអាយ', startMs: 100, endMs: 560, confidence: 0.96 },
  ], {
    engine: 'faster-whisper-local',
    directAlignment: false,
    fallbackReason: 'fixture KFA failure',
  }), 1_000, vocabulary);
  assert.equal(fallback.tokens[0].alignmentScore, 1);
  assert.equal(fallback.tokens[0].timingSource, 'stt-split');
  assert.equal(fallback.tokens[0].confidence, 0.96);
  assert.equal(resolveCaptionWordTiming(oneCaption(fallback)).state, 'partial');
});
