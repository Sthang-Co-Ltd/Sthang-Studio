import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateWithRollback,
  isInside,
  recoverInterruptedActivation,
  samePath,
  writeJsonAtomic,
} from '../scripts/update-runtime.mjs';

test('runtime activation keeps rollback material until the new version is healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), previous);
    await activateWithRollback({
      installRoot: root,
      target: { version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) },
      launch: async () => 123,
      healthCheck: async () => true,
      stop: async () => {},
    });
    const rollback = JSON.parse(await fs.readFile(path.join(updates, 'rollback.json'), 'utf8'));
    assert.deepEqual(rollback.previous, previous);
    assert.equal(rollback.active.version, '0.8.0');
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime health failure stops the failed process and restores the prior pointer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  let stopped = false;
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), previous);
    await assert.rejects(() => activateWithRollback({
      installRoot: root,
      target: { version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) },
      launch: async () => 456,
      healthCheck: async () => false,
      stop: async () => { stopped = true; },
    }), /healthy/i);
    assert.equal(stopped, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(updates, 'active.json'), 'utf8')), previous);
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rolls back an interrupted activation and records a safe notice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    const target = { schemaVersion: 1, version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), target);
    await writeJsonAtomic(path.join(updates, 'transaction.json'), { schemaVersion: 1, status: 'activating', previous, target });
    assert.equal(await recoverInterruptedActivation(root), true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(updates, 'active.json'), 'utf8')), previous);
    const failure = JSON.parse(await fs.readFile(path.join(updates, 'last-failure.json'), 'utf8'));
    assert.match(failure.message, /rolled back/i);
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime recovery is non-destructive when no transaction exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    assert.equal(await recoverInterruptedActivation(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic JSON replacement never exposes partial JSON to readers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  const file = path.join(root, 'updates', 'active.json');
  try {
    await writeJsonAtomic(file, { schemaVersion: 1, version: '0.7.14', payload: 'a'.repeat(1000) });
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonAtomic(file, {
      schemaVersion: 1,
      version: `0.8.${index}`,
      payload: String(index).repeat(1000),
    })));
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(parsed.schemaVersion, 1);
    assert.match(parsed.version, /^0\.8\.\d+$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('path checks reject siblings and treat Windows path casing as equivalent', () => {
  const parent = path.resolve('/tmp/studio/versions');
  assert.equal(isInside(parent, path.join(parent, '0.8.0')), true);
  assert.equal(isInside(parent, path.resolve('/tmp/studio/versions-evil/0.8.0')), false);
  assert.equal(samePath('C:\\Users\\Creator\\App', 'c:\\users\\creator\\app\\', 'win32'), true);
});
