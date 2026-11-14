import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionSaveCoalescer, type CaptionSaveIdentity } from '../apps/web/src/caption-save-coalescing.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function identity(): CaptionSaveIdentity {
  return { ticket: { key: 'same-project-and-media' }, version: 1, snapshot: [], recovery: null, recordCorrections: true };
}

test('blur and export prerequisites share one pending snapshot, admission and result', async () => {
  const writes = createCaptionSaveCoalescer<object>(); const owner = identity(); const gate = deferred<object>();
  let admissions = 0;
  const start = () => { admissions++; return gate.promise; };
  const first = writes.run(owner, start);
  const readers = Array.from({ length: 12 }, () => writes.run({ ...owner }, start));
  assert.equal(admissions, 1); assert(readers.every((promise) => promise === first));
  const result = { confirmed: true }; gate.resolve(result);
  for (const value of await Promise.all([first, ...readers])) assert.equal(value, result);
});

test('a correction-recording write may cover a weaker caller without upgrading a pending autosave', async () => {
  const writes = createCaptionSaveCoalescer<string>(); const owner = identity();
  const learning = deferred<string>(); const ordinary = deferred<string>(); let admissions = 0;
  const weak = writes.run({ ...owner, recordCorrections: false }, () => { admissions++; return ordinary.promise; });
  const strong = writes.run(owner, () => { admissions++; return learning.promise; });
  assert.notEqual(strong, weak); assert.equal(admissions, 2);
  assert.equal(writes.run(owner, async () => { throw new Error('duplicate strong write'); }), strong);
  ordinary.resolve('ordinary'); learning.resolve('learning'); await Promise.all([weak, strong]);
  const second = deferred<string>();
  const strongerFirst = writes.run(owner, () => { admissions++; return second.promise; });
  assert.equal(writes.run({ ...owner, recordCorrections: false }, async () => 'unexpected'), strongerFirst);
  second.resolve('saved with corrections'); await strongerFirst; assert.equal(admissions, 3);
});

test('newer drafts, different snapshot references, media epochs and recovery owners remain separate', async () => {
  const writes = createCaptionSaveCoalescer<number>(); const owner = identity(); const gates: Array<ReturnType<typeof deferred<number>>> = [];
  const start = () => { const gate = deferred<number>(); gates.push(gate); return gate.promise; };
  const requests = [
    writes.run(owner, start),
    writes.run({ ...owner, version: 2 }, start),
    writes.run({ ...owner, snapshot: [] }, start),
    writes.run({ ...owner, ticket: { key: 'same-project-and-media' } }, start),
    writes.run({ ...owner, recovery: { key: 'restored-copy-a' } }, start),
    writes.run({ ...owner, recovery: { key: 'restored-copy-b' } }, start),
  ];
  assert.equal(gates.length, 6);
  gates.forEach((gate, index) => gate.resolve(index));
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4, 5]);
});

test('failed and uncertain writes settle every joiner and permit a new deliberate attempt', async () => {
  const writes = createCaptionSaveCoalescer<string | null>(); const owner = identity(); const gate = deferred<string | null>();
  let admissions = 0;
  const first = writes.run(owner, () => { admissions++; return gate.promise; });
  const second = writes.run(owner, async () => { admissions++; return 'unexpected'; });
  gate.resolve(null); assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(await writes.run(owner, async () => { admissions++; return 'explicit retry'; }), 'explicit retry');
  const rejected = writes.run(owner, async () => { admissions++; throw new Error('Unconfirmed transport'); });
  await assert.rejects(rejected, /Unconfirmed transport/);
  assert.equal(await writes.run(owner, async () => { admissions++; return 'fresh after rejection'; }), 'fresh after rejection');
  assert.equal(admissions, 4);
});

test('settling an older version cannot remove a newer pending write owner', async () => {
  const writes = createCaptionSaveCoalescer<string>(); const owner = identity(); const old = deferred<string>(); const fresh = deferred<string>();
  const first = writes.run(owner, () => old.promise);
  const nextOwner = { ...owner, version: 2, snapshot: [] };
  const second = writes.run(nextOwner, () => fresh.promise);
  old.resolve('old ACK'); await first;
  assert.equal(writes.run(nextOwner, async () => { throw new Error('new owner was lost'); }), second);
  fresh.resolve('new ACK'); assert.equal(await second, 'new ACK');
});

test('successful results are not cached as authorization for a later save', async () => {
  const writes = createCaptionSaveCoalescer<number>(); const owner = identity(); let admissions = 0;
  assert.equal(await writes.run(owner, async () => ++admissions), 1);
  assert.equal(await writes.run(owner, async () => ++admissions), 2);
});

test('admission is reserved before callbacks and synchronous failures release it', async () => {
  const writes = createCaptionSaveCoalescer<number>(); const owner = identity(); const gate = deferred<number>();
  let nested: Promise<number> | undefined;
  const first = writes.run(owner, () => {
    nested = writes.run(owner, async () => { throw new Error('reentrant duplicate admission'); });
    return gate.promise;
  });
  assert.equal(nested, first); gate.resolve(1); assert.equal(await first, 1);
  await assert.rejects(writes.run(owner, () => { throw new Error('admission failed'); }), /admission failed/);
  assert.equal(await writes.run(owner, async () => 2), 2);
});
