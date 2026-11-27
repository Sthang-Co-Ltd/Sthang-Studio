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

function probe(state: string, before = '', exercise = 'const response = await purge();') {
  const script = `
    import fs from 'node:fs/promises'; import path from 'node:path'; import express from 'express'; import { once } from 'node:events'; import assert from 'node:assert/strict';
    const { store } = await import('./apps/server/src/services/store.ts');
    const { config } = await import('./apps/server/src/config.ts');
    await store.list(); ${before}
    const { default: projects } = await import('./apps/server/src/routes/projects.ts');
    const { default: bin } = await import('./apps/server/src/routes/project-bin.ts');
    const { default: previews } = await import('./apps/server/src/routes/media-preview.ts');
    const app = express(); app.use(express.json()); app.use('/projects', projects); app.use('/project-bin', bin); app.use('/media-preview', previews);
    app.use((error, req, res, next) => res.status(500).json({ error: 'Synthetic persistence failure' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/projects/good';
      const binUrl = url.replace('/projects/', '/project-bin/');
      const move = () => fetch(url, { method: 'DELETE' });
      const instanceRequest = (instanceId, method, suffix = '') => fetch(binUrl + suffix, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instanceId }),
      });
      const deleteNow = (instanceId) => instanceRequest(instanceId, 'DELETE');
      const restore = (instanceId) => instanceRequest(instanceId, 'POST', '/restore');
      const purge = async () => {
        const moved = await move();
        if (moved.status !== 200) return moved;
        return deleteNow((await moved.json()).instanceId);
      };
      ${exercise}
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
    assert.equal(JSON.parse(result.body).code, 'storage_blocked');
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
  test(`${failure} failure retains a durable purging record after media/history cleanup`, async () => {
    const files = await seed(failure, false);
    const injected = failure === 'project-remove'
      ? `const original = fs.rm; fs.rm = async (...args) => { if (String(args[0]) === path.join(path.dirname(config.dataFile), 'projects', 'good.json')) throw new Error('synthetic failure'); return original(...args); };`
      : `const original = fs.rename; fs.rename = async (...args) => { if (String(args[1]) === path.join(path.dirname(config.dataFile), 'projects', 'order.json')) throw new Error('synthetic failure'); return original(...args); };`;
    const result = probe(files.state, injected);
    assert.equal(result.status, 500);
    assert.equal(JSON.parse(result.body).code, 'purge_incomplete');
    for (const file of [files.media, files.history, files.cache]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    assert.ok(JSON.parse(await fs.readFile(path.join(files.directory, 'good.json'), 'utf8')).deletion.purgeStartedAt);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(files.directory, 'order.json'), 'utf8')), failure === 'order-publish' ? ['good'] : []);
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

// Admit a real preview entry, but hold its worker before it can invoke FFmpeg.
// Deletion must abort and await this worker before touching durable source data.
const heldPreview = `
  const previewService = await import('./apps/server/src/services/media-preview.ts');
  const { jobAdmission } = await import('./apps/server/src/services/job-admission.ts');
  const sourceRecord = await store.get('good');
  const originalRun = jobAdmission.run;
  const OriginalAbortController = globalThis.AbortController;
  let previewAbort, releaseWorker, holdNext = true, drained = false;
  const workerBarrier = new Promise(resolve => { releaseWorker = resolve; });
  jobAdmission.run = function(operation) {
    if (!holdNext) return originalRun.call(this, operation);
    holdNext = false;
    return originalRun.call(this, async () => {
      try { await workerBarrier; return await operation(); }
      finally { drained = true; }
    });
  };
  globalThis.AbortController = class extends OriginalAbortController {
    constructor() { super(); previewAbort = this; }
  };
  try { assert.equal((await previewService.startMediaPreview(sourceRecord)).state, 'processing'); }
  finally { globalThis.AbortController = OriginalAbortController; }
  assert.ok(previewAbort);
  const aborted = new Promise(resolve => previewAbort.signal.addEventListener('abort', resolve, { once: true }));
  const recordFile = path.join(path.dirname(config.dataFile), 'projects', 'good.json');
  const sourceFile = path.join(config.uploadDir, sourceRecord.media.filename);
  const originalRm = fs.rm;
  const destructive = [];
  fs.rm = async (...args) => {
    if ([recordFile, sourceFile].includes(String(args[0]))) destructive.push({ target: String(args[0]), drained });
    return originalRm(...args);
  };
  const releaseFixture = async () => {
    releaseWorker();
    try { await previewService.cancelMediaPreviewPreparation('good'); }
    finally { jobAdmission.run = originalRun; fs.rm = originalRm; }
  };
`;

test('API deletion aborts and drains preview preparation before removing its record or source', async () => {
  const files = await seed('preview-drain', false);
  const result = probe(files.state, heldPreview, `
    let response;
    const deleting = purge();
    try {
      await aborted;
      assert.equal(await store.get('good'), null);
      assert.equal((await store.listBinned())[0].purging, false);
      assert.equal(await fs.readFile(sourceFile, 'utf8'), 'synthetic retained bytes');
      assert.deepEqual(destructive, []);
      let settled = false; void deleting.then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'deletion must await the aborted worker releasing its source');
      releaseWorker(); response = await deleting;
      assert.equal(response.status, 204);
      assert.deepEqual(destructive.map(item => item.target), [sourceFile, recordFile]);
      assert.ok(destructive.every(item => item.drained));
    } finally { await releaseFixture(); }
  `);
  assert.equal(result.status, 204); assert.deepEqual(result.ids, []);
  for (const file of [files.media, files.history, files.cache, path.join(files.directory, 'good.json')]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('preview cancellation failure leaves the project, source, history and cache intact', async () => {
  const files = await seed('preview-drain-failure', false);
  const result = probe(files.state, heldPreview, `
    let response;
    const originalAbort = previewAbort.abort.bind(previewAbort);
    previewAbort.abort = () => { throw new Error('Synthetic preview cancellation failure'); };
    try {
      response = await purge();
      assert.equal(response.status, 500);
      assert.equal(await store.get('good'), null);
      assert.equal((await store.listBinned())[0].purging, false);
      assert.deepEqual(destructive, []);
      assert.equal(await fs.readFile(sourceFile, 'utf8'), 'synthetic retained bytes');
    } finally { previewAbort.abort = originalAbort; await releaseFixture(); }
  `);
  assert.equal(result.status, 500); assert.deepEqual(result.ids, []);
  for (const file of [files.media, files.history, files.cache]) assert.equal(await fs.readFile(file, 'utf8'), 'synthetic retained bytes');
  const { deletion, ...retained } = JSON.parse(await fs.readFile(path.join(files.directory, 'good.json'), 'utf8'));
  assert.deepEqual(retained, project);
  assert.ok(deletion.instanceId);
  assert.equal(deletion.purgeStartedAt, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(files.directory, 'order.json'), 'utf8')), ['good']);
});

for (const condition of ['missing', 'corrupt-video']) {
  test(`deleting ${condition} media without an active preview never requires a successful probe`, async () => {
    const files = await seed(`no-preview-${condition}`, false);
    if (condition === 'missing') await fs.rm(files.media);
    else await fs.writeFile(path.join(files.directory, 'good.json'), JSON.stringify({ ...project, media: { ...project.media, mimeType: 'video/mp4' } }));
    const result = probe(files.state, `config.ffprobePath = path.join(config.workingDir, 'must-not-probe');`);
    assert.equal(result.status, 204); assert.deepEqual(result.ids, []);
    for (const file of [files.media, files.history, files.cache, path.join(files.directory, 'good.json')]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  });
}

// Use the real pointer validation and reader admission with synthetic bytes;
// this case needs no decoder or process mock to retain a metadata reader.
const cachedPreview = `
  const { createHash } = await import('node:crypto');
  const sourceRecord = await store.get('good');
  const recordFile = path.join(path.dirname(config.dataFile), 'projects', 'good.json');
  const sourceFile = path.join(config.uploadDir, sourceRecord.media.filename);
  const sourceStat = await fs.lstat(sourceFile);
  const signature = createHash('sha256').update(JSON.stringify(['preview-h264-aac-v1', sourceRecord.media.filename,
    sourceRecord.media.size, sourceStat.size, sourceStat.mtimeMs, sourceStat.ino])).digest('hex');
  const previewDirectory = path.join(config.cacheDir, 'media-previews', 'good');
  const filename = signature + '.' + 'a'.repeat(32) + '.mp4';
  const previewFile = path.join(previewDirectory, filename);
  const previewBytes = 'synthetic playback bytes';
  await fs.mkdir(previewDirectory, { recursive: true });
  await fs.writeFile(previewFile, previewBytes);
  await fs.writeFile(path.join(previewDirectory, 'ready.json'), JSON.stringify({ signature, filename, size: previewBytes.length, videoCodec: 'hevc' }));
`;

for (const boundary of [
  { name: 'cached metadata', method: 'lstat', target: 'previewFile' },
  { name: 'cached pointer', method: 'readFile', target: "path.join(previewDirectory, 'ready.json')" },
  { name: 'source identity', method: 'lstat', target: 'sourceFile' },
]) test(`${boundary.name} reader timeout leaves deletion intact and retryable`, async () => {
  const files = await seed(`${boundary.method}-${boundary.name.replaceAll(' ', '-')}-timeout`, false);
  const result = probe(files.state, cachedPreview, `
    const preservedFiles = [recordFile, sourceFile, path.join(path.dirname(recordFile), 'order.json'), previewFile,
      path.join(previewDirectory, 'ready.json'), path.join(config.historyDir, 'good.json'), path.join(config.cacheDir, 'good', 'retained.txt')];
    const originalBytes = await Promise.all(preservedFiles.map(file => fs.readFile(file)));
    const originalRead = fs.${boundary.method};
    let entered, release, holdNext = true;
    const held = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { entered = resolve; });
    fs.${boundary.method} = async (...args) => {
      if (holdNext && String(args[0]) === ${boundary.target}) { holdNext = false; entered(); await held; }
      return originalRead(...args);
    };
    let response, statusRequest;
    try {
      statusRequest = fetch(url.replace('/projects/', '/media-preview/') + '?source=' + encodeURIComponent(sourceRecord.media.filename));
      await reading;
      const moved = await move();
      assert.equal(moved.status, 200);
      const { instanceId } = await moved.json();
      originalBytes[0] = await fs.readFile(recordFile);
      const began = performance.now();
      response = await deleteNow(instanceId);
      const failure = {
        status: response.status,
        elapsedMs: performance.now() - began,
        restorable: (await store.listBinned()).some(item => item.id === 'good' && !item.purging),
        recordPresent: await fs.stat(recordFile).then(() => true, () => false),
        sourcePresent: await fs.stat(sourceFile).then(() => true, () => false),
        previewPresent: await fs.stat(previewFile).then(() => true, () => false),
        historyPresent: await fs.stat(path.join(config.historyDir, 'good.json')).then(() => true, () => false),
        cachePresent: await fs.stat(path.join(config.cacheDir, 'good', 'retained.txt')).then(() => true, () => false),
      };
      assert.equal(await store.get('good'), null);
      assert.deepEqual(await Promise.all(preservedFiles.map(file => fs.readFile(file))), originalBytes);
      release(); fs.${boundary.method} = originalRead;
      const status = await statusRequest;
      assert.equal(status.status, 200);
      assert.equal((await status.json()).state, 'ready', 'the preserved cached copy remains readable after the failed drain');
      assert.equal((await restore(instanceId)).status, 200);
      assert.deepEqual(await store.get('good'), sourceRecord);
      const retry = await purge();
      console.log('DELETION-OBSERVED:' + JSON.stringify({ ...failure, retryStatus: retry.status }));
      assert.equal(failure.restorable, true, 'a failed reader drain must retain the project for restore');
      for (const key of ['recordPresent', 'sourcePresent', 'previewPresent', 'historyPresent', 'cachePresent']) assert.equal(failure[key], true, key);
      assert.equal(failure.status, 409);
      assert.ok(failure.elapsedMs >= 2900, 'the real three-second drain deadline must expire');
      assert.equal(retry.status, 204);
    } finally {
      release(); fs.${boundary.method} = originalRead;
      if (statusRequest) await statusRequest.then(response => response.arrayBuffer()).catch(() => {});
    }
  `);
  assert.equal(result.status, 409); assert.deepEqual(result.ids, []);
  for (const file of [files.media, files.history, files.cache, path.join(files.directory, 'good.json'), path.join(files.state, 'data', 'cache', 'media-previews', 'good')]) {
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});

for (const failRemoval of [false, true]) test(`deletion keeps preview admission closed through ${failRemoval ? 'a failed record removal and retry' : 'durable removal and nested cache cleanup'}`, async () => {
  const files = await seed(failRemoval ? 'delete-admission-failure' : 'delete-admission-success', false);
  const result = probe(files.state, cachedPreview, `
    const previewService = await import('./apps/server/src/services/media-preview.ts');
    const originalRm = fs.rm;
    const originalLstat = fs.lstat;
    let enterRemoval, releaseRemoval, holdRemoval = true, previewReads = 0;
    const removing = new Promise(resolve => { enterRemoval = resolve; });
    const removalGate = new Promise(resolve => { releaseRemoval = resolve; });
    const pauseFile = ${failRemoval} ? recordFile : path.join(config.cacheDir, 'good');
    fs.rm = async (...args) => {
      if (holdRemoval && String(args[0]) === pauseFile) {
        holdRemoval = false; enterRemoval(); await removalGate;
        if (${failRemoval}) throw new Error('Synthetic record removal failure');
      }
      return originalRm(...args);
    };
    fs.lstat = async (...args) => {
      if (String(args[0]) === previewFile) previewReads++;
      return originalLstat(...args);
    };
    let response;
    const moved = await move(); assert.equal(moved.status, 200);
    const { instanceId } = await moved.json();
    const deleting = deleteNow(instanceId);
    try {
      await removing;
      assert.equal(await store.get('good'), null);
      assert.equal((await store.listBinned())[0].purging, true);
      assert.ok(JSON.parse(await fs.readFile(recordFile, 'utf8')).deletion.purgeStartedAt);
      const previewUrl = url.replace('/projects/', '/media-preview/');
      const status = await fetch(previewUrl + '?source=' + encodeURIComponent(sourceRecord.media.filename));
      assert.equal(status.status, 404); await status.arrayBuffer();
      for (const method of ['GET', 'HEAD']) {
        const file = await fetch(previewUrl + '/file/' + filename, { method, headers: { Range: 'bytes=0-8' } });
        assert.equal(file.status, 404); await file.arrayBuffer();
      }
      for (const method of ['POST', 'DELETE']) {
        const operation = await fetch(previewUrl, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceRecord.media.filename }) });
        assert.equal(operation.status, 404); await operation.arrayBuffer();
      }
      const duplicate = await fetch(url, { method: 'DELETE' }); assert.equal(duplicate.status, 409); await duplicate.arrayBuffer();
      const form = new FormData();
      form.append('mode', 'reset'); form.append('expectedMedia', JSON.stringify(sourceRecord.media));
      form.append('expectedUpdatedAt', sourceRecord.updatedAt);
      form.append('media', new Blob(['synthetic replacement bytes'], { type: 'video/mp4' }), 'replacement.mp4');
      const replacement = await fetch(url + '/replace-media', { method: 'POST', body: form });
      assert.equal(replacement.status, 409); assert.equal((await replacement.json()).code, 'MEDIA_PROJECT_BUSY');
      assert.deepEqual(await fs.readdir(config.uploadDir), [], 'rejected replacement removes its own upload');
      assert.equal(previewReads, 0, 'refused requests cannot enter cached file validation');
      // Nested preview invalidation has finished. The outer purge still fences
      // a status request that captured the project before it became hidden.
      for (const attempt of [
        () => previewService.mediaPreviewStatus(sourceRecord),
        () => previewService.startMediaPreview(sourceRecord),
        () => previewService.acquireMediaPreviewFile(sourceRecord, filename),
      ]) await assert.rejects(attempt, error => error.httpStatus === 409);
      releaseRemoval();
      response = await deleting;
      assert.equal(response.status, ${failRemoval ? 500 : 204});
      if (${failRemoval}) {
        assert.equal(await store.get('good'), null);
        const { deletion, ...retained } = JSON.parse(await fs.readFile(recordFile, 'utf8'));
        assert.deepEqual(retained, sourceRecord);
        assert.equal(deletion.instanceId, instanceId);
        assert.ok(deletion.purgeStartedAt);
        assert.equal((await restore(instanceId)).status, 409);
        fs.rm = originalRm;
        assert.equal((await deleteNow(instanceId)).status, 204, 'failed callback releases both admission gates for retry');
      }
    } finally {
      releaseRemoval(); fs.rm = originalRm; fs.lstat = originalLstat;
      await deleting.catch(() => {});
    }
  `);
  assert.equal(result.status, failRemoval ? 500 : 204); assert.deepEqual(result.ids, []);
  for (const file of [files.media, files.history, files.cache, path.join(files.directory, 'good.json'), path.join(files.state, 'data', 'cache', 'media-previews', 'good')]) {
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});
