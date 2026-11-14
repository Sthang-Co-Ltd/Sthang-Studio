import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashExportFile, isExportPublication, verifyExportPublication, type ExportPublication } from '../apps/server/src/services/export-publication.js';

const owner = { id: 'job-one', projectId: 'project-one', sourceMediaFilename: 'source.mp4', sourceMediaSize: 42 };
const bytes = Buffer.from('An exact verified synthetic export');
function publication(): ExportPublication {
  return { version: 1, jobId: owner.id, projectId: owner.projectId, sourceMediaFilename: owner.sourceMediaFilename,
    sourceMediaSize: owner.sourceMediaSize, sha256: createHash('sha256').update(bytes).digest('hex'), contentFingerprint: 'a'.repeat(64),
    result: { filename: 'exact-output.mp4', url: '/exports/exact-output.mp4', sizeBytes: bytes.length,
      width: 160, height: 90, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
      durationMs: 1000, createdAt: '2026-11-14T00:00:00.000Z' },
  };
}

test('publication ownership and safe filename are required before reading any output', async () => {
  const value = publication();
  assert.equal(isExportPublication(value, owner), true);
  for (const changed of [{ id: 'other' }, { projectId: 'other' }, { sourceMediaFilename: 'other.mp4' }, { sourceMediaSize: 43 }]) {
    assert.equal(isExportPublication(value, { ...owner, ...changed }), false);
  }
  for (const filename of ['../escape.mp4', '..\\escape.mp4', 'C:escape.mp4', 'exact-output.mp4/other.mp4']) {
    assert.equal((await verifyExportPublication('/unused', { ...value, result: { ...value.result, filename } }, owner)).status, 'uncertain');
  }
  assert.equal(isExportPublication({ ...value, sha256: 'invalid' }, owner), false);
  assert.equal(isExportPublication({ ...value, result: { ...value.result, url: '/exports/another.mp4' } }, owner), false);
});

test('only the exact same verified bytes and size recover a completed result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-publication-check-'));
  const file = path.join(root, 'exact-output.mp4');
  try {
    const value = publication();
    assert.equal((await verifyExportPublication(root, value, owner)).status, 'missing');
    await fs.writeFile(file, bytes);
    assert.deepEqual(await hashExportFile(file), { sha256: value.sha256, sizeBytes: bytes.length });
    await assert.rejects(hashExportFile(file, () => true), /cancelled/);
    assert.deepEqual(await verifyExportPublication(root, value, owner), { status: 'published', publication: value });
    assert.equal((await verifyExportPublication(root, { ...value, result: { ...value.result, sizeBytes: bytes.length + 1 } }, owner)).status, 'uncertain');
    await fs.writeFile(file, Buffer.alloc(bytes.length, 120));
    assert.equal((await verifyExportPublication(root, value, owner)).status, 'uncertain');
    await fs.rm(file); await fs.mkdir(file);
    assert.equal((await verifyExportPublication(root, value, owner)).status, 'uncertain');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unreadable output stays uncertain without exposing private errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-publication-unreadable-'));
  const file = path.join(root, 'exact-output.mp4'); await fs.writeFile(file, bytes);
  const original = fs.open;
  const fault = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file) throw Object.assign(new Error('PRIVATE local output path'), { code: 'EACCES' });
    return original(...args);
  });
  try { assert.deepEqual(await verifyExportPublication(root, publication(), owner), { status: 'uncertain' }); }
  finally { fault.mock.restore(); await fs.rm(root, { recursive: true, force: true }); }
});
