import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportContentBasis, type CaptionProject } from '../packages/shared/src/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-export-evidence-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
const { exportFingerprint, recordExportEvidence, readExportEvidence } = await import('../apps/server/src/services/export-evidence.js');
const { config } = await import('../apps/server/src/config.js');
after(() => fs.rm(root, { recursive: true, force: true }));
const project = (id = 'fixture'): CaptionProject => ({ id, title: 'Private title', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  mode: 'phrase', transcript: null, media: { filename: 'source.mp4', originalName: 'Private source', url: '/media/source.mp4', mimeType: 'video/mp4', size: 1200 },
  captions: [{ id: 'c1', startMs: 100, endMs: 1000, text: 'ខ្មែរ captions', approved: false }] });

test('plain SRT ignores title, approval, locks and appearance but tracks actual text/timing/media', () => {
  const base = project();
  const signature = exportFingerprint(base, 'srt');
  const cosmetic = structuredClone(base); cosmetic.title = 'New'; cosmetic.updatedAt = '2026-02-01';
  cosmetic.captions[0].approved = true; cosmetic.captions[0].textLocked = true; cosmetic.captionAppearance = { textColor: '#FF0000' } as any;
  assert.equal(exportFingerprint(cosmetic, 'srt'), signature);
  for (const change of [(p: CaptionProject) => { p.captions[0].text += '!'; }, (p: CaptionProject) => { p.captions[0].startMs += 100; }, (p: CaptionProject) => { p.media.filename = 'replacement.mp4'; }]) {
    const next = structuredClone(base); change(next); assert.notEqual(exportFingerprint(next, 'srt'), signature);
  }
});
test('video appearance changes are stale while title and approvals are irrelevant', () => {
  const base = project(); const next = structuredClone(base);
  next.title = 'New'; next.captions[0].approved = true;
  assert.equal(exportFingerprint(next, 'video'), exportFingerprint(base, 'video'));
  next.captionAppearance = { textColor: '#FF0000' } as any;
  assert.notEqual(exportFingerprint(next, 'video'), exportFingerprint(base, 'video'));
});
test('data and bundle track exported review metadata and appearance', () => {
  const base = project(); const next = structuredClone(base); next.captions[0].approved = true;
  for (const format of ['data', 'bundle'] as const) assert.notEqual(exportFingerprint(base, format), exportFingerprint(next, format));
});
test('video tracks ready word-paint timing without treating word identity as a pixel change', () => {
  const base = project(); base.captions[0].text = 'Hello';
  base.captionAppearance = { highlightMode: 'word' } as any;
  base.captions[0].wordTiming = { version: 1, text: 'Hello', words: [{ id: 'old-id', startOffset: 0, endOffset: 5, startMs: 100, endMs: 900, source: 'manual' }] };
  const next = structuredClone(base); next.captions[0].wordTiming!.words[0].id = 'new-id';
  assert.equal(exportFingerprint(next, 'video'), exportFingerprint(base, 'video'));
  next.captions[0].wordTiming!.words[0].endMs = 800;
  assert.notEqual(exportFingerprint(next, 'video'), exportFingerprint(base, 'video'));
  assert.equal(exportFingerprint(next, 'srt'), exportFingerprint(base, 'srt'));
  assert.notEqual(exportFingerprint(next, 'word-srt'), exportFingerprint(base, 'word-srt'));
});
test('undoing content back to its exported state matches again', () => {
  const base = project(); const next = structuredClone(base); const signature = exportFingerprint(base, 'srt');
  next.captions[0].text = 'changed'; assert.notEqual(exportFingerprint(next, 'srt'), signature);
  next.captions[0].text = base.captions[0].text; assert.equal(exportFingerprint(next, 'srt'), signature);
  assert.equal(typeof exportContentBasis(next, 'srt'), 'string');
});
test('concurrent receipts retain latest per format without retaining caption/source text', async () => {
  const p = project('concurrent');
  assert.deepEqual(await readExportEvidence(p.id), []);
  assert.deepEqual(await Promise.all(['srt', 'vtt', 'data', 'bundle', 'video'].map((f) => recordExportEvidence(p, f as any))), [true, true, true, true, true]);
  const next = structuredClone(p); next.captions[0].text += '!';
  assert.equal(await recordExportEvidence(next, 'srt'), true);
  const entries = await readExportEvidence(p.id); assert.equal(entries.length, 5);
  assert.equal(entries.find((entry) => entry.format === 'srt')?.fingerprint, exportFingerprint(next, 'srt'));
  const disk = await fs.readFile(path.join(config.historyDir, p.id, 'export-receipts.json'), 'utf8');
  for (const secret of [p.title, p.captions[0].text, p.media.filename, p.media.originalName]) assert.equal(disk.includes(secret), false);
  assert.equal((await fs.readdir(path.join(config.historyDir, p.id))).some((name) => name.endsWith('.tmp')), false);
});
test('corrupt and oversized history is preserved, write failure remains optional', async () => {
  const p = project('corrupt'); const dir = path.join(config.historyDir, p.id); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'export-receipts.json');
  for (const bad of ['{broken', 'x'.repeat(9000), JSON.stringify([{ version: 1 }])]) {
    await fs.writeFile(file, bad); await assert.rejects(readExportEvidence(p.id), /could not be read/);
    assert.equal(await recordExportEvidence(p, 'srt'), false); assert.equal(await fs.readFile(file, 'utf8'), bad);
  }
});
test('project deletion removes receipts with existing project history cleanup', async () => {
  const p = project('deleted'); await recordExportEvidence(p, 'srt');
  const { historyStore } = await import('../apps/server/src/services/history-store.js');
  await historyStore.clear(p.id); assert.deepEqual(await readExportEvidence(p.id), []);
});
test('invalid project IDs never escape their project-owned directory', async () => {
  await assert.rejects(readExportEvidence('../escape'), /Invalid project/);
  assert.equal(await recordExportEvidence(project('../escape'), 'srt'), false);
});
