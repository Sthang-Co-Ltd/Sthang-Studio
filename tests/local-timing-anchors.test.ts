import test from 'node:test';
import assert from 'node:assert/strict';
import { alignGeminiToTiming } from '../apps/server/src/services/alignment.js';
import { normalizeLocalTimingWords } from '../apps/server/src/services/local-timing.js';
import { tokenizeText } from '../apps/server/src/services/tokenizer.js';
import type { TimingResult, TimingWord } from '../apps/server/src/services/timing-types.js';

function timing(words: TimingWord[], directAlignment: boolean, engine: TimingResult['engine']): TimingResult {
  return {
    transcript: words.map((word) => word.text).join(' '),
    words,
    engine,
    provider: engine === 'google-cloud-stt-v2' ? 'google-cloud' : 'local',
    model: 'fixture',
    directAlignment,
  };
}

test('direct KFA keeps one measured mixed Khmer anchor intact when the final display target is one exact token', () => {
  const acoustic: TimingWord = { text: 'ខ្មែរ-AI', startMs: 120, endMs: 520, confidence: 0.97 };
  assert.equal(tokenizeText(acoustic.text).length, 2, 'fixture must exercise Intl splitting of the raw KFA span');
  assert.equal(tokenizeText('ខ្មែរAI').length, 1, 'canonical Gemini target must remain one display token');

  const words = normalizeLocalTimingWords([acoustic], { engine: 'kfa-local', directAlignment: true });
  assert.deepEqual(words, [acoustic]);

  const aligned = alignGeminiToTiming('ខ្មែរAI', timing(words, true, 'kfa-local'), 1_000);
  assert.equal(aligned.tokens.length, 1);
  assert.equal(aligned.tokens[0].timingSource, 'stt');
  assert.equal(aligned.tokens[0].startMs, acoustic.startMs);
  assert.equal(aligned.tokens[0].endMs, acoustic.endMs);
});

test('one direct KFA anchor matched to several Gemini display tokens stays tentative downstream', () => {
  const acoustic: TimingWord = { text: 'ខ្មែរ-AI', startMs: 120, endMs: 520, confidence: 0.97 };
  const words = normalizeLocalTimingWords([acoustic], { engine: 'kfa-local', directAlignment: true });
  const aligned = alignGeminiToTiming('ខ្មែរ AI', timing(words, true, 'kfa-local'), 1_000);

  assert.equal(aligned.tokens.length, 2);
  assert.deepEqual(aligned.tokens.map((token) => token.timingSource), ['stt-split', 'stt-split']);
  assert.equal(aligned.tokens[0].startMs, acoustic.startMs);
  assert.equal(aligned.tokens[1].endMs, acoustic.endMs);
  assert.ok(aligned.tokens[0].endMs <= aligned.tokens[1].startMs);
});

test('direct KFA cleanup removes invalid and duplicate clips, sorts anchors, and preserves punctuation and measured bounds', () => {
  const words = normalizeLocalTimingWords([
    { text: 'later?', startMs: 800, endMs: 920, confidence: 0.8 },
    { text: 'ខ្មែរ-AI!', startMs: 400, endMs: 700, confidence: 0.5 },
    { text: 'ខ្មែរ-AI!', startMs: 400, endMs: 700, confidence: 0.95 },
    { text: 'earlier។', startMs: 100, endMs: 260, confidence: 0.9 },
    { text: 'bad', startMs: 300, endMs: 300, confidence: 1 },
    { text: 'nan', startMs: Number.NaN, endMs: 350, confidence: 1 },
    { text: '   ', startMs: 20, endMs: 40, confidence: 1 },
  ], { engine: 'kfa-local', directAlignment: true });

  assert.deepEqual(words, [
    { text: 'earlier។', startMs: 100, endMs: 260, confidence: 0.9 },
    { text: 'ខ្មែរ-AI!', startMs: 400, endMs: 700, confidence: 0.95 },
    { text: 'later?', startMs: 800, endMs: 920, confidence: 0.8 },
  ]);
});

test('Whisper fallback keeps the established display-token splitting behavior separate from direct KFA', () => {
  const acoustic: TimingWord = { text: 'ខ្មែរ-AI', startMs: 120, endMs: 520, confidence: 0.91 };
  const words = normalizeLocalTimingWords([acoustic], { engine: 'faster-whisper-local', directAlignment: false });

  assert.equal(words.length, 2);
  assert.deepEqual(words.map((word) => word.text), ['ខ្មែរ-', 'AI']);
  assert.deepEqual(words.map((word) => word.derived), [true, true]);
  assert.equal(words[0].startMs, acoustic.startMs);
  assert.equal(words[1].endMs, acoustic.endMs);
  assert.ok(words[0].endMs <= words[1].startMs);
});

test('direct KFA retains distinct near-spelled overlapping words instead of fuzzy-deduplicating acoustic anchors', () => {
  const acoustic: TimingWord[] = [
    { text: 'correct', startMs: 100, endMs: 300, confidence: 0.6 },
    { text: 'corrects', startMs: 150, endMs: 340, confidence: 0.95 },
  ];
  const direct = normalizeLocalTimingWords(acoustic, { engine: 'kfa-local', directAlignment: true });
  assert.deepEqual(direct, acoustic, 'two different KFA orthographic words must retain both measured intervals');

  const fallback = normalizeLocalTimingWords(acoustic, { engine: 'faster-whisper-local', directAlignment: false });
  assert.equal(fallback.length, 1, 'existing fuzzy Whisper duplicate cleanup is intentionally unchanged');
  assert.equal(fallback[0].text, 'corrects');
});
