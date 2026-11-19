import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type CaptionSegment, type CaptionWord } from '@kcs/shared';
import { ApiRequestError, WordHighlightPublicationError } from '../apps/web/src/api';
import {
  affectedHighlightIds, classifyHighlightTargets, runWordHighlightPass, wordHighlightCoverage,
  type WordHighlightProgress,
} from '../apps/web/src/word-highlight-apply';

const cue = (id: string, startMs = 100, text = 'Alpha beta'): CaptionSegment => ({ id, text, startMs, endMs: startMs + 200 });
const fixture = (captions: CaptionSegment[]): CaptionProject => ({
  id: 'fixture', title: 'Fixture', captions, transcript: null, mode: 'single-line', engineVersion: 'fixture',
  createdAt: 'first', updatedAt: 'first', captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, highlightMode: 'word' },
  media: { filename: 'fixture.mp4', size: 10, originalName: 'fixture.mp4', url: '/media/fixture.mp4', mimeType: 'video/mp4' },
});
const fingerprint = createHash('sha256').update('fixture.mp4:10:fixture.mp4').digest('hex').slice(0, 24);

function setup(captions = [cue('a'), cue('b', 400)], overrides: Partial<Parameters<typeof runWordHighlightPass>[0]> = {}) {
  const saved = fixture(captions);
  saved.wordHighlightFollow = { version: 1, mediaFingerprint: fingerprint, enabled: true, epoch: 'epoch' };
  const states: WordHighlightProgress[] = [];
  const chunks: string[][] = [];
  const publications: Array<[string, string[], string]> = [];
  const adopted: Array<unknown> = [];
  const controller = new AbortController();
  let receipts = 0;
  let historyFallbacks = 0;
  let unconfirmed = 0;
  const options: Parameters<typeof runWordHighlightPass>[0] = {
    signal: controller.signal, intent: 'apply',
    waitForClean: async () => saved,
    arm: async () => 'epoch',
    waitForJob: async () => true,
    prepare: async () => ({ mediaFingerprint: fingerprint }),
    candidates: async (ids) => {
      chunks.push(ids);
      return { results: ids.map((id) => ({ id, status: 'candidate', preparedKey: id + 'key' })) };
    },
    inPublicationLane: async (operation) => { await operation((result) => adopted.push(result)); return true; },
    publish: async (...args) => { publications.push(args); return { project: saved, applied: [] }; },
    readReceipt: async () => { receipts++; return { committed: false }; },
    readProject: async () => saved,
    onProgress: (progress) => states.push(progress),
    onHistoryRecovery: () => { historyFallbacks++; },
    onUnconfirmedPublication: () => { unconfirmed++; },
    newRequestId: () => 'request-id',
    delay: async () => {},
    ...overrides,
  };
  return {
    saved, controller, chunks, publications, states, adopted, options,
    receipts: () => receipts, historyFallbacks: () => historyFallbacks, unconfirmed: () => unconfirmed,
    run: () => runWordHighlightPass(options),
  };
}
const conflict = (code: string, changedIds: string[] = [], expiredKeys: string[] = []) =>
  new WordHighlightPublicationError(code, code, changedIds, expiredKeys);

test('all captions reach a disposition even when an early target fails and a response omits an ID', async () => {
  const captions = Array.from({ length: 66 }, (_, index) => cue(String(index), 300 * index));
  captions.push({ ...cue('locked'), timingLocked: true }, cue('punctuation', 21_000, '?'), cue('blank', 21_300, ' '));
  const pass = setup(captions);
  const normal = pass.options.candidates;
  pass.options.candidates = async (ids, signal) => {
    const { results } = await normal(ids, signal);
    return { results: results.filter(({ id }) => id !== '52').map((result) =>
      result.id === '1' ? { id: '1', status: 'error' } : result) };
  };
  const result = await pass.run();
  assert.deepEqual(pass.chunks.map((ids) => ids.length), [32, 32, 2]);
  assert.equal(result?.dispositions.size, captions.length);
  assert.equal(result.dispositions.get('1'), 'error');
  assert.equal(result.dispositions.get('2'), 'candidate');
  assert.equal(result.dispositions.get('52'), 'error');
  assert.equal(result.dispositions.get('locked'), 'locked');
  assert.equal(result.dispositions.get('punctuation'), 'non-speech');
  assert.equal(pass.publications.length, 1);
  assert.equal(pass.publications[0][1].length, 64);
  assert.deepEqual(pass.states.at(-1), { status: 'complete', total: 66, completed: 66, pauseReason: undefined });
});

test('a run-level 503 pauses without contacting candidates or publishing', async () => {
  const pass = setup(undefined, { prepare: async () => { throw new ApiRequestError('Unavailable', 503, 'WORD_TIMING_UNAVAILABLE'); } });
  assert.equal(await pass.run(), undefined);
  assert.equal(pass.states.at(-1)?.pauseReason, 'unavailable');
  assert.deepEqual(pass.chunks, []);
  assert.deepEqual(pass.publications, []);
});

test('a busy job pauses and retries the blocked call once', async () => {
  const pass = setup();
  let prepares = 0;
  let resume!: (free: boolean) => void;
  const free = new Promise<boolean>((resolve) => { resume = resolve; });
  let reachedBusy!: () => void;
  const blocked = new Promise<void>((resolve) => { reachedBusy = resolve; });
  pass.options.waitForJob = () => { reachedBusy(); return free; };
  pass.options.prepare = async () => {
    if (++prepares === 1) throw new ApiRequestError('Busy', 409, 'WORD_TIMING_PROJECT_BUSY');
    return { mediaFingerprint: fingerprint };
  };
  const operation = pass.run();
  await blocked;
  assert.equal(pass.states.at(-1)?.pauseReason, 'busy');
  assert.equal(pass.publications.length, 0);
  resume(true);
  await operation;
  assert.equal(prepares, 2);
  assert.equal(pass.publications.length, 1);
});

test('arming and publishing wait for separate clean editor acknowledgements', async () => {
  const pass = setup();
  const waiting: Array<() => void> = [];
  let calls = 0;
  let reachedPublicationGate!: () => void;
  const publicationGate = new Promise<void>((resolve) => { reachedPublicationGate = resolve; });
  pass.options.waitForClean = async () => {
    if (++calls !== 2) await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (calls === 3) reachedPublicationGate();
    });
    return pass.saved;
  };
  const operation = pass.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(pass.chunks, []);
  waiting.shift()!();
  await publicationGate;
  assert.deepEqual(pass.chunks, [['a', 'b']]);
  assert.deepEqual(pass.publications, []);
  waiting.shift()!();
  await operation;
  assert.equal(pass.publications.length, 1);
});

test('context-changed checks the affected IDs, then waits for a new revision after three retries', async () => {
  const pass = setup();
  let attempts = 0;
  let waitForRevision: string | undefined;
  const normal = pass.options.publish;
  pass.options.publish = async (...args) => {
    await normal(...args);
    if (++attempts <= 4) throw conflict('WORD_HIGHLIGHT_CONTEXT_CHANGED', ['b']);
    return { project: pass.saved, applied: [] };
  };
  pass.options.waitForClean = async (afterRevision) => {
    if (afterRevision) { waitForRevision = afterRevision; pass.saved.updatedAt = 'after edit'; }
    return pass.saved;
  };
  await pass.run();
  assert.equal(waitForRevision, 'first');
  assert.deepEqual(pass.chunks, [['a', 'b'], ['b'], ['b'], ['b'], ['b']]);
  assert.ok(pass.publications.every(([, keys]) => keys.includes('akey')));
});

test('expiry checks only expired keys once and an intent change stops silently', async () => {
  const pass = setup();
  const normal = pass.options.publish;
  pass.options.publish = async (...args) => {
    await normal(...args);
    throw pass.publications.length === 1
      ? conflict('WORD_HIGHLIGHT_PREPARED_EXPIRED', [], ['akey']) : conflict('WORD_HIGHLIGHT_INTENT_CHANGED');
  };
  assert.equal(await pass.run(), undefined);
  assert.deepEqual(pass.chunks, [['a', 'b'], ['a']]);
  assert.ok(!pass.states.some((state) => state.status === 'paused'));
  assert.equal(pass.receipts(), 0);
});

test('lost ACK followed by Cancel uses the exact receipt to adopt the committed state', async () => {
  const pass = setup();
  const before = pass.saved.captions[0];
  const after = { ...before, wordTiming: { version: 1 as const, text: before.text, words: [] } };
  const applied = [{ id: before.id, before, after }];
  const project = { ...pass.saved, captions: [after, pass.saved.captions[1]] };
  let reads = 0;
  pass.options.publish = async () => { pass.controller.abort(); throw new TypeError('Fetch failed'); };
  pass.options.readReceipt = async () => {
    if (!reads++) throw new TypeError('Fetch failed');
    return { committed: true, intent: 'apply', applied };
  };
  pass.options.readProject = async () => project;
  await pass.run();
  assert.equal(reads, 2);
  assert.deepEqual(pass.adopted, [{ project, applied }]);
});

test('known absent receipt retries the same ID and an expired receipt uses only History', async () => {
  const pass = setup();
  const normal = pass.options.publish;
  pass.options.publish = async (...args) => {
    const result = await normal(...args);
    if (pass.publications.length === 1) throw new TypeError('Fetch failed');
    return result;
  };
  await pass.run();
  assert.deepEqual(pass.publications[0], pass.publications[1]);
  assert.equal(pass.receipts(), 3);

  const expired = setup();
  expired.options.publish = async () => { throw new TypeError('Fetch failed'); };
  expired.options.readReceipt = async () => ({ committed: true, receiptAvailable: false });
  await expired.run();
  assert.equal(expired.historyFallbacks(), 1);
  assert.deepEqual(expired.adopted, [{ project: expired.saved, applied: [] }]);
});

test('follow diff handles editing, overlap, insert/delete, split/merge and unlock', () => {
  const a = cue('a', 0);
  const b = cue('b', 200);
  const c = cue('c', 400);
  const d = cue('d', 600);
  const e = { ...cue('e', 800), timingLocked: true };
  const original = [a, b, c, d, e];
  assert.deepEqual(affectedHighlightIds(original, [a, { ...b, text: 'new' }, c, d, e]), ['a', 'b', 'c']);
  assert.deepEqual(affectedHighlightIds(original, [a, { ...b, endMs: 700 }, c, d, e]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(affectedHighlightIds(original, [a, cue('x', 100), b, c, d, e]), ['a', 'x', 'b']);
  assert.deepEqual(affectedHighlightIds(original, [a, c, d, e]), ['a', 'c']);
  assert.deepEqual(affectedHighlightIds(original, [a, { ...b, endMs: 300 }, { ...cue('x', 300), endMs: 400 }, c, d, e]), ['a', 'b', 'x', 'c']);
  assert.deepEqual(affectedHighlightIds(original, [a, { ...b, endMs: 600 }, d, e]), ['a', 'b', 'd']);
  assert.deepEqual(affectedHighlightIds(original, [a, b, c, d, { ...e, timingLocked: false }]), ['d', 'e']);
  assert.deepEqual(affectedHighlightIds(original, [{ ...a, approved: true }, b, c, { ...d, wordTiming: { version: 1, text: d.text, words: [] } }, e]), []);
});

test('exceptions rank conflicts, plain and partial captions before locked ones, with groups counted as full', () => {
  const marked = (caption: CaptionSegment, words: CaptionWord[]) => ({
    ...caption, wordTiming: { version: 1 as const, evidence: 2 as const, text: caption.text, words },
  });
  const individual = (id: string, startOffset: number, endOffset: number): CaptionWord => ({
    id, startOffset, endOffset, startMs: 150, endMs: 210, method: 'kfa', source: 'aligned',
  });
  const issue = (id: string, startOffset: number, endOffset: number, code: CaptionWord['issue']): CaptionWord => ({
    id, startOffset, endOffset, startMs: null, endMs: null, issue: code, source: 'estimated', needsReview: true,
  });
  const partial = marked(cue('partial'), [individual('p0', 0, 5), issue('p1', 6, 10, 'missing')]);
  const urgent = marked(cue('urgent'), [individual('u0', 0, 5), issue('u1', 6, 10, 'ambiguous-occurrence')]);
  const group = marked(cue('group'), [{ ...individual('g0', 0, 10), method: 'kfa-group', members: [[0, 5], [6, 10]] }]);
  const result = wordHighlightCoverage([partial, { ...cue('locked'), timingLocked: true }, cue('plain'), urgent, group]);
  assert.deepEqual(result.exceptions.map(({ id }) => id), ['urgent', 'plain', 'partial', 'locked']);
  assert.equal(result.exceptions[0].wordId, 'u1');
  assert.deepEqual(result.counts, { 'full-individual': 0, 'full-with-groups': 1, partial: 2, none: 2 });
  assert.deepEqual(classifyHighlightTargets([group, partial]).targets, ['partial']);
});
