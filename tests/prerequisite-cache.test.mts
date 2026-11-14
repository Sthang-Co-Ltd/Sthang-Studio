import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrerequisiteCache } from '../apps/server/src/services/prerequisite-cache.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const cache = () => createPrerequisiteCache<string, string>({ maxEntries: 2, ttlMs: 30_000 });

test('concurrent prerequisite readers share one source probe and reuse its completed value', async () => {
  const store = cache(); const gate = deferred<string>(); let probes = 0;
  const load = () => { probes++; return gate.promise; };
  const first = store.read('project:source-a:100', load);
  const second = store.read('project:source-a:100', load);
  await Promise.resolve(); assert.equal(probes, 1);
  gate.resolve('available'); assert.deepEqual(await Promise.all([first, second]), ['available', 'available']);
  assert.equal(await store.read('project:source-a:100', async () => { throw new Error('unexpected probe'); }), 'available');
});

test('pre-invalidation font inventory cannot refill the cache or escape to its waiting caller', async () => {
  const store = cache(); const old = deferred<string>(); let probes = 0;
  const load = async () => { probes++; return probes === 1 ? old.promise : 'new-font-inventory'; };
  const beforeMutation = store.read('project:source:100', load);
  await Promise.resolve(); store.invalidate();
  assert.equal(await store.read('project:source:100', load), 'new-font-inventory');
  old.resolve('old-font-inventory');
  assert.equal(await beforeMutation, 'new-font-inventory');
  assert.equal(await store.read('project:source:100', load), 'new-font-inventory');
  assert.equal(probes, 2);
});

test('a retired failed probe joins newer pending work without clearing its ownership', async () => {
  const store = cache(); const old = deferred<string>(); const fresh = deferred<string>(); let probes = 0;
  const load = () => (++probes === 1 ? old.promise : fresh.promise);
  const first = store.read('source', load); await Promise.resolve(); store.invalidate();
  const second = store.read('source', load); await Promise.resolve();
  old.reject(new Error('retired probe failed')); await Promise.resolve(); await Promise.resolve();
  const third = store.read('source', load); await Promise.resolve(); assert.equal(probes, 2);
  fresh.resolve('current'); assert.deepEqual(await Promise.all([first, second, third]), ['current', 'current', 'current']);
});

test('multiple invalidations cannot revive intermediate font or support snapshots', async () => {
  const store = cache(); const old = deferred<string>(); const middle = deferred<string>(); let probes = 0;
  const load = () => { probes++; return probes === 1 ? old.promise : probes === 2 ? middle.promise : Promise.resolve('latest'); };
  const first = store.read('source', load); await Promise.resolve(); store.invalidate();
  const second = store.read('source', load); await Promise.resolve(); store.invalidate();
  const third = store.read('source', load); assert.equal(await third, 'latest');
  middle.resolve('intermediate'); old.resolve('obsolete');
  assert.deepEqual(await Promise.all([first, second]), ['latest', 'latest']); assert.equal(probes, 3);
});

test('current errors remain retryable while different media never share prerequisite evidence', async () => {
  const store = cache(); let failures = 0;
  await assert.rejects(store.read('project:old:100', async () => { failures++; throw new Error('offline'); }), /offline/);
  assert.equal(await store.read('project:old:100', async () => 'old-source'), 'old-source');
  assert.equal(await store.read('project:new:100', async () => 'new-source'), 'new-source');
  assert.equal(await store.read('project:new:101', async () => 'changed-bytes'), 'changed-bytes');
  assert.equal(failures, 1);
});

test('prerequisite reuse expires and stays bounded without polling or persistent storage', async () => {
  let now = 0; let probes = 0;
  const store = createPrerequisiteCache<string, number>({ maxEntries: 2, ttlMs: 30, now: () => now });
  const load = async () => ++probes;
  assert.equal(await store.read('a', load), 1); assert.equal(await store.read('b', load), 2);
  assert.equal(await store.read('c', load), 3); assert.equal(await store.read('b', load), 2);
  assert.equal(await store.read('a', load), 4);
  now = 31; assert.equal(await store.read('a', load), 5);
  store.invalidate(); assert.equal(await store.read('a', load), 6);
});
