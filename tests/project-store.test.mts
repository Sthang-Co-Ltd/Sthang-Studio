import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-store-test-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const projectDir = path.join(path.dirname(config.dataFile), 'projects');
await fs.mkdir(projectDir, { recursive: true });
const original: CaptionProject = {
  id: 'reviewed', title: 'Synthetic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  media: { filename: 'synthetic.wav', originalName: 'synthetic.wav', size: 0, mimeType: 'audio/wav', url: '/media/synthetic.wav' },
  mode: 'phrase', transcript: null, captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
  captions: [{ id: 'c1', startMs: 0, endMs: 1000, text: 'កម្ពុជា', textLocked: true, timingLocked: true, approved: true }],
};
await fs.writeFile(path.join(projectDir, 'reviewed.json'), JSON.stringify(original));
await fs.writeFile(path.join(projectDir, 'order.json'), '["reviewed"]');
await fs.writeFile(path.join(projectDir, '.per-project-v1'), 'fixture');
const { store } = await import('../apps/server/src/services/store.js');
after(() => fs.rm(root, { recursive: true, force: true }));

for (const appearanceFirst of [true, false]) {
  test(`caption and appearance writes keep both edits (${appearanceFirst ? 'appearance' : 'caption'} first)`, async () => {
    const captionSnapshot = (await store.get(original.id))!;
    captionSnapshot.captions[0].text = appearanceFirst ? 'ខ្មែរ' : 'កម្ពុជា ថ្មី';
    const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: appearanceFirst ? 72 : 84 };
    const writeAppearance = () => store.setCaptionAppearance(original.id, appearance);
    const writeCaptions = () => store.upsert(captionSnapshot);
    const pending = appearanceFirst ? [writeAppearance(), writeCaptions()] : [writeCaptions(), writeAppearance()];
    await Promise.all(pending);
    const current = (await store.get(original.id))!;
    assert.equal(current.captions[0].text, captionSnapshot.captions[0].text);
    assert.deepEqual(current.captionAppearance, appearance);
    assert.equal(current.captions[0].approved, true);
    assert.equal(current.captions[0].textLocked, true);
    assert.equal(current.captions[0].timingLocked, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(projectDir, 'reviewed.json'), 'utf8')), current);
    current.captions[0].text = 'external mutation';
    current.captionAppearance!.fontSize1080 = 22;
    assert.notDeepEqual(await store.get(original.id), current);
  });
}

test('a failed disk write does not publish its appearance or poison a later save', async (t) => {
  const before = (await store.get(original.id))!;
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('reviewed.json')) throw new Error('Synthetic disk failure');
    return rename(...args);
  });
  await assert.rejects(store.setCaptionAppearance(original.id, { ...DEFAULT_CAPTION_APPEARANCE, bold: false }), /Synthetic disk failure/);
  assert.deepEqual(await store.get(original.id), before);
  mocked.mock.restore();
  const saved = await store.setCaptionAppearance(original.id, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 92 });
  assert.equal(saved?.captionAppearance?.fontSize1080, 92);
  assert.deepEqual(saved?.captions, before.captions);
});

test('home summaries match stored projects without sharing or returning full payloads', async () => {
  const full = (await store.get(original.id))!;
  const list = await store.listSummaries();
  assert.deepEqual(list, [{ id: full.id, title: full.title, createdAt: full.createdAt, updatedAt: full.updatedAt, captionCount: full.captions.length }]);
  list[0].title = 'external mutation';
  assert.equal((await store.get(original.id))!.title, full.title);
  assert.deepEqual((await store.list())[0], full, 'the original full-list API is preserved');
});

test('deletion and queued appearance writes cannot recreate a removed project', async () => {
  await Promise.all([store.remove(original.id), store.setCaptionAppearance(original.id, DEFAULT_CAPTION_APPEARANCE)]);
  assert.equal(await store.get(original.id), null);
  assert.equal(await store.setCaptionAppearance('missing', DEFAULT_CAPTION_APPEARANCE), null);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(path.join(projectDir, 'reviewed.json')), { code: 'ENOENT' });
});
