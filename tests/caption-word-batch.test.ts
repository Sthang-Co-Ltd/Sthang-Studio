import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '../packages/shared/src/index.js';
import { segmentTimedTokens } from '../apps/server/src/services/segmenter.js';
import { hydrateProjectWordTimings } from '../apps/server/src/services/caption-word-timing.js';
import {
  applyCaptionWordBatch,
  CaptionWordBatchConflictError,
  CaptionWordBatchInputError,
  planCaptionWordBatchApply,
} from '../apps/server/src/services/caption-word-batch.js';

function token(id: string, text: string, startMs: number, endMs: number, spaceBefore: boolean): TimedToken {
  return { id, text, startMs, endMs, spaceBefore, timingSource: 'stt' };
}

function cue(id: string, words: Array<[string, number, number]>, base = 0) {
  const tokens = words.map(([text, start, end], index) => token(`${id}-w${index}`, text, base + start, base + end, index > 0));
  const caption = segmentTimedTokens(tokens, { mode: 'single-line' })[0];
  assert.ok(caption?.wordTiming, 'fixture must produce ready word timing');
  return { ...caption, id };
}

function fixture(id = 'word-batch'): CaptionProject {
  const captions = [
    cue('c1', [['hello', 100, 300], ['world', 360, 600]]),
    cue('c2', [['second', 100, 330], ['caption', 380, 700]], 800),
    cue('c3', [['untouched', 100, 450]], 1_700),
  ];
  return {
    id,
    title: 'Word batch fixture',
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 1234, url: `/media/${id}.mp4` },
    transcript: null,
    captions,
    mode: 'single-line',
    engineVersion: 'test',
  };
}

function readyChange(before: CaptionSegment, shift = 10): CaptionSegment {
  const after = structuredClone(before);
  assert.ok(after.wordTiming);
  after.wordTiming.words[0].startMs! += shift;
  after.approved = false;
  assert.equal(resolveCaptionWordTiming(after).state, 'ready');
  return after;
}

test('atomic planning applies target word timing while preserving unrelated same-media edits', () => {
  const original = fixture();
  const before = structuredClone(original.captions[0]);
  const project = structuredClone(original);
  project.captions[2] = { ...project.captions[2], textLocked: true, approved: true };
  const unrelated = structuredClone(project.captions[2]);

  const after = readyChange(before);
  const result = planCaptionWordBatchApply(project, project.media, [{ before, after }]);

  assert.equal(result.appliedCount, 1);
  assert.deepEqual(result.project.captions[2], unrelated);
  assert.equal(result.project.engineVersion, original.engineVersion);
  assert.equal(result.project.captions[0].wordTiming!.words[0].startMs, after.wordTiming!.words[0].startMs);
  assert.equal(result.project.captions[0].approved, false);
});

test('cross-tab target changes reject the whole two-caption batch without touching either target', () => {
  const project = fixture();
  const beforeOne = structuredClone(project.captions[0]);
  const beforeTwo = structuredClone(project.captions[1]);
  const snapshot = structuredClone(project.captions);
  project.captions[1].wordTiming!.words[0].startMs! += 10;

  assert.throws(() => planCaptionWordBatchApply(project, project.media, [
    { before: beforeOne, after: readyChange(beforeOne) },
    { before: beforeTwo, after: readyChange(beforeTwo) },
  ]), CaptionWordBatchConflictError);
  assert.deepEqual(snapshot[0], project.captions[0], 'first target was not partially applied');
  assert.notDeepEqual(snapshot[1], project.captions[1], 'fixture contains the simulated newer edit');
});

test('media, lock, missing-caption and duplicate-target conflicts fail closed', () => {
  const project = fixture();
  const before = structuredClone(project.captions[0]);
  const change = { before, after: readyChange(before) };

  assert.throws(() => planCaptionWordBatchApply(project, { ...project.media, filename: 'replacement.mp4' }, [change]), CaptionWordBatchConflictError);
  assert.throws(() => planCaptionWordBatchApply({ ...project, captions: project.captions.slice(1) }, project.media, [change]), CaptionWordBatchConflictError);
  assert.throws(() => planCaptionWordBatchApply({ ...project, captions: [{ ...project.captions[0], timingLocked: true }, ...project.captions.slice(1)] }, project.media, [
    { before: { ...before, timingLocked: true }, after: { ...readyChange(before), timingLocked: true } },
  ]), CaptionWordBatchConflictError);
  assert.throws(() => planCaptionWordBatchApply(project, project.media, [change, change]), CaptionWordBatchInputError);
});

test('apply accepts only ready timing and rejects unsupported caption mutations or actions', () => {
  const project = fixture();
  const before = structuredClone(project.captions[0]);
  const partial = structuredClone(before);
  partial.wordTiming!.words[0].needsReview = true;
  assert.equal(resolveCaptionWordTiming(partial).state, 'partial');

  assert.throws(() => planCaptionWordBatchApply(project, project.media, [{ before, after: partial }], 'apply'), CaptionWordBatchInputError);
  assert.throws(() => planCaptionWordBatchApply(project, project.media, [{ before, after: readyChange(before) }], 'later'), CaptionWordBatchInputError);
  assert.throws(() => planCaptionWordBatchApply(project, project.media, [{ before, after: { ...readyChange(before), text: 'changed text' } }]), CaptionWordBatchInputError);
  assert.throws(() => planCaptionWordBatchApply(project, project.media, [{
    before,
    after: { ...readyChange(before), dangerouslySetInnerHTML: '<img src=x onerror=alert(1)>' } as CaptionSegment,
  }]), CaptionWordBatchInputError);
});

test('Khmer grapheme-splitting word offsets are rejected before persistence', () => {
  const khmer = cue('khmer', [['ខ្មែរ', 100, 600]]);
  const project = { ...fixture('khmer-boundary'), captions: [khmer] };
  const after = structuredClone(khmer);
  const boundaries = new Set<number>([0, khmer.text.length]);
  for (const item of new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(khmer.text)) {
    boundaries.add(item.index);
    boundaries.add(item.index + item.segment.length);
  }
  const unsafe = Array.from({ length: khmer.text.length - 1 }, (_, index) => index + 1).find((index) => !boundaries.has(index));
  assert.notEqual(unsafe, undefined, 'fixture needs an interior non-grapheme boundary');
  after.wordTiming!.words[0].startOffset = unsafe!;
  assert.equal(resolveCaptionWordTiming(after).state, 'stale');
  assert.throws(() => planCaptionWordBatchApply(project, project.media, [{ before: khmer, after }]), CaptionWordBatchInputError);
});

test('legacy exact captions compare against safe hydrated timing without persisting fuzzy wording', () => {
  const tokens = [
    token('legacy-khmer', 'ខ្មែរ', 100, 450, false),
    token('legacy-ai', 'AI', 520, 760, true),
  ];
  const generated = segmentTimedTokens(tokens, { mode: 'single-line' })[0];
  generated.id = 'legacy-cue';
  const project: CaptionProject = {
    ...fixture('legacy'),
    transcript: {
      language: 'km',
      fullText: 'ខ្មែរ AI',
      tokens,
      segments: [structuredClone(generated)],
      timing: {
        engine: 'kfa-local', provider: 'local', model: 'fixture', sttTranscript: 'ខ្មែរ AI', audioDurationMs: 1_000,
        totalTokens: 2, anchoredTokens: 2, interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1,
      },
    },
    captions: [structuredClone(generated)],
  };
  delete project.captions[0].wordTiming;
  const hydrated = hydrateProjectWordTimings(project).captions[0];
  assert.equal(resolveCaptionWordTiming(project.captions[0]).state, 'missing');
  assert.equal(resolveCaptionWordTiming(hydrated).state, 'ready');

  const after = readyChange(hydrated);
  const planned = planCaptionWordBatchApply(project, project.media, [{ before: hydrated, after }]);
  assert.equal(resolveCaptionWordTiming(planned.project.captions[0]).state, 'ready');

  const corrected = structuredClone(project);
  corrected.captions[0].text = 'ខ្មែរ corrected AI';
  assert.throws(() => planCaptionWordBatchApply(corrected, corrected.media, [{ before: hydrated, after }]), CaptionWordBatchConflictError);
});

test('reversed undo atomically restores missing and partial tracks plus approval state', () => {
  const project = fixture('undo');
  const missingBefore = structuredClone(project.captions[0]);
  delete missingBefore.wordTiming;
  missingBefore.approved = true;
  project.captions[0] = structuredClone(missingBefore);

  const partialBefore = structuredClone(project.captions[1]);
  partialBefore.wordTiming!.words[0].needsReview = true;
  partialBefore.approved = true;
  assert.equal(resolveCaptionWordTiming(partialBefore).state, 'partial');
  project.captions[1] = structuredClone(partialBefore);

  const readyOne = structuredClone(fixture('ready-one').captions[0]);
  readyOne.id = missingBefore.id;
  readyOne.startMs = missingBefore.startMs;
  readyOne.endMs = missingBefore.endMs;
  readyOne.text = missingBefore.text;
  readyOne.wordTiming = structuredClone(fixture('undo').captions[0].wordTiming);
  readyOne.approved = false;
  const readyTwo = structuredClone(partialBefore);
  delete readyTwo.wordTiming!.words[0].needsReview;
  readyTwo.approved = false;
  assert.equal(resolveCaptionWordTiming(readyOne).state, 'ready');
  assert.equal(resolveCaptionWordTiming(readyTwo).state, 'ready');

  const applied = planCaptionWordBatchApply(project, project.media, [
    { before: missingBefore, after: readyOne },
    { before: partialBefore, after: readyTwo },
  ], 'apply');
  const undone = planCaptionWordBatchApply(applied.project, project.media, [
    { before: readyOne, after: missingBefore },
    { before: readyTwo, after: partialBefore },
  ], 'undo');

  assert.equal(resolveCaptionWordTiming(undone.project.captions[0]).state, 'missing');
  assert.equal(resolveCaptionWordTiming(undone.project.captions[1]).state, 'partial');
  assert.equal(undone.project.captions[0].approved, true);
  assert.equal(undone.project.captions[1].approved, true);
});

test('service checkpoints and persists once, while a stale two-target batch persists nothing', async () => {
  let current = fixture('service');
  let checkpoints: string[] = [];
  let persists = 0;
  const dependencies = {
    store: {
      withProjectWrite: async (_id: string, operation: (value: CaptionProject | null, persist: (next: CaptionProject) => Promise<CaptionProject>) => Promise<unknown>) => operation(
        structuredClone(current),
        async (next) => { persists += 1; current = structuredClone(next); return structuredClone(next); },
      ),
    },
    checkpoint: async (_project: CaptionProject, label: string) => { checkpoints.push(label); return {} as never; },
  };
  const beforeOne = structuredClone(current.captions[0]);
  const beforeTwo = structuredClone(current.captions[1]);
  const afterOne = readyChange(beforeOne);
  const afterTwo = readyChange(beforeTwo);

  const applied = await applyCaptionWordBatch(current.id, current.media, [
    { before: beforeOne, after: afterOne },
    { before: beforeTwo, after: afterTwo },
  ], 'apply', dependencies as never);
  assert.equal(applied.appliedCount, 2);
  assert.equal(persists, 1);
  assert.deepEqual(checkpoints, ['Before applying prepared word timings']);

  const undo = await applyCaptionWordBatch(current.id, current.media, [
    { before: afterOne, after: beforeOne },
    { before: afterTwo, after: beforeTwo },
  ], 'undo', dependencies as never);
  assert.equal(undo.appliedCount, 2);
  assert.equal(persists, 2);
  assert.deepEqual(checkpoints, ['Before applying prepared word timings', 'Before undoing prepared word timings']);

  const staleOne = structuredClone(current.captions[0]);
  current.captions[1].wordTiming!.words[0].startMs! += 10;
  const beforePersist = persists;
  const beforeCheckpoints = checkpoints.length;
  await assert.rejects(applyCaptionWordBatch(current.id, current.media, [
    { before: staleOne, after: readyChange(staleOne) },
    { before: structuredClone(beforeTwo), after: readyChange(beforeTwo) },
  ], 'apply', dependencies as never), CaptionWordBatchConflictError);
  assert.equal(persists, beforePersist);
  assert.equal(checkpoints.length, beforeCheckpoints);
});

test('caption text resembling HTML remains inert data and byte-for-byte unchanged', () => {
  const text = '<img src=x onerror=alert(1)>ខ្មែរ';
  const caption = cue('markup', [[text, 100, 700]]);
  const project = { ...fixture('markup'), captions: [caption] };
  const after = readyChange(caption);
  const result = planCaptionWordBatchApply(project, project.media, [{ before: caption, after }]);
  assert.equal(result.project.captions[0].text, text);
  assert.equal(Object.prototype.hasOwnProperty.call(result.project.captions[0], 'dangerouslySetInnerHTML'), false);
});
