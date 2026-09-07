import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PreviewFontCache } from '../apps/server/src/services/preview-font-cache.js';

// Synthetic bytes test cache ownership, not native font validity/shaping.
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-font-staging-'));
  const font = path.join(root, 'synthetic.ttf'); await fs.writeFile(font, 'font-A');
  return { root, font, staging: path.join(root, 'working'), faces: [{ source: font, name: 'regular.ttf' }] };
}

test('concurrent previews share immutable font staging and same-size source changes invalidate it', async () => {
  const f = await fixture(); const cache = new PreviewFontCache();
  try {
    const [a, b] = await Promise.all([cache.acquire(f.staging, f.faces), cache.acquire(f.staging, f.faces)]);
    assert.ok(a && b); assert.equal(a.directory, b.directory);
    const stat = await fs.stat(f.font);
    await fs.writeFile(f.font, 'font-B'); await fs.utimes(f.font, stat.atime, stat.mtime);
    const c = await cache.acquire(f.staging, f.faces); assert.ok(c);
    assert.notEqual(c.directory, a.directory);
    assert.equal(await fs.readFile(path.join(a.directory, 'regular.ttf'), 'utf8'), 'font-A');
    assert.equal(await fs.readFile(path.join(c.directory, 'regular.ttf'), 'utf8'), 'font-B');
    a.release(); a.release(); b.release(); c.release();
    assert.deepEqual(await fs.readdir(c.directory), ['regular.ttf']);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('active leases cannot be evicted; unused entries are bounded by both count and bytes', async () => {
  const f = await fixture(); const cache = new PreviewFontCache(1, 10);
  try {
    const a = await cache.acquire(f.staging, f.faces); assert.ok(a);
    await fs.writeFile(f.font, 'font-B');
    assert.equal(await cache.acquire(f.staging, f.faces), null);
    a.release();
    const b = await cache.acquire(f.staging, f.faces); assert.ok(b);
    await assert.rejects(fs.stat(a.directory), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.staging)).length, 1);
    b.release();
    await fs.writeFile(f.font, 'more-than-ten-bytes');
    assert.equal(await cache.acquire(f.staging, f.faces), null);
    assert.equal((await fs.readdir(f.staging)).length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('removed scratch paths and failed setup recover on a later request', async (t) => {
  const f = await fixture(); const cache = new PreviewFontCache();
  try {
    const a = await cache.acquire(f.staging, f.faces); assert.ok(a); a.release();
    await fs.rm(a.directory, { recursive: true });
    const mock = t.mock.method(fs, 'writeFile', async () => { throw new Error('disk'); });
    await assert.rejects(cache.acquire(f.staging, f.faces), /disk/); mock.mock.restore();
    assert.deepEqual(await fs.readdir(f.staging), []);
    const b = await cache.acquire(f.staging, f.faces); assert.ok(b); b.release();
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test('byte limit is enforced independently of the entry count limit', async () => {
  const f = await fixture(); const cache = new PreviewFontCache(4, 10);
  try {
    const a = await cache.acquire(f.staging, f.faces); assert.ok(a);
    await fs.writeFile(f.font, 'font-B');
    assert.equal(await cache.acquire(f.staging, f.faces), null, 'two active six-byte sets exceed ten bytes');
    a.release();
    const b = await cache.acquire(f.staging, f.faces); assert.ok(b);
    assert.notEqual(a.directory, b.directory);
    await assert.rejects(fs.stat(a.directory), { code: 'ENOENT' });
    assert.equal((await fs.readdir(f.staging)).length, 1);
    b.release();
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
