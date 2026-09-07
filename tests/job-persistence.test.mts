import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJobPersistence, atomicJobWrite } from '../apps/server/src/services/job-persistence.js';

function manualClock() {
  let now = 0;
  const tasks = new Set<{ at: number; callback(): void }>();
  return {
    schedule(callback: () => void, delay: number) {
      const task = { at: now + delay, callback }; tasks.add(task);
      return () => { tasks.delete(task); };
    },
    tick(ms: number) {
      now += ms;
      for (const task of [...tasks]) if (task.at <= now) { tasks.delete(task); task.callback(); }
    },
    size: () => tasks.size,
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('50 progress updates share a non-resetting deadline; final failure preserves the immutable export snapshot', async () => {
  const clock = manualClock();
  const jobs = [{ id: 'export', status: 'running', progress: 0, payload: { exportCaptions: [{ text: 'ខ្មែរ', startMs: 0, endMs: 1000 }] } }];
  const writes: string[] = [];
  const persistence = createJobPersistence(() => jobs, async (value) => { writes.push(value); }, (error) => assert.fail(String(error)), clock);
  await persistence.flush(); // creation is durable
  for (let i = 1; i <= 50; i += 1) { jobs[0].progress = i; persistence.progress(); clock.tick(9); }
  assert.equal(writes.length, 1);
  assert.equal(clock.size(), 1);
  clock.tick(1550); await settle();
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1])[0].progress, 50);
  jobs[0].progress = 75; persistence.progress();
  jobs[0].status = 'failed'; await persistence.flush();
  clock.tick(5000); await settle();
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(writes[2])[0], jobs[0]);
  assert.equal(JSON.parse(writes[0])[0].progress, 0, 'queued snapshots are immutable');
});

test('slow progress writes remain bounded, and a durable cancel follows them rather than racing', async () => {
  const clock = manualClock();
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let state = { status: 'running', progress: 1 };
  const writes: string[] = [];
  let active = 0, maxActive = 0;
  const persistence = createJobPersistence(() => state, async (value) => {
    active += 1; maxActive = Math.max(maxActive, active);
    if (!writes.length) await blocked;
    writes.push(value); active -= 1;
  }, (error) => assert.fail(String(error)), clock);
  persistence.progress(); clock.tick(2000); await settle();
  for (let i = 0; i < 50; i += 1) { state.progress++; persistence.progress(); clock.tick(2000); }
  assert.equal(clock.size(), 0, 'no growing progress queue behind slow disk');
  state = { status: 'cancelled', progress: 51 };
  const durable = persistence.flush();
  release(); await durable; await settle();
  assert.equal(maxActive, 1);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]).status, 'cancelled');
});

test('failed durable write rejects its caller but does not poison later flushes', async () => {
  let fail = true;
  const writes: string[] = [];
  const persistence = createJobPersistence(() => ({ progress: 1 }), async (value) => {
    if (fail) throw new Error('disk'); writes.push(value);
  }, (error) => assert.fail(String(error)), manualClock());
  await assert.rejects(persistence.flush(), /disk/);
  fail = false; await persistence.flush();
  assert.equal(writes.length, 1);
});

test('atomic replacement failure preserves the previous JSON and removes temporary files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-job-persistence-'));
  try {
    const file = path.join(root, 'jobs.json');
    await atomicJobWrite(file, '{"progress":1}');
    const mock = t.mock.method(fs, 'rename', async () => { throw new Error('rename blocked'); });
    await assert.rejects(atomicJobWrite(file, '{"progress":2}'), /rename blocked/);
    mock.mock.restore();
    assert.equal(await fs.readFile(file, 'utf8'), '{"progress":1}');
    assert.deepEqual(await fs.readdir(root), ['jobs.json']);
    await atomicJobWrite(file, '{"progress":3}');
    assert.equal(await fs.readFile(file, 'utf8'), '{"progress":3}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('a background progress failure is reported, and later updates can persist', async () => {
  const clock = manualClock(); let fail = true; let state = 0;
  const errors: unknown[] = [], writes: string[] = [];
  const persistence = createJobPersistence(() => ({ state }), async (value) => {
    if (fail) throw new Error('disk'); writes.push(value);
  }, (error) => errors.push(error), clock);
  persistence.progress(); clock.tick(2000); await settle();
  assert.equal(errors.length, 1); assert.equal(writes.length, 0);
  fail = false; state = 2; persistence.progress(); clock.tick(2000); await settle();
  assert.deepEqual(writes.map((value) => JSON.parse(value)), [{ state: 2 }]);
});
