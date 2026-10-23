import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-storage-api-'));
process.env.STHANG_STUDIO_STATE_ROOT = root; process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = ''; process.env.STHANG_CONTRIBUTION_ENDPOINT = ''; process.env.STHANG_ANALYTICS_ENDPOINT = '';
process.env.DOTENV_CONFIG_QUIET = 'true';
const dir = path.join(root, 'data', 'projects'); await fs.mkdir(dir, { recursive: true });
const saved = { id: 'good', title: 'PRIVATE TITLE', createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'phrase', transcript: null,
  captions: [{ id: 'c1', text: 'PRIVATE WORDING', startMs: 100, endMs: 900 }],
  media: { filename: 'private-source.wav', originalName: 'private-source.wav', url: '/media/private-source.wav', mimeType: 'audio/wav', size: 0 } };
await fs.writeFile(path.join(dir, 'good.json'), JSON.stringify(saved));
await fs.writeFile(path.join(dir, 'bad.json'), '{private corrupt bytes');
await fs.writeFile(path.join(dir, 'order.json'), '["good"]'); await fs.writeFile(path.join(dir, '.per-project-v1'), 'fixture');
const { default: systemRouter } = await import('../apps/server/src/routes/system.js');
const { store } = await import('../apps/server/src/services/store.js');
const app = express(); app.use('/api/system', systemRouter);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system/project-storage`;
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const relative = path.relative(os.tmpdir(), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});
test('storage metadata is uncached, sanitized and leaves saved files unchanged', async () => {
  const names = ['good.json', 'bad.json', 'order.json', '.per-project-v1'];
  const before = await Promise.all(names.map((name) => fs.readFile(path.join(dir, name), 'utf8')));
  const response = await fetch(url, { redirect: 'error' }); assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const text = await response.text(); const status = JSON.parse(text);
  assert.equal(status.loadedProjectCount, 1); assert.equal(status.unreadableProjectCount, 1);
  for (const value of [root, saved.title, saved.media.filename, saved.captions[0].text, 'private corrupt bytes']) assert.equal(text.includes(value), false);
  assert.deepEqual(await Promise.all(names.map((name) => fs.readFile(path.join(dir, name), 'utf8'))), before);
});
test('explicit recheck inspects repair without adopting the restored project into the running store', async () => {
  const restored = { ...saved, id: 'restored' }; await fs.writeFile(path.join(dir, 'bad.json'), JSON.stringify(restored));
  const response = await fetch(`${url}?recheck=1`); assert.equal(response.status, 200);
  const status = await response.json(); assert.equal(status.readableProjectCount, 2); assert.equal(status.unreadableProjectCount, 0);
  assert.equal(status.loadedProjectCount, 1); assert.equal(status.restartRequired, true);
  assert.equal(await store.get('restored'), null); assert.equal(await fs.readFile(path.join(dir, 'bad.json'), 'utf8'), JSON.stringify(restored));
});
test('an unavailable check is an explicit 503 and never exposes raw exception details', async () => {
  const original = store.storageStatus;
  try {
    store.storageStatus = async () => { throw new Error('PRIVATE_TEST_SENTINEL /sensitive/local/path'); };
    const response = await fetch(url); assert.equal(response.status, 503);
    const text = await response.text(); assert.equal(text.includes('PRIVATE_TEST_SENTINEL'), false); assert.equal(text.includes('/sensitive/'), false);
    assert.match(text, /files were not changed/);
  } finally { store.storageStatus = original; }
});
