import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-storage-delete-'));
after(async () => {
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.match(path.basename(root), /^studio-storage-delete-/);
  await fs.rm(root, { recursive: true, force: true });
});
const project = { id: 'good', title: 'Synthetic retained project', createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'phrase', transcript: null,
  captions: [], media: { filename: 'synthetic.wav', originalName: 'synthetic.wav', url: '/media/synthetic.wav', mimeType: 'audio/wav', size: 0 } };

async function seed(name: string, partial: boolean) {
  const state = path.join(root, name);
  const directory = path.join(state, 'data', 'projects');
  await fs.mkdir(directory, { recursive: true });
  const legacy = JSON.stringify([project, { id: 'broken' }]);
  if (partial) await fs.writeFile(path.join(state, 'data', 'projects.json'), legacy);
  else {
    await fs.writeFile(path.join(directory, 'good.json'), JSON.stringify(project));
    await fs.writeFile(path.join(directory, 'order.json'), '["good"]');
    await fs.writeFile(path.join(directory, '.per-project-v1'), 'fixture');
  }
  const media = path.join(state, 'uploads', project.media.filename);
  const history = path.join(state, 'data', 'history', 'good.json');
  const cache = path.join(state, 'data', 'cache', 'good', 'retained.txt');
  for (const file of [media, history, cache]) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'synthetic retained bytes');
  }
  return { state, directory, media, history, cache, legacy };
}

function probe(state: string, before = '') {
  const script = `
    import fs from 'node:fs/promises'; import path from 'node:path'; import express from 'express'; import { once } from 'node:events';
    const { store } = await import('./apps/server/src/services/store.ts');
    const { config } = await import('./apps/server/src/config.ts');
    await store.list(); ${before}
    const { default: projects } = await import('./apps/server/src/routes/projects.ts');
    const app = express(); app.use('/projects', projects); app.use((error, req, res, next) => res.status(500).json({ error: 'Synthetic persistence failure' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/projects/good', { method: 'DELETE' });
      const result = { status: response.status, body: await response.text(), ids: (await store.list()).map(p => p.id) };
      console.log('RESULT:' + JSON.stringify(result));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, STHANG_STUDIO_STATE_ROOT: state, STHANG_STUDIO_ENV_FILE: path.join(state, 'absent.env'), GEMINI_API_KEY: '',
      STHANG_CONTRIBUTION_ENDPOINT: '', STHANG_ANALYTICS_ENDPOINT: '', DOTENV_CONFIG_QUIET: 'true' }, timeout: 20_000, encoding: 'utf8' });
  const line = output.split(/\r?\n/).find(line => line.startsWith('RESULT:')); assert.ok(line);
  return JSON.parse(line.slice(7));
}

test('partial migration API deletion refuses before media, history, or cache cleanup and survives restart', async () => {
  const files = await seed('partial', true);
  for (let restart = 0; restart < 2; restart++) {
    const result = probe(files.state);
    assert.equal(result.status, 409);
    assert.equal(JSON.parse(result.body).code, 'PROJECT_STORAGE_RECOVERY_REQUIRED');
    assert.match(JSON.parse(result.body).error, /restart Studio/);
    for (const secret of [files.state, project.title, project.media.filename, 'broken']) assert.equal(result.body.includes(secret), false);
    assert.deepEqual(result.ids, ['good']);
    for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
    assert.equal(await fs.readFile(path.join(files.state, 'data', 'projects.json'), 'utf8'), files.legacy);
  }
});

test('rechecking repaired migration metadata cannot unlock deletion in the original session', async () => {
  const files = await seed('sticky', true);
  const result = probe(files.state, `await fs.writeFile(path.join(path.dirname(config.dataFile), 'projects', 'good.json'), ${JSON.stringify(JSON.stringify(project))});
    await fs.writeFile(path.join(path.dirname(config.dataFile), 'projects', '.per-project-v1'), 'synthetic repaired marker'); await store.storageStatus(true);`);
  assert.equal(result.status, 409);
  for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
  assert.equal(await fs.readFile(path.join(files.state, 'data', 'projects.json'), 'utf8'), files.legacy);
  assert.equal(probe(files.state).status, 204, 'a new startup with completed migration permits normal deletion');
});

test('disk-backed projects also remain protected while legacy migration is unresolved', async () => {
  const files = await seed('partial-disk-backed', true);
  const original = JSON.stringify(project);
  await fs.writeFile(path.join(files.directory, 'good.json'), original);
  assert.equal(probe(files.state).status, 409);
  assert.equal(await fs.readFile(path.join(files.directory, 'good.json'), 'utf8'), original);
  for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
  assert.equal(await fs.readFile(path.join(files.state, 'data', 'projects.json'), 'utf8'), files.legacy);
});

test('migration uncertainty discovered on recheck stays blocked until a new safe startup', async () => {
  const files = await seed('recheck-marker-missing', false);
  const result = probe(files.state, `const marker = path.join(path.dirname(config.dataFile), 'projects', '.per-project-v1');
    await fs.unlink(marker); await store.storageStatus(true); await fs.writeFile(marker, 'restored'); await store.storageStatus(true);`);
  assert.equal(result.status, 409);
  for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
  assert.equal(probe(files.state).status, 204);
});

for (const failure of ['project-remove', 'order-publish']) {
  test(`${failure} failure stops API deletion before media/history cleanup`, async () => {
    const files = await seed(failure, false);
    const injected = failure === 'project-remove'
      ? `const original = fs.rm; fs.rm = async (...args) => { if (String(args[0]) === path.join(path.dirname(config.dataFile), 'projects', 'good.json')) throw new Error('synthetic failure'); return original(...args); };`
      : `const original = fs.rename; fs.rename = async (...args) => { if (String(args[1]) === path.join(path.dirname(config.dataFile), 'projects', 'order.json')) throw new Error('synthetic failure'); return original(...args); };`;
    assert.equal(probe(files.state, injected).status, 500);
    for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
    assert.equal(await fs.readFile(path.join(files.directory, 'order.json'), 'utf8'), '["good"]');
  });
}

test('healthy API deletion still removes its project and owned media/history/cache', async () => {
  const files = await seed('healthy', false);
  await fs.writeFile(path.join(files.directory, 'unrelated.json'), '{unreadable unrelated project');
  const result = probe(files.state);
  assert.equal(result.status, 204); assert.deepEqual(result.ids, []);
  for (const file of [files.media, files.history, files.cache, path.join(files.directory, 'good.json')]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(files.directory, 'order.json'), 'utf8')), []);
  assert.equal(await fs.readFile(path.join(files.directory, 'unrelated.json'), 'utf8'), '{unreadable unrelated project');
});
