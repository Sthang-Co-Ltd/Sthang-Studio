import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE } from '@kcs/shared';
import {
  queueCaptionAppearanceSave,
  recoverUnsavedCaptionAppearance,
  waitForCaptionAppearanceSaves,
} from '../apps/web/src/caption-appearance-save.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('an untouched project has no pending or recoverable appearance', async (t) => {
  assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  assert.equal(recoverUnsavedCaptionAppearance(t.name), null);
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
  const first = queueCaptionAppearanceSave(t.name, appearance);
  appearance.fontSize1080 = 72;
  const second = queueCaptionAppearanceSave(t.name, appearance);
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
  assert.equal(recoverUnsavedCaptionAppearance(t.name)?.fontSize1080, 72);
});

test('a stalled project does not block appearance saves for another project', async (t) => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const stalledId = `${t.name}-stalled`;
  t.mock.method(globalThis, 'fetch', (url: unknown) => {
    if (url === `/api/video-export/${stalledId}/appearance`) {
      started.resolve();
      return response.promise;
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const stalled = queueCaptionAppearanceSave(stalledId, DEFAULT_CAPTION_APPEARANCE);
  await started.promise;
  try {
    assert.equal(await queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE), true);
    assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  } finally {
    response.resolve(new Response(null, { status: 204 }));
    await stalled;
  }
});

test('failed saves remain recoverable by copy until a successful retry', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, textColor: '#123456' };
  assert.equal(await queueCaptionAppearanceSave(t.name, appearance), false);
  assert.equal(await waitForCaptionAppearanceSaves(t.name), false);
  appearance.textColor = '#FFFFFF';
  const recovered = recoverUnsavedCaptionAppearance(t.name);
  assert.ok(recovered);
  assert.equal(recovered.textColor, '#123456');
  recovered.textColor = '#000000';
  assert.equal(recoverUnsavedCaptionAppearance(t.name)?.textColor, '#123456');

  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  assert.equal(await queueCaptionAppearanceSave(t.name, recovered), true);
  assert.equal(await waitForCaptionAppearanceSaves(t.name), true);
  assert.equal(recoverUnsavedCaptionAppearance(t.name), null);
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
  const first = queueCaptionAppearanceSave(t.name, DEFAULT_CAPTION_APPEARANCE);
  const second = queueCaptionAppearanceSave(t.name, { ...DEFAULT_CAPTION_APPEARANCE, bold: false });
  const barrier = waitForCaptionAppearanceSaves(t.name);
  await started.promise;
  response.reject(new Error('synthetic connection failure'));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(await barrier, true);
  assert.equal(calls, 2);
  assert.equal(recoverUnsavedCaptionAppearance(t.name), null);
});
