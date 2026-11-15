import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessingJob } from '@kcs/shared';
import { api, ApiRequestError } from '../apps/web/src/api.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const job = (id: string) => ({ id, projectId: 'project-a', status: 'queued' }) as ProcessingJob;

test('concurrent Activity callers share one pending read and the next settled refresh is fresh', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const gate = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? gate.promise : response([job('later')]); };
  const readers = Array.from({ length: 12 }, () => api.jobs());
  assert.equal(calls, 1);
  gate.resolve(response([job('first')]));
  for (const value of await Promise.all(readers)) assert.equal(value[0].id, 'first');
  assert.equal((await api.jobs())[0].id, 'later');
  assert.equal(calls, 2);
});

test('different project filters share only their own pending result', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const reads: Array<{ url: string; gate: ReturnType<typeof deferred<Response>> }> = [];
  globalThis.fetch = async (input) => {
    const gate = deferred<Response>(); reads.push({ url: String(input), gate }); return gate.promise;
  };
  const values = [api.jobs('project/a'), api.jobs('project/a'), api.jobs('project-b'), api.jobs()];
  assert.deepEqual(reads.map((read) => read.url), ['/api/jobs?projectId=project%2Fa', '/api/jobs?projectId=project-b', '/api/jobs']);
  reads.forEach((read, index) => read.gate.resolve(response([job(String(index))])));
  assert.deepEqual((await Promise.all(values)).map((value) => value[0].id), ['0', '0', '1', '2']);
});

test('a mutation retires earlier reads without allowing their cleanup to remove the new shared owner', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const gates: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return response(job('resumed'));
    const gate = deferred<Response>(); gates.push(gate); return gate.promise;
  };
  const before = api.jobs();
  await api.resumeJob('resumed');
  const after = api.jobs();
  assert.equal(gates.length, 2);
  gates[0].resolve(response([job('old')]));
  assert.equal((await before)[0].id, 'old');
  const joined = api.jobs();
  assert.equal(gates.length, 2);
  gates[1].resolve(response([job('resumed')]));
  assert.equal((await after)[0].id, 'resumed');
  assert.equal((await joined)[0].id, 'resumed');
});

test('failed shared reads settle every caller and permit one fresh retry', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const gate = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? gate.promise : response([job('recovered')]); };
  const first = api.jobs(); const second = api.jobs();
  const failures = Promise.allSettled([first, second]);
  gate.reject(new TypeError('Synthetic offline request'));
  assert.deepEqual((await failures).map((item) => item.status), ['rejected', 'rejected']);
  assert.equal((await api.jobs())[0].id, 'recovered');
  assert.equal(calls, 2);
});

test('creation errors carry a definite retry decision without changing other API errors', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => response({ error: 'Choose a smaller file.', code: 'PROJECT_CREATE_NOT_APPLIED', retryable: false }, 413);
  await assert.rejects(api.get('attempt'), (error: unknown) => error instanceof ApiRequestError
    && error.code === 'PROJECT_CREATE_NOT_APPLIED' && error.retryable === false && error.message === 'Choose a smaller file.');
});

test('a stalled Activity read aborts every joiner at its original deadline and permits a fresh retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; t.mock.timers.reset(); });
  const signals: AbortSignal[] = []; let calls = 0; let settled = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const signal = init?.signal; assert.ok(signal); signals.push(signal);
    if (calls > 1) return response([job('recovered-after-deadline')]);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const readers = [api.jobs(), api.jobs()];
  for (const reader of readers) void reader.then(() => { settled++; }, () => { settled++; });
  t.mock.timers.tick(14_999); await Promise.resolve();
  assert.equal(settled, 0); assert.equal(signals[0].aborted, false);
  const lateJoiner = api.jobs();
  const failures = Promise.allSettled([...readers, lateJoiner]);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  for (const result of await failures) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.name, 'AbortError');
  }
  assert.equal(signals[0].aborted, true);
  assert.equal((await api.jobs())[0].id, 'recovered-after-deadline');
  assert.equal(calls, 2);
  t.mock.timers.tick(60_000);
  assert.equal(signals[1].aborted, false, 'settled reads must clear their timer');
  assert.equal(calls, 2, 'a read deadline never starts another request itself');
});

test('the Activity deadline also aborts an unfinished JSON response body after headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; t.mock.timers.reset(); });
  let calls = 0; let body: ReadableStream<Uint8Array> | undefined; let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    calls++;
    if (calls > 1) return response([job('recovered-body')]);
    assert.ok(init?.signal); signal = init.signal;
    body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"id":"unfinished'));
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
    } });
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  };
  const results = Promise.allSettled([api.jobs(), api.jobs()]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(body?.locked, true, 'headers settled and JSON consumption started');
  t.mock.timers.tick(15_000);
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.name, 'AbortError');
  }
  assert.equal(signal?.aborted, true);
  assert.equal((await api.jobs())[0].id, 'recovered-body');
  assert.equal(calls, 2);
});

test('an old read deadline cannot abort or clear a newer mutation-generation read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; t.mock.timers.reset(); });
  const reads: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<Response>> }> = [];
  let mutations = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      mutations++; assert.equal(init.signal, undefined, 'the read deadline must not cancel mutations');
      return response(job('resumed-after-old-read'));
    }
    assert.ok(init?.signal);
    const gate = deferred<Response>(); const signal = init.signal;
    signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true });
    reads.push({ signal, gate }); return gate.promise;
  };
  const before = api.jobs();
  const timedOut = assert.rejects(before, (error: Error) => error.name === 'AbortError');
  t.mock.timers.tick(5_000);
  await api.resumeJob('resumed-after-old-read');
  const after = api.jobs();
  assert.equal(reads.length, 2);
  t.mock.timers.tick(10_000); await timedOut;
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(reads[1].signal.aborted, false);
  const joined = api.jobs(); assert.equal(reads.length, 2);
  reads[1].gate.resolve(response([job('resumed-after-old-read')]));
  for (const value of await Promise.all([after, joined])) assert.equal(value[0].id, 'resumed-after-old-read');
  t.mock.timers.tick(60_000);
  assert.equal(reads[1].signal.aborted, false);
  assert.equal(mutations, 1, 'settling an old read must not retry its related mutation');
});

test('newer healthy streamed snapshots supersede a pending fallback success, failure and deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  t.after(() => {
    source?.onerror?.();
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalSource) Object.defineProperty(globalThis, 'EventSource', originalSource); else Reflect.deleteProperty(globalThis, 'EventSource');
  });
  let source!: FakeSource;
  class FakeSource extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { super(); source = this; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource });
  const reads: Array<{ gate: ReturnType<typeof deferred<Response>>; signal: AbortSignal }> = []; let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++; assert.ok(init?.signal);
    const gate = deferred<Response>(); const signal = init.signal;
    signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true });
    reads.push({ gate, signal }); return gate.promise;
  };
  const pending = api.jobs();
  source.dispatchEvent(new MessageEvent('jobs', { data: JSON.stringify([job('streamed')]) }));
  reads[0].gate.resolve(response([job('old-fallback')]));
  assert.equal((await pending)[0].id, 'streamed');
  assert.equal((await api.jobs())[0].id, 'streamed');
  assert.equal(calls, 1);
  t.mock.timers.tick(15_000);
  assert.equal(reads[0].signal.aborted, false, 'SSE supersession still clears a settled read timer');

  source.onerror?.();
  const failed = api.jobs(); const joinedFailure = api.jobs();
  source.dispatchEvent(new MessageEvent('jobs', { data: JSON.stringify([job('streamed-after-error')]) }));
  reads[1].gate.reject(new TypeError('Late retired fallback failure'));
  for (const value of await Promise.all([failed, joinedFailure])) assert.equal(value[0].id, 'streamed-after-error');
  assert.equal((await api.jobs())[0].id, 'streamed-after-error');
  assert.equal(calls, 2);

  source.onerror?.();
  const expired = api.jobs(); const joinedDeadline = api.jobs();
  source.dispatchEvent(new MessageEvent('jobs', { data: JSON.stringify([job('streamed-before-deadline')]) }));
  t.mock.timers.tick(15_000);
  for (const value of await Promise.all([expired, joinedDeadline])) assert.equal(value[0].id, 'streamed-before-deadline');
  assert.equal(reads[2].signal.aborted, true);
  assert.equal((await api.jobs())[0].id, 'streamed-before-deadline');
  assert.equal(calls, 3);
});
