import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CaptionSegment, CaptionRenderState, QaProfileSettings } from '@kcs/shared';
import type { TimingResult, TimingWord } from '../apps/server/src/services/timing-types.js';
import type { VocabularyEntry } from '../apps/server/src/services/vocabulary.js';
import { alignGeminiToTiming } from '../apps/server/src/services/alignment.js';
import { analyzeCaptions, QA_PROFILES, type ReviewIssue } from '../apps/web/src/review.js';
import { captionPreviewLookahead } from '../apps/web/src/caption-preview-plan.js';

// Frozen output from the pre-Batch-4 source, not regenerated from the candidate.
const golden = JSON.parse(readFileSync('tests/fixtures/performance-batch4.json', 'utf8')) as {
  alignment: Array<{ name: string; fullText: string; duration: number; timing: TimingResult; vocabulary?: VocabularyEntry[]; expected?: unknown; error?: string }>;
  quality: { captions: CaptionSegment[]; vocabulary: string[]; duration: number; cases: Array<{ settings: QaProfileSettings; expected: ReviewIssue[] }> };
};

function stableAlignment(result: ReturnType<typeof alignGeminiToTiming>) {
  return JSON.parse(JSON.stringify({ ...result, tokens: result.tokens.map(({ id: _id, ...token }) => token) }));
}

test('QA reuses segmentation setup and does not search the caption array while sorting', () => {
  let constructions = 0;
  const original = Intl.Segmenter;
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: new Proxy(original, { construct(target, args) { constructions += 1; return Reflect.construct(target, args); } }) });
  try {
    const captions: CaptionSegment[] = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, startMs: i * 1000, endMs: i * 1000 + 100, text: 'ខ្មែរ AI' }));
    Object.defineProperty(captions, 'findIndex', { value() { throw new Error('Per-comparison caption search'); } });
    assert.equal(analyzeCaptions(captions, []).length, 50);
    assert.equal(analyzeCaptions(captions, []).length, 50);
    assert.ok(constructions <= 1, `Expected reused segmenter, constructed ${constructions}`);
  } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
});

test('QA preserves complete warning objects/order for Khmer, duplicates, locks and all profiles', () => {
  const { captions, vocabulary, duration, cases } = golden.quality;
  const before = structuredClone(captions);
  for (const { settings, expected } of cases) assert.deepEqual(analyzeCaptions(captions, vocabulary, settings, duration), expected, settings.id);
  assert.deepEqual(captions, before, 'QA must not change caption data');
  assert.deepEqual(analyzeCaptions([], []), []);
});

test('QA duplicate-ID order is first occurrence and new calls see edits/reordering', () => {
  const captions: CaptionSegment[] = [
    { id: 'a', text: '', startMs: 0, endMs: 1000 },
    { id: 'b', text: '', startMs: 2000, endMs: 3000 },
    { id: 'a', text: '', startMs: 4000, endMs: 5000 },
  ];
  assert.deepEqual(analyzeCaptions(captions, []).map((issue) => issue.captionId), ['a', 'b']);
  assert.deepEqual(analyzeCaptions([captions[1], captions[0], captions[2]], []).map((issue) => issue.captionId), ['b', 'a']);
  assert.deepEqual(analyzeCaptions([{ id: 'a', text: 'hello', startMs: 0, endMs: 1000, approved: true }], [], QA_PROFILES['capcut-srt']), []);
});

test('reconciliation preserves full token/timing/diagnostic outputs and rejection messages', () => {
  for (const entry of golden.alignment) {
    const before = structuredClone(entry.timing);
    const run = () => alignGeminiToTiming(entry.fullText, entry.timing, entry.duration, entry.vocabulary);
    if (entry.error) assert.throws(run, { message: entry.error }, entry.name);
    else assert.deepEqual(stableAlignment(run()), entry.expected, entry.name);
    assert.deepEqual(entry.timing, before, `${entry.name}: input mutation`);
  }
});

test('timing normalization reads each word once per call and refreshes changed wording', () => {
  const texts = ['alpha', 'beta', 'gamma'];
  const reads = [0, 0, 0];
  const words: TimingWord[] = texts.map((_, i) => ({
    get text() { reads[i] += 1; return texts[i]; }, startMs: i * 1000, endMs: i * 1000 + 800,
  }));
  const timing: TimingResult = { transcript: '', words, engine: 'faster-whisper-local', provider: 'local', model: 'synthetic' };
  assert.equal(alignGeminiToTiming(texts.join(' '), timing, 4000).diagnostics.alignmentCoverage, 1);
  assert.deepEqual(reads, [1, 1, 1]);
  texts[1] = 'delta';
  const updated = alignGeminiToTiming(texts.join(' '), timing, 4000);
  assert.deepEqual(reads, [2, 2, 2]);
  assert.equal(updated.tokens[1].text, 'delta');
  assert.equal(updated.diagnostics.meanAlignmentScore, 1);
});

test('preview lookahead matches the original suffix/filter for every starting index', () => {
  const states: CaptionRenderState[] = Array.from({ length: 5000 }, (_, i) => ({ atMs: i * 100, endMs: i * 100 + 100, key: i % 3 ? String(i % 19) : '', text: i % 3 ? 'ខ្មែរ' : '' }));
  for (let start = 0; start < states.length + 5; start += 1) {
    const expected = states.slice(start).filter((state) => state.key).slice(0, 8);
    const actual = captionPreviewLookahead(states, start);
    assert.deepEqual(actual, expected);
    actual.forEach((state, i) => assert.equal(state, expected[i], 'retain state identity and duplicates'));
  }
  assert.deepEqual(captionPreviewLookahead([], 0), []);
});

test('preview lookahead never reads the suffix after its eighth drawable state', () => {
  const states: CaptionRenderState[] = Array.from({ length: 9 }, (_, i) => ({ atMs: i, endMs: i + 1, key: String(i), text: 'ខ្មែរ' }));
  Object.defineProperty(states, 8, { get() { throw new Error('Unnecessary suffix read'); } });
  assert.equal(captionPreviewLookahead(states, 0).length, 8);
});
