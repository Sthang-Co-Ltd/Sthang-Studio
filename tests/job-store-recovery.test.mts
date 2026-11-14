import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const service = (name: string) => new URL('../apps/server/src/' + name, import.meta.url).href;
function historyJob(id: string, status = 'completed') {
  return { id, projectId: 'synthetic', projectTitle: 'Synthetic saved work', type: 'transcribe', status,
    stage: status, progress: status === 'completed' ? 100 : 48, message: 'Synthetic saved job',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    canResume: status === 'interrupted', payload: { sourceMediaFilename: 'synthetic.mp4', sourceMediaSize: 42,
      geminiModels: { model: 'synthetic-no-request', fallbackModel: '' } },
  };
}
function videoHistoryJob(id: string, status = 'interrupted', projectId = 'synthetic') {
  const job = historyJob(id, status);
  return { ...job, projectId, type: 'export-video', canResume: status === 'interrupted' || status === 'failed',
    payload: { ...job.payload,
      exportMediaFilename: 'synthetic.mp4', exportMediaSize: 42,
      exportSettings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' },
      exportAppearance: {}, exportCaptions: [],
    },
  };
}
const publishedBytes = 'Synthetic verified output owned by one exact saved job';
function publicationJob(id = 'published') {
  const job = videoHistoryJob(id, 'running');
  const result = { filename: `${id}-verified.mp4`, url: `/exports/${id}-verified.mp4`, sizeBytes: Buffer.byteLength(publishedBytes),
    width: 160, height: 90, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
    durationMs: 1000, createdAt: '2026-01-01T00:00:05.000Z' };
  return { ...job, payload: { ...job.payload, exportPublication: { version: 1, jobId: id, projectId: job.projectId,
    sourceMediaFilename: 'synthetic.mp4', sourceMediaSize: 42, result,
    sha256: createHash('sha256').update(publishedBytes).digest('hex'), contentFingerprint: 'a'.repeat(64) } } };
}
async function probe(history: string | undefined, body: string, beforeImport = '') {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'studio-job-recovery-')));
  const owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner);
  const code = `
    import fs from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { once } from 'node:events';
    import { mock } from 'node:test';
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== '127.0.0.1') throw new Error('External requests are forbidden in this owned fixture');
      return nativeFetch(input, options);
    };
    const { config } = await import(${JSON.stringify(service('config.ts'))});
    const { store } = await import(${JSON.stringify(service('services/store.ts'))});
    const { cancelScheduledProjectPrewarm } = await import(${JSON.stringify(service('services/prewarm.ts'))});
    await fs.mkdir(path.dirname(config.jobsFile), { recursive: true });
    ${history === undefined ? '' : 'await fs.writeFile(config.jobsFile, ' + JSON.stringify(history) + ');'}
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const seed = async (id = 'synthetic') => {
      const project = { id, title: 'Synthetic project', createdAt: '2026-01-01', updatedAt: '2026-01-01',
        mode: 'phrase', transcript: null, captions: [], media: { filename: 'synthetic.mp4', originalName: 'synthetic.mp4',
        size: 42, mimeType: 'video/mp4', url: '/media/synthetic.mp4' } };
      await store.upsert(project); cancelScheduledProjectPrewarm(id); return project;
    };
    ${beforeImport}
    const { jobStore, JobHistoryUnavailableError, JobPersistenceError, reportJobProgress } = await import(${JSON.stringify(service('services/job-store.ts'))});
    const idle = async () => {
      const deadline = Date.now() + 8000;
      while (jobStore.hasAnyActive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      assert.equal(jobStore.hasAnyActive(), false, 'owned synthetic workers must drain');
    };
    let result;
    ${body}
    console.log('RESULT ' + JSON.stringify(result ?? true));
  `;
  try {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: repo, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, STHANG_STUDIO_STATE_ROOT: root, STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'),
        LOCALAPPDATA: root, XDG_CONFIG_HOME: root, GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
        STHANG_ANALYTICS_ENDPOINT: '', STHANG_CONTRIBUTION_ENDPOINT: '' },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
    const output = run.stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('RESULT '));
    assert.ok(output, run.stdout);
    return JSON.parse(output.slice(7));
  } finally {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

test('only a missing history is a fresh install and legacy optional fields stay readable', async () => {
  assert.equal(await probe(undefined, `
    assert.deepEqual(await jobStore.list(), []);
    assert.equal(jobStore.historyIsAvailable(), true);
    await assert.rejects(fs.stat(config.jobsFile), { code: 'ENOENT' });
    const snapshots = []; const stop = jobStore.subscribe(value => snapshots.push(value)); stop();
    assert.deepEqual(snapshots, [[]]);
  `), true);
  const legacy = historyJob('legacy');
  assert.equal(await probe(JSON.stringify([legacy]), `
    const rows = await jobStore.list();
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'legacy'); assert.equal('payload' in rows[0], false);
    assert.deepEqual(JSON.parse(await fs.readFile(config.jobsFile, 'utf8')), ${JSON.stringify([legacy])});
  `), true);
});

test('unreadable or malformed history is preserved, blocks mutation, and a repaired retry recovers interrupted work once', async () => {
  const valid = [historyJob('finished'), historyJob('restart', 'running')];
  for (const corrupt of ['{truncated', '{}', '[null]']) await probe(corrupt, `
    assert.equal(jobStore.historyIsAvailable(), false);
    await assert.rejects(jobStore.list(), JobHistoryUnavailableError);
    await assert.rejects(jobStore.create('export-video', 'synthetic', {}), JobHistoryUnavailableError);
    await assert.rejects(jobStore.resume('restart'), JobHistoryUnavailableError);
    await assert.rejects(jobStore.removeProject('synthetic'), JobHistoryUnavailableError);
    assert.throws(() => jobStore.subscribe(() => {}), JobHistoryUnavailableError);
    assert.equal(await fs.readFile(config.jobsFile, 'utf8'), ${JSON.stringify(corrupt)});
    await fs.writeFile(config.jobsFile, JSON.stringify(${JSON.stringify(valid)}));
    const rows = await jobStore.list();
    assert.deepEqual(rows.map(job => [job.id, job.status]), [['finished', 'completed'], ['restart', 'interrupted']]);
    assert.equal(rows[1].canResume, true); assert.equal(jobStore.hasAnyActive(), false);
    const recoveredBytes = await fs.readFile(config.jobsFile, 'utf8');
    const again = await jobStore.list(); assert.deepEqual(again, rows);
    assert.equal(await fs.readFile(config.jobsFile, 'utf8'), recoveredBytes);
    assert.deepEqual(JSON.parse(recoveredBytes)[1].payload, ${JSON.stringify(valid[1].payload)});
  `);
});

test('permission failures and SSE return truthful unavailable responses until GET retry succeeds', async () => {
  const valid = JSON.stringify([historyJob('retained')]);
  await probe(valid, `
    const { default: express } = await import('express');
    const { default: jobsRouter } = await import(${JSON.stringify(service('routes/jobs.ts'))});
    const app = express(); app.use(express.json()); app.use('/api/jobs', jobsRouter);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port + '/api/jobs';
    try {
      for (const endpoint of ['', '/events', '/retained']) {
        const response = await fetch(base + endpoint);
        assert.equal(response.status, 503);
        assert.ok(response.headers.get('content-type').includes('application/json'));
        const value = await response.json();
        assert.equal(value.code, 'JOB_HISTORY_UNAVAILABLE');
        assert.equal(value.error.includes(config.jobsFile), false);
      }
      assert.equal(await originalRead(config.jobsFile, 'utf8'), ${JSON.stringify(valid)});
      fault.mock.restore();
      const retry = await fetch(base); assert.equal(retry.status, 200);
      assert.equal((await retry.json())[0].id, 'retained');
      const controller = new AbortController();
      const streamed = await fetch(base + '/events', { signal: controller.signal });
      assert.equal(streamed.status, 200);
      const chunk = await streamed.body.getReader().read();
      const text = new TextDecoder().decode(chunk.value);
      assert.ok(text.includes('event: jobs') && text.includes('retained'));
      controller.abort();
    } finally { fault.mock.restore(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
  `, `
    const originalRead = fs.readFile;
    const fault = mock.method(fs, 'readFile', async (...args) => {
      if (String(args[0]) === config.jobsFile) throw Object.assign(new Error('Synthetic private path ' + config.jobsFile), { code: 'EACCES' });
      return originalRead(...args);
    });
  `);
});

test('failed create is never published or executed; retry and lost acknowledgement reuse one durable job', async () => {
  await probe('[]', `
    await seed();
    const writeEntered = deferred(); const releaseWrite = deferred();
    const originalRename = fs.rename;
    const fault = mock.method(fs, 'rename', async (...args) => {
      if (String(args[1]) === config.jobsFile) { writeEntered.resolve(); await releaseWrite.promise; throw new Error('Synthetic write failure'); }
      return originalRename(...args);
    });
    const observed = []; const stop = jobStore.subscribe(rows => observed.push(rows.map(job => job.id)));
    const request = jobStore.createWithDisposition('export-video', 'synthetic', {});
    const rejected = assert.rejects(request, JobPersistenceError);
    await writeEntered.promise;
    assert.deepEqual(await jobStore.list(), []);
    assert.equal(jobStore.hasActiveForProject('synthetic'), false);
    releaseWrite.resolve(); await rejected; fault.mock.restore();
    assert.deepEqual(await jobStore.list(), []);
    assert.equal(await fs.readFile(config.jobsFile, 'utf8'), '[]');
    assert.ok(observed.every(rows => rows.length === 0));
    const workerEntered = deferred(); const releaseWorker = deferred(); let starts = 0;
    const held = mock.method(store, 'getMedia', async () => { starts++; workerEntered.resolve(); await releaseWorker.promise; return null; });
    try {
      const accepted = await jobStore.createWithDisposition('export-video', 'synthetic', {});
      await workerEntered.promise;
      const repeated = await jobStore.createWithDisposition('export-video', 'synthetic', {});
      assert.equal(accepted.created, true); assert.equal(repeated.created, false);
      assert.equal(repeated.job.id, accepted.job.id); assert.equal(starts, 1);
      assert.equal(JSON.parse(await fs.readFile(config.jobsFile, 'utf8')).length, 1);
      await jobStore.cancel(accepted.job.id);
    } finally { releaseWorker.resolve(); held.mock.restore(); stop(); }
    await idle();
  `);
});

test('failed resume retains its exact saved state and checkpoints until an explicit durable retry', async () => {
  const previous = historyJob('resume', 'interrupted');
  await probe(JSON.stringify([previous]), `
    await seed();
    const { writeRunCheckpoint, readRunCheckpoint } = await import(${JSON.stringify(service('services/run-checkpoints.ts'))});
    await writeRunCheckpoint('synthetic', 'resume', 'synthetic-stage', 'owned-signature', { evidence: 'Saved stage evidence' });
    const before = await fs.readFile(config.jobsFile, 'utf8');
    const originalRename = fs.rename;
    const fault = mock.method(fs, 'rename', async (...args) => {
      if (String(args[1]) === config.jobsFile) throw new Error('Synthetic resume write failure');
      return originalRename(...args);
    });
    await assert.rejects(jobStore.resume('resume'), JobPersistenceError);
    assert.equal((await jobStore.get('resume')).status, 'interrupted');
    assert.equal((await jobStore.get('resume')).canResume, true);
    assert.equal(await fs.readFile(config.jobsFile, 'utf8'), before);
    assert.deepEqual(await readRunCheckpoint('synthetic', 'resume', 'synthetic-stage', 'owned-signature'), { evidence: 'Saved stage evidence' });
    fault.mock.restore();
    const workerEntered = deferred(); const releaseWorker = deferred(); let starts = 0;
    const originalGetMedia = store.getMedia; let mediaReads = 0;
    const held = mock.method(store, 'getMedia', async (...args) => {
      if (++mediaReads === 1) return originalGetMedia(...args); // Resume's media preflight.
      starts++; workerEntered.resolve(); await releaseWorker.promise; return null;
    });
    try {
      const accepted = await jobStore.resume('resume'); await workerEntered.promise;
      assert.equal(accepted.id, 'resume'); assert.equal(starts, 1);
      await assert.rejects(jobStore.resume('resume'), /Only failed or interrupted/);
      assert.equal(starts, 1); assert.equal(JSON.parse(await fs.readFile(config.jobsFile, 'utf8')).length, 1);
      await jobStore.cancel('resume');
    } finally { releaseWorker.resolve(); held.mock.restore(); }
    await idle();
  `);
});

test('a start-state write failure exposes Activity Resume for the same durable ID without starting work', async () => {
  await probe('[]', `
    await seed();
    const { DEFAULT_CAPTION_APPEARANCE } = await import('@kcs/shared');
    const originalRename = fs.rename; let writes = 0;
    let prematureReads = 0; const beforeGetMedia = store.getMedia;
    const beforeStart = mock.method(store, 'getMedia', async (...args) => { prematureReads++; return beforeGetMedia(...args); });
    const interrupted = deferred();
    const stop = jobStore.subscribe(rows => { if (rows.some(job => job.status === 'interrupted')) interrupted.resolve(); });
    const fault = mock.method(fs, 'rename', async (...args) => {
      if (String(args[1]) === config.jobsFile && ++writes >= 2) throw new Error('Synthetic start-state failure');
      return originalRename(...args);
    });
    const accepted = await jobStore.createWithDisposition('export-video', 'synthetic', {
      exportSettings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' },
      exportAppearance: DEFAULT_CAPTION_APPEARANCE, exportCaptions: [], exportMediaFilename: 'synthetic.mp4', exportMediaSize: 42,
    });
    await interrupted.promise; await idle();
    assert.equal((await jobStore.get(accepted.job.id)).status, 'interrupted');
    assert.equal((await jobStore.get(accepted.job.id)).canResume, true);
    assert.equal(JSON.parse(await fs.readFile(config.jobsFile, 'utf8'))[0].status, 'queued');
    assert.equal(writes, 3, 'one failed start write and one optional recovery-note write only');
    assert.equal(prematureReads, 0, 'no processing boundary is entered before a durable running state');
    beforeStart.mock.restore();
    fault.mock.restore();
    const workerEntered = deferred(); const releaseWorker = deferred(); let starts = 0;
    const originalGetMedia = store.getMedia; let mediaReads = 0;
    const held = mock.method(store, 'getMedia', async (...args) => {
      if (++mediaReads === 1) return originalGetMedia(...args);
      starts++; workerEntered.resolve(); await releaseWorker.promise; return null;
    });
    try {
      const repeated = await jobStore.resume(accepted.job.id);
      await workerEntered.promise;
      assert.equal(repeated.id, accepted.job.id); assert.equal(starts, 1);
      await jobStore.cancel(accepted.job.id);
    } finally { releaseWorker.resolve(); held.mock.restore(); stop(); }
    await idle();
  `);
});

test('progress waits out a failed admission and delayed progress cannot overwrite a newer cancellation request', async () => {
  await probe(JSON.stringify([historyJob('active', 'interrupted')]), `
    await seed();
    const workerEntered = deferred(); const releaseWorker = deferred();
    const originalGetMedia = store.getMedia; let mediaReads = 0;
    const held = mock.method(store, 'getMedia', async (...args) => {
      if (++mediaReads === 1) return originalGetMedia(...args);
      workerEntered.resolve(); await releaseWorker.promise; return null;
    });
    const observed = []; const statuses = [];
    const stop = jobStore.subscribe(rows => { observed.push(rows.map(job => job.id)); statuses.push(rows); });
    const admissionEntered = deferred(); const releaseAdmission = deferred();
    const sampled = deferred(); const cancelEntered = deferred(); const releaseCancel = deferred();
    let gateCancel = false;
    const originalRename = fs.rename;
    let fault;
    try {
      await jobStore.resume('active'); await workerEntered.promise;
      await reportJobProgress('active', 'starting', 22, 'Earlier measured progress');
      fault = mock.method(fs, 'rename', async (...args) => {
        if (String(args[1]) === config.jobsFile) {
          const snapshot = JSON.parse(await fs.readFile(args[0], 'utf8'));
          if (snapshot.some(job => job.id !== 'active')) {
            admissionEntered.resolve(); await releaseAdmission.promise;
            throw new Error('Synthetic admission failed after concurrent progress arrived');
          }
          const current = snapshot[0];
          if (gateCancel && current.status === 'running' && current.cancelRequested) {
            cancelEntered.resolve(); await releaseCancel.promise;
            gateCancel = false;
            throw new Error('Synthetic cancellation snapshot failure');
          }
          const returned = await originalRename(...args);
          if (current.progress === 65 && !current.cancelRequested) sampled.resolve();
          return returned;
        }
        return originalRename(...args);
      });
      const admission = jobStore.createWithDisposition('export-video', 'synthetic', {});
      const rejected = assert.rejects(admission, JobPersistenceError);
      await admissionEntered.promise;
      let progressSettled = false;
      const progress = reportJobProgress('active', 'starting', 65, 'New measured progress').then(() => { progressSettled = true; });
      await new Promise(done => setImmediate(done));
      assert.equal(progressSettled, false);
      assert.equal((await jobStore.get('active')).progress, 22);
      releaseAdmission.resolve(); await rejected; await progress;
      let sampleTimeout;
      try {
        // Keep the child alive for the production timer, which is deliberately
        // unref'd, and fail with a specific progress deadline if it never writes.
        await Promise.race([sampled.promise, new Promise((_done, reject) => {
          sampleTimeout = setTimeout(() => reject(new Error('The sampled progress snapshot did not commit')), 5000);
        })]);
      } finally { clearTimeout(sampleTimeout); }
      const disk = JSON.parse(await fs.readFile(config.jobsFile, 'utf8'));
      assert.deepEqual(disk.map(job => job.id), ['active']);
      assert.equal(disk[0].progress, 65);
      assert.ok(observed.every(ids => ids.length === 1 && ids[0] === 'active'));
      gateCancel = true;
      const cancellation = jobStore.cancel('active');
      const rejectedCancellation = assert.rejects(cancellation, JobPersistenceError);
      await cancelEntered.promise;
      assert.match(statuses[statuses.length - 1][0].message, /Cancellation requested/,
        'the SSE observer must see the public stop request before its held disk write settles');
      const late = assert.rejects(reportJobProgress('active', 'obsolete-stage', 99, 'Obsolete external progress'), /cancelled/);
      releaseCancel.resolve(); await rejectedCancellation; await late;
      const stopped = await jobStore.get('active');
      assert.equal(stopped.stage, 'starting'); assert.equal(stopped.progress, 65);
      assert.match(stopped.message, /Cancellation requested/);
      assert.match(statuses[statuses.length - 1][0].message, /Cancellation requested/);
    } finally {
      releaseAdmission.resolve(); releaseCancel.resolve(); releaseWorker.resolve();
      fault?.mock.restore(); held.mock.restore(); stop();
    }
    await idle();
    assert.equal((await jobStore.get('active')).status, 'cancelled');
    await assert.rejects(reportJobProgress('active', 'late', 100, 'Must remain cancelled'), /cancelled/);
  `);
});

test('another admitted job starts after a failed first start without losing the active lane wakeup', async () => {
  await probe('[]', `
    await seed('first'); await seed('second');
    const { DEFAULT_CAPTION_APPEARANCE } = await import('@kcs/shared');
    const payload = { exportSettings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' },
      exportAppearance: DEFAULT_CAPTION_APPEARANCE, exportCaptions: [], exportMediaFilename: 'synthetic.mp4', exportMediaSize: 42 };
    const startEntered = deferred(); const releaseStart = deferred();
    const secondEntered = deferred(); const releaseSecond = deferred();
    let firstStarts = 0; let secondStarts = 0; let failed = false;
    const media = mock.method(store, 'getMedia', async (id) => {
      if (id === 'first') { firstStarts++; return null; }
      secondStarts++; secondEntered.resolve(); await releaseSecond.promise; return null;
    });
    const originalRename = fs.rename;
    const fault = mock.method(fs, 'rename', async (...args) => {
      if (String(args[1]) === config.jobsFile && !failed) {
        const snapshot = JSON.parse(await fs.readFile(args[0], 'utf8'));
        if (snapshot.some(job => job.projectId === 'first' && job.status === 'running')) {
          startEntered.resolve(); await releaseStart.promise; failed = true;
          throw new Error('Synthetic first start failure');
        }
      }
      return originalRename(...args);
    });
    try {
      const first = await jobStore.createWithDisposition('export-video', 'first', payload);
      await startEntered.promise;
      const pendingSecond = jobStore.createWithDisposition('export-video', 'second', payload);
      releaseStart.resolve();
      const second = await pendingSecond;
      let deadline;
      try {
        await Promise.race([secondEntered.promise, new Promise((_done, reject) => {
          deadline = setTimeout(() => reject(new Error('The admitted second job lost its worker wakeup')), 5000);
        })]);
      } finally { clearTimeout(deadline); }
      const retained = await jobStore.get(first.job.id);
      assert.equal(retained.status, 'interrupted'); assert.equal(retained.canResume, true);
      assert.equal(firstStarts, 0); assert.equal(secondStarts, 1);
      assert.equal((await jobStore.get(second.job.id)).status, 'running');
      assert.equal((await jobStore.list()).length, 2);
      await jobStore.cancel(second.job.id);
    } finally { releaseStart.resolve(); releaseSecond.resolve(); media.mock.restore(); fault.mock.restore(); }
    await idle();
  `);
});

test('Resume rejects an active sibling while preserving unrelated projects and job kinds', async () => {
  const active = videoHistoryJob('active-export', 'queued');
  const older = videoHistoryJob('older-export');
  const other = videoHistoryJob('other-export', 'interrupted', 'other');
  const captions = historyJob('different-kind', 'interrupted');
  await probe(JSON.stringify([active, older, other, captions]), `
    await activeEntered.promise;
    const before = await jobStore.get('older-export');
    await assert.rejects(jobStore.resume('older-export'), /already active/);
    assert.deepEqual(await jobStore.get('older-export'), before);
    const otherAccepted = await jobStore.resume('other-export');
    assert.equal(otherAccepted.id, 'other-export');
    assert.equal(otherAccepted.status, 'queued');
    const captionEntered = deferred(); const releaseCaption = deferred(); let reads = 0;
    const independent = mock.method(store, 'getMedia', async (...args) => {
      if (++reads === 1) return originalGetMedia(...args);
      captionEntered.resolve(); await releaseCaption.promise; return null;
    });
    try {
      const accepted = await jobStore.resume('different-kind');
      assert.equal(accepted.id, 'different-kind'); await captionEntered.promise;
      await jobStore.cancel('different-kind');
      await jobStore.cancel('active-export'); await jobStore.cancel('other-export');
    } finally { independent.mock.restore(); releaseCaption.resolve(); releaseActive.resolve(); held.mock.restore(); }
    await idle();
  `, `
    await seed(); await seed('other');
    const activeEntered = deferred(); const releaseActive = deferred();
    const originalGetMedia = store.getMedia; let heldOnce = false;
    const held = mock.method(store, 'getMedia', async (...args) => {
      if (!heldOnce && args[0] === 'synthetic') {
        heldOnce = true; activeEntered.resolve(); await releaseActive.promise; return null;
      }
      return originalGetMedia(...args);
    });
  `);
});

test('simultaneous Resume of different saved exports admits one unchanged job identity', async () => {
  await probe(JSON.stringify([videoHistoryJob('resume-one'), videoHistoryJob('resume-two')]), `
    await seed();
    const entered = deferred(); const release = deferred(); let reads = 0; const original = store.getMedia;
    const held = mock.method(store, 'getMedia', async (...args) => {
      if (++reads === 1) return original(...args);
      entered.resolve(); await release.promise; return null;
    });
    try {
      const results = await Promise.allSettled([jobStore.resume('resume-one'), jobStore.resume('resume-two')]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      const rejected = results.find(value => value.status === 'rejected'); assert.match(rejected.reason.message, /already active/);
      const accepted = results.find(value => value.status === 'fulfilled').value;
      await entered.promise;
      const loser = accepted.id === 'resume-one' ? 'resume-two' : 'resume-one';
      assert.equal((await jobStore.get(loser)).status, 'interrupted');
      await assert.rejects(jobStore.resume(accepted.id), /Only failed or interrupted/);
      assert.equal(reads, 2, 'one resume preflight and one worker, with no duplicate worker or sibling preflight');
      await jobStore.cancel(accepted.id);
    } finally { release.resolve(); held.mock.restore(); }
    await idle();
  `);
});

test('startup publishes pending recovery without waiting for a large exact-file check, then recovers the same result', async () => {
  const saved = publicationJob();
  await probe(JSON.stringify([saved]), `
    assert.equal((await jobStore.get('published')).stage, 'checking-export-completion');
    assert.equal((await jobStore.get('published')).canResume, false);
    await hashEntered.promise;
    await assert.rejects(jobStore.resume('published'), /may already have finished/);
    const finished = deferred();
    const stop = jobStore.subscribe(rows => { if (rows.some(job => job.id === 'published' && job.status === 'completed')) finished.resolve(); });
    releaseHash.resolve(); await finished.promise; stop(); fault.mock.restore();
    const completed = await jobStore.get('published');
    assert.equal(completed.id, 'published'); assert.equal(completed.status, 'completed'); assert.equal(completed.canResume, false);
    assert.deepEqual(completed.resultExport, ${JSON.stringify(saved.payload.exportPublication.result)});
    assert.equal(completed.exportContentFingerprint, 'a'.repeat(64));
    assert.match(completed.message, /same verified file was recovered/);
    assert.equal((await jobStore.list()).length, 1);
    assert.equal(jobStore.hasAnyActive(), false);
    // Completion is deliberately visible before its durable write. Enter the
    // same mutation queue to await that barrier without polling the Windows
    // replacement target while it is being renamed.
    await assert.rejects(jobStore.resume('published'), /Only failed or interrupted jobs/);
    const disk = JSON.parse(await fs.readFile(config.jobsFile, 'utf8'));
    assert.equal(disk[0].status, 'completed', JSON.stringify({ saved: disk[0], live: await jobStore.get('published') }));
    assert.equal(disk[0].payload.exportCaptions, undefined);
  `, `
    await seed(); await fs.mkdir(config.exportDir, { recursive: true });
    const output = path.join(config.exportDir, 'published-verified.mp4'); await fs.writeFile(output, ${JSON.stringify(publishedBytes)});
    const hashEntered = deferred(); const releaseHash = deferred(); const originalOpen = fs.open;
    const fault = mock.method(fs, 'open', async (...args) => {
      if (String(args[0]) === output) { hashEntered.resolve(); await releaseHash.promise; }
      return originalOpen(...args);
    });
  `);
});

for (const mode of ['missing', 'changed', 'unreadable', 'foreign-owner'] as const) test(`startup ${mode} publication never guesses or automatically renders`, async () => {
  const saved = publicationJob();
  if (mode === 'foreign-owner') saved.payload.exportPublication.jobId = 'another-job';
  await probe(JSON.stringify([saved]), `
    const settled = deferred();
    const stop = jobStore.subscribe(rows => { if (rows.some(job => job.id === 'published' && job.stage !== 'checking-export-completion')) settled.resolve(); });
    await settled.promise; stop();
    const recovered = await jobStore.get('published');
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.resultExport, undefined);
    assert.equal(recovered.canResume, ${mode === 'missing'});
    assert.equal(recovered.stage, ${JSON.stringify(mode === 'missing' ? 'interrupted' : 'export-completion-uncertain')});
    assert.equal(jobStore.hasAnyActive(), false);
    if (${mode !== 'missing'}) await assert.rejects(jobStore.resume('published'), /may already have finished/);
    const before = openReads; await jobStore.list(); await jobStore.list(); assert.equal(openReads, before, 'Activity reads must not repeat video hashing');
    fault.mock.restore();
    if (${mode === 'missing'}) {
      const entered = deferred(); const release = deferred(); let reads = 0; const originalMedia = store.getMedia;
      const held = mock.method(store, 'getMedia', async (...args) => {
        if (++reads === 1) return originalMedia(...args);
        entered.resolve(); await release.promise; return null;
      });
      try {
        const accepted = await jobStore.resume('published'); await entered.promise;
        assert.equal(accepted.id, 'published'); assert.equal((await jobStore.list()).length, 1);
        const disk = JSON.parse(await fs.readFile(config.jobsFile, 'utf8'));
        assert.equal(disk[0].payload.exportPublication, undefined, 'a deliberate new run releases only its old missing publication intent');
        await jobStore.cancel('published');
      } finally { release.resolve(); held.mock.restore(); }
      await idle();
    }
  `, `
    await seed(); await fs.mkdir(config.exportDir, { recursive: true });
    const output = path.join(config.exportDir, 'published-verified.mp4');
    ${mode === 'missing' ? '' : 'await fs.writeFile(output, ' + JSON.stringify(mode === 'changed' ? 'Changed bytes' : publishedBytes) + ');'}
    const originalOpen = fs.open; let openReads = 0;
    const fault = mock.method(fs, 'open', async (...args) => {
      if (String(args[0]) === output) {
        openReads++;
        ${mode === 'unreadable' ? "throw Object.assign(new Error('PRIVATE output location'), { code: 'EACCES' });" : ''}
      }
      return originalOpen(...args);
    });
  `);
});
