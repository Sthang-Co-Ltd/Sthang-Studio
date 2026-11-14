import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE } from '@kcs/shared';
import {
  queueCaptionAppearanceSave,
  flushCaptionAppearanceSaves,
  getCaptionAppearanceSaveState,
  markCaptionAppearanceDraft,
  observeSavedCaptionAppearance,
  recoverUnsavedCaptionAppearance,
  subscribeCaptionAppearanceSaves,
  waitForCaptionAppearanceSaves,
  withCaptionAppearanceBarrier,
} from '../apps/web/src/caption-appearance-save.js';

const sourceMedia = { filename: 'synthetic-source.mp4', size: 100 };

// Each editor starts from an adopted saved look. The queue never invents one.
test.beforeEach((t) => observeSavedCaptionAppearance(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('an untouched project has no pending or recoverable appearance', async (t) => {
  assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia), null);
});

test('a revision check and save reserves the appearance lane until the write settles', async (t) => {
  const firstResponse = deferred<Response>();
  const firstStarted = deferred<void>();
  const saveGate = deferred<void>();
  const saveStarted = deferred<void>();
  const events: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    events.push('appearance');
    if (events.length === 1) { firstStarted.resolve(); return firstResponse.promise; }
    return new Response(null, { status: 204 });
  });
  const appearance = queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia);
  await firstStarted.promise;
  const save = withCaptionAppearanceBarrier(t.name, async () => {
    events.push('revision-read'); saveStarted.resolve();
    await saveGate.promise;
    events.push('caption-put');
    return 'saved';
  });
  const laterAppearance = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, bold: false }, sourceMedia);
  assert.deepEqual(events, ['appearance']);
  firstResponse.resolve(new Response(null, { status: 204 }));
  await saveStarted.promise;
  assert.deepEqual(events, ['appearance', 'revision-read']);
  saveGate.resolve();
  assert.deepEqual(await Promise.all([appearance, save, laterAppearance]), [true, 'saved', true]);
  assert.deepEqual(events, ['appearance', 'revision-read', 'caption-put', 'appearance']);
});

test('a rejected caption save does not poison appearance or claim to repair an appearance failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  assert.equal(await queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia), false);
  await assert.rejects(withCaptionAppearanceBarrier(t.name, async () => { throw new Error('save conflict'); }), /save conflict/);
  assert.equal(await waitForCaptionAppearanceSaves(t.name, sourceMedia), false);
  assert.ok(recoverUnsavedCaptionAppearance(t.name, sourceMedia));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia), true);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('same-project saves serialize immutable snapshots and barriers wait for the last write', async (t) => {
  const firstResponse = deferred<Response>();
  const secondResponse = deferred<Response>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const requests: Array<{ url: unknown; options?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', (url: unknown, options?: RequestInit) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      firstStarted.resolve();
      return firstResponse.promise;
    }
    secondStarted.resolve();
    return secondResponse.promise;
  });

  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 48 };
  const first = queueCaptionAppearanceSave(t.name, appearance, sourceMedia);
  appearance.fontSize1080 = 72;
  const second = queueCaptionAppearanceSave(t.name, appearance, sourceMedia);
  appearance.fontSize1080 = 90;
  const barrier = waitForCaptionAppearanceSaves(t.name);

  await firstStarted.promise;
  assert.equal(requests.length, 1, 'the second write must not overtake the first');
  assert.equal(requests[0].url, `/api/video-export/${t.name}/appearance`);
  assert.equal(requests[0].options?.method, 'PUT');
  assert.equal(JSON.parse(String(requests[0].options?.body)).appearance.fontSize1080, 48);

  firstResponse.resolve(new Response(null, { status: 204 }));
  assert.equal(await first, true);
  await secondStarted.promise;
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(String(requests[1].options?.body)).appearance.fontSize1080, 72);
  // Finishing the first task must not remove the second task from the queue.
  const lateBarrier = waitForCaptionAppearanceSaves(t.name);
  secondResponse.reject(new Error('synthetic connection failure'));
  assert.equal(await second, false);
  assert.equal(await barrier, false);
  assert.equal(await lateBarrier, false);
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia)?.fontSize1080, 72);
});

test('a stalled project does not block appearance saves for another project', async (t) => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const stalledId = `${t.name}-stalled`;
  observeSavedCaptionAppearance(stalledId, DEFAULT_CAPTION_APPEARANCE, sourceMedia);
  t.mock.method(globalThis, 'fetch', (url: unknown) => {
    if (url === `/api/video-export/${stalledId}/appearance`) {
      started.resolve();
      return response.promise;
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const stalled = queueCaptionAppearanceSave(stalledId, DEFAULT_CAPTION_APPEARANCE, sourceMedia);
  await started.promise;
  try {
    assert.equal(await queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia), true);
    assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  } finally {
    response.resolve(new Response(null, { status: 204 }));
    await stalled;
  }
});

test('failed saves remain recoverable by copy until a successful retry', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#123456' };
  assert.equal(await queueCaptionAppearanceSave(t.name, appearance, sourceMedia), false);
  assert.equal(await waitForCaptionAppearanceSaves(t.name), false);
  appearance.textColor = '#FFFFFF';
  const recovered = recoverUnsavedCaptionAppearance(t.name, sourceMedia);
  assert.ok(recovered);
  assert.equal(recovered.textColor, '#123456');
  recovered.textColor = '#000000';
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia)?.textColor, '#123456');

  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  assert.equal(await queueCaptionAppearanceSave(t.name, recovered, sourceMedia), true);
  assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia), null);
});

test('a failed write does not poison the next already-queued save', async (t) => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      return response.promise;
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const first = queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, sourceMedia);
  const second = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, bold: false }, sourceMedia);
  const barrier = waitForCaptionAppearanceSaves(t.name);
  await started.promise;
  response.reject(new Error('synthetic connection failure'));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(await barrier, true);
  assert.equal(calls, 2);
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia), null);
});


test('queued appearance captures media identity and recovery cannot leak across replacement', async (t) => {
  const source = { filename: 'retired.mp4', size: 42 };
  const next = { filename: 'replacement.mp4', size: 84 };
  observeSavedCaptionAppearance(t.name, DEFAULT_CAPTION_APPEARANCE, source);
  const pending = deferred<Response>();
  const started = deferred<void>();
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)));
    started.resolve();
    return pending.promise;
  });
  const save = queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE, source);
  source.filename = next.filename;
  source.size = next.size;
  await started.promise;
  assert.deepEqual(bodies[0].expectedMedia, { filename: 'retired.mp4', size: 42 });
  pending.resolve(new Response('{}', { status: 409 }));
  assert.equal(await save, false);
  assert.ok(recoverUnsavedCaptionAppearance(t.name, { filename: 'retired.mp4', size: 42 }));
  assert.equal(recoverUnsavedCaptionAppearance(t.name, next), null);
  assert.equal(await waitForCaptionAppearanceSaves(t.name, next), true);
});

test('an appearance edit is protected during debounce and an older success cannot mark its newer draft saved', async (t) => {
  const firstResponse = deferred<Response>();
  const started = deferred<void>();
  const sent: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    sent.push(JSON.parse(String(options?.body)).appearance.fontSize1080);
    if (sent.length === 1) { started.resolve(); return firstResponse.promise; }
    return new Response(null, { status: 204 });
  });
  const seen: string[] = [];
  const unsubscribe = subscribeCaptionAppearanceSaves(() => seen.push(getCaptionAppearanceSaveState(t.name, sourceMedia).status));
  try {
    const first = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 70 }, sourceMedia);
    await started.promise;
    const newer = markCaptionAppearanceDraft(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 }, sourceMedia);
    assert.equal(newer.status, 'pending');
    firstResponse.resolve(new Response(null, { status: 204 }));
    assert.equal(await first, true);
    assert.equal(await waitForCaptionAppearanceSaves(t.name, sourceMedia), false);
    assert.deepEqual(getCaptionAppearanceSaveState(t.name, sourceMedia), {
      ...newer, basis: { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 70 },
    }, 'only the saved basis advances; the newer revision, value and pending state remain');
    assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia)?.fontSize1080, 91);
    assert.equal(await flushCaptionAppearanceSaves(t.name, sourceMedia), true);
    assert.deepEqual(sent, [70, 91]);
    assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia).status, 'saved');
    assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia).revision, newer.revision);
    assert.ok(seen.includes('pending') && seen.includes('saving') && seen.at(-1) === 'saved');
  } finally { unsubscribe(); firstResponse.resolve(new Response(null, { status: 204 })); }
});

test('a failed older write preserves the newer debounce draft and one explicit retry saves that latest look', async (t) => {
  const firstResponse = deferred<Response>();
  const started = deferred<void>();
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    sent.push(JSON.parse(String(options?.body)).appearance.textColor);
    if (sent.length === 1) { started.resolve(); return firstResponse.promise; }
    return new Response(null, { status: 204 });
  });
  const first = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#111111' }, sourceMedia);
  await started.promise;
  markCaptionAppearanceDraft(t.name, { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#222222' }, sourceMedia);
  firstResponse.reject(new Error('Synthetic interrupted save'));
  assert.equal(await first, false);
  assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia).status, 'pending');
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia)?.textColor, '#222222');
  assert.equal(await flushCaptionAppearanceSaves(t.name, sourceMedia), true);
  assert.deepEqual(sent, ['#111111', '#222222']);
});

test('a tool flush, navigation and header Save share one pending write and can retry its failure after the tool closes', async (t) => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return response.promise; });
  const look = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 84 };
  markCaptionAppearanceDraft(t.name, look, sourceMedia);
  const write = queueCaptionAppearanceSave(t.name, look, sourceMedia);
  await started.promise;
  const repeated = queueCaptionAppearanceSave(t.name, look, sourceMedia);
  const header = flushCaptionAppearanceSaves(t.name, sourceMedia);
  assert.equal(repeated, write);
  assert.equal(fetchMock.mock.callCount(), 1);
  response.reject(new Error('Synthetic offline response'));
  assert.deepEqual(await Promise.all([write, repeated, header]), [false, false, false]);
  assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia).status, 'error');
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  assert.equal(await flushCaptionAppearanceSaves(t.name, sourceMedia), true);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(recoverUnsavedCaptionAppearance(t.name, sourceMedia), null);
});

test('editing back to a previously saved value is a new draft after a different saved look was loaded', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const original = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 72 };
  await queueCaptionAppearanceSave(t.name, original, sourceMedia);
  const saved = getCaptionAppearanceSaveState(t.name, sourceMedia);
  // Another tab can save a different look which the workspace loads directly.
  // A deliberate edit back to72 must still be submitted, even though this lane
  // last acknowledged72 before that external save.
  observeSavedCaptionAppearance(t.name, { ...original, fontSize1080: 85 }, sourceMedia);
  const edited = markCaptionAppearanceDraft(t.name, original, sourceMedia);
  assert.equal(edited.status, 'pending');
  assert.ok(edited.revision > saved.revision);
  assert.equal(await waitForCaptionAppearanceSaves(t.name, sourceMedia), false);
  assert.equal(await flushCaptionAppearanceSaves(t.name, sourceMedia), true);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('a missing adopted appearance basis fails closed without submitting a write', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const id = t.name + '-unopened';
  assert.equal(await queueCaptionAppearanceSave(id, DEFAULT_CAPTION_APPEARANCE, sourceMedia), false);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(getCaptionAppearanceSaveState(id, sourceMedia).status, 'error');
  assert.ok(recoverUnsavedCaptionAppearance(id, sourceMedia));
});

test('queued changes use only their own preceding acknowledged appearance as the next basis', async (t) => {
  const response = deferred<Response>(); const started = deferred<void>();
  const bodies: Array<{ appearance: typeof DEFAULT_CAPTION_APPEARANCE; expectedAppearance: typeof DEFAULT_CAPTION_APPEARANCE }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)));
    if (bodies.length === 1) { started.resolve(); return response.promise; }
    return new Response(null, { status: 204 });
  });
  const firstLook = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 76 };
  const secondLook = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 };
  const first = queueCaptionAppearanceSave(t.name, firstLook, sourceMedia);
  await started.promise;
  const second = queueCaptionAppearanceSave(t.name, secondLook, sourceMedia);
  observeSavedCaptionAppearance(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 120 }, sourceMedia);
  response.resolve(new Response(null, { status: 204 }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(bodies.map((body) => body.expectedAppearance.fontSize1080), [DEFAULT_CAPTION_APPEARANCE.fontSize1080, 76]);
  assert.deepEqual(bodies.map((body) => body.appearance.fontSize1080), [76, 91]);
  assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia).basis?.fontSize1080, 91);
});

test('a foreign appearance conflict retains the newest draft and prevents queued or explicit overwrites', async (t) => {
  const response = deferred<Response>(); const started = deferred<void>();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return response.promise; });
  const first = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 76 }, sourceMedia);
  await started.promise;
  const second = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 }, sourceMedia);
  response.resolve(new Response(JSON.stringify({ error: 'Saved appearance changed', code: 'APPEARANCE_REVISION_CHANGED' }), { status: 409 }));
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await flushCaptionAppearanceSaves(t.name, sourceMedia), false);
  assert.equal(fetchMock.mock.callCount(), 1);
  const state = getCaptionAppearanceSaveState(t.name, sourceMedia);
  assert.equal(state.conflict, true);
  assert.equal(state.appearance?.fontSize1080, 91);
  assert.deepEqual(state.basis, DEFAULT_CAPTION_APPEARANCE);
  observeSavedCaptionAppearance(t.name, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 100 }, sourceMedia);
  assert.equal(getCaptionAppearanceSaveState(t.name, sourceMedia), state, 'an unrelated read cannot rebase a conflict');
});
