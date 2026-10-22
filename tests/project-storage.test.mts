import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { CaptionProject } from '@kcs/shared';
import { isLoadableProject, readStorageJson, scanProjectStorage } from '../apps/server/src/services/project-storage.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-storage-notices-'));
after(async () => {
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});
const project = (id = 'good'): CaptionProject => ({ id, title: 'Synthetic Khmer ខ្មែរ', mode: 'phrase', transcript: null,
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
  media: { filename: 'synthetic.wav', originalName: 'synthetic.wav', mimeType: 'audio/wav', url: '/media/synthetic.wav', size: 0 },
  captions: [{ id: 'c1', text: 'ខ្មែរ', startMs: 100, endMs: 900 }] });
async function seed(name: string, files: Record<string, string>, marker = true) {
  const state = path.join(root, name); const directory = path.join(state, 'data', 'projects');
  await fs.mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, name), text);
  if (marker) await fs.writeFile(path.join(directory, '.per-project-v1'), 'fixture');
  return { state, directory };
}
function probe(state: string, operation = 'const result = { status: await store.storageStatus(), ids: (await store.listSummaries()).map(p => p.id) };') {
  const script = `const { store } = await import('./apps/server/src/services/store.ts'); ${operation} console.log('RESULT:' + JSON.stringify(result));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, STHANG_STUDIO_STATE_ROOT: state, STHANG_STUDIO_ENV_FILE: path.join(state, 'absent.env'),
      GEMINI_API_KEY: '', STHANG_CONTRIBUTION_ENDPOINT: '', STHANG_ANALYTICS_ENDPOINT: '', DOTENV_CONFIG_QUIET: 'true' }, timeout: 15_000, encoding: 'utf8' });
  const line = output.split(/\r?\n/).find((line) => line.startsWith('RESULT:')); assert.ok(line);
  return JSON.parse(line.slice(7));
}

test('missing, malformed and unreadable data have distinct read outcomes without altering bytes', async () => {
  const { directory } = await seed('read-outcomes', { 'bad.json': '{corrupt' });
  assert.equal((await readStorageJson(path.join(directory, 'missing.json'))).state, 'missing');
  assert.equal((await readStorageJson(path.join(directory, 'bad.json'))).state, 'unreadable');
  await fs.mkdir(path.join(directory, 'folder.json'));
  assert.equal((await readStorageJson(path.join(directory, 'folder.json'))).state, 'unreadable');
  assert.equal(await fs.readFile(path.join(directory, 'bad.json'), 'utf8'), '{corrupt');
});
test('invalid project shape is isolated while finite editorial timing remains available for repair', () => {
  assert.equal(isLoadableProject({ id: 'partial' }), false);
  const p = project(); p.captions[0].startMs = -100; p.captions[0].endMs = -200;
  assert.equal(isLoadableProject(p), true);
  assert.equal(isLoadableProject({ ...p, captions: [null] }), false);
});
test('healthy projects load beside unreadable and malformed files; warning exposes no paths or content', async () => {
  const { state, directory } = await seed('partial', { 'good.json': JSON.stringify(project()), 'bad.json': '{private', 'shape.json': '{"id":"invalid"}', 'order.json': '["good"]' });
  const result = probe(state);
  assert.deepEqual(result.ids, ['good']); assert.equal(result.status.unreadableProjectCount, 2);
  assert.equal(result.status.loadedProjectCount, 1); assert.equal(result.status.readableProjectCount, 1);
  assert.equal(JSON.stringify(result.status).includes(state), false); assert.equal(JSON.stringify(result.status).includes('private'), false);
  assert.equal(await fs.readFile(path.join(directory, 'bad.json'), 'utf8'), '{private');
});
test('duplicate identities are visible without discarding either original file', async () => {
  const { state, directory } = await seed('duplicate', { 'one.json': JSON.stringify(project()), 'two.json': JSON.stringify(project()), 'order.json': '["good"]' });
  const result = probe(state); assert.equal(result.status.duplicateProjectCount, 1); assert.equal(result.status.loadedProjectCount, 1);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.json')).length, 3);
});
test('corrupt legacy source is retained and never finalized as an empty migration', async () => {
  const { state, directory } = await seed('legacy-corrupt', { 'good.json': JSON.stringify(project()), 'order.json': '["good"]' }, false);
  const legacy = path.join(state, 'data', 'projects.json'); await fs.writeFile(legacy, '{corrupt legacy');
  const result = probe(state); assert.deepEqual(result.ids, ['good']); assert.equal(result.status.legacyUnreadable, true); assert.equal(result.status.migrationPending, true);
  await assert.rejects(fs.stat(path.join(directory, '.per-project-v1')));
  assert.equal(await fs.readFile(legacy, 'utf8'), '{corrupt legacy');
});
test('a valid older record cannot overwrite an unreadable newer per-project file', async () => {
  const { state, directory } = await seed('no-substitution', { 'good.json': '{newer unreadable', 'order.json': '["good"]' }, false);
  await fs.writeFile(path.join(state, 'data', 'projects.json'), JSON.stringify([project()]));
  const result = probe(state); assert.deepEqual(result.ids, []); assert.equal(result.status.migrationPending, true);
  assert.equal(await fs.readFile(path.join(directory, 'good.json'), 'utf8'), '{newer unreadable');
  await assert.rejects(fs.stat(path.join(directory, '.per-project-v1')));
});
test('known-good legacy migration still preserves source and backup, and publishes readable projects', async () => {
  const { state, directory } = await seed('legacy-valid', {}, false);
  const original = JSON.stringify([project()]); await fs.writeFile(path.join(state, 'data', 'projects.json'), original);
  const result = probe(state); assert.deepEqual(result.ids, ['good']); assert.equal(result.status.migrationPending, false);
  assert.equal(result.status.readableProjectCount, 1);
  assert.equal(await fs.readFile(path.join(state, 'data', 'projects.legacy-v0.7.json'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(state, 'data', 'projects.json'), 'utf8'), original);
  assert.ok((await fs.stat(path.join(directory, '.per-project-v1'))).isFile());
});
test('a partially malformed legacy array remains pending while its safe records stay usable', async () => {
  const { state, directory } = await seed('legacy-partial', {}, false);
  const contents = JSON.stringify([project(), { id: 'broken' }]);
  await fs.writeFile(path.join(state, 'data', 'projects.json'), contents);
  const result = probe(state); assert.deepEqual(result.ids, ['good']); assert.equal(result.status.legacyUnreadable, true);
  assert.equal(result.status.migrationPending, true);
  await assert.rejects(fs.stat(path.join(directory, '.per-project-v1')));
  await assert.rejects(fs.stat(path.join(directory, 'good.json')));
  assert.equal(await fs.readFile(path.join(state, 'data', 'projects.json'), 'utf8'), contents);
});
test('an unusable legacy-backup destination cannot finalize migration or replace originals', async () => {
  const { state, directory } = await seed('backup-blocked', {}, false);
  const contents = JSON.stringify([project()]); await fs.writeFile(path.join(state, 'data', 'projects.json'), contents);
  await fs.mkdir(path.join(state, 'data', 'projects.legacy-v0.7.json'));
  const result = probe(state); assert.deepEqual(result.ids, ['good']); assert.equal(result.status.migrationPending, true);
  await assert.rejects(fs.stat(path.join(directory, '.per-project-v1')));
  assert.equal(await fs.readFile(path.join(state, 'data', 'projects.json'), 'utf8'), contents);
  assert.ok((await fs.stat(path.join(state, 'data', 'projects.legacy-v0.7.json'))).isDirectory());
});
test('an unusable migration marker is retained and reported, never silently replaced', async () => {
  const { state, directory } = await seed('marker', { 'good.json': JSON.stringify(project()), 'order.json': '["good"]' }, false);
  await fs.mkdir(path.join(directory, '.per-project-v1'));
  const result = probe(state); assert.deepEqual(result.ids, ['good']); assert.equal(result.status.migrationPending, true);
  assert.ok((await fs.stat(path.join(directory, '.per-project-v1'))).isDirectory());
});
test('an unreadable order index survives initialization and subsequent explicit project writes', async () => {
  const { state, directory } = await seed('order', { 'good.json': JSON.stringify(project()), 'order.json': '{corrupt order' });
  const next = project('new');
  const result = probe(state, `await store.listSummaries(); await store.upsert(${JSON.stringify(next)}); const { cancelScheduledProjectPrewarm } = await import('./apps/server/src/services/prewarm.ts'); cancelScheduledProjectPrewarm('new'); const result = { status: await store.storageStatus(), ids: (await store.listSummaries()).map(p => p.id) };`);
  assert.equal(result.status.orderUnreadable, true); assert.equal(result.ids.length, 2);
  assert.equal(await fs.readFile(path.join(directory, 'order.json'), 'utf8'), '{corrupt order');
  assert.ok((await fs.stat(path.join(directory, 'new.json'))).isFile());
});
test('read-only recheck notices repaired/new/missing files without replacing published project state', async () => {
  const { state, directory } = await seed('recheck', { 'good.json': JSON.stringify(project()), 'bad.json': '{bad', 'order.json': '["good"]' });
  const restored = project('bad');
  const result = probe(state, `await store.listSummaries(); const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(path.join(directory, 'bad.json'))}, ${JSON.stringify(JSON.stringify(restored))}); await fs.unlink(${JSON.stringify(path.join(directory, 'good.json'))}); const result = { status: await store.storageStatus(true), ids: (await store.listSummaries()).map(p => p.id) };`);
  assert.deepEqual(result.ids, ['good']); assert.equal(result.status.readableProjectCount, 1);
  assert.equal(result.status.unreadableProjectCount, 0); assert.equal(result.status.missingProjectCount, 1); assert.equal(result.status.restartRequired, true);
  assert.equal(await fs.readFile(path.join(directory, 'bad.json'), 'utf8'), JSON.stringify(restored));
});
test('saving a healthy project retains unreadable project references and recovery ordering', async () => {
  const { state, directory } = await seed('retained-order', { 'good.json': JSON.stringify(project()), 'bad.json': '{unreadable', 'order.json': '["bad","good"]' });
  const next = project('new');
  const result = probe(state, `await store.listSummaries(); await store.upsert(${JSON.stringify(next)}); const { cancelScheduledProjectPrewarm } = await import('./apps/server/src/services/prewarm.ts'); cancelScheduledProjectPrewarm('new'); const result = { ids: (await store.listSummaries()).map(p => p.id) };`);
  assert.deepEqual(result.ids, ['new', 'good']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'order.json'), 'utf8')), ['new', 'bad', 'good']);
  assert.equal(await fs.readFile(path.join(directory, 'bad.json'), 'utf8'), '{unreadable');
});
test('an unlistable directory is reported as unavailable, not a healthy empty library', async () => {
  const file = path.join(root, 'not-a-directory'); await fs.writeFile(file, 'retained');
  const scan = await scanProjectStorage(file); assert.equal(scan.directoryUnreadable, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'retained');
});
