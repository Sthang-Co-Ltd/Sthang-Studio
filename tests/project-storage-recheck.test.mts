import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-storage-recheck-'));
after(async () => {
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});

// Each process owns an isolated store and synthetic files. Filesystem barriers,
// rather than clock delays, force the real save/delete through each scan window.
function probe(name: string, operation: string) {
  const state = path.join(root, name);
  const script = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    const directory = path.join(process.env.STHANG_STUDIO_STATE_ROOT, 'data', 'projects');
    const project = (id) => ({ id, title: 'Synthetic', mode: 'phrase', transcript: null,
      createdAt: '2026-01-01', updatedAt: '2026-01-01', captions: [],
      media: { filename: 'synthetic.wav', originalName: 'synthetic.wav', mimeType: 'audio/wav', url: '/media/synthetic.wav', size: 0 } });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'good.json'), JSON.stringify(project('good')));
    await fs.writeFile(path.join(directory, 'order.json'), '["good"]');
    await fs.writeFile(path.join(directory, '.per-project-v1'), 'fixture');
    const { store } = await import('./apps/server/src/services/store.ts');
    const { cancelScheduledProjectPrewarm } = await import('./apps/server/src/services/prewarm.ts');
    await store.list();
    const save = async (id) => { const value = await store.upsert(project(id)); cancelScheduledProjectPrewarm(id); return value; };
    const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
    ${operation}
    console.log('RESULT:' + JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), windowsHide: true, timeout: 15_000, encoding: 'utf8',
    env: { ...process.env, STHANG_STUDIO_STATE_ROOT: state, STHANG_STUDIO_ENV_FILE: path.join(state, 'absent.env'),
      GEMINI_API_KEY: '', STHANG_CONTRIBUTION_ENDPOINT: '', STHANG_ANALYTICS_ENDPOINT: '', DOTENV_CONFIG_QUIET: 'true' },
  });
  const line = output.split(/\r?\n/).find(line => line.startsWith('RESULT:'));
  assert.ok(line);
  return JSON.parse(line.slice(7));
}

test('recheck retries a directory snapshot taken before a real new-project save and index publication', () => {
  const result = probe('save-after-snapshot', `
    const entered = barrier(), release = barrier();
    const readdir = fs.readdir;
    let scans = 0;
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory && ++scans === 1) { entered.release(); await release.promise; }
      return names;
    };
    const pending = store.storageStatus(true);
    await entered.promise;
    const saved = await save('new');
    const file = JSON.parse(await fs.readFile(path.join(directory, 'new.json'), 'utf8'));
    const index = JSON.parse(await fs.readFile(path.join(directory, 'order.json'), 'utf8'));
    release.release();
    const status = await pending;
    fs.readdir = readdir;
    const result = { status, later: await store.storageStatus(true), scans, saved, file, index,
      ids: (await store.list()).map(p => p.id) };
  `);
  assert.deepEqual(result.saved, result.file, 'the real store published a readable file');
  assert.deepEqual(result.index, ['new', 'good'], 'the real index was published before the stale scan resumed');
  assert.deepEqual(result.ids, ['new', 'good']);
  assert.equal(result.status.missingProjectCount, 0, 'a file published after readdir is not missing');
  for (const status of [result.status, result.later]) {
    assert.equal(status.readableProjectCount, 2);
    assert.equal(status.missingProjectCount, 0);
    assert.equal(status.unreadableProjectCount, 0);
    assert.equal(status.restartRequired, false, 'a discarded scan must never latch a restart');
  }
  assert.equal(result.scans, 2);
});

test('recheck retries a snapshot overlapping a legitimate removal and its index update', () => {
  const result = probe('delete-after-snapshot', `
    const entered = barrier(), release = barrier();
    const readdir = fs.readdir;
    let scans = 0;
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory && ++scans === 1) { entered.release(); await release.promise; }
      return names;
    };
    const pending = store.storageStatus(true);
    await entered.promise;
    await store.remove('good');
    release.release();
    const status = await pending;
    fs.readdir = readdir;
    const result = { status, later: await store.storageStatus(true), scans,
      names: await readdir(directory), index: JSON.parse(await fs.readFile(path.join(directory, 'order.json'), 'utf8')),
      ids: (await store.list()).map(p => p.id) };
  `);
  assert.equal(result.names.includes('good.json'), false);
  assert.deepEqual(result.index, []);
  assert.deepEqual(result.ids, []);
  assert.equal(result.scans, 2);
  for (const status of [result.status, result.later]) {
    assert.equal(status.readableProjectCount, 0);
    assert.equal(status.missingProjectCount, 0);
    assert.equal(status.unreadableProjectCount, 0);
    assert.equal(status.restartRequired, false);
  }
});

for (const publication of ['new.json', 'order.json']) {
  test(`an in-flight ${publication} publication makes recheck unavailable without latching recovery`, () => {
    const result = probe(`active-${publication}`, `
      const entered = barrier(), release = barrier();
      const rename = fs.rename;
      fs.rename = async (...args) => {
        if (String(args[1]) === path.join(directory, '${publication}')) { entered.release(); await release.promise; }
        return rename(...args);
      };
      const pending = save('new');
      await entered.promise;
      let unavailable = false;
      try { await store.storageStatus(true); } catch { unavailable = true; }
      const during = await store.storageStatus();
      release.release();
      await pending;
      fs.rename = rename;
      const result = { unavailable, during, status: await store.storageStatus(true),
        file: JSON.parse(await fs.readFile(path.join(directory, 'new.json'), 'utf8')) };
    `);
    assert.equal(result.unavailable, true);
    assert.equal(result.during.restartRequired, false);
    assert.equal(result.status.readableProjectCount, 2);
    assert.equal(result.status.missingProjectCount, 0);
    assert.equal(result.status.restartRequired, false);
    assert.equal(result.file.id, 'new');
  });
}

test('sustained mutations exhaust three scan attempts without publishing a mixed snapshot', () => {
  const result = probe('sustained-mutations', `
    const readdir = fs.readdir;
    let scans = 0;
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory) await save('new-' + (++scans));
      return names;
    };
    let unavailable = false;
    try { await store.storageStatus(true); } catch { unavailable = true; }
    fs.readdir = readdir;
    const beforeFresh = await store.storageStatus();
    const result = { unavailable, scans, beforeFresh, status: await store.storageStatus(true),
      ids: (await store.list()).map(p => p.id) };
  `);
  assert.equal(result.unavailable, true);
  assert.equal(result.scans, 3, 'bounded retries cannot starve saves or loop indefinitely');
  assert.equal(result.beforeFresh.restartRequired, false);
  assert.equal(result.status.readableProjectCount, 4);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
  assert.equal(result.ids.length, 4);
});

test('a real indexed file loss remains missing after a concurrent save invalidates the first scan', () => {
  const result = probe('genuine-loss-with-save', `
    await fs.unlink(path.join(directory, 'good.json'));
    const readdir = fs.readdir;
    let scans = 0;
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory && ++scans === 1) await save('new');
      return names;
    };
    const status = await store.storageStatus(true);
    fs.readdir = readdir;
    const result = { status, scans, ids: (await store.list()).map(p => p.id),
      index: JSON.parse(await fs.readFile(path.join(directory, 'order.json'), 'utf8')) };
  `);
  assert.equal(result.scans, 2);
  assert.equal(result.status.missingProjectCount, 1);
  assert.equal(result.status.unreadableProjectCount, 0);
  assert.equal(result.status.readableProjectCount, 1);
  assert.equal(result.status.restartRequired, true);
  assert.deepEqual(result.ids, ['new', 'good'], 'recheck does not replace the session store');
  assert.deepEqual(result.index, ['new', 'good'], 'genuine recovery references remain published');
});

for (const publication of ['new.json', 'order.json']) {
  test(`failed ${publication} publication leaves the recheck available after the mutation ends`, () => {
    const result = probe(`failed-${publication}`, `
      const entered = barrier(), release = barrier();
      const rename = fs.rename;
      fs.rename = async (...args) => {
        if (String(args[1]) === path.join(directory, '${publication}')) {
          entered.release(); await release.promise; throw new Error('Synthetic publication failure');
        }
        return rename(...args);
      };
      const pending = save('new').then(() => false, () => true);
      await entered.promise;
      let unavailable = false;
      try { await store.storageStatus(true); } catch { unavailable = true; }
      const during = await store.storageStatus();
      release.release();
      const failed = await pending;
      cancelScheduledProjectPrewarm('new');
      fs.rename = rename;
      const status = await store.storageStatus(true);
      await save('after');
      const result = { unavailable, failed, during, status, after: await store.storageStatus(true) };
    `);
    assert.equal(result.unavailable, true);
    assert.equal(result.failed, true);
    assert.equal(result.during.restartRequired, false);
    for (const status of [result.status, result.after]) {
      assert.equal(status.missingProjectCount, 0);
      assert.equal(status.unreadableProjectCount, 0);
      assert.equal(status.restartRequired, false, 'try/finally must release failed mutations');
    }
  });
}

test('a failed mutation beginning and ending during the scan still invalidates that scan', () => {
  const result = probe('failed-during-scan', `
    const rename = fs.rename, readdir = fs.readdir;
    let scans = 0, failed = false;
    fs.rename = async (...args) => {
      if (String(args[1]) === path.join(directory, 'new.json')) throw new Error('Synthetic publication failure');
      return rename(...args);
    };
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory && ++scans === 1) {
        try { await save('new'); } catch { failed = true; }
      }
      return names;
    };
    const status = await store.storageStatus(true);
    fs.rename = rename; fs.readdir = readdir;
    const result = { failed, scans, status };
  `);
  assert.equal(result.failed, true);
  assert.equal(result.scans, 2);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

test('a removal during project reads discards the stale loaded identity', () => {
  const result = probe('delete-during-read', `
    const readFile = fs.readFile, readdir = fs.readdir;
    let scans = 0, removed = false;
    fs.readdir = async (...args) => { if (String(args[0]) === directory) scans++; return readdir(...args); };
    fs.readFile = async (...args) => {
      const contents = await readFile(...args);
      if (!removed && String(args[0]) === path.join(directory, 'good.json')) {
        removed = true; await store.remove('good');
      }
      return contents;
    };
    const status = await store.storageStatus(true);
    fs.readFile = readFile; fs.readdir = readdir;
    const result = { status, scans, ids: (await store.list()).map(p => p.id) };
  `);
  assert.deepEqual(result.ids, []);
  assert.equal(result.scans, 2);
  assert.equal(result.status.readableProjectCount, 0);
  assert.equal(result.status.unreadableProjectCount, 0);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

test('publication during index reading invalidates the whole candidate, not just project reads', () => {
  const result = probe('save-during-index', `
    const readFile = fs.readFile, readdir = fs.readdir;
    let scans = 0, saved = false;
    fs.readdir = async (...args) => { if (String(args[0]) === directory) scans++; return readdir(...args); };
    fs.readFile = async (...args) => {
      const contents = await readFile(...args);
      if (!saved && String(args[0]) === path.join(directory, 'order.json')) { saved = true; await save('new'); }
      return contents;
    };
    const status = await store.storageStatus(true);
    fs.readFile = readFile; fs.readdir = readdir;
    const result = { status, scans };
  `);
  assert.equal(result.scans, 2);
  assert.equal(result.status.readableProjectCount, 2);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

test('a discarded migration candidate cannot latch deletion blocking or restart recovery', () => {
  const result = probe('discard-migration-status', `
    const marker = path.join(directory, '.per-project-v1');
    await fs.unlink(marker);
    const readFile = fs.readFile, readdir = fs.readdir;
    let scans = 0, changed = false;
    fs.readdir = async (...args) => { if (String(args[0]) === directory) scans++; return readdir(...args); };
    fs.readFile = async (...args) => {
      if (!changed && String(args[0]) === path.join(path.dirname(directory), 'projects.json')) {
        changed = true;
        await save('new');
        await fs.writeFile(marker, 'restored fixture');
      }
      return readFile(...args);
    };
    const status = await store.storageStatus(true);
    fs.readFile = readFile; fs.readdir = readdir;
    let deletionBlocked = false;
    try { await store.remove('good'); } catch { deletionBlocked = true; }
    const result = { status, scans, deletionBlocked, later: await store.storageStatus(true) };
  `);
  assert.equal(result.scans, 2);
  assert.equal(result.status.migrationPending, false);
  assert.equal(result.status.restartRequired, false);
  assert.equal(result.deletionBlocked, false, 'discarded candidates cannot latch the migration guard');
  assert.equal(result.later.restartRequired, false);
  assert.equal(result.later.missingProjectCount, 0);
});

test('the real storage endpoint reports a concurrent mutation as sanitized unavailable and later recovers', () => {
  const result = probe('api-overlap', `
    const { default: express } = await import('express');
    const { once } = await import('node:events');
    const { default: systemRouter } = await import('./apps/server/src/routes/system.ts');
    const app = express(); app.use('/api/system', systemRouter);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port + '/api/system/project-storage?recheck=1';
    const entered = barrier(), release = barrier(), rename = fs.rename;
    fs.rename = async (...args) => {
      if (String(args[1]) === path.join(directory, 'new.json')) { entered.release(); await release.promise; }
      return rename(...args);
    };
    const pending = save('new'); await entered.promise;
    const response = await fetch(url);
    const text = await response.text();
    release.release(); await pending; fs.rename = rename;
    const fresh = await fetch(url);
    const result = { code: response.status, text, cache: response.headers.get('cache-control'),
      freshCode: fresh.status, status: await fresh.json(), leakedPath: text.includes(directory) };
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  `);
  assert.equal(result.code, 503);
  assert.match(result.cache, /no-store/);
  assert.match(result.text, /files were not changed/);
  assert.equal(result.leakedPath, false);
  assert.equal(result.freshCode, 200);
  assert.equal(result.status.readableProjectCount, 2);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

test('a mutation that starts during the scan and remains active prevents snapshot publication', () => {
  const result = probe('active-at-validation', `
    const entered = barrier(), release = barrier();
    const rename = fs.rename, readdir = fs.readdir;
    let pending, scans = 0;
    fs.rename = async (...args) => {
      if (String(args[1]) === path.join(directory, 'new.json')) { entered.release(); await release.promise; }
      return rename(...args);
    };
    fs.readdir = async (...args) => {
      const names = await readdir(...args);
      if (String(args[0]) === directory && ++scans === 1) { pending = save('new'); await entered.promise; }
      return names;
    };
    let unavailable = false;
    try { await store.storageStatus(true); } catch { unavailable = true; }
    const during = await store.storageStatus();
    release.release(); await pending;
    fs.rename = rename; fs.readdir = readdir;
    const result = { unavailable, during, scans, status: await store.storageStatus(true) };
  `);
  assert.equal(result.unavailable, true);
  assert.equal(result.scans, 1, 'do not scan while a mutation is known to be active');
  assert.equal(result.during.restartRequired, false);
  assert.equal(result.status.readableProjectCount, 2);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

for (const failure of ['remove-file', 'remove-index']) {
  test(`${failure} failure releases mutation tracking and preserves genuine recovery evidence`, () => {
    const result = probe(failure, `
      const entered = barrier(), release = barrier();
      const rename = fs.rename, rm = fs.rm;
      fs.rm = async (...args) => {
        if ('${failure}' === 'remove-file' && String(args[0]) === path.join(directory, 'good.json')) {
          entered.release(); await release.promise; throw new Error('Synthetic file removal failure');
        }
        return rm(...args);
      };
      fs.rename = async (...args) => {
        if ('${failure}' === 'remove-index' && String(args[1]) === path.join(directory, 'order.json')) {
          entered.release(); await release.promise; throw new Error('Synthetic index publication failure');
        }
        return rename(...args);
      };
      const pending = store.remove('good').then(() => false, () => true);
      await entered.promise;
      let unavailable = false;
      try { await store.storageStatus(true); } catch { unavailable = true; }
      const during = await store.storageStatus();
      release.release(); const failed = await pending;
      fs.rename = rename; fs.rm = rm;
      const result = { unavailable, failed, during, status: await store.storageStatus(true),
        names: await fs.readdir(directory), index: await fs.readFile(path.join(directory, 'order.json'), 'utf8'),
        ids: (await store.list()).map(p => p.id) };
    `);
    assert.equal(result.unavailable, true);
    assert.equal(result.failed, true);
    assert.equal(result.during.restartRequired, false);
    assert.equal(result.index, '["good"]', 'failed deletion must preserve the exact index bytes');
    const removed = failure === 'remove-index';
    assert.equal(result.names.includes('good.json'), !removed);
    assert.deepEqual(result.ids, removed ? [] : ['good']);
    assert.equal(result.status.missingProjectCount, removed ? 1 : 0);
    assert.equal(result.status.unreadableProjectCount, 0);
    assert.equal(result.status.restartRequired, removed);
  });
}

test('independent project mutations are counted until both actual publications finish', () => {
  const result = probe('two-active-writes', `
    const firstEntered = barrier(), secondEntered = barrier(), firstRelease = barrier(), secondRelease = barrier();
    const rename = fs.rename;
    fs.rename = async (...args) => {
      if (String(args[1]) === path.join(directory, 'first.json')) { firstEntered.release(); await firstRelease.promise; }
      if (String(args[1]) === path.join(directory, 'second.json')) { secondEntered.release(); await secondRelease.promise; }
      return rename(...args);
    };
    const first = save('first'), second = save('second');
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    firstRelease.release(); await first;
    let unavailable = false;
    try { await store.storageStatus(true); } catch { unavailable = true; }
    secondRelease.release(); await second;
    fs.rename = rename;
    const result = { unavailable, status: await store.storageStatus(true) };
  `);
  assert.equal(result.unavailable, true);
  assert.equal(result.status.readableProjectCount, 3);
  assert.equal(result.status.missingProjectCount, 0);
  assert.equal(result.status.restartRequired, false);
});

test('an arbitrary project-write callback does not block recheck before actual persistence', () => {
  const result = probe('callback-before-persist', `
    const entered = barrier(), release = barrier();
    const pending = store.withProjectWrite('good', async (current, persist) => {
      entered.release(); await release.promise;
      return persist({ ...current, title: 'Saved after read' });
    });
    await entered.promise;
    const status = await store.storageStatus(true);
    release.release(); await pending;
    const result = { status, later: await store.storageStatus(true), title: (await store.get('good')).title };
  `);
  assert.equal(result.status.restartRequired, false);
  assert.equal(result.later.restartRequired, false);
  assert.equal(result.title, 'Saved after read');
});
