import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DEFAULT_CAPTION_APPEARANCE, editCaptionWord, type CaptionProject, type CaptionSegment } from '@kcs/shared';
import type { WordHighlightOutcome } from '../apps/server/src/services/word-highlight-engine.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-highlight-publication-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const { default: projectsRouter, createWordHighlightHandler } = await import('../apps/server/src/routes/projects.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { config } = await import('../apps/server/src/config.js');
const { wordHighlightCandidateStore } = await import('../apps/server/src/services/word-highlight-candidate-store.js');
const { wordHighlightPublicationReceipts } = await import('../apps/server/src/services/word-highlight-publication-receipts.js');
const { mediaFingerprint } = await import('../apps/server/src/services/cache.js');
const { createWordHighlightEngine, highlightInputRevision } = await import('../apps/server/src/services/word-highlight-engine.js');
const { applyPreparedWordHighlightBatch, updateWordHighlightFollow, PreparedWordHighlightConflictError } =
  await import('../apps/server/src/services/caption-word-batch.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

const measurements = new Map<string, Record<string, [startMs: number, endMs: number]>>();
const noFits = new Set<string>();
const fractionalTail = new Set<string>();
const durationMs = 1_000_000;
const engine = createWordHighlightEngine({
  getProject: (id) => store.get(id),
  ensureNormalizedAudio: async () => ({ outputPath: 'fixture', durationMs, dir: 'fixture', fingerprint: 'fixture', cacheHit: true, cachedAt: '' }),
  prepareFullEmission: async () => ({ prepared: true }),
  alignWindowsLocally: async (_wav, projectId, { targets }) => ({
    clock: { sampleCount: 16_000 * durationMs / 1_000 + (fractionalTail.has(projectId) ? 4 : 0), sampleRate: 16_000, frameCount: durationMs },
    targets: targets.map(({ id, variants: [variant] }) => {
      const line = variant.lines.findIndex(({ target }) => target);
      const [startFrame, endFrame] = measurements.get(projectId)?.[id] ?? [variant.startMs + 20, variant.startMs + 80];
      if (noFits.has(projectId)) return { id, attempts: [{ variant: variant.name, result: 'no-fit' }] };
      return { id, attempts: [{ variant: variant.name, result: 'ok' }], words: [{
        line, text: variant.lines[line].text.replaceAll(' ', ''), startFrame, endFrame, score: 1, peak: 1,
      }] };
    }),
  }),
  clock: () => 0,
});

const app = express();
app.use(express.json({ limit: '8mb' }));
app.post('/api/projects/:id/caption-word-timing/candidates', createWordHighlightHandler('candidates', {
  engine, candidateStore: wordHighlightCandidateStore, hasActiveCaptionJobForProject: () => false,
}));
const dropNextPublish = new Set<string>();
app.use('/api/projects/:id/caption-word-timing/batch-apply', (req, res, next) => {
  if (dropNextPublish.delete(req.params.id)) {
    res.json = () => {
      res.destroy();
      return res;
    };
  }
  next();
});
app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8 });
});

const cue = (id: string, startMs = 100, endMs = 300, text = id): CaptionSegment => ({ id, text, startMs, endMs });
function fixture(id: string, captions: CaptionSegment[]): CaptionProject {
  return {
    id, title: 'Synthetic publication fixture', captions, transcript: null, mode: 'single-line', engineVersion: 'fixture',
    captionAppearance: DEFAULT_CAPTION_APPEARANCE,
    media: { filename: `${id}.wav`, originalName: 'source.wav', size: 4, url: `/media/${id}.wav`, mimeType: 'audio/wav' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
type Prepared = WordHighlightOutcome & { preparedKey: string };
const candidatePath = '/caption-word-timing/candidates';
const batchPath = '/caption-word-timing/batch-apply';
const followPath = '/word-highlight-follow';
function api(project: CaptionProject, suffix = '', method = 'GET', body?: object) {
  return fetch(`${base}/${project.id}${suffix}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok(response: Response) {
  assert.equal(response.status, 200, response.status === 200 ? undefined : JSON.stringify(await response.json()));
  return response.json();
}
async function arm(project: CaptionProject) {
  const result = await ok(await api(project, followPath, 'PUT', { expectedMedia: project.media, action: 'arm' }));
  assert.equal(result.wordHighlightFollow.enabled, true);
  return { project: (await store.get(project.id))!, epoch: result.wordHighlightFollow.epoch as string, updatedAt: result.updatedAt as string };
}
async function setup(id: string, captions: CaptionSegment[], anchors: Record<string, [number, number]> = {}) {
  const project = fixture(id, captions);
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  measurements.set(id, anchors);
  return arm(project);
}
async function prepare(project: CaptionProject, ids: string[]): Promise<Prepared[]> {
  const { results } = await ok(await api(project, candidatePath, 'POST', { expectedMedia: project.media, ids }));
  for (const result of results) assert.ok(result.preparedKey, JSON.stringify(result));
  return results;
}
function publish(project: CaptionProject, epoch: string, preparedKeys: string[], intent: 'apply' | 'follow' = 'apply', requestId = randomUUID()) {
  return api(project, batchPath, 'POST', { expectedMedia: project.media, mode: 'prepared', intent, epoch, preparedKeys, requestId });
}
function readReceipt(project: CaptionProject, requestId: string) {
  const query = new URLSearchParams({ filename: project.media.filename, size: String(project.media.size) });
  return api(project, `/caption-word-timing/publication/${requestId}?${query}`);
}
async function change(project: CaptionProject, update: (current: CaptionProject) => CaptionProject) {
  return store.withProjectWrite(project.id, (current, persist) => persist(update(current!)));
}
async function rejectsUnchanged(project: CaptionProject, action: () => Promise<Response>, details: object) {
  const before = await store.get(project.id);
  const history = await historyStore.list(project.id);
  const response = await action();
  assert.equal(response.status, 409);
  const { error, ...body } = await response.json();
  assert.equal(typeof error, 'string');
  assert.deepEqual(body, details);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await historyStore.list(project.id), history);
}
const contextChanged = (...changedIds: string[]) => ({ code: 'WORD_HIGHLIGHT_CONTEXT_CHANGED', changedIds });
const intentChanged = { code: 'WORD_HIGHLIGHT_INTENT_CHANGED' };

test('prepared apply persists only word timing, writes a pre-write snapshot, and supports lost ACK readback and exact replay', async () => {
  const { project, epoch } = await setup('publish', [{ ...cue('one'), approved: true }, cue('two', 400, 600)], { one: [120, 150] });
  const [entry] = await prepare(project, ['one']);
  assert.deepEqual(entry.consulted, ['one', 'two']);
  assert.equal(entry.planDurationMs, durationMs);
  const response = await publish(project, epoch, [entry.preparedKey]);
  assert.equal(response.status, 200);
  // Recover the canonical result without consuming the publication response.
  const saved = await ok(await api(project));
  assert.deepEqual(saved.captions[0], { ...project.captions[0], wordTiming: entry.track });
  assert.deepEqual(saved.captions[1], project.captions[1]);
  assert.notEqual(saved.updatedAt, project.updatedAt);
  const [checkpoint] = await historyStore.list(project.id);
  assert.equal(checkpoint.source, 'word-highlight');
  assert.equal(checkpoint.label, 'Before applying word highlights');
  assert.deepEqual((await historyStore.get(project.id, checkpoint.id))?.snapshot, project);
  await response.body?.cancel();

  const replay = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.deepEqual(replay, { project: saved, appliedCount: 0, applied: [], unchanged: ['one'], kept: [] });
  assert.deepEqual(await historyStore.list(project.id), [checkpoint]);
  await change(project, (current) => ({
    ...current, captions: [editCaptionWord(current.captions[0], entry.track!.words[0].id, { startMs: 130, endMs: 170 }), current.captions[1]],
  }));
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey]), contextChanged('one'));
});

for (const scenario of ['edited', 'inserted', 'deleted', 'locked'] as const) {
  test(`prepared batch atomically rejects this dependency change: ${scenario}`, async () => {
    const { project, epoch } = await setup(`context-${scenario}`, [cue('target'), cue('neighbor', 400, 550), cue('independent', 20_000, 20_300)]);
    const keys = (await prepare(project, ['independent', 'target'])).map(({ preparedKey }) => preparedKey);
    await change(project, (current) => {
      const [target, neighbor, independent] = current.captions;
      return { ...current, captions: [
        scenario === 'locked' ? { ...target, timingLocked: true } : target,
        ...(scenario === 'inserted' ? [cue('inserted', 310, 350)] : []),
        ...(scenario === 'deleted' ? [] : [scenario === 'edited' ? { ...neighbor, text: 'different' } : neighbor]),
        independent,
      ] };
    });
    const alsoConsultedByIndependent = scenario === 'edited' || scenario === 'deleted';
    await rejectsUnchanged(project, () => publish(project, epoch, keys),
      contextChanged(...(alsoConsultedByIndependent ? ['independent', 'target'] : ['target'])));
  });
}

test('equal-time nested reorder and newly overlapping owners invalidate canonical context', async () => {
  const parent = cue('parent', 100, 600);
  const child = cue('child', 200, 300);
  const twin = cue('twin', 200, 300);
  const { project, epoch } = await setup('reorder', [parent, child, twin], { parent: [210, 260] });
  const [entry] = await prepare(project, ['parent']);
  assert.ok(entry.overlapping?.some(({ id }) => id === 'twin'));
  await change(project, (current) => ({ ...current, captions: [parent, twin, child] }));
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey]), contextChanged('parent'));

  const second = await setup('overlap', [parent], { parent: [210, 260] });
  const [original] = await prepare(second.project, ['parent']);
  await ok(await publish(second.project, second.epoch, [original.preparedKey]));
  await change(second.project, (current) => ({ ...current, captions: [...current.captions, child] }));
  await rejectsUnchanged(second.project, () => publish(second.project, second.epoch, [original.preparedKey]), contextChanged('parent'));
  const [refreshed] = await prepare(second.project, ['parent']);
  assert.notEqual(refreshed.basis, original.basis);
  assert.equal(refreshed.track?.words[0].issue, 'ambiguous-occurrence');
  // Even an equal-basis stored track cannot suppress a real change to guarded paint.
  await change(second.project, (current) => {
    const [currentParent, currentChild] = current.captions;
    return { ...current, captions: [{ ...currentParent, wordTiming: { ...currentParent.wordTiming!, basis: refreshed.basis } }, currentChild] };
  });
  const [sameBasis] = await prepare(second.project, ['parent']);
  const applied = await ok(await publish(second.project, second.epoch, [sameBasis.preparedKey]));
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.applied[0].after.wordTiming.words[0].issue, 'ambiguous-occurrence');
});

test('approvals do not invalidate inputs and a newly published neighbor participates in the guard', async () => {
  const { project, epoch } = await setup('neighbor-paint', [cue('left', 100, 200, 'go'), cue('right', 200, 300, 'go')], {
    left: [150, 230], right: [150, 230],
  });
  const [left] = await prepare(project, ['left']);
  const [right] = await prepare(project, ['right']);
  await change(project, (current) => ({ ...current, captions: current.captions.map((caption) => ({ ...caption, approved: true })) }));
  const publishedRight = await ok(await publish(project, epoch, [right.preparedKey]));
  assert.equal(publishedRight.applied[0].after.approved, true);
  assert.equal(publishedRight.applied[0].after.wordTiming.words[0].issue, undefined);
  const publishedLeft = await ok(await publish(project, epoch, [left.preparedKey], 'follow'));
  assert.equal(publishedLeft.applied[0].after.approved, true);
  assert.equal(publishedLeft.applied[0].after.wordTiming.words[0].issue, 'ambiguous-occurrence');
  assert.equal((await ok(await publish(project, epoch, [left.preparedKey], 'follow'))).appliedCount, 0);
});

test('an intervening automatic write to the same target is a context conflict', async () => {
  const { project, epoch } = await setup('target-paint', [cue('one')], { one: [120, 160] });
  const [stale] = await prepare(project, ['one']);
  measurements.set(project.id, { one: [150, 190] });
  const [winner] = await prepare(project, ['one']);
  assert.equal((await ok(await publish(project, epoch, [winner.preparedKey]))).appliedCount, 1);
  await rejectsUnchanged(project, () => publish(project, epoch, [stale.preparedKey]), contextChanged('one'));
});

test('a no-fit attempt with the same inputs cannot discard stronger guarded evidence', async () => {
  const { project, epoch } = await setup('no-fit', [cue('word')], { word: [120, 160] });
  const [original] = await prepare(project, ['word']);
  const saved = await ok(await publish(project, epoch, [original.preparedKey]));
  noFits.add(project.id);
  const [replacement] = await prepare(project, ['word']);
  assert.equal(replacement.basis, original.basis);
  assert.equal(replacement.track?.words[0].issue, 'no-fit');
  const history = await historyStore.list(project.id);
  for (let replay = 0; replay < 2; replay += 1) {
    const result = await ok(await publish(project, epoch, [replacement.preparedKey]));
    assert.equal(result.appliedCount, 0);
    assert.deepEqual(result.project, saved.project);
  }
  assert.deepEqual(await historyStore.list(project.id), history);
});

test('frame-derived evidence can include the fractional tail beyond the rounded planner duration and replay unchanged', async () => {
  const { project, epoch } = await setup('fractional-tail', [cue('end', durationMs - 200, durationMs)], {
    end: [durationMs - 50, durationMs],
  });
  fractionalTail.add(project.id);
  await change(project, (current) => ({
    ...current, pipelineCache: { mediaFingerprint: 'fixture', normalizedAudioCached: true, normalizedAudioDurationMs: durationMs },
  }));
  const [entry] = await prepare(project, ['end']);
  assert.equal(entry.planDurationMs, durationMs);
  assert.equal(entry.evidenceDurationMs, durationMs + 0.25);
  assert.equal(entry.track?.words[0].endMs, durationMs + 0.25);
  const applied = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.equal(applied.appliedCount, 1);
  const checkpoints = await historyStore.list(project.id);
  const replay = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.equal(replay.appliedCount, 0);
  assert.equal(replay.project.updatedAt, applied.project.updatedAt);
  assert.deepEqual(await historyStore.list(project.id), checkpoints);
  const roundedSave = await ok(await api(project, '/captions', 'PUT', {
    expectedMedia: project.media, expectedUpdatedAt: applied.project.updatedAt, recordCorrections: false,
    captions: [{ ...applied.project.captions[0], approved: true }],
  }));
  assert.equal(roundedSave.project.captions[0].wordTiming.words[0].endMs, durationMs + 0.25);
  const invented = structuredClone(roundedSave.project.captions);
  invented[0].wordTiming.words[0].endMs = durationMs + 0.375;
  assert.equal((await api(project, '/captions', 'PUT', {
    expectedMedia: project.media, expectedUpdatedAt: roundedSave.project.updatedAt, recordCorrections: false, captions: invented,
  })).status, 400);
});

test('JSON-invisible optional fields on the before-track do not turn an approval save into a conflict', async () => {
  const caption = cue('word');
  caption.wordTiming = {
    version: 1, text: caption.text,
    words: [{ id: 'old-estimate', startOffset: 0, endOffset: 4, startMs: 120, endMs: 150, source: 'estimated', needsReview: undefined }],
  };
  const { project, epoch } = await setup('json-track', [caption], { word: [120, 150] });
  const [entry] = await prepare(project, ['word']);
  assert.ok(Object.hasOwn(wordHighlightCandidateStore.get(entry.preparedKey)!.beforeTrack!.words[0], 'needsReview'));
  const approved = await ok(await api(project, '/captions', 'PUT', {
    expectedMedia: project.media, expectedUpdatedAt: project.updatedAt, recordCorrections: false,
    captions: [{ ...caption, approved: true }],
  }));
  assert.ok(!Object.hasOwn(approved.project.captions[0].wordTiming.words[0], 'needsReview'));
  const applied = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.project.captions[0].approved, true);
  const history = await historyStore.list(project.id);
  const replay = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.equal(replay.appliedCount, 0);
  assert.equal(replay.project.updatedAt, applied.project.updatedAt);
  assert.deepEqual(await historyStore.list(project.id), history);
});

test('a malformed final track aborts before any project or History write', async () => {
  const { project, epoch } = await setup('invalid-final', [cue('valid'), cue('invalid', 350, 570)], {
    valid: [110, 150], invalid: [400, 450],
  });
  const [valid, invalid] = await prepare(project, ['valid', 'invalid']);
  const data = wordHighlightCandidateStore.get(invalid.preparedKey)!;
  const tampered = wordHighlightCandidateStore.put({ ...data, track: { ...data.track, text: 'wrong' } })!;
  const response = await publish(project, epoch, [valid.preparedKey, tampered]);
  assert.equal(response.status, 500);
  assert.deepEqual(await store.get(project.id), project);
  assert.deepEqual(await historyStore.list(project.id), []);
});

test('by-reference publication compares separately prepared chunks together and replays guarded results', async () => {
  const { project, epoch } = await setup('cross-chunk', [cue('left', 100, 200, 'go'), cue('right', 200, 300, 'go')], {
    left: [150, 230], right: [150, 230],
  });
  const keys = [...await prepare(project, ['left']), ...await prepare(project, ['right'])].map(({ preparedKey }) => preparedKey);
  const result = await ok(await publish(project, epoch, keys));
  assert.equal(result.appliedCount, 2);
  assert.deepEqual(result.project.captions.map((item: CaptionSegment) => item.wordTiming?.words[0].issue), ['ambiguous-occurrence', 'ambiguous-occurrence']);
  assert.deepEqual((await ok(await publish(project, epoch, keys))).unchanged, ['left', 'right']);
});

test('selected replacement tracks, including on replay, supersede their different saved automatic tracks', async () => {
  const { project, epoch } = await setup('replaced-neighbor', [cue('left', 100, 200, 'go'), cue('right', 200, 300, 'go')], {
    left: [150, 230], right: [150, 230],
  });
  const [left] = await prepare(project, ['left']);
  const [oldRight] = await prepare(project, ['right']);
  await ok(await publish(project, epoch, [oldRight.preparedKey]));
  measurements.set(project.id, { right: [240, 280] });
  const [newRight] = await prepare(project, ['right']);
  const keys = [left.preparedKey, newRight.preparedKey];
  const published = await ok(await publish(project, epoch, keys));
  assert.equal(published.appliedCount, 2);
  assert.deepEqual(published.project.captions.map((caption: CaptionSegment) => caption.wordTiming?.words[0].issue), [undefined, undefined]);
  assert.equal((await ok(await publish(project, epoch, keys))).appliedCount, 0);
});

test('derived manual group metadata can change without invalidating this target or an adjacent key', async () => {
  const compound = cue('compound', 100, 300, 'AI CapCut unclear');
  compound.wordTiming = {
    version: 1, text: compound.text, words: [
      { id: 'user-manual', startOffset: 0, endOffset: 9, startMs: 120, endMs: 175, source: 'manual' },
      { id: 'old-untimed', startOffset: 10, endOffset: 17, startMs: null, endMs: null, source: 'estimated', needsReview: true },
    ],
  };
  const { project, epoch } = await setup('manual-representation', [compound, cue('adjacent', 400, 500)], {
    compound: [180, 240], adjacent: [420, 450],
  });
  const [record] = await prepare(project, ['compound']);
  const [adjacent] = await prepare(project, ['adjacent']);
  assert.ok(adjacent.consulted?.includes('compound'));
  const keys = [record.preparedKey, adjacent.preparedKey];
  const accepted = await ok(await publish(project, epoch, keys));
  assert.equal(accepted.appliedCount, 2);
  const converted = accepted.project.captions[0] as CaptionSegment;
  assert.deepEqual(converted.wordTiming?.words[0].members, [[0, 2], [3, 9]]);
  assert.equal(highlightInputRevision(converted), highlightInputRevision(compound));
  const history = await historyStore.list(project.id);
  const replayed = await ok(await publish(project, epoch, keys));
  assert.equal(replayed.appliedCount, 0);
  assert.equal(replayed.project.updatedAt, accepted.project.updatedAt);
  assert.deepEqual(await historyStore.list(project.id), history);
  await change(project, (current) => ({ ...current, captions: [
    editCaptionWord(current.captions[0], 'user-manual', { startMs: 130, endMs: 175 }), current.captions[1],
  ] }));
  await rejectsUnchanged(project, () => publish(project, epoch, keys), contextChanged('compound', 'adjacent'));
});

for (const kind of ['stale text snapshot', 'untimed anchor'] as const) {
  test(`a legacy ${kind} supplies no manual input and exact replay adds no revision or History`, async () => {
    const caption = cue('word');
    caption.wordTiming = {
      version: 1, text: kind === 'stale text snapshot' ? 'past' : 'word',
      words: [{ id: 'legacy-manual', startOffset: 0, endOffset: 4, source: 'manual',
        startMs: kind === 'untimed anchor' ? null : 130, endMs: kind === 'untimed anchor' ? null : 170 }],
    };
    const { project, epoch } = await setup(kind.replaceAll(' ', '-'), [caption], { word: [120, 160] });
    const [entry] = await prepare(project, ['word']);
    const applied = await ok(await publish(project, epoch, [entry.preparedKey]));
    assert.equal(applied.appliedCount, 1);
    assert.equal(applied.project.captions[0].wordTiming.words[0].source, 'aligned');
    assert.equal(highlightInputRevision(applied.project.captions[0]), highlightInputRevision(caption));
    const history = await historyStore.list(project.id);
    const replay = await ok(await publish(project, epoch, [entry.preparedKey]));
    assert.equal(replay.appliedCount, 0);
    assert.equal(replay.project.updatedAt, applied.project.updatedAt);
    assert.deepEqual(await historyStore.list(project.id), history);
  });
}

test('a now-ready legacy target is kept, and stale or foreign keys commit nothing', async () => {
  const { project, epoch } = await setup('kept', [cue('word')], { word: [110, 150] });
  const [entry] = await prepare(project, ['word']);
  const foreign = await setup('foreign', [cue('word')]);
  const [foreignEntry] = await prepare(foreign.project, ['word']);
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey, foreignEntry.preparedKey, 'expired']), {
    code: 'WORD_HIGHLIGHT_PREPARED_EXPIRED', expiredKeys: [foreignEntry.preparedKey, 'expired'],
  });
  await change(project, (current) => ({ ...current, captions: [{
    ...current.captions[0], wordTiming: {
      version: 1, text: 'word', words: [{ id: 'legacy', startOffset: 0, endOffset: 4, startMs: 130, endMs: 190, source: 'aligned' }],
    },
  }] }));
  const kept = await ok(await publish(project, epoch, [entry.preparedKey]));
  assert.deepEqual([kept.appliedCount, kept.kept], [0, ['word']]);
  assert.deepEqual(await historyStore.list(project.id), []);
});

test('follow arm and revoke update the save basis, ignore a stale revoke epoch, and serialize against writes', async () => {
  const { project, epoch, updatedAt } = await setup('intent', [cue('word')]);
  assert.equal(updatedAt, project.updatedAt);
  const [entry] = await prepare(project, ['word']);
  const rearmed = await arm(project);
  assert.notEqual(rearmed.epoch, epoch);
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey]), intentChanged);
  const revokedResponse = api(project, followPath, 'PUT', { expectedMedia: project.media, action: 'revoke', epoch });
  const revoked = await ok(await revokedResponse);
  assert.equal(revoked.wordHighlightFollow.enabled, false);
  assert.equal(revoked.wordHighlightFollow.epoch, rearmed.epoch);
  assert.notEqual(revoked.updatedAt, rearmed.updatedAt);
  await rejectsUnchanged(project, () => publish(project, rearmed.epoch, [entry.preparedKey]), intentChanged);
  await rejectsUnchanged(project, () => api(project, followPath, 'PUT', {
    expectedMedia: { ...project.media, size: 9 }, action: 'arm',
  }), intentChanged);
  assert.deepEqual(await historyStore.list(project.id), []);
});

test('concurrent revoke and publish commit in project write order', async () => {
  for (const revokesFirst of [true, false]) {
    const { project, epoch } = await setup(`race-${revokesFirst}`, [cue('word')], { word: [120, 150] });
    const [entry] = await prepare(project, ['word']);
    const revoke = () => updateWordHighlightFollow(project.id, project.media, 'revoke', epoch);
    const write = () => applyPreparedWordHighlightBatch(project.id, project.media, {
      intent: 'follow', epoch, preparedKeys: [entry.preparedKey], requestId: randomUUID(),
    });
    const outcomes = revokesFirst ? await Promise.allSettled([revoke(), write()]) : await Promise.allSettled([write(), revoke()]);
    if (revokesFirst) {
      assert.equal(outcomes[0].status, 'fulfilled');
      assert.equal(outcomes[1].status, 'rejected');
      if (outcomes[1].status === 'rejected') {
        assert.ok(outcomes[1].reason instanceof PreparedWordHighlightConflictError);
        assert.deepEqual(outcomes[1].reason.details, intentChanged);
      }
    } else assert.ok(outcomes.every((entry) => entry.status === 'fulfilled'));
    const final = await store.get(project.id);
    assert.equal(final?.wordHighlightFollow?.enabled, false);
    assert.equal(Boolean(final?.captions[0].wordTiming), !revokesFirst);
    assert.equal((await historyStore.list(project.id)).length, revokesFirst ? 0 : 1);
  }
});

test('explicit Undo has its own History barrier and refuses an intervening manual edit', async () => {
  const { project, epoch } = await setup('undo', [cue('word')], { word: [120, 160] });
  const [entry] = await prepare(project, ['word']);
  const applied = await ok(await publish(project, epoch, [entry.preparedKey]));
  const inverse = applied.applied.map(({ before, after }: { before: CaptionSegment; after: CaptionSegment }) => ({ before: after, after: before }));
  const undo = () => api(project, batchPath, 'POST', { expectedMedia: project.media, action: 'undo', intent: 'apply', changes: inverse });
  const undone = await ok(await undo());
  assert.equal(undone.project.wordHighlightFollow.enabled, false);
  assert.deepEqual(undone.project.captions, project.captions);
  assert.deepEqual((await historyStore.list(project.id)).map(({ label, source }) => [label, source]), [
    ['Before undoing word highlights', 'word-highlight'], ['Before applying word highlights', 'word-highlight'],
  ]);
  const rearmed = await arm(project);
  const [next] = await prepare(project, ['word']);
  await ok(await publish(project, rearmed.epoch, [next.preparedKey]));
  await change(project, (current) => ({ ...current, captions: [
    editCaptionWord(current.captions[0], next.track!.words[0].id, { startMs: 130, endMs: 170 }),
  ] }));
  const before = await store.get(project.id);
  const checkpoints = await historyStore.list(project.id);
  assert.equal((await undo()).status, 409);
  assert.deepEqual(await store.get(project.id), before);
  assert.deepEqual(await historyStore.list(project.id), checkpoints);
});

test('a lost publication response followed by Cancel still yields the exact guarded inverse', async () => {
  const { project, epoch } = await setup('lost-cross-chunk', [
    cue('left', 100, 200, 'go'), cue('right', 200, 300, 'go'),
  ], { left: [150, 230], right: [150, 230] });
  const candidates = [...await prepare(project, ['left']), ...await prepare(project, ['right'])];
  const keys = candidates.map(({ preparedKey }) => preparedKey);
  const requestId = randomUUID();
  assert.deepEqual(candidates.map(({ track }) => track?.words[0].issue), [undefined, undefined]);
  dropNextPublish.add(project.id);
  await assert.rejects(publish(project, epoch, keys, 'apply', requestId), TypeError);
  const revoke = await ok(await api(project, followPath, 'PUT', { expectedMedia: project.media, action: 'revoke', epoch }));
  assert.equal(revoke.wordHighlightFollow.enabled, false);
  await rejectsUnchanged(project, () => publish(project, epoch, keys, 'apply', requestId), intentChanged);

  const saved = (await store.get(project.id))!;
  const history = await historyStore.list(project.id);
  const receipt = await ok(await readReceipt(project, requestId));
  assert.deepEqual(receipt, {
    committed: true, intent: 'apply',
    applied: saved.captions.map((after, index) => ({ id: after.id, before: project.captions[index], after })),
  });
  for (const [index, candidate] of candidates.entries()) {
    const track = saved.captions[index].wordTiming;
    assert.equal(track?.words[0].issue, 'ambiguous-occurrence');
    assert.notDeepEqual(track, candidate.track);
    assert.notDeepEqual(track, candidate.beforeTrack);
  }
  assert.deepEqual(history.map(({ source }) => source), ['word-highlight']);
  assert.deepEqual(await store.get(project.id), saved);
  assert.deepEqual(await historyStore.list(project.id), history);
  const undone = await ok(await api(project, batchPath, 'POST', {
    expectedMedia: project.media, action: 'undo', intent: 'apply',
    changes: receipt.applied.map(({ before, after }: { before: CaptionSegment; after: CaptionSegment }) => ({ before: after, after: before })),
  }));
  assert.deepEqual(undone.project.captions, project.captions);
});

test('a request ID replays its accepted result while armed and falls back to History after receipt expiry', async (t) => {
  const { project, epoch } = await setup('receipt-expiry', [cue('word')], { word: [120, 160] });
  const keys = (await prepare(project, ['word'])).map(({ preparedKey }) => preparedKey);
  const requestId = randomUUID();
  assert.deepEqual(await ok(await readReceipt(project, requestId)), { committed: false });
  assert.equal((await readReceipt(project, 'not-a-uuid')).status, 400);
  assert.equal((await api(project, batchPath, 'POST', {
    expectedMedia: project.media, mode: 'prepared', intent: 'apply', epoch, preparedKeys: keys,
  })).status, 400);
  const first = await ok(await publish(project, epoch, keys, 'apply', requestId));
  const history = await historyStore.list(project.id);
  const replay = await ok(await publish(project, epoch, keys, 'apply', requestId));
  assert.deepEqual(replay.applied, first.applied);
  assert.equal(replay.appliedCount, 0);
  assert.deepEqual(replay.project, first.project);
  assert.ok(wordHighlightPublicationReceipts.get(project.id, mediaFingerprint(project), requestId));
  t.mock.method(Date, 'now', () => Date.parse(first.project.updatedAt) + 31 * 60_000);
  assert.deepEqual(await ok(await readReceipt(project, requestId)), { committed: true, receiptAvailable: false });
  assert.deepEqual(await historyStore.list(project.id), history);
  assert.deepEqual(await store.get(project.id), first.project);
  assert.equal(Object.hasOwn(history[0], 'publicationRequestId'), false);
});

test('prepared publication accepts more than 1,000 references and its guarded inverse', async () => {
  const captions = Array.from({ length: 1_001 }, (_, i) => cue(`c${i}`, 300 * i, 300 * i + 200, 'word'));
  const anchors = Object.fromEntries(captions.map(({ id, startMs }) => [id, [startMs + 20, startMs + 80] as [number, number]]));
  const { project, epoch } = await setup('large-batch', captions, anchors);
  const keys: string[] = [];
  for (let start = 0; start < captions.length; start += 32) {
    keys.push(...(await prepare(project, captions.slice(start, start + 32).map(({ id }) => id))).map(({ preparedKey }) => preparedKey));
  }
  const applied = await ok(await publish(project, epoch, keys));
  assert.equal(applied.appliedCount, 1_001);
  const changes = applied.applied.map(({ before, after }: { before: CaptionSegment; after: CaptionSegment }) => ({ before: after, after: before }));
  const result = await ok(await api(project, batchPath, 'POST', { expectedMedia: project.media, action: 'undo', intent: 'apply', changes }));
  assert.equal(result.appliedCount, 1_001);
  assert.deepEqual(result.project.captions, captions);
});

test('history restore clears follow even when the selected snapshot was armed, and deletion expires prepared keys', async () => {
  const { project, epoch } = await setup('restore-delete', [cue('word')], { word: [120, 160] });
  const [entry] = await prepare(project, ['word']);
  await ok(await publish(project, epoch, [entry.preparedKey]));
  const [snapshot] = await historyStore.list(project.id);
  assert.ok((await historyStore.get(project.id, snapshot.id))?.snapshot.wordHighlightFollow?.enabled);
  const restored = await ok(await api(project, `/history/${snapshot.id}/restore`, 'POST', { expectedMedia: project.media }));
  assert.equal(restored.wordHighlightFollow, undefined);
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey]), intentChanged);
  await arm(project);
  assert.equal((await api(project, '', 'DELETE')).status, 204);
  assert.equal(await store.get(project.id), null);
  assert.equal(wordHighlightCandidateStore.get(entry.preparedKey), undefined);
});

test('same original name and size on replacement still change media identity and clear follow', async () => {
  const { project, epoch } = await setup('replace', [cue('word')], { word: [120, 160] });
  const [entry] = await prepare(project, ['word']);
  const requestId = randomUUID();
  const committed = await ok(await publish(project, epoch, [entry.preparedKey], 'apply', requestId));
  const fingerprint = mediaFingerprint(project);
  assert.ok(wordHighlightPublicationReceipts.get(project.id, fingerprint, requestId));
  await fs.writeFile(path.join(config.uploadDir, project.media.filename), 'old!');
  const body = new FormData();
  body.append('media', new Blob(['new!'], { type: 'audio/wav' }), project.media.originalName);
  body.set('mode', 'reset');
  body.set('expectedMedia', JSON.stringify({ filename: project.media.filename, size: project.media.size }));
  body.set('expectedUpdatedAt', committed.project.updatedAt);
  const replacement = await ok(await fetch(`${base}/${project.id}/replace-media`, { method: 'POST', body }));
  cancelScheduledProjectPrewarm(project.id);
  assert.equal(replacement.media.size, project.media.size);
  assert.equal(replacement.media.originalName, project.media.originalName);
  assert.notEqual(replacement.media.filename, project.media.filename);
  assert.equal(replacement.wordHighlightFollow, undefined);
  assert.equal(wordHighlightCandidateStore.get(entry.preparedKey), undefined);
  assert.equal(wordHighlightPublicationReceipts.get(project.id, fingerprint, requestId), undefined);
  assert.deepEqual(await ok(await readReceipt(project, requestId)), { committed: false });
  assert.deepEqual(await ok(await readReceipt(replacement, requestId)), { committed: false });
  await rejectsUnchanged(project, () => publish(project, epoch, [entry.preparedKey]), intentChanged);
  const recovered = await ok(await api(project, `/media-replacements/${replacement.mediaReplacement.id}/restore`, 'POST', {
    expectedMedia: replacement.media, expectedUpdatedAt: replacement.updatedAt,
  }));
  cancelScheduledProjectPrewarm(project.id);
  assert.equal(recovered.wordHighlightFollow, undefined);
});

test('three follow publications preserve the first snapshot, and later saves break only the relevant burst', async (t) => {
  let now = Date.now();
  const { project, epoch } = await setup('history', [cue('one'), cue('two', 400, 600), cue('three', 700, 900), cue('four', 1_000, 1_200)], {
    one: [120, 150], two: [430, 470], three: [750, 780], four: [1_060, 1_080],
  });
  const [one, two, three, four] = await prepare(project, ['one', 'two', 'three', 'four']);
  t.mock.method(Date, 'now', () => now);
  await ok(await publish(project, epoch, [one.preparedKey], 'follow'));
  const [first] = await historyStore.list(project.id);
  assert.equal(first.source, 'word-highlight-auto');
  assert.equal(first.label, 'Before updating word highlights after edits');
  now += 4_000;
  const auto = await historyStore.checkpoint((await store.get(project.id))!, 'Autosave', 'autosave', { dedupeWindowMs: 15_000 });
  now += 2_000;
  await ok(await publish(project, epoch, [two.preparedKey], 'follow'));
  now += 2_000;
  const autosave = await historyStore.checkpoint((await store.get(project.id))!, 'Autosave', 'autosave', { dedupeWindowMs: 15_000 });
  assert.equal(autosave.id, auto.id);
  assert.notEqual(autosave.createdAt, auto.createdAt);
  now += 2_000;
  await ok(await publish(project, epoch, [three.preparedKey], 'follow'));
  assert.deepEqual((await historyStore.list(project.id)).map(({ id }) => id), [auto.id, first.id]);
  assert.deepEqual((await historyStore.get(project.id, first.id))?.snapshot, project);
  now += 5_000;
  await ok(await publish(project, epoch, [four.preparedKey], 'follow'));
  const afterWindow = await historyStore.list(project.id);
  assert.notEqual(afterWindow[0].id, first.id);
  assert.equal(afterWindow[0].source, 'word-highlight-auto');
  assert.equal(afterWindow.filter(({ source }) => source === 'word-highlight-auto').length, 2);
});

for (const [barrier, label] of [
  ['manual-save', 'Before manual save'],
  ['restore', 'Before restoring an earlier version'],
] as const) {
  test(`History dedupes an identical ${barrier} checkpoint and keeps the follow burst open`, async () => {
    const project = fixture(`barrier-${barrier}-identical`, [cue('word')]);
    const options = { coalesceKey: 'first-epoch', coalesceWindowMs: 15_000 };
    const first = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', options);
    const middle = await historyStore.checkpoint(project, label, barrier);
    assert.equal(middle.id, first.id);
    const second = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', options);
    assert.equal(second.id, first.id);
    const newEpoch = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', { ...options, coalesceKey: 'new-epoch' });
    assert.deepEqual((await historyStore.list(project.id)).map(({ id }) => id), [newEpoch.id, first.id]);
  });

  test(`History preserves a changed ${barrier} checkpoint and closes the follow burst`, async () => {
    const project = fixture(`barrier-${barrier}-changed`, [cue('word')]);
    const changed = { ...project, captions: [{ ...project.captions[0], text: 'Changed text' }] };
    const options = { coalesceKey: 'first-epoch', coalesceWindowMs: 15_000 };
    const first = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', options);
    const middle = await historyStore.checkpoint(changed, label, barrier);
    const second = await historyStore.checkpoint(changed, 'Follow', 'word-highlight-auto', options);
    const newEpoch = await historyStore.checkpoint(changed, 'Follow', 'word-highlight-auto', { ...options, coalesceKey: 'new-epoch' });
    assert.deepEqual((await historyStore.list(project.id)).map(({ id }) => id), [newEpoch.id, second.id, middle.id, first.id]);
  });
}

for (const [barrier, label] of [
  ['word-highlight', 'Before applying word highlights'],
  ['word-highlight', 'Before undoing word highlights'],
] as const) {
  test(`History preserves a distinct ${label.toLowerCase()} barrier even at an identical fingerprint`, async () => {
    const project = fixture(`barrier-${label.split(' ').at(-2)}-${label.split(' ')[1]}`, [cue('word')]);
    const options = { coalesceKey: 'first-epoch', coalesceWindowMs: 15_000 };
    const first = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', options);
    const middle = await historyStore.checkpoint(project, label, barrier);
    const second = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', options);
    const newEpoch = await historyStore.checkpoint(project, 'Follow', 'word-highlight-auto', { ...options, coalesceKey: 'new-epoch' });
    assert.deepEqual((await historyStore.list(project.id)).map(({ id }) => id), [newEpoch.id, second.id, middle.id, first.id]);
  });
}

test('exact receipt Undo after replacing a stale persisted legacy track', async () => {
  const caption = cue('word');
  caption.wordTiming = {
    version: 1, text: 'past',
    words: [{ id: 'legacy-manual', startOffset: 0, endOffset: 4, source: 'manual', startMs: 130, endMs: 170 }],
  };
  const { project, epoch } = await setup('stale-legacy-undo', [caption], { word: [120, 160] });
  const [candidate] = await prepare(project, ['word']);
  const requestId = randomUUID();
  const result = await ok(await publish(project, epoch, [candidate.preparedKey], 'apply', requestId));
  assert.equal(result.appliedCount, 1);
  assert.deepEqual(result.applied[0].before, caption);
  assert.equal(result.applied[0].after.wordTiming.evidence, 2);
  const receipt = await ok(await readReceipt(project, requestId));
  assert.deepEqual(receipt, { committed: true, intent: 'apply', applied: result.applied });
  const historyBeforeUndo = await historyStore.list(project.id);
  assert.equal(historyBeforeUndo.length, 1);
  const undo = await api(project, batchPath, 'POST', {
    expectedMedia: project.media, action: 'undo', intent: 'apply',
    changes: receipt.applied.map(({ before, after }: { before: CaptionSegment; after: CaptionSegment }) => ({ before: after, after: before })),
  });
  if (undo.status !== 200) {
    assert.deepEqual(await store.get(project.id), result.project);
    assert.deepEqual(await historyStore.list(project.id), historyBeforeUndo);
  }
  const undone = await ok(undo);
  assert.deepEqual(undone.project.captions, project.captions);
  assert.equal(undone.project.wordHighlightFollow.enabled, false);
});
