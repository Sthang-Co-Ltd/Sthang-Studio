import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject } from '@kcs/shared';

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-appearance-read-'));
process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
process.env.STHANG_STUDIO_ENV_FILE = path.join(stateRoot, 'absent.env');
process.env.GEMINI_API_KEY = ''; process.env.STHANG_CONTRIBUTION_ENDPOINT = ''; process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const app = express(); app.use(express.json()); app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function seed(id: string, count = 1) {
  const captions = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, text: `Private ខ្មែរ caption ${index}`,
    startMs: index * 1000, endMs: index * 1000 + 900, approved: true, timingSource: 'manual' as const }));
  const project: CaptionProject = {
    id, title: 'PRIVATE PROJECT TITLE', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', mode: 'phrase',
    media: { filename: `${id}.wav`, originalName: 'Synthetic source.wav', size: 100, mimeType: 'audio/wav', url: `/media/${id}.wav` },
    captions, captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 72 },
    transcriptionContext: { description: 'PRIVATE ACCURACY DESCRIPTION', vocabulary: ['PrivateTerm'] },
    transcript: { language: 'km', fullText: captions.map((caption) => caption.text).join(' '), segments: structuredClone(captions),
      tokens: captions.map((caption) => ({ id: `token-${caption.id}`, text: caption.text, startMs: caption.startMs, endMs: caption.endMs,
        spaceBefore: true, timingSource: 'stt' as const })) },
  };
  await store.upsert(project); cancelScheduledProjectPrewarm(id);
  return (await store.get(id))!;
}
const projection = (project: CaptionProject) => ({ id: project.id, media: project.media, captionAppearance: project.captionAppearance });
const disk = (id: string) => fs.readFile(path.join(path.dirname(config.dataFile), 'projects', `${id}.json`), 'utf8');

for (const count of [500, 5000]) test(`saved-look HTTP read returns only detached appearance authority for ${count} captions`, async (t) => {
  const source = await seed(`payload-${count}`, count); const before = await disk(source.id);
  const fullResponse = await fetch(`${baseUrl}/${source.id}`); assert.equal(fullResponse.status, 200);
  const fullText = await fullResponse.text();
  const clone = globalThis.structuredClone;
  const spy = t.mock.method(globalThis, 'structuredClone', <Value,>(value: Value): Value => {
    assert.ok(!(value && typeof value === 'object' && ('captions' in value || 'transcript' in value)), 'projection must not clone the full project');
    return clone(value);
  });
  const response = await fetch(`${baseUrl}/${source.id}/appearance`);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /no-store/);
  const text = await response.text(); const value = JSON.parse(text);
  spy.mock.restore();
  assert.deepEqual(value, projection(source));
  assert.deepEqual(Object.keys(value).sort(), ['captionAppearance', 'id', 'media']);
  for (const privateValue of [source.title, source.captions[0].text, source.transcriptionContext!.description, 'PrivateTerm', stateRoot]) {
    assert.equal(text.includes(privateValue), false);
  }
  const fullBytes = Buffer.byteLength(fullText); const appearanceBytes = Buffer.byteLength(text);
  t.diagnostic(JSON.stringify({ captions: count, fullProjectBytes: fullBytes, appearanceBytes,
    removedBytes: fullBytes - appearanceBytes, reductionPercent: Number((100 * (1 - appearanceBytes / fullBytes)).toFixed(3)) }));
  assert.ok(appearanceBytes < 4096, 'response size is bounded by media and appearance, not caption count');
  assert.ok(fullBytes > appearanceBytes * 100, 'fixture demonstrates the removed full-project transfer');
  assert.equal(await disk(source.id), before, 'inspecting appearance never writes the project');
  value.media.filename = 'external mutation.wav'; value.captionAppearance.fontSize1080 = 12;
  assert.deepEqual(await store.getAppearance(source.id), projection(source));
});

test('appearance projection uses the exact project ID and retains full GET missing semantics', async () => {
  const source = await seed('exact-id');
  for (const id of ['missing', `${source.id}%2F`]) {
    const full = await fetch(`${baseUrl}/${id}`); const narrow = await fetch(`${baseUrl}/${id}/appearance`);
    assert.equal(full.status, 404); assert.equal(narrow.status, full.status);
    assert.deepEqual(await narrow.json(), await full.json());
  }
  assert.equal(await store.getAppearance(''), null); assert.equal(await store.getAppearance(`${source.id}/`), null);
});

test('projection never reads the full-project accessor or exposes live nested references', async (t) => {
  const source = await seed('no-full-read');
  t.mock.method(store, 'get', async () => { throw new Error('Full project accessor must not run'); });
  const response = await fetch(`${baseUrl}/${source.id}/appearance`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), projection(source));
  const first = (await store.getAppearance(source.id))!;
  first.media.url = '/media/external.wav'; first.captionAppearance!.textColor = '#FFFFFF';
  assert.deepEqual(await store.getAppearance(source.id), projection(source));
});

test('projection follows published appearance and media while a failed save keeps its prior authority', async (t) => {
  const source = await seed('published-look');
  const changed = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 94 };
  await store.setCaptionAppearance(source.id, changed);
  const saved = (await store.get(source.id))!;
  assert.deepEqual(await (await fetch(`${baseUrl}/${source.id}/appearance`)).json(), projection(saved));
  const before = await disk(source.id); const rename = fs.rename;
  const spy = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith(`${source.id}.json`)) throw new Error('Synthetic appearance publication failure');
    return rename(...args);
  });
  await assert.rejects(store.setCaptionAppearance(source.id, { ...changed, fontSize1080: 110 }), /Synthetic appearance publication failure/);
  assert.deepEqual(await (await fetch(`${baseUrl}/${source.id}/appearance`)).json(), projection(saved));
  assert.equal(await disk(source.id), before); spy.mock.restore();
  const replaced = await store.upsert({ ...saved, media: { ...saved.media, filename: 'new-source.wav', size: 999, url: '/media/new-source.wav' } });
  cancelScheduledProjectPrewarm(source.id);
  assert.deepEqual(await (await fetch(`${baseUrl}/${source.id}/appearance`)).json(), projection(replaced));
  await store.moveToBin(source.id);
  assert.equal((await fetch(`${baseUrl}/${source.id}/appearance`)).status, 404);
});
