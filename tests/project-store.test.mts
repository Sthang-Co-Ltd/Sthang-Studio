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

test('narrow reads share initialization and preserve exact missing-id semantics', async () => {
  const [exists, media, missing] = await Promise.all([
    store.has(original.id), store.getMedia(original.id), store.getMedia('missing'),
  ]);
  assert.equal(exists, true);
  assert.deepEqual(media, { id: original.id, media: original.media });
  assert.equal(missing, null);
  assert.equal(await store.has('missing'), false);
  assert.equal(await store.has(''), false);
  assert.equal(await store.has('reviewed/'), false, 'reads must not sanitize an unrelated key into an existing ID');
  assert.equal(await store.getMedia('reviewed/'), null);
});

test('narrow reads never clone a full project and return detached media only', async (t) => {
  const clone = globalThis.structuredClone;
  let clones = 0;
  const spy = t.mock.method(globalThis, 'structuredClone', <T>(value: T): T => {
    assert.ok(!(value && typeof value === 'object' && ('captions' in value || 'transcript' in value)), 'no full-project clone');
    clones += 1;
    return clone(value);
  });
  assert.equal(await store.has(original.id), true);
  assert.equal(clones, 0, 'existence checks allocate no clone');
  const media = (await store.getMedia(original.id))!;
  assert.equal(clones, 1);
  assert.deepEqual(Object.keys(media).sort(), ['id', 'media']);
  spy.mock.restore();
  media.id = 'changed externally';
  media.media.filename = 'changed externally.wav';
  assert.deepEqual(await store.getMedia(original.id), { id: original.id, media: original.media });
  assert.deepEqual(await store.get(original.id), original, 'full project contents remain intact');
});

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

test('metadata remains published-state data during a queued media save', { timeout: 5000 }, async (t) => {
  const before = (await store.get(original.id))!;
  const replacement = { ...before, media: { ...before.media, filename: 'replacement.wav', size: 42 } };
  const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
  let signalEntered!: () => void;
  let releaseWrite!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('reviewed.json')) {
      signalEntered();
      await released;
    }
    return rename(...args);
  });
  const pending = store.upsert(replacement);
  try {
    await entered;
    assert.equal(await store.has(original.id), true);
    assert.deepEqual(await store.getMedia(original.id), { id: before.id, media: before.media });
    releaseWrite();
    await pending;
    cancelScheduledProjectPrewarm(original.id);
    assert.deepEqual(await store.getMedia(original.id), { id: replacement.id, media: replacement.media });
    assert.deepEqual((await store.get(original.id))!.captions, before.captions);
  } finally {
    releaseWrite();
    await pending.catch(() => {});
    mocked.mock.restore();
    cancelScheduledProjectPrewarm(original.id);
  }
});

test('a failed media save does not leak uncommitted metadata', async (t) => {
  const before = (await store.get(original.id))!;
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('reviewed.json')) throw new Error('Synthetic media-save failure');
    return rename(...args);
  });
  await assert.rejects(store.upsert({ ...before, media: { ...before.media, filename: 'never-published.wav' } }), /Synthetic media-save failure/);
  assert.equal(await store.has(original.id), true);
  assert.deepEqual(await store.getMedia(original.id), { id: before.id, media: before.media });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(projectDir, 'reviewed.json'), 'utf8')), before);
  mocked.mock.restore();
});

test('normalized-audio cache accepts detached metadata with identical fingerprint and WAV bytes', async () => {
  const { ensureNormalizedAudio, mediaFingerprint, projectCacheDir } = await import('../apps/server/src/services/cache.js');
  const full = (await store.get(original.id))!;
  const metadata = (await store.getMedia(original.id))!;
  assert.equal(mediaFingerprint(metadata), mediaFingerprint(full));
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const dir = projectCacheDir(full.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'normalized.wav'), wav);
  await fs.writeFile(path.join(dir, 'audio-meta.json'), JSON.stringify({ mediaFingerprint: mediaFingerprint(full), durationMs: 1000, cachedAt: '2026-01-01T00:00:00Z' }));
  const expected = await ensureNormalizedAudio(full);
  const actual = await ensureNormalizedAudio(metadata);
  assert.equal(actual.cacheHit, true);
  assert.deepEqual(actual, expected);
  assert.deepEqual(await fs.readFile(actual.outputPath), wav);
});

test('deletion and queued appearance writes cannot recreate a removed project', async () => {
  await Promise.all([store.remove(original.id), store.setCaptionAppearance(original.id, DEFAULT_CAPTION_APPEARANCE)]);
  assert.equal(await store.get(original.id), null);
  assert.equal(await store.has(original.id), false);
  assert.equal(await store.getMedia(original.id), null);
  assert.equal(await store.setCaptionAppearance('missing', DEFAULT_CAPTION_APPEARANCE), null);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(path.join(projectDir, 'reviewed.json')), { code: 'ENOENT' });
});
