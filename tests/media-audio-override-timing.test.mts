import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCaptionWordTiming, resolveCaptionWordTiming, serializeCaptionFile, type CaptionProject, type QaProfileSettings, type TimedToken } from '../packages/shared/src/index.js';
import type { CaptionWordTimingDependencies } from '../apps/server/src/services/caption-word-timing.js';

// Every persistence operation in this suite owns a disposable synthetic state root.
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audio-override-timing-'));
process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
process.env.STHANG_STUDIO_ENV_FILE = path.join(stateRoot, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { postprocessProjectTiming } = await import('../apps/server/src/services/project-processing.js');
const { assertRetainedTimingCanBeDerived, MediaAlignmentUnverifiedError } = await import('../apps/server/src/services/media-alignment.js');
const { hydrateProjectWordTimings, syncCaptionWordsLocally, CaptionWordTimingConflictError } = await import('../apps/server/src/services/caption-word-timing.js');
const { planCaptionWordBatchApply, CaptionWordBatchConflictError } = await import('../apps/server/src/services/caption-word-batch.js');
const { createVideoExportCaptionSnapshot } = await import('../apps/server/src/services/video-export.js');

after(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function fixture(id: string): CaptionProject {
  const tokens: TimedToken[] = [
    { id: 'hello', text: 'hello', startMs: 200, endMs: 400, spaceBefore: false, timingSource: 'stt' },
    { id: 'world', text: 'world', startMs: 500, endMs: 700, spaceBefore: true, timingSource: 'stt' },
  ];
  const caption = { id: 'cue', text: 'hello world', startMs: 100, endMs: 900, approved: true, textLocked: true, timingLocked: true };
  const wordTiming = buildCaptionWordTiming(caption, tokens);
  assert.ok(wordTiming);
  return {
    id, title: 'Synthetic retained timing', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z',
    media: { filename: `${id}-replacement.mp4`, originalName: 'synthetic.mp4', mimeType: 'video/mp4', size: 1234, url: `/media/${id}-replacement.mp4` },
    captions: [{ ...caption, wordTiming }],
    transcript: { language: 'en', fullText: 'hello world', tokens, segments: [] },
    mode: 'single-line', engineVersion: 'test',
    mediaAlignment: { state: 'unverified-audio-change', acceptedAt: '2026-10-17T00:00:01.000Z', sourceRevision: 'synthetic-source-revision' },
  };
}

const settings: QaProfileSettings = {
  id: 'synthetic', name: 'Synthetic timing cleanup', description: '', maxCps: 30, maxCharsPerLine: 42, maxLines: 2,
  minDurationMs: 300, maxDurationMs: 5000, minGapMs: 40, leadInMs: 20, leadOutMs: 20, snapToleranceMs: 120,
};

test('retained old-audio transcript anchors cannot feed automatic timing derivation', () => {
  const project = fixture('derivation');
  const before = structuredClone(project);
  assert.throws(() => assertRetainedTimingCanBeDerived(project), (error: unknown) => error instanceof MediaAlignmentUnverifiedError
    && /existing caption and word times were kept/.test(error.message)
    && /manual|manually/.test(error.message));
  assert.deepEqual(project, before);
  const verified = { ...project };
  delete verified.mediaAlignment;
  assert.doesNotThrow(() => assertRetainedTimingCanBeDerived(verified));
});

test('timing cleanup rejects before checkpoint/persist and keeps every retained review field', async () => {
  const project = fixture('cleanup-guard');
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const before = await store.get(project.id);
  await assert.rejects(postprocessProjectTiming(project.id, settings, project.media), MediaAlignmentUnverifiedError);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await historyStore.list(project.id, project.media), []);
});

test('ordinary timing cleanup remains available for unchanged-audio projects', async () => {
  const project = fixture('cleanup-regression');
  delete project.mediaAlignment;
  project.captions[0].timingLocked = false;
  project.captions[0].textLocked = false;
  await store.upsert(project);
  cancelScheduledProjectPrewarm(project.id);
  const cleaned = await postprocessProjectTiming(project.id, settings, project.media);
  assert.notEqual(cleaned.captions[0].startMs, project.captions[0].startMs);
  assert.equal((await historyStore.list(project.id, project.media)).length, 1);
});

test('retained persisted word-highlight export uses exact reviewed intervals without mutating project', () => {
  const project = fixture('retained-export');
  // Manual review differs from canonical tokens: hydration must never replace it.
  project.captions[0].wordTiming!.words[0].startMs = 240;
  const before = structuredClone(project);
  const hydrated = hydrateProjectWordTimings(project);
  const snapshot = createVideoExportCaptionSnapshot(project);
  assert.deepEqual(snapshot, project.captions);
  assert.deepEqual(hydrated.captions, project.captions);
  assert.equal(resolveCaptionWordTiming(snapshot[0]).state, 'ready');
  const words = serializeCaptionFile({ captions: snapshot }, 'word-srt').text;
  assert.match(words, /00:00:00,240 --> 00:00:00,400/);
  assert.match(words, /00:00:00,500 --> 00:00:00,700/);
  assert.deepEqual(project, before);
});

test('legacy hydration stays deterministic and read-only after audio override', () => {
  const original = fixture('legacy-export');
  delete original.captions[0].wordTiming;
  const replacement = structuredClone(original);
  delete original.mediaAlignment;
  const expected = createVideoExportCaptionSnapshot(original);
  assert.deepEqual(createVideoExportCaptionSnapshot(replacement), expected);
  assert.equal(replacement.captions[0].wordTiming, undefined);
  assert.ok(replacement.mediaAlignment, 'pure hydration never claims the replacement audio was verified');
});

function syncDependencies(project: CaptionProject, heavy: { calls: number }): CaptionWordTimingDependencies {
  return {
    getProject: async () => structuredClone(project),
    ensureNormalizedAudio: async () => {
      heavy.calls += 1;
      return { dir: 'synthetic-cache', outputPath: 'synthetic.wav', durationMs: 2000, fingerprint: 'synthetic-new-audio', cacheHit: true, cachedAt: project.updatedAt };
    },
    makeAudioChunk: async (_source, outputPath, _startMs, durationMs) => ({ outputPath, durationMs, cacheHit: true, directSource: false }),
    alignTimingLocally: async () => ({ transcript: 'hello world', words: [{ text: 'hello', startMs: 200, endMs: 400, confidence: 0.99 }, { text: 'world', startMs: 500, endMs: 700, confidence: 0.99 }], engine: 'kfa-local', provider: 'local', model: 'synthetic', directAlignment: true }),
    removeWorkingDir: async () => {},
  };
}

test('explicit word sync returns a review candidate without applying it or clearing provenance', async () => {
  const project = fixture('explicit-sync');
  project.captions[0].timingLocked = false;
  const before = structuredClone(project);
  const heavy = { calls: 0 };
  const candidate = await syncCaptionWordsLocally(project.id, project.captions[0], project.media, syncDependencies(project, heavy));
  assert.equal(heavy.calls, 1);
  assert.equal(resolveCaptionWordTiming({ ...candidate.basis, wordTiming: candidate.wordTiming }).state, 'ready');
  assert.deepEqual(project, before, 'sync candidate does not save or overwrite reviewed word timing');
});

test('stale pre-replacement sync and batch requests cannot overwrite retained word tracks', async () => {
  const project = fixture('stale-sync');
  project.captions[0].timingLocked = false;
  const before = structuredClone(project);
  const oldMedia = { ...project.media, filename: 'retired-media.mp4' };
  const heavy = { calls: 0 };
  await assert.rejects(syncCaptionWordsLocally(project.id, project.captions[0], oldMedia, syncDependencies(project, heavy)), CaptionWordTimingConflictError);
  assert.equal(heavy.calls, 0);
  assert.throws(() => planCaptionWordBatchApply(project, oldMedia, [{ before: project.captions[0], after: project.captions[0] }]), CaptionWordBatchConflictError);
  assert.deepEqual(project, before);
});

test('explicit candidate batch apply preserves alignment warning and unrelated reviewed fields', () => {
  const project = fixture('explicit-apply');
  project.captions[0].timingLocked = false;
  const before = structuredClone(project.captions[0]);
  const after = structuredClone(before);
  after.wordTiming!.words[0].startMs = 240;
  after.approved = false;
  const applied = planCaptionWordBatchApply(project, project.media, [{ before, after }]).project;
  assert.equal(applied.captions[0].wordTiming!.words[0].startMs, 240);
  assert.equal(applied.captions[0].textLocked, true);
  assert.deepEqual(applied.mediaAlignment, project.mediaAlignment);
  assert.deepEqual(applied.transcript, project.transcript);
  assert.deepEqual(project.captions[0], before);
});
