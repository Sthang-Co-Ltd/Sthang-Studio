import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptionWordTiming, type CaptionProject, type CaptionSegment, type TimedToken } from '../packages/shared/src/index.js';
import { preserveCaptionLocks } from '../apps/server/src/services/caption-locks.js';
import {
  CaptionWordTimingBusyError,
  CaptionWordTimingConflictError,
  CaptionWordTimingInputError,
  captionWordTimingRevision,
  hydrateProjectWordTimings,
  syncCaptionWordsLocally,
  type CaptionWordTimingDependencies,
} from '../apps/server/src/services/caption-word-timing.js';
import { segmentTimedTokens } from '../apps/server/src/services/segmenter.js';
import { createVideoExportCaptionSnapshot } from '../apps/server/src/services/video-export.js';

function token(id: string, text: string, startMs: number, endMs: number, spaceBefore: boolean): TimedToken {
  return { id, text, startMs, endMs, spaceBefore, timingSource: 'stt' };
}

function projectFixture(id = 'word-sync-project') {
  const tokens = [
    token('hello', 'hello', 1_050, 1_300, false),
    token('world', 'world', 1_420, 1_700, true),
  ];
  const caption = segmentTimedTokens(tokens, { mode: 'single-line' })[0];
  const project: CaptionProject = {
    id,
    title: 'Word sync fixture',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 1234, url: `/media/${id}.mp4` },
    transcript: {
      language: 'en',
      fullText: 'hello world',
      tokens,
      segments: [caption],
      timing: {
        engine: 'kfa-local', provider: 'local', model: 'fixture', sttTranscript: 'hello world', audioDurationMs: 5_000,
        totalTokens: 2, anchoredTokens: 2, interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1,
      },
    },
    captions: [caption],
    mode: 'single-line',
    engineVersion: 'test',
  };
  return { project, caption };
}

function fakeDependencies(getProject: CaptionWordTimingDependencies['getProject'], overrides: Partial<CaptionWordTimingDependencies> = {}) {
  let cleaned = 0;
  const dependencies: CaptionWordTimingDependencies = {
    getProject,
    ensureNormalizedAudio: async (project) => ({
      dir: `cache/${project.id}`,
      outputPath: `cache/${project.id}/normalized.wav`,
      durationMs: 5_000,
      fingerprint: 'fixture-media',
      cacheHit: true,
      cachedAt: '2026-09-19T00:00:00.000Z',
    }),
    makeAudioChunk: async (_source, outputPath, _startMs, durationMs) => ({ outputPath, durationMs, cacheHit: true, directSource: false }),
    alignTimingLocally: async () => ({
      transcript: 'hello world',
      words: [
        { text: 'hello', startMs: 150, endMs: 400, confidence: 0.99 },
        { text: 'world', startMs: 520, endMs: 700, confidence: 0.99 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
    removeWorkingDir: async () => { cleaned += 1; },
    ...overrides,
  };
  return { dependencies, cleaned: () => cleaned };
}

test('server segmentation persists exact spoken-word timing for each generated cue', () => {
  const captions = segmentTimedTokens([
    token('hello', 'hello', 100, 260, false),
    token('world', 'world', 340, 600, true),
  ], { mode: 'single-line' });

  assert.equal(captions.length, 1);
  assert.deepEqual(captions[0].wordTiming?.words.map((word) => [word.id, word.startMs, word.endMs]), [
    ['hello', 100, 260],
    ['world', 340, 600],
  ]);
  assert.equal(resolveCaptionWordTiming(captions[0]).state, 'ready');
});

test('text locks adopt fresh generated word anchors when exact locked wording still matches', () => {
  const existing = segmentTimedTokens([
    token('old-hello', 'hello', 100, 260, false),
    token('old-world', 'world', 340, 600, true),
  ], { mode: 'single-line' })[0];
  existing.textLocked = true;

  const generated = segmentTimedTokens([
    token('new-hello', 'hello', 120, 280, false),
    token('new-world', 'world', 500, 700, true),
  ], { mode: 'single-line' })[0];
  const [preserved] = preserveCaptionLocks([existing], [generated]);

  assert.equal(preserved.text, existing.text);
  assert.deepEqual(preserved.wordTiming?.words.map((word) => [word.id, word.startMs, word.endMs]), [
    ['new-hello', 120, 280],
    ['new-world', 500, 700],
  ]);
  assert.equal(resolveCaptionWordTiming(preserved).state, 'ready');
});

test('timing locks keep existing word anchors even when regeneration has newer anchors', () => {
  const existing = segmentTimedTokens([
    token('old-hello', 'hello', 100, 260, false),
    token('old-world', 'world', 340, 600, true),
  ], { mode: 'single-line' })[0];
  existing.timingLocked = true;

  const generated = segmentTimedTokens([
    token('new-hello', 'hello', 120, 280, false),
    token('new-world', 'world', 500, 700, true),
  ], { mode: 'single-line' })[0];
  const [preserved] = preserveCaptionLocks([existing], [generated]);

  assert.deepEqual(preserved.wordTiming?.words.map((word) => [word.id, word.startMs, word.endMs]), [
    ['old-hello', 100, 260],
    ['old-world', 340, 600],
  ]);
  assert.equal(resolveCaptionWordTiming(preserved).state, 'ready');
});

test('word timing and locks participate in the server stale-response revision', () => {
  const basis = segmentTimedTokens([
    token('hello', 'hello', 100, 260, false),
    token('world', 'world', 340, 600, true),
  ], { mode: 'single-line' })[0] as CaptionSegment;
  const revision = captionWordTimingRevision(basis);
  assert.equal(captionWordTimingRevision(structuredClone(basis)), revision);

  const changedWord = structuredClone(basis);
  changedWord.wordTiming!.words[0].startMs = 110;
  assert.notEqual(captionWordTimingRevision(changedWord), revision);
  assert.notEqual(captionWordTimingRevision({ ...basis, timingLocked: true }), revision);
  assert.notEqual(captionWordTimingRevision({ ...basis, textLocked: true }), revision);
});

test('pure project hydration and the export snapshot add legacy word timing without mutating project state', () => {
  const { project } = projectFixture('legacy-export');
  const legacy = structuredClone(project);
  delete legacy.captions[0].wordTiming;
  assert.equal(legacy.captions[0].wordTiming, undefined);

  const hydrated = hydrateProjectWordTimings(legacy);
  assert.notEqual(hydrated, legacy);
  assert.equal(resolveCaptionWordTiming(hydrated.captions[0]).state, 'ready');
  assert.equal(legacy.captions[0].wordTiming, undefined);

  const snapshot = createVideoExportCaptionSnapshot(legacy);
  assert.equal(resolveCaptionWordTiming(snapshot[0]).state, 'ready');
  assert.notEqual(snapshot[0], hydrated.captions[0]);
  assert.equal(legacy.captions[0].wordTiming, undefined);

  const unsynced = { ...legacy, transcriptNeedsSync: true };
  assert.equal(hydrateProjectWordTimings(unsynced), unsynced);
  assert.equal(createVideoExportCaptionSnapshot(unsynced)[0].wordTiming, undefined);
});

test('sync rejects oversized captions and timing locks before any local heavy work', async () => {
  const { project, caption } = projectFixture('bounds');
  let reads = 0;
  const { dependencies } = fakeDependencies(async () => { reads += 1; return structuredClone(project); });

  await assert.rejects(
    syncCaptionWordsLocally(project.id, { ...caption, endMs: caption.startMs + 60_001 }, project.media, dependencies),
    CaptionWordTimingInputError,
  );
  await assert.rejects(
    syncCaptionWordsLocally(project.id, { ...caption, text: 'x'.repeat(2_001) }, project.media, dependencies),
    CaptionWordTimingInputError,
  );
  assert.equal(reads, 0);

  const locked = { ...caption, timingLocked: true };
  const lockedProject = { ...project, captions: [locked] };
  let aligned = 0;
  const lockedDeps = fakeDependencies(async () => structuredClone(lockedProject), {
    alignTimingLocally: async () => { aligned += 1; throw new Error('must not align'); },
  }).dependencies;
  await assert.rejects(syncCaptionWordsLocally(project.id, locked, project.media, lockedDeps), CaptionWordTimingConflictError);
  assert.equal(aligned, 0);
});

test('sync discards a candidate when the saved caption word revision changes during local alignment', async () => {
  const { project, caption } = projectFixture('stale-word');
  const changed = structuredClone(project);
  changed.captions[0].wordTiming!.words[0].startMs! += 10;
  let reads = 0;
  const { dependencies, cleaned } = fakeDependencies(async () => {
    reads += 1;
    return structuredClone(reads >= 3 ? changed : project);
  });

  await assert.rejects(syncCaptionWordsLocally(project.id, caption, project.media, dependencies), CaptionWordTimingConflictError);
  assert.equal(reads, 3);
  assert.equal(cleaned(), 1);
});

test('only one local spoken-word sync can consume heavy timing work at a time', async () => {
  const { project, caption } = projectFixture('concurrency');
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const base = fakeDependencies(async () => structuredClone(project));
  const dependencies: CaptionWordTimingDependencies = {
    ...base.dependencies,
    alignTimingLocally: async (..._args) => {
      startedResolve();
      await release;
      return base.dependencies.alignTimingLocally('', '', '');
    },
  };

  const first = syncCaptionWordsLocally(project.id, caption, project.media, dependencies);
  await started;
  await assert.rejects(syncCaptionWordsLocally(project.id, caption, project.media, dependencies), CaptionWordTimingBusyError);
  releaseResolve();
  const result = await first;
  assert.equal(resolveCaptionWordTiming({ ...caption, wordTiming: result.wordTiming }).state, 'ready');
  assert.equal(base.cleaned(), 1);
});

test('fallback warnings stay user-facing and do not expose timing engine/provider names', async () => {
  const { project, caption } = projectFixture('warning-copy');
  const base = fakeDependencies(async () => structuredClone(project));
  const dependencies: CaptionWordTimingDependencies = {
    ...base.dependencies,
    alignTimingLocally: async () => ({
      transcript: 'hello world',
      words: [
        { text: 'hello', startMs: 150, endMs: 400, confidence: 0.99 },
        { text: 'world', startMs: 520, endMs: 700, confidence: 0.99 },
      ],
      engine: 'faster-whisper-local', provider: 'local', model: 'hidden-provider-name', directAlignment: false,
      fallbackReason: 'synthetic primary timing failure',
    }),
  };
  const result = await syncCaptionWordsLocally(project.id, caption, project.media, dependencies);
  assert.ok(result.warnings?.some((warning) => warning.includes('local timing fallback')));
  assert.equal(result.warnings?.some((warning) => /kfa|whisper|provider|model/i.test(warning)), false);
});

test('local word sync gives short cues enough acoustic context without crossing media bounds', async () => {
  const cases = [
    { name: 'interior', mediaDurationMs: 5_000, startMs: 2_000, endMs: 2_200, expectedStart: 1_700, expectedDuration: 800 },
    { name: 'near-start', mediaDurationMs: 5_000, startMs: 50, endMs: 250, expectedStart: 0, expectedDuration: 800 },
    { name: 'near-end', mediaDurationMs: 5_000, startMs: 4_750, endMs: 4_950, expectedStart: 4_200, expectedDuration: 800 },
    { name: 'longer-cue', mediaDurationMs: 5_000, startMs: 1_000, endMs: 2_000, expectedStart: 900, expectedDuration: 1_200 },
    { name: 'short-source', mediaDurationMs: 600, startMs: 100, endMs: 300, expectedStart: 0, expectedDuration: 600 },
  ];

  for (const item of cases) {
    await test(item.name, async () => {
      const basis: CaptionSegment = { id: `window-${item.name}`, startMs: item.startMs, endMs: item.endMs, text: 'hello' };
      const project: CaptionProject = {
        id: `window-${item.name}`,
        title: 'Word timing window fixture',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
        media: { filename: `${item.name}.mp4`, originalName: `${item.name}.mp4`, mimeType: 'video/mp4', size: 1, url: `/media/${item.name}.mp4` },
        transcript: null,
        captions: [basis],
        mode: 'single-line',
      };
      let chunkStart = -1;
      let chunkDuration = -1;
      let whisperFallbackAllowed: boolean | undefined;
      const dependencies = fakeDependencies(async () => structuredClone(project), {
        ensureNormalizedAudio: async () => ({
          dir: `cache/${project.id}`,
          outputPath: `cache/${project.id}/normalized.wav`,
          durationMs: item.mediaDurationMs,
          fingerprint: 'fixture-media',
          cacheHit: true,
          cachedAt: '2026-09-23T00:00:00.000Z',
        }),
        makeAudioChunk: async (_source, outputPath, startMs, durationMs) => {
          chunkStart = startMs;
          chunkDuration = durationMs;
          return { outputPath, durationMs, cacheHit: true, directSource: false };
        },
        alignTimingLocally: async (_wavPath, _workDir, _transcript, _cacheNamespace, options) => {
          whisperFallbackAllowed = options?.allowWhisperFallback;
          return {
            transcript: 'hello',
            words: [{
              text: 'hello',
              startMs: Math.max(0, item.startMs - chunkStart + 10),
              endMs: Math.min(chunkDuration, item.endMs - chunkStart - 10),
              confidence: 0.99,
            }],
            engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
          };
        },
      }).dependencies;

      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
      assert.equal(chunkStart, item.expectedStart);
      assert.equal(chunkDuration, item.expectedDuration);
      assert.equal(whisperFallbackAllowed, false);
      assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, 'ready');
    });
  }
});

test('local word sync automatically trims trustworthy edge spill to the caption interval', async () => {
  const text = 'hello world';
  const basis: CaptionSegment = { id: 'edge-spill', startMs: 1_000, endMs: 1_500, text };
  const project: CaptionProject = {
    id: 'edge-spill-sync',
    title: 'Word timing edge spill fixture',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    media: { filename: 'edge-spill.mp4', originalName: 'edge-spill.mp4', mimeType: 'video/mp4', size: 2222, url: '/media/edge-spill.mp4' },
    transcript: null,
    captions: [basis],
    mode: 'single-line',
  };
  const dependencies = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async () => ({
      transcript: text,
      words: [
        { text: 'hello', startMs: 100, endMs: 320, confidence: 0.99 },
        { text: 'world', startMs: 430, endMs: 700, confidence: 0.99 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'ready');
  assert.equal(result.wordTiming.words[0].startMs, basis.startMs);
  assert.equal(result.wordTiming.words.at(-1)?.endMs, basis.endMs);
  assert.equal(result.wordTiming.words.some((word) => word.needsReview), false);
});

test('local word sync keeps wholly out-of-cue evidence review-required instead of pulling it into the caption', async () => {
  const text = 'hello world';
  const basis: CaptionSegment = { id: 'outside-evidence', startMs: 1_000, endMs: 1_500, text };
  const project: CaptionProject = {
    id: 'outside-evidence-sync',
    title: 'Word timing outside evidence fixture',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    media: { filename: 'outside-evidence.mp4', originalName: 'outside-evidence.mp4', mimeType: 'video/mp4', size: 3333, url: '/media/outside-evidence.mp4' },
    transcript: null,
    captions: [basis],
    mode: 'single-line',
  };
  const dependencies = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async () => ({
      transcript: text,
      words: [
        { text: 'hello', startMs: 0, endMs: 40, confidence: 0.99 },
        { text: 'world', startMs: 300, endMs: 420, confidence: 0.99 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'partial');
  assert.ok((result.wordTiming.words[0].startMs ?? basis.startMs) < basis.startMs);
});

test('exact direct KFA unions stay aligned without treating raw path score as ASR confidence', async () => {
  const text = 'notebook';
  const basis: CaptionSegment = { id: 'direct-union', startMs: 1_000, endMs: 1_800, text };
  const project: CaptionProject = {
    id: 'direct-union-sync',
    title: 'Direct KFA union fixture',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    media: { filename: 'direct-union.mp4', originalName: 'direct-union.mp4', mimeType: 'video/mp4', size: 4444, url: '/media/direct-union.mp4' },
    transcript: null,
    captions: [basis],
    mode: 'single-line',
  };
  const dependencies = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async () => ({
      transcript: text,
      words: [
        { text: 'note', startMs: 120, endMs: 360, confidence: 0.08 },
        { text: 'book', startMs: 390, endMs: 650, confidence: 0.12 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'ready');
  assert.equal(result.wordTiming.words.length, 1);
  assert.equal(result.wordTiming.words[0].source, 'aligned');
  assert.equal(result.wordTiming.words[0].needsReview, undefined);
});

test('exact direct KFA still marks proportional one-anchor text splits for review', async () => {
  const text = 'note book';
  const basis: CaptionSegment = { id: 'direct-split', startMs: 1_000, endMs: 1_800, text };
  const project: CaptionProject = {
    id: 'direct-split-sync',
    title: 'Direct KFA split fixture',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    media: { filename: 'direct-split.mp4', originalName: 'direct-split.mp4', mimeType: 'video/mp4', size: 5555, url: '/media/direct-split.mp4' },
    transcript: null,
    captions: [basis],
    mode: 'single-line',
  };
  const dependencies = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async () => ({
      transcript: text,
      words: [{ text: 'notebook', startMs: 120, endMs: 650, confidence: 0.99 }],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'partial');
  assert.ok(result.wordTiming.words.every((word) => word.source === 'estimated' && word.needsReview));
});

test('local sync rebuilds exact Khmer spaces and trailing punctuation after alignment spacing normalization', async () => {
  const text = 'ខ្មែរ ស្រឡាញ់ កម្ពុជា!';
  const basis: CaptionSegment = { id: 'exact-khmer', startMs: 1_000, endMs: 2_500, text };
  const project: CaptionProject = {
    id: 'exact-khmer-sync',
    title: 'Exact Khmer sync fixture',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    media: { filename: 'exact-khmer.mp4', originalName: 'exact-khmer.mp4', mimeType: 'video/mp4', size: 4321, url: '/media/exact-khmer.mp4' },
    transcript: null,
    captions: [basis],
    mode: 'phrase',
  };
  const dependencies = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async () => ({
      transcript: text,
      words: [
        { text: 'ខ្មែរ', startMs: 150, endMs: 390, confidence: 0.99 },
        { text: 'ស្រឡាញ់', startMs: 430, endMs: 740, confidence: 0.99 },
        { text: 'កម្ពុជា!', startMs: 780, endMs: 1_130, confidence: 0.99 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'ready');
  assert.equal(result.wordTiming.text, text);
  assert.deepEqual(result.wordTiming.words.map((word) => text.slice(word.startOffset, word.endOffset)), ['ខ្មែរ', 'ស្រឡាញ់', 'កម្ពុជា!']);
  assert.equal(text.slice(result.wordTiming.words[0].endOffset, result.wordTiming.words[1].startOffset), ' ');
  assert.equal(text.slice(result.wordTiming.words[1].endOffset, result.wordTiming.words[2].startOffset), ' ');
});
