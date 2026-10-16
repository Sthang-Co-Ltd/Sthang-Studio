import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobAdmissionGate, JobAdmissionError } from '../apps/server/src/services/job-admission.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

test('in-flight admission cannot race the idle check, including async project lookup', async () => {
  const gate = createJobAdmissionGate();
  const lookup = deferred();
  let active = false;
  const job = gate.run(async () => { await lookup.promise; active = true; });
  assert.throws(() => gate.beginUpdate(() => active), JobAdmissionError);
  lookup.resolve(); await job;
  assert.throws(() => gate.beginUpdate(() => active), JobAdmissionError);
  active = false;
  gate.beginUpdate(() => active)();
});

test('update owns admission until release; all concurrent tabs and job types reject', async () => {
  const gate = createJobAdmissionGate();
  const release = gate.beginUpdate(() => false);
  let started = 0;
  await Promise.all(Array.from({ length: 50 }, () => assert.rejects(gate.run(async () => { started++; }), JobAdmissionError)));
  assert.equal(started, 0);
  assert.throws(() => gate.beginUpdate(() => false), JobAdmissionError);
  release(); release();
  await gate.run(async () => { started++; });
  assert.equal(started, 1);
});

test('failed admission and failed preparation both release, without stale release unlocking later update', async () => {
  const gate = createJobAdmissionGate();
  await assert.rejects(gate.run(async () => { throw new Error('failed lookup'); }));
  const release = gate.beginUpdate(() => false);
  try { throw new Error('failed preparation'); } catch { release(); }
  const releaseNext = gate.beginUpdate(() => false);
  release();
  await assert.rejects(gate.run(async () => true), JobAdmissionError);
  releaseNext();
  assert.equal(await gate.run(async () => true), true);
});

test('media transaction excludes same-project jobs and updates but allows other projects', async () => {
  const gate = createJobAdmissionGate();
  const pending = deferred();
  const swap = gate.changeProjectMedia('a', () => false, async () => pending.promise);
  try {
    await assert.rejects(gate.runForProject('a', async () => true), JobAdmissionError);
    await assert.rejects(gate.changeProjectMedia('a', () => false, async () => true), JobAdmissionError);
    assert.throws(() => gate.beginUpdate(() => false), JobAdmissionError);
    assert.equal(await gate.runForProject('b', async () => 'unrelated'), 'unrelated');
  } finally { pending.resolve(); await swap; }
  assert.equal(await gate.runForProject('a', async () => 'released'), 'released');
});

test('project admission reserves before asynchronous lookup and releases on failure', async () => {
  const gate = createJobAdmissionGate();
  const pending = deferred();
  const job = gate.runForProject('a', async () => pending.promise);
  try {
    await assert.rejects(gate.changeProjectMedia('a', () => false, async () => true), JobAdmissionError);
  } finally { pending.resolve(); await job; }
  await assert.rejects(gate.changeProjectMedia('a', () => true, async () => true), JobAdmissionError);
  await assert.rejects(gate.changeProjectMedia('a', () => false, async () => { throw new Error('verification failed'); }), /verification failed/);
  assert.equal(await gate.changeProjectMedia('a', () => false, async () => 'retried'), 'retried');
  const release = gate.beginUpdate(() => false);
  await assert.rejects(gate.runForProject('a', async () => true), JobAdmissionError);
  await assert.rejects(gate.changeProjectMedia('a', () => false, async () => true), JobAdmissionError);
  release();
  assert.equal(await gate.changeProjectMedia('a', () => false, async () => 'after update'), 'after update');
});
