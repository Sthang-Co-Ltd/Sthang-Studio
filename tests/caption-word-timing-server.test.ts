import test from 'node:test';
import assert from 'node:assert/strict';
import { planCaptionRenderStates, resolveCaptionWordTiming, type CaptionProject, type CaptionSegment, type TimedToken } from '../packages/shared/src/index.js';
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

test('direct word sync clips measured cue edges beyond the small-repair limit and keeps interior intervals', async () => {
  const text = 'hello bright world';
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
        { text: 'hello', startMs: 52, endMs: 216, confidence: 0.99 },
        { text: 'bright', startMs: 300, endMs: 411, confidence: 0.99 },
        { text: 'world', startMs: 570, endMs: 730, confidence: 0.99 },
      ],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'ready');
  assert.deepEqual(result.wordTiming.words.map(({ startMs, endMs }) => [startMs, endMs]), [
    [1_000, 1_066], [1_150, 1_261], [1_420, 1_500],
  ]);
  assert.equal(result.wordTiming.words.some((word) => word.needsReview), false);
});

test('direct word sync leaves words outside the cue or with too little in-cue evidence for review', async (t) => {
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
  for (const [label, endMs] of [['wholly outside', 40], ['6 ms in the cue', 156]] as const) {
    await t.test(label, async () => {
      const dependencies = fakeDependencies(async () => structuredClone(project), {
        alignTimingLocally: async () => ({
          transcript: text,
          words: [
            { text: 'hello', startMs: 0, endMs, confidence: 0.99 },
            { text: 'world', startMs: 300, endMs: 420, confidence: 0.99 },
          ],
          engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
        }),
      }).dependencies;
      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
      assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, 'partial');
      assert.equal(result.wordTiming.words[0].startMs, 850);
      assert.equal(result.wordTiming.words[0].endMs, 850 + endMs);
    });
  }
});

test('short out-of-cue speech gets a guarded, opt-in suggestion from the adjoining audio', async (t) => {
  const basis: CaptionSegment = { id: 'short', startMs: 1_600, endMs: 1_800, text: 'one two three four', approved: true };
  const previous: CaptionSegment = { id: 'left', startMs: 800, endMs: 1_600, text: 'before', approved: true };
  const next: CaptionSegment = { id: 'right', startMs: 2_250, endMs: 2_600, text: 'after', approved: true };
  const ownWords = [
    { text: 'one', startMs: 150, endMs: 210 },
    { text: 'two', startMs: 230, endMs: 310 },
    { text: 'three', startMs: 330, endMs: 420 },
    { text: 'four', startMs: 450, endMs: 570 },
  ];

  for (const variant of ['supported', 'automatic batch', 'locked neighbor', 'changed neighbor', 'disagreeing measurement'] as const) {
    await t.test(variant, async () => {
      const { project } = projectFixture('short-cue-neighborhood');
      project.transcript = null;
      project.captions = [previous, basis, next].map((cue) => ({ ...cue }));
      if (variant === 'locked neighbor') project.captions[0].timingLocked = true;
      let reads = 0;
      let alignments = 0;
      const { dependencies } = fakeDependencies(async () => {
        const snapshot = structuredClone(project);
        if (++reads === 3 && variant === 'changed neighbor') snapshot.captions[0].text = 'a newer edit';
        return snapshot;
      }, {
        alignTimingLocally: async (_path, _work, transcript, _namespace, options) => {
          alignments += 1;
          assert.equal(options?.allowWhisperFallback, false);
          const words = transcript === basis.text ? ownWords : [
            { text: 'before', startMs: 140, endMs: 680 },
            ...ownWords.map((word, index) => ({
              ...word,
              startMs: word.startMs + (variant === 'disagreeing measurement' && index === 0 ? 505 : 600),
              endMs: word.endMs + 600,
            })),
            { text: 'after', startMs: 1_560, endMs: 1_800 },
          ];
          return { transcript, words, engine: 'kfa-local', provider: 'local', model: 'fixture', directAlignment: true };
        },
      });

      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies, variant !== 'automatic batch');
      assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, 'partial');
      assert.equal(alignments, 2);
      if (variant !== 'supported') {
        assert.equal(result.edgeRepair, undefined);
        return;
      }
      assert.ok(result.edgeRepair);
      assert.deepEqual(result.edgeRepair.before, [previous, basis]);
      assert.deepEqual(result.edgeRepair.guards, [next]);
      assert.deepEqual(result.edgeRepair.after.map((cue) => [cue.id, cue.startMs, cue.endMs, cue.approved]), [
        ['left', 800, 1_415, false], ['short', 1_415, 1_870, false],
      ]);
      assert.ok(result.edgeRepair.after.every((cue) => resolveCaptionWordTiming(cue).state === 'ready'));
      assert.deepEqual(project.captions, [previous, basis, next]);
    });
  }
});

test('automatic word sync recovers a short cue when bounded and contextual measurements agree', async (t) => {
  const basis: CaptionSegment = { id: 'short', startMs: 1_600, endMs: 1_960, text: 'hello world', approved: true };
  const previous: CaptionSegment = { id: 'left', startMs: 800, endMs: 1_560, text: 'before' };
  const next: CaptionSegment = { id: 'right', startMs: 2_220, endMs: 2_450, text: 'after' };
  for (const variant of ['agreement', 'remeasured compound', 'unmeasured compound', 'disagreement', 'large spill', 'newer neighbor edit'] as const) {
    await t.test(variant, async () => {
      const { project } = projectFixture('bounded-word-sync');
      project.transcript = null;
      project.captions = [previous, basis, next];
      const windows: Array<[number, number]> = [];
      const requests: string[] = [];
      const compound = variant === 'remeasured compound' || variant === 'unmeasured compound';
      let reads = 0;
      const { dependencies } = fakeDependencies(async () => {
        const current = structuredClone(project);
        if (++reads === 3 && variant === 'newer neighbor edit') current.captions[0].text = 'newer wording';
        return current;
      }, {
        makeAudioChunk: async (_source, outputPath, startMs, durationMs) => {
          windows.push([startMs, startMs + durationMs]);
          return { outputPath, durationMs, cacheHit: true, directSource: false };
        },
        alignTimingLocally: async (_path, _work, transcript, _namespace, options) => {
          assert.equal(options?.allowWhisperFallback, false);
          requests.push(transcript);
          const measured = windows.length === 1 ? [
            { text: 'hello', startMs: 90, endMs: 190 },
            { text: 'world', startMs: 215, endMs: 550 },
          ] : windows.length === 2 ? [
            { text: 'before', startMs: 150, endMs: 865 },
            { text: 'hello', startMs: 892, endMs: 1_054 },
            { text: 'world', startMs: 1_074, endMs: 1_256 },
            { text: 'after', startMs: 1_520, endMs: 1_710 },
          ] : [
            { text: 'hello', startMs: variant === 'large spill' ? 10 : compound ? 21 : 41, endMs: 188 },
            { text: 'world', startMs: 208, endMs: variant === 'disagreement' ? 334 : 374 },
          ];
          const words = windows.length === 1 && compound && (transcript === basis.text || variant === 'unmeasured compound')
            ? [{ text: 'helloworld', startMs: 90, endMs: 550 }] : measured;
          return { transcript, words, engine: 'kfa-local', provider: 'local', model: 'fixture', directAlignment: true };
        },
      });
      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
      if (variant === 'unmeasured compound') {
        assert.deepEqual(windows, [[1_380, 2_180]]);
        assert.deepEqual(requests, [basis.text, 'hello\nworld']);
      } else {
        assert.deepEqual(windows, [[1_380, 2_180], [700, 2_550], [1_560, 2_180]]);
        if (compound) assert.deepEqual(requests, [basis.text, 'hello\nworld', 'before\nhello\nworld\nafter', 'hello\nworld']);
      }
      assert.equal(result.edgeRepair, undefined);
      assert.deepEqual(result.basis, basis);
      const ready = variant === 'agreement' || variant === 'remeasured compound';
      assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, ready ? 'ready' : 'partial');
      if (ready) {
        assert.deepEqual(result.wordTiming.words.map(({ startMs, endMs }) => [startMs, endMs]), [
          [compound ? 1_600 : 1_601, 1_748], [1_768, 1_934],
        ]);
      }
    });
  }
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
      words: [{ text: 'notebook', startMs: 20, endMs: 650, confidence: 0.99 }],
      engine: 'kfa-local', provider: 'local', model: 'fake-local', directAlignment: true,
    }),
  }).dependencies;

  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  const resolved = resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming });
  assert.equal(resolved.state, 'partial');
  assert.ok(result.wordTiming.words.every((word) => word.source === 'estimated' && word.needsReview));
  assert.ok(result.wordTiming.words[0].startMs! < basis.startMs);
});

test('word sync replaces an exact compound split only with a consistent new measurement', async (t) => {
  const text = 'hello note book world';
  const basis: CaptionSegment = { id: 'remeasured-split', startMs: 1_000, endMs: 2_000, text, approved: true };
  const { project } = projectFixture('remeasured-split-project');
  project.transcript = null;
  project.captions = [basis];
  const original = [
    { text: 'hello', startMs: 160, endMs: 270 },
    { text: 'notebook', startMs: 340, endMs: 650 },
    { text: 'world', startMs: 710, endMs: 950 },
  ];
  const measured = [
    { text: 'hello', startMs: 140, endMs: 260 },
    { text: 'note', startMs: 340, endMs: 460 },
    { text: 'book', startMs: 480, endMs: 650 },
    { text: 'world', startMs: 730, endMs: 910 },
  ];
  const variants = [
    { name: 'matching measured span', words: measured, ready: true },
    { name: 'shifted span', words: measured.map((word) => word.text === 'note' ? { ...word, startMs: 310 } : word) },
    { name: 'overlapping words', words: measured.map((word) => word.text === 'note' ? { ...word, endMs: 490 } : word) },
    { name: 'missing word', words: measured.filter((word) => word.text !== 'book') },
    { name: 'second pass failed', words: null },
  ];

  for (const { name, words, ready } of variants) {
    await t.test(name, async () => {
      const requests: string[] = [];
      const { dependencies } = fakeDependencies(async () => structuredClone(project), {
        alignTimingLocally: async (_audio, _work, transcript, _namespace, options) => {
          requests.push(transcript);
          assert.equal(options?.allowWhisperFallback, false);
          const result = requests.length === 1 ? original : words;
          if (!result) throw new Error('Synthetic second pass failed');
          return { transcript, words: result, engine: 'kfa-local', provider: 'local', model: 'fixture', directAlignment: true };
        },
      });
      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
      assert.deepEqual(requests, [text, 'hello\nnote\nbook\nworld']);
      assert.deepEqual(result.basis, basis);
      assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, ready ? 'ready' : 'partial');
      assert.deepEqual(result.wordTiming.words.map((word) => word.source),
        ready ? ['aligned', 'aligned', 'aligned', 'aligned'] : ['aligned', 'estimated', 'estimated', 'aligned']);
      if (ready) {
        assert.deepEqual(result.wordTiming.words.map(({ startMs, endMs }) => [startMs, endMs]), [
          [1_060, 1_170], [1_240, 1_360], [1_380, 1_550], [1_610, 1_850],
        ]);
      }
    });
  }
});

test('word sync keeps a confirmed pause inside a display word and preserves the surrounding measured word', async (t) => {
  const text = 'alpha notebook tail';
  const basis: CaptionSegment = { id: 'measured-pause', startMs: 1_000, endMs: 1_840, text, approved: true };
  const { project } = projectFixture('measured-pause-project');
  project.transcript = null;
  project.captions = [basis];
  const original = [
    { text: 'alphan', startMs: 20, endMs: 245 },
    { text: 'ote', startMs: 285, endMs: 489 },
    { text: 'book', startMs: 734, endMs: 836 },
    { text: 'tail', startMs: 856, endMs: 958 },
  ];
  const separated = [
    { text: 'alpha', startMs: 20, endMs: 184 },
    { text: 'note', startMs: 204, endMs: 489 },
    { text: 'book', startMs: 734, endMs: 836 },
    { text: 'tail', startMs: 866, endMs: 950 },
  ];

  for (const variant of ['confirmed pause', 'drifting pause', 'short gap', 'changed wording', 'word wholly outside'] as const) {
    await t.test(variant, async () => {
      const requests: string[] = [];
      const { dependencies } = fakeDependencies(async () => structuredClone(project), {
        alignTimingLocally: async (_audio, _work, transcript) => {
          requests.push(transcript);
          const words = structuredClone(requests.length === 1 ? original : separated);
          if (variant === 'short gap') words[1].endMs = 650;
          if (requests.length === 2) {
            if (variant === 'drifting pause') words[1].endMs = 525;
            if (variant === 'changed wording') words[2].text = 'books';
            if (variant === 'word wholly outside') words[0].endMs = 80;
          }
          return { transcript, words, engine: 'kfa-local', provider: 'local', model: 'fixture', directAlignment: true };
        },
      });
      const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
      assert.deepEqual(requests, [text, 'alpha\nnotebook\ntail']);
      assert.deepEqual(result.basis, basis);
      const caption = { ...basis, wordTiming: result.wordTiming };
      if (variant !== 'confirmed pause') {
        assert.equal(resolveCaptionWordTiming(caption).state, 'partial');
        return;
      }
      assert.equal(resolveCaptionWordTiming(caption).state, 'ready');
      assert.deepEqual(result.wordTiming.words.map((word) => [text.slice(word.startOffset, word.endOffset), word.startMs, word.endMs]), [
        ['alpha', 1_000, 1_084], ['note', 1_104, 1_389], ['book', 1_634, 1_736], ['tail', 1_756, 1_840],
      ]);
      const states = planCaptionRenderStates([caption], true);
      const pause = states.find((state) => state.atMs <= 1_500 && state.endMs > 1_500);
      assert.equal(pause?.text, text);
      assert.deepEqual(pause?.activeWordOffsets, []);
    });
  }
});

test('local sync repairs a legacy track that treated the Khmer repetition sign as its own word', async () => {
  const text = 'ខ្លីៗ';
  const basis: CaptionSegment = {
    id: 'repeat', startMs: 1_000, endMs: 1_131, text, approved: true,
    wordTiming: {
      version: 1, text, words: [
        { id: 'base', startOffset: 0, endOffset: 4, startMs: 995, endMs: 1_070, source: 'estimated', needsReview: true },
        { id: 'sign', startOffset: 4, endOffset: 5, startMs: 1_070, endMs: 1_101, source: 'estimated', needsReview: true },
      ],
    },
  };
  const { project } = projectFixture('repeat-sign-sync');
  project.transcript = null;
  project.captions = [basis];
  let calls = 0;
  const { dependencies } = fakeDependencies(async () => structuredClone(project), {
    alignTimingLocally: async (_audio, _work, transcript) => {
      calls += 1;
      assert.equal(transcript, text);
      return {
        transcript, words: [{ text, startMs: 329, endMs: 432 }],
        engine: 'kfa-local', provider: 'local', model: 'fixture', directAlignment: true,
      };
    },
  });
  const result = await syncCaptionWordsLocally(project.id, basis, project.media, dependencies);
  assert.equal(calls, 1);
  assert.deepEqual(result.basis, basis);
  assert.equal(resolveCaptionWordTiming({ ...basis, wordTiming: result.wordTiming }).state, 'ready');
  assert.deepEqual(result.wordTiming.words.map((word) => [word.startOffset, word.endOffset, word.startMs, word.endMs]), [
    [0, text.length, 1_000, 1_098],
  ]);
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
