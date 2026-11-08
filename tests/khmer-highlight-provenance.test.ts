import test from 'node:test';
import assert from 'node:assert/strict';
import { createUntimedCaptionWordTiming, resolveCaptionWordTiming } from '../packages/shared/src/word-timing.js';
import { captionWordBreakOffsets } from '../packages/shared/src/caption-layout.js';
import { alignGeminiToTiming } from '../apps/server/src/services/alignment.js';
import { normalizeLocalTimingWords } from '../apps/server/src/services/local-timing.js';
import { segmentTimedTokens } from '../apps/server/src/services/segmenter.js';
import { tokenizeText } from '../apps/server/src/services/tokenizer.js';
import type { TimingResult, TimingWord } from '../apps/server/src/services/timing-types.js';

function localCaptions(
  text: string,
  engine: 'kfa-local' | 'faster-whisper-local',
  words: TimingWord[],
) {
  const directAlignment = engine === 'kfa-local';
  const timing: TimingResult = {
    transcript: text,
    words: normalizeLocalTimingWords(words, { engine, directAlignment }),
    engine,
    provider: 'local',
    model: 'controlled-test',
    directAlignment,
  };
  const aligned = alignGeminiToTiming(text, timing, 1_000);
  const captions = segmentTimedTokens(aligned.tokens, { mode: 'single-line' });
  return { aligned, captions };
}

test('a measured Khmer KFA orthographic word can remain highlight-ready across an ICU token mismatch', () => {
  // The aligner word contains a hyphen; the displayed one does not. Both
  // normalize to the same lexical text, and there is only ONE measured acoustic
  // time range. Raw KFA path score is not a calibrated ASR word probability.
  const raw: TimingWord = { text: 'ខ្មែរ-AI', startMs: 120, endMs: 620, confidence: 0.03 };
  const { aligned, captions } = localCaptions('ខ្មែរAI', 'kfa-local', [raw]);
  assert.equal(aligned.tokens.length, 1);
  assert.equal(aligned.tokens[0].timingSource, 'stt');
  assert.equal(aligned.tokens[0].confidence, undefined);
  assert.equal(aligned.tokens[0].startMs, 120);
  assert.equal(aligned.tokens[0].endMs, 620);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, 'ខ្មែរAI');
  assert.equal(captions[0].timingQuality, 'high');
  assert.equal(resolveCaptionWordTiming(captions[0]).state, 'ready');
});

test('a KFA span subdivided into genuinely separate display words stays review-required', () => {
  const raw: TimingWord = { text: 'ខ្មែរ-AI', startMs: 120, endMs: 620, confidence: 0.98 };
  const { aligned, captions } = localCaptions('ខ្មែរ AI', 'kfa-local', [raw]);
  assert.deepEqual(aligned.tokens.map((token) => token.timingSource), ['stt-split', 'stt-split']);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, 'ខ្មែរ AI');
  assert.equal(resolveCaptionWordTiming(captions[0]).state, 'partial');
  assert.ok(captions[0].wordTiming?.words.every((word) => word.needsReview));
});

test('Khmer repetition signs share the preceding word timing and wrap as one unit', () => {
  const text = 'ខ្លីៗ';
  const { aligned, captions } = localCaptions(text, 'kfa-local', [{ text, startMs: 120, endMs: 320 }]);
  assert.deepEqual(aligned.tokens.map((token) => [token.text, token.timingSource]), [[text, 'stt']]);
  const timing = resolveCaptionWordTiming(captions[0]);
  assert.equal(timing.state, 'ready');
  assert.deepEqual(timing.words.map((word) => captions[0].text.slice(word.startOffset, word.endOffset)), [text]);
  assert.deepEqual(captionWordBreakOffsets('ខ្លីៗកម្ពុជា'), [text.length]);

  for (const separator of ['', ' ', '\u200B']) {
    const phrase = `ខ្លី${separator}ៗ`;
    assert.deepEqual(tokenizeText(phrase).map((token) => token.text), [phrase]);
    const cue = createUntimedCaptionWordTiming({ id: 'manual', text: phrase, startMs: 100, endMs: 600 });
    assert.deepEqual(cue.wordTiming?.words.map((word) => phrase.slice(word.startOffset, word.endOffset)), [phrase]);
  }
});

test('a repetition sign stays distinct across punctuation, line breaks, or a non-Khmer word', () => {
  for (const text of ['ៗ ខ្លី', 'ខ្លី!ៗ', 'ខ្លី\nៗ', 'AI ៗ']) {
    assert.equal(tokenizeText(text).length, 2, text);
    assert.ok(tokenizeText(text).some((token) => token.text === 'ៗ'), text);
  }
  const { captions } = localCaptions('ខ្លីៗ', 'kfa-local', [{ text: 'ខ្លី', startMs: 120, endMs: 320 }]);
  assert.equal(resolveCaptionWordTiming(captions[0]).state, 'partial');
});

test('Whisper word timestamps remain useful subtitle timing but never silently certify Khmer word highlights', () => {
  const raw: TimingWord[] = [
    { text: 'ខ្មែរ', startMs: 120, endMs: 410, confidence: 0.99 },
    { text: 'AI', startMs: 450, endMs: 710, confidence: 0.99 },
  ];
  const { aligned, captions } = localCaptions('ខ្មែរ AI', 'faster-whisper-local', raw);
  assert.deepEqual(aligned.tokens.map((token) => token.timingSource), ['stt-split', 'stt-split']);
  assert.deepEqual(aligned.tokens.map((token) => [token.startMs, token.endMs]), [[120, 410], [450, 710]]);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, 'ខ្មែរ AI');
  assert.equal(resolveCaptionWordTiming(captions[0]).state, 'partial');
});
