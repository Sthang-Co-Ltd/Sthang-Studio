import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptionWordTimingForExactText,
  hydrateCaptionWordTimings,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '../packages/shared/src/index.js';
import {
  buildCaptionWordTiming,
  createUntimedCaptionWordTiming,
  editCaptionWord,
  reconcileCaptionWordTiming,
  resolveCaptionWordTiming,
} from '../packages/shared/src/word-timing.js';

function caption(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return {
    id: 'caption-1',
    startMs: 1_000,
    endMs: 2_000,
    text: 'ខ្មែរ AI!',
    ...overrides,
  };
}

function token(overrides: Partial<TimedToken> & Pick<TimedToken, 'id' | 'text' | 'startMs' | 'endMs' | 'spaceBefore'>): TimedToken {
  return {
    timingSource: 'stt',
    ...overrides,
  };
}

const sourceTokens = (): TimedToken[] => [
  token({ id: 'khmer', text: 'ខ្មែរ', startMs: 1_050, endMs: 1_350, spaceBefore: false }),
  token({ id: 'ai', text: 'AI!', startMs: 1_420, endMs: 1_700, spaceBefore: true }),
];

test('builds exact grapheme-safe UTF-16 offsets and requires exact contiguous token text', () => {
  const source = caption();
  const timing = buildCaptionWordTiming(source, sourceTokens());
  assert.ok(timing);
  assert.equal(timing.text, source.text);
  assert.deepEqual(timing.words.map((word) => source.text.slice(word.startOffset, word.endOffset)), ['ខ្មែរ', 'AI!']);
  assert.deepEqual(timing.words.map((word) => word.id), ['khmer', 'ai']);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'ready');

  assert.equal(buildCaptionWordTiming(source, [
    sourceTokens()[0],
    { ...sourceTokens()[1], spaceBefore: false },
  ]), undefined);
  assert.equal(buildCaptionWordTiming(source, [
    sourceTokens()[0],
    { ...sourceTokens()[1], id: 'khmer' },
  ]), undefined);
});

test('estimated/split timing is retained as evidence but blocks whole-cue highlight readiness', () => {
  const source = caption();
  const timing = buildCaptionWordTiming(source, [
    sourceTokens()[0],
    { ...sourceTokens()[1], timingSource: 'stt-split' },
  ]);
  assert.ok(timing);
  assert.equal(timing.words[1].source, 'estimated');
  assert.equal(timing.words[1].needsReview, true);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'partial');
});

test('known low confidence or alignment marks review without treating missing metadata as zero', () => {
  const source = caption();
  const missing = buildCaptionWordTiming(source, sourceTokens());
  assert.ok(missing);
  assert.deepEqual(missing.words.map((word) => word.needsReview), [undefined, undefined]);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: missing }).state, 'ready');

  const lowConfidence = buildCaptionWordTiming(source, [
    { ...sourceTokens()[0], confidence: 0.49 },
    sourceTokens()[1],
  ]);
  assert.ok(lowConfidence);
  assert.equal(lowConfidence.words[0].needsReview, true);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: lowConfidence }).state, 'partial');

  const lowAlignment = buildCaptionWordTiming(source, [
    sourceTokens()[0],
    { ...sourceTokens()[1], alignmentScore: 0.54 },
  ]);
  assert.ok(lowAlignment);
  assert.equal(lowAlignment.words[1].needsReview, true);

  const thresholds = buildCaptionWordTiming(source, [
    { ...sourceTokens()[0], confidence: 0.5 },
    { ...sourceTokens()[1], alignmentScore: 0.55 },
  ]);
  assert.ok(thresholds);
  assert.deepEqual(thresholds.words.map((word) => word.needsReview), [undefined, undefined]);
});

test('sub-grid word intervals stay partial before and after persistence', () => {
  const source = caption({ text: 'AI' });
  const built = buildCaptionWordTiming(source, [
    token({ id: 'tiny', text: 'AI', startMs: 1_001, endMs: 1_004, spaceBefore: false }),
  ]);
  assert.ok(built);
  assert.equal(built.words[0].needsReview, true);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: built }).state, 'partial');

  const imported = {
    ...source,
    wordTiming: {
      version: 1 as const,
      text: source.text,
      words: [{
        id: 'old', startOffset: 0, endOffset: 2,
        startMs: 1_001, endMs: 1_004,
        source: 'aligned' as const,
      }],
    },
  };
  assert.equal(resolveCaptionWordTiming(imported).state, 'partial');
});

test('build finds one exact contiguous token window near the cue and rejects local repeated ambiguity', () => {
  const source = caption({ text: 'go now', startMs: 5_000, endMs: 6_000 });
  const wholeTranscript: TimedToken[] = [
    token({ id: 'far-go', text: 'go', startMs: 100, endMs: 220, spaceBefore: false }),
    token({ id: 'far-now', text: 'now', startMs: 260, endMs: 430, spaceBefore: true }),
    token({ id: 'local-go', text: 'go', startMs: 5_100, endMs: 5_280, spaceBefore: true }),
    token({ id: 'local-now', text: 'now', startMs: 5_350, endMs: 5_600, spaceBefore: true }),
    token({ id: 'tail', text: 'later', startMs: 7_500, endMs: 7_800, spaceBefore: true }),
  ];
  const timing = buildCaptionWordTiming(source, wholeTranscript);
  assert.ok(timing);
  assert.deepEqual(timing.words.map((word) => word.id), ['local-go', 'local-now']);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'ready');

  const ambiguous = [
    ...wholeTranscript.slice(0, 4),
    token({ id: 'second-go', text: 'go', startMs: 6_200, endMs: 6_330, spaceBefore: true }),
    token({ id: 'second-now', text: 'now', startMs: 6_380, endMs: 6_600, spaceBefore: true }),
  ];
  assert.equal(buildCaptionWordTiming(source, ambiguous), undefined);
});

test('legacy hydration requires the whole current caption wording to still equal canonical wording', () => {
  const tokens: TimedToken[] = [
    token({ id: 'alpha', text: 'alpha', startMs: 100, endMs: 300, spaceBefore: false }),
    token({ id: 'beta', text: 'beta', startMs: 350, endMs: 600, spaceBefore: true }),
    token({ id: 'gamma', text: 'gamma', startMs: 900, endMs: 1_150, spaceBefore: true }),
    token({ id: 'delta', text: 'delta', startMs: 1_200, endMs: 1_500, spaceBefore: true }),
  ];
  const first: CaptionSegment = { id: 'first', startMs: 80, endMs: 650, text: 'alpha beta' };
  const corrected: CaptionSegment = { id: 'second', startMs: 850, endMs: 1_550, text: 'gamma DELTA' };
  const firstTiming = buildCaptionWordTiming(first, tokens);
  assert.ok(firstTiming);
  const project: CaptionProject = {
    id: 'corrected-legacy', title: 'Corrected legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    media: { filename: 'legacy.mp4', originalName: 'legacy.mp4', mimeType: 'video/mp4', size: 1, url: '/media/legacy.mp4' },
    transcript: { language: 'en', fullText: 'alpha beta gamma delta', tokens, segments: [] },
    captions: [{ ...first, wordTiming: firstTiming }, corrected],
    mode: 'phrase',
    transcriptNeedsSync: false,
  };

  const hydrated = hydrateCaptionWordTimings(project);
  assert.equal(hydrated, project);
  assert.equal(hydrated.captions[0].wordTiming, firstTiming);
  assert.equal(hydrated.captions[1].wordTiming, undefined);
});

test('legacy hydration fills every unchanged caption slice when project wording still exactly matches canonical tokens', () => {
  const tokens: TimedToken[] = [
    token({ id: 'alpha', text: 'alpha', startMs: 100, endMs: 300, spaceBefore: false }),
    token({ id: 'beta', text: 'beta', startMs: 350, endMs: 600, spaceBefore: true }),
    token({ id: 'gamma', text: 'gamma', startMs: 900, endMs: 1_150, spaceBefore: true }),
    token({ id: 'delta', text: 'delta', startMs: 1_200, endMs: 1_500, spaceBefore: true }),
  ];
  const project: CaptionProject = {
    id: 'unchanged-legacy', title: 'Unchanged legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    media: { filename: 'legacy.mp4', originalName: 'legacy.mp4', mimeType: 'video/mp4', size: 1, url: '/media/legacy.mp4' },
    transcript: { language: 'en', fullText: 'alpha beta gamma delta', tokens, segments: [] },
    captions: [
      { id: 'first', startMs: 80, endMs: 650, text: 'alpha beta' },
      { id: 'second', startMs: 850, endMs: 1_550, text: 'gamma delta' },
    ],
    mode: 'phrase',
    transcriptNeedsSync: false,
  };

  const hydrated = hydrateCaptionWordTimings(project);
  assert.notEqual(hydrated, project);
  assert.deepEqual(hydrated.captions.map((cue) => resolveCaptionWordTiming(cue).state), ['ready', 'ready']);
  assert.deepEqual(hydrated.captions[0].wordTiming?.words.map((word) => word.id), ['alpha', 'beta']);
  assert.deepEqual(hydrated.captions[1].wordTiming?.words.map((word) => word.id), ['gamma', 'delta']);
  assert.equal(project.captions[0].wordTiming, undefined);
  assert.equal(project.captions[1].wordTiming, undefined);
});

test('exact-text builder restores Khmer word timing without trusting normalized spaceBefore flags', () => {
  const text = 'ខ្មែរ ស្រឡាញ់ កម្ពុជា!';
  const source = caption({ text, startMs: 1_000, endMs: 2_500 });
  const timing = buildCaptionWordTimingForExactText(source, [
    token({ id: 'khmer', text: 'ខ្មែរ', startMs: 1_050, endMs: 1_300, spaceBefore: false }),
    token({ id: 'love', text: 'ស្រឡាញ់', startMs: 1_340, endMs: 1_650, spaceBefore: false }),
    token({ id: 'cambodia', text: 'កម្ពុជា!', startMs: 1_690, endMs: 2_050, spaceBefore: false }),
  ]);

  assert.ok(timing);
  assert.equal(timing.text, text);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'ready');
  assert.deepEqual(timing.words.map((word) => text.slice(word.startOffset, word.endOffset)), ['ខ្មែរ', 'ស្រឡាញ់', 'កម្ពុជា!']);
  assert.equal(text.slice(timing.words[0].endOffset, timing.words[1].startOffset), ' ');
  assert.equal(text.slice(timing.words[1].endOffset, timing.words[2].startOffset), ' ');
});

test('exact-text builder preserves repeated whitespace, newlines, and separately-tokenized punctuation offsets', () => {
  const text = 'hello   world\nagain!';
  const source = caption({ text, startMs: 1_000, endMs: 3_000 });
  const timing = buildCaptionWordTimingForExactText(source, [
    token({ id: 'hello', text: 'hello', startMs: 1_050, endMs: 1_300, spaceBefore: false }),
    token({ id: 'world', text: 'world', startMs: 1_400, endMs: 1_700, spaceBefore: false }),
    token({ id: 'again', text: 'again', startMs: 1_800, endMs: 2_100, spaceBefore: false }),
    token({ id: 'bang', text: '!', startMs: 2_100, endMs: 2_130, spaceBefore: false }),
  ]);

  assert.ok(timing);
  assert.equal(timing.text, text);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'ready');
  assert.deepEqual(timing.words.map((word) => text.slice(word.startOffset, word.endOffset)), ['hello', 'world', 'again']);
  assert.equal(text.slice(timing.words[0].endOffset, timing.words[1].startOffset), '   ');
  assert.equal(text.slice(timing.words[1].endOffset, timing.words[2].startOffset), '\n');
  assert.equal(text.slice(timing.words[2].endOffset), '!');
});

test('exact-text builder keeps English spelling literal and refuses lexical mismatch instead of guessing', () => {
  const source = caption({ text: 'OpenAI rocks.', startMs: 1_000, endMs: 2_200 });
  const exact = buildCaptionWordTimingForExactText(source, [
    token({ id: 'openai', text: 'OpenAI', startMs: 1_050, endMs: 1_400, spaceBefore: false }),
    token({ id: 'rocks', text: 'rocks.', startMs: 1_500, endMs: 1_850, spaceBefore: false }),
  ]);
  assert.ok(exact);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: exact }).state, 'ready');

  assert.equal(buildCaptionWordTimingForExactText(source, [
    token({ id: 'wrong-case', text: 'OpenAi', startMs: 1_050, endMs: 1_400, spaceBefore: false }),
    token({ id: 'rocks', text: 'rocks.', startMs: 1_500, endMs: 1_850, spaceBefore: false }),
  ]), undefined);
  assert.equal(buildCaptionWordTimingForExactText(caption({ text: 'hello world' }), [
    token({ id: 'hello', text: 'hello', startMs: 1_050, endMs: 1_300, spaceBefore: false }),
    token({ id: 'wrong-word', text: 'whirled', startMs: 1_400, endMs: 1_700, spaceBefore: false }),
  ]), undefined);
});

test('persisted spans do not depend on ICU reproducing the same Khmer word partition', () => {
  const text = 'ខ្មែរ';
  const source = caption({ text, startMs: 1_000, endMs: 1_800 });
  const icuWords = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)].filter((part) => part.isWordLike);
  assert.equal(icuWords.length, 1);

  const timing = buildCaptionWordTiming(source, [
    token({ id: 'khmer-a', text: 'ខ្', startMs: 1_050, endMs: 1_220, spaceBefore: false }),
    token({ id: 'khmer-b', text: 'មែរ', startMs: 1_230, endMs: 1_560, spaceBefore: false }),
  ]);
  assert.ok(timing);
  assert.equal(timing.words.length, 2);
  assert.deepEqual(timing.words.map((word) => text.slice(word.startOffset, word.endOffset)), ['ខ្', 'មែរ']);
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: timing }).state, 'ready');

  const splitInsideGrapheme = buildCaptionWordTiming(source, [
    token({ id: 'khmer-mid-a', text: 'ខ', startMs: 1_050, endMs: 1_130, spaceBefore: false }),
    token({ id: 'khmer-mid-b', text: '្', startMs: 1_130, endMs: 1_220, spaceBefore: false }),
    token({ id: 'khmer-mid-c', text: 'មែរ', startMs: 1_230, endMs: 1_560, spaceBefore: false }),
  ]);
  assert.ok(splitInsideGrapheme);
  assert.equal(splitInsideGrapheme.words.length, 2);
  assert.equal(text.slice(splitInsideGrapheme.words[0].startOffset, splitInsideGrapheme.words[0].endOffset), 'ខ្');
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: splitInsideGrapheme }).state, 'ready');
});

test('rejects stale snapshots and offsets that split a grapheme cluster', () => {
  const text = 'កា AI';
  const source = caption({ text, endMs: 2_500 });
  const timing = buildCaptionWordTiming(source, [
    token({ id: 'kh', text: 'កា', startMs: 1_100, endMs: 1_400, spaceBefore: false }),
    token({ id: 'ai', text: 'AI', startMs: 1_500, endMs: 1_800, spaceBefore: true }),
  ]);
  assert.ok(timing);
  assert.equal(resolveCaptionWordTiming({ ...source, text: `${text}!`, wordTiming: timing }).state, 'stale');

  const broken = structuredClone(timing);
  broken.words[0].endOffset = 1;
  assert.equal(resolveCaptionWordTiming({ ...source, wordTiming: broken }).state, 'stale');

  const malformed = { ...source, wordTiming: { version: 1, text, words: undefined } as unknown as NonNullable<CaptionSegment['wordTiming']> };
  assert.deepEqual(resolveCaptionWordTiming(malformed), {
    state: 'stale',
    words: [],
    reason: 'Word timing data is malformed.',
  });
});

test('reconciles punctuation/spacing without losing timing and makes lexical substitutions tentative', () => {
  const before = caption();
  before.wordTiming = buildCaptionWordTiming(before, sourceTokens());
  assert.ok(before.wordTiming);

  const punctuation = reconcileCaptionWordTiming(before, { ...before, text: 'ខ្មែរ   AI?' });
  assert.ok(punctuation.wordTiming);
  assert.equal(resolveCaptionWordTiming(punctuation).state, 'ready');
  assert.deepEqual(punctuation.wordTiming.words.map((word) => word.startMs), [1_050, 1_420]);
  assert.deepEqual(punctuation.wordTiming.words.map((word) => punctuation.text.slice(word.startOffset, word.endOffset)), ['ខ្មែរ', 'AI?']);

  const spelling = reconcileCaptionWordTiming(before, { ...before, text: 'ខ្មែរ AGI!' });
  assert.ok(spelling.wordTiming);
  assert.equal(spelling.wordTiming.words[0].needsReview, undefined);
  assert.equal(spelling.wordTiming.words[1].startMs, 1_420);
  assert.equal(spelling.wordTiming.words[1].needsReview, true);
  assert.equal(resolveCaptionWordTiming(spelling).state, 'partial');
});

test('changed word counts never invent timing and repeated-word ambiguity invalidates the affected occurrence', () => {
  const before = caption({ text: 'go now' });
  before.wordTiming = buildCaptionWordTiming(before, [
    token({ id: 'go', text: 'go', startMs: 1_050, endMs: 1_250, spaceBefore: false }),
    token({ id: 'now', text: 'now', startMs: 1_350, endMs: 1_650, spaceBefore: true }),
  ]);
  assert.ok(before.wordTiming);
  const inserted = reconcileCaptionWordTiming(before, { ...before, text: 'go right now' });
  assert.ok(inserted.wordTiming);
  assert.deepEqual(inserted.wordTiming.words.map((word) => inserted.text.slice(word.startOffset, word.endOffset)), ['go', 'right', 'now']);
  assert.equal(inserted.wordTiming.words[0].startMs, 1_050);
  assert.equal(inserted.wordTiming.words[1].startMs, null);
  assert.equal(inserted.wordTiming.words[2].startMs, 1_350);
  assert.equal(resolveCaptionWordTiming(inserted).state, 'partial');

  const repeated = caption({ text: 'go go now' });
  repeated.wordTiming = buildCaptionWordTiming(repeated, [
    token({ id: 'go-1', text: 'go', startMs: 1_020, endMs: 1_180, spaceBefore: false }),
    token({ id: 'go-2', text: 'go', startMs: 1_220, endMs: 1_380, spaceBefore: true }),
    token({ id: 'now', text: 'now', startMs: 1_450, endMs: 1_700, spaceBefore: true }),
  ]);
  assert.ok(repeated.wordTiming);
  const deleted = reconcileCaptionWordTiming(repeated, { ...repeated, text: 'go now' });
  assert.ok(deleted.wordTiming);
  assert.equal(deleted.wordTiming.words[0].startMs, null);
  assert.equal(deleted.wordTiming.words[0].needsReview, true);
  assert.equal(deleted.wordTiming.words[1].id, 'now');
  assert.equal(resolveCaptionWordTiming(deleted).state, 'partial');
});

test('uniform cue moves translate word times while edge trims do not stretch them', () => {
  const before = caption();
  before.wordTiming = buildCaptionWordTiming(before, sourceTokens());
  assert.ok(before.wordTiming);

  const moved = reconcileCaptionWordTiming(before, { ...before, startMs: 1_250, endMs: 2_250 });
  assert.ok(moved.wordTiming);
  assert.deepEqual(moved.wordTiming.words.map((word) => [word.startMs, word.endMs]), [
    [1_300, 1_600],
    [1_670, 1_950],
  ]);
  assert.equal(resolveCaptionWordTiming(moved).state, 'ready');

  const trimmed = reconcileCaptionWordTiming(before, { ...before, startMs: 1_200 });
  assert.ok(trimmed.wordTiming);
  assert.equal(trimmed.wordTiming.words[0].startMs, 1_050);
  assert.equal(trimmed.wordTiming.words[0].needsReview, true);
  assert.equal(resolveCaptionWordTiming(trimmed).state, 'partial');
});

test('reconcile keeps no-ops cheap and respects an explicit word-timing clear', () => {
  const before = caption();
  before.wordTiming = buildCaptionWordTiming(before, sourceTokens());
  assert.ok(before.wordTiming);

  assert.equal(reconcileCaptionWordTiming(before, before), before);
  const unchanged = { ...before };
  assert.equal(reconcileCaptionWordTiming(before, unchanged), unchanged);
  assert.equal(unchanged.wordTiming, before.wordTiming);

  const cleared: CaptionSegment = { ...before, wordTiming: undefined };
  const result = reconcileCaptionWordTiming(before, cleared);
  assert.equal(result, cleared);
  assert.equal(result.wordTiming, undefined);
});

test('manual word edits respect cue bounds, neighbors and timing locks', () => {
  const source = caption();
  source.wordTiming = buildCaptionWordTiming(source, sourceTokens());
  assert.ok(source.wordTiming);

  const edited = editCaptionWord(source, 'khmer', { startMs: 1_020, endMs: 1_400 });
  assert.notEqual(edited, source);
  assert.equal(edited.wordTiming?.words[0].source, 'manual');
  assert.equal(edited.wordTiming?.words[0].needsReview, undefined);
  assert.equal(edited.timingSource, 'manual');
  assert.equal(edited.timingQuality, 'medium');
  assert.equal(edited.approved, false);
  assert.equal(resolveCaptionWordTiming(edited).state, 'ready');

  assert.equal(editCaptionWord(source, 'khmer', { startMs: 1_020, endMs: 1_500 }), source);
  assert.equal(editCaptionWord(source, 'khmer', { startMs: 900, endMs: 1_300 }), source);
  assert.equal(editCaptionWord({ ...source, timingLocked: true }, 'khmer', { startMs: 1_020, endMs: 1_300 }).wordTiming, source.wordTiming);
});

test('manual-start timing is explicit, quantized, and can confirm a tentative same interval', () => {
  const source = caption();
  const punctuationOnly = caption({ text: '…?!' });
  assert.equal(createUntimedCaptionWordTiming(punctuationOnly), punctuationOnly);
  const untimed = createUntimedCaptionWordTiming(source);
  assert.ok(untimed.wordTiming);
  assert.equal(resolveCaptionWordTiming(untimed).state, 'partial');
  assert.deepEqual(untimed.wordTiming.words.map((word) => [word.startMs, word.endMs, word.source]), [
    [null, null, 'estimated'],
    [null, null, 'estimated'],
  ]);

  const first = untimed.wordTiming.words[0];
  const manuallyTimed = editCaptionWord(untimed, first.id, { startMs: 1_054, endMs: 1_346 });
  assert.deepEqual(
    [manuallyTimed.wordTiming?.words[0].startMs, manuallyTimed.wordTiming?.words[0].endMs, manuallyTimed.wordTiming?.words[0].source],
    [1_050, 1_350, 'manual'],
  );
  assert.equal(editCaptionWord(untimed, first.id, { startMs: 1_051, endMs: 1_054 }), untimed);

  const aligned = caption();
  aligned.wordTiming = buildCaptionWordTiming(aligned, sourceTokens());
  assert.ok(aligned.wordTiming);
  const tentative = reconcileCaptionWordTiming(aligned, { ...aligned, text: 'ខ្មែរ AGI!' });
  const changed = tentative.wordTiming!.words[1];
  assert.equal(changed.needsReview, true);
  const confirmed = editCaptionWord(tentative, changed.id, { startMs: changed.startMs!, endMs: changed.endMs! });
  assert.equal(confirmed.wordTiming?.words[1].source, 'manual');
  assert.equal(confirmed.wordTiming?.words[1].needsReview, undefined);
  assert.equal(resolveCaptionWordTiming(confirmed).state, 'ready');
});
