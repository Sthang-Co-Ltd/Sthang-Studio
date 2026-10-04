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
