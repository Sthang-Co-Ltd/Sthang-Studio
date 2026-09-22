import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { CaptionProject } from '@kcs/shared';
import { decodePcmWav } from '../apps/web/src/audio/wav.js';

// Exercise real HTTP file delivery inside a dot-prefixed ancestor, as in a
// development worktree. Browser fixtures that return WAV bytes bypass this path.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-waveform-route-'));
const root = path.join(scratch, '.sthang-worktrees', 'preview & audio');
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.LOCAL_TIMING_PYTHON = path.join(root, 'missing-python.exe');
process.env.GEMINI_API_KEY = '';

const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { mediaFingerprint, projectCacheDir } = await import('../apps/server/src/services/cache.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');

const app = express();
app.use('/api/projects', projectsRouter);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function syntheticWav() {
  const sampleRate = 16_000;
  const samples = sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 8000), 44 + index * 2);
  }
  return bytes;
}

async function seedProject(id: string, cached: boolean) {
  const wav = syntheticWav();
  const project: CaptionProject = {
    id, title: 'Synthetic waveform delivery',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'phrase', transcript: null,
    media: { filename: `${id}.wav`, originalName: `${id}.wav`, mimeType: 'audio/wav', size: wav.length, url: `/media/${id}.wav` },
    captions: [{ id: 'caption-1', text: 'Synthetic caption', startMs: 100, endMs: 900, approved: true, timingLocked: true }],
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  await fs.writeFile(path.join(config.uploadDir, project.media.filename), wav);
  const cacheDir = projectCacheDir(id);
  await fs.mkdir(cacheDir, { recursive: true });
  if (cached) {
    await fs.writeFile(path.join(cacheDir, 'normalized.wav'), wav);
    await fs.writeFile(path.join(cacheDir, 'audio-meta.json'), JSON.stringify({ mediaFingerprint: mediaFingerprint(project), durationMs: 1000, cachedAt: project.createdAt }));
  }
  return { project, wav, cacheDir };
}

test('cached waveform is delivered and decoded when application state has a hidden ancestor', async () => {
  const { project, wav } = await seedProject('cached-audio', true);
  const response = await fetch(`${baseUrl}/api/projects/${project.id}/normalized-audio.wav`);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, body.toString('utf8', 0, 160));
  assert.match(response.headers.get('content-type') || '', /^audio\/wav/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('x-sthang-audio-cache'), 'hit');
  assert.deepEqual(body, wav, 'Return the cached WAV unchanged');
  const decoded = decodePcmWav(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.durationMs, 1000);
  assert.ok(decoded.samples.some(sample => Math.abs(sample) > 0.1));

  const ranged = await fetch(`${baseUrl}/api/projects/${project.id}/normalized-audio.wav`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-43/${wav.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), wav.subarray(0, 44));
});

test('fresh generation and forced waveform rebuild work without changing media or captions', async () => {
  const { project, wav } = await seedProject('generated-audio', false);
  const savedBefore = await fs.readFile(path.join(root, 'data', 'projects', `${project.id}.json`));
  for (const [query, cacheStatus] of [['', 'generated'], ['?refresh=1', 'rebuilt']] as const) {
    const response = await fetch(`${baseUrl}/api/projects/${project.id}/normalized-audio.wav${query}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, body.toString('utf8', 0, 160));
    assert.equal(response.headers.get('x-sthang-audio-cache'), cacheStatus);
    const decoded = decodePcmWav(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    assert.equal(decoded.durationMs, 1000);
    assert.equal(decoded.sampleRate, 16_000);
    assert.ok(decoded.samples.some(sample => Math.abs(sample) > 0.1));
  }
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), wav);
  assert.deepEqual(await fs.readFile(path.join(root, 'data', 'projects', `${project.id}.json`)), savedBefore);
});

test('the waveform route serves only its fixed audio file, not neighbouring metadata or hidden files', async () => {
  const { project, wav, cacheDir } = await seedProject('private-audio', true);
  const sentinel = 'synthetic private marker';
  await fs.writeFile(path.join(cacheDir, '.private'), sentinel);
  const endpoint = `${baseUrl}/api/projects/${project.id}`;
  for (const suffix of ['/audio-meta.json', '/.private', '/normalized-audio.wav/.private']) {
    const response = await fetch(`${endpoint}${suffix}`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(sentinel));
  }
  const fixed = await fetch(`${endpoint}/normalized-audio.wav?path=.private&filename=audio-meta.json`);
  assert.equal(fixed.status, 200);
  assert.deepEqual(Buffer.from(await fixed.arrayBuffer()), wav);
  const missing = await fetch(`${baseUrl}/api/projects/missing/normalized-audio.wav`);
  assert.equal(missing.status, 404);
});
