import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { CaptionProject, ProjectDeletion } from '@kcs/shared';
import express from 'express';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-bin-'));
function isolated(state: string) {
  return { STHANG_STUDIO_STATE_ROOT: state, STHANG_STUDIO_ENV_FILE: path.join(state, 'absent.env'),
    GEMINI_API_KEY: '', STHANG_CONTRIBUTION_ENDPOINT: '', STHANG_ANALYTICS_ENDPOINT: '', DOTENV_CONFIG_QUIET: 'true' };
}
Object.assign(process.env, isolated(root));
const { config } = await import('../apps/server/src/config.js');
const { PROJECT_RESTORE_WINDOW_MS: week } = await import('../apps/server/src/services/project-storage.js');
const stateDir = (state: string) => path.join(state, 'data', 'projects');
const recordFile = (id: string, state = root) => path.join(stateDir(state), `${id}.json`);
const iso = (time: number) => new Date(time).toISOString();
const stamp = '2026-01-01T00:00:00.000Z';
const uploadId = `upload_${'a'.repeat(32)}`;
const source = 'synthetic';
function project(id: string): CaptionProject {
  return { id, title: `Synthetic ${id}`, createdAt: stamp, updatedAt: stamp, mode: 'phrase', transcript: null,
    captions: [{ id: 'one', startMs: 0, endMs: 1000, text: 'Synthetic caption' }],
    media: { filename: `${id}.wav`, originalName: 'source.wav', mimeType: 'audio/wav', size: source.length, url: `/media/${id}.wav` } };
}
function marker(binnedAt: number, extras: Partial<ProjectDeletion> = {}): ProjectDeletion {
  return { instanceId: randomUUID(), binnedAt: iso(binnedAt), restoreUntil: iso(binnedAt + week), recordUpdatedAt: stamp, ...extras };
}
async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
  return file;
}
const writeJson = (file: string, value: unknown) => write(file, JSON.stringify(value));
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const hasFile = async (file: string) => fs.stat(file).then(() => true, (error) => {
  assert.equal(error.code, 'ENOENT');
  return false;
});
async function seed(state: string, records: CaptionProject[], publishMarker = true) {
  for (const item of records) await writeJson(recordFile(item.id, state), item);
  await writeJson(path.join(stateDir(state), 'order.json'), records.map((item) => item.id));
  if (publishMarker) await write(path.join(stateDir(state), '.per-project-v1'), 'fixture');
}
const ids = ['neighbour', 'bin', 'tail', 'expired', 'purging', 'complete', 'other', 'proposal-fault', 'fs-fault', 'expired-sweep',
  'unexpired-sweep', 'sweep-fault', 'race', 'activity', 'active-job', uploadId, 'duplicate', 'unreadable', 'rename', 'shared', 'unsafe'];
const records = ids.map(project);
records.find((item) => item.id === 'shared')!.media.filename = 'neighbour.wav';
records.find((item) => item.id === 'unsafe')!.media.filename = '../outside.wav';
await seed(root, records);
const job = (id: string, projectId: string) => ({ id, projectId, projectTitle: project(projectId).title, type: 'transcribe',
  stage: 'failed', status: 'failed', message: 'Synthetic job', createdAt: stamp, updatedAt: stamp, progress: 5, canResume: true,
  payload: { sourceMediaFilename: `${projectId}.wav`, sourceMediaSize: source.length } });
await writeJson(config.jobsFile, [job('saved-activity', 'activity'), job('saved-complete', 'complete'), job('saved-other', 'other')]);
const { store } = await import('../apps/server/src/services/store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { profileStore } = await import('../apps/server/src/services/profile-store.js');
const { proposalStore } = await import('../apps/server/src/services/proposal-store.js');
const { sweepProjectBin } = await import('../apps/server/src/services/project-purge.js');
const { default: projects } = await import('../apps/server/src/routes/projects.js');
const { default: bin } = await import('../apps/server/src/routes/project-bin.js');
const { default: jobs } = await import('../apps/server/src/routes/jobs.js');
const { default: profile } = await import('../apps/server/src/routes/profile.js');
const app = express();
app.use(express.json());
app.use('/api/projects', projects);
app.use('/api/project-bin', bin);
app.use('/api/jobs', jobs);
app.use('/api/profile', profile);
app.use('/media', express.static(config.uploadDir));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(path.dirname(root), os.tmpdir());
  assert.match(path.basename(root), /^studio-project-bin-/u);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const request = (route: string, method = 'GET', body?: unknown) => fetch(origin + route, { method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const projectUrl = (id: string) => `/api/projects/${id}`;
const binUrl = '/api/project-bin';
const move = (id: string) => request(binUrl, 'POST', { projectId: id });
const restore = (id: string, instanceId: string) => request(`${binUrl}/${id}/restore`, 'POST', { instanceId });
const remove = (id: string, instanceId: string) => request(`${binUrl}/${id}`, 'DELETE', { instanceId });
async function expectCode(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(JSON.stringify(body).includes(root), false);
}
async function moved(response: Response) {
  assert.equal(response.status, 200);
  return await response.json() as { id: string; instanceId: string; restoreUntil: string };
}
async function probe(state: string, operation: string) {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { store } = await import('./apps/server/src/services/store.ts');
    const { sweepProjectBin } = await import('./apps/server/src/services/project-purge.ts');
    ${operation}
    console.log('RESULT:' + JSON.stringify({ active: await store.list(), bin: await store.listBinned(), status: await store.storageStatus(true) }));
  `], { env: { ...process.env, ...isolated(state) }, windowsHide: true, timeout: 20_000 });
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('RESULT:'));
  assert.ok(line);
  return JSON.parse(line.slice(7));
}
const barrier = () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release };
};

test('legacy DELETE bins independently of a project named bin and restores its order, revision and source', async () => {
  const original = await store.get('bin');
  const originalOrder = (await store.listSummaries()).map((entry) => entry.id);
  const upload = await write(path.join(config.uploadDir, 'bin.wav'), source);
  const { instanceId, restoreUntil } = await moved(await request(projectUrl('bin'), 'DELETE'));
  assert.equal((await request(projectUrl('bin'))).status, 404);
  assert.equal((await (await request('/api/projects?summary=1')).json()).some((entry: CaptionProject) => entry.id === 'bin'), false);
  const { items } = await (await request(binUrl)).json();
  assert.deepEqual(items, [{ id: 'bin', title: original!.title, captionCount: 1, instanceId,
    binnedAt: iso(Date.parse(restoreUntil) - week), restoreUntil, purging: false }]);
  assert.equal(await (await request('/media/bin.wav')).text(), source);
  assert.equal((await fs.stat(upload)).isFile(), true);
  const recheck = await store.storageStatus(true);
  assert.equal(recheck.loadedProjectCount, ids.length);
  assert.equal(recheck.missingProjectCount, 0);
  assert.equal(recheck.restartRequired, false);
  const response = await restore('bin', instanceId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updatedAt, original!.updatedAt);
  assert.deepEqual(await store.get('bin'), original);
  assert.deepEqual((await store.listSummaries()).map((entry) => entry.id), originalOrder);
  assert.equal((await readJson(recordFile('bin'))).deletion, undefined);
  await new Promise((resolve) => setTimeout(resolve, 420));
  assert.equal(await hasFile(path.join(config.cacheDir, 'bin')), false, 'restore must not schedule normalization');
});

test('restore rejects a stale instance, an elapsed deadline and a started purge', async () => {
  const expired = await store.moveToBin('expired', Date.now() - week - 10_000);
  await expectCode(await restore('expired', 'wrong'), 409, 'instance_mismatch');
  await expectCode(await restore('expired', expired.instanceId), 409, 'expired');
  const purging = await store.moveToBin('purging');
  await assert.rejects(store.purgeBinnedProject('purging', purging, (run) => run(), async () => { throw new Error('fixture'); }));
  await expectCode(await restore('purging', purging.instanceId), 409, 'purging');
});

test('Delete now removes all owned data, and moving discards only this project’s unsent clips', async () => {
  function correction(id: string) { return { id: `correction-${id}`, projectId: id, captionId: 'one', projectTitle: project(id).title,
    startMs: 0, endMs: 1000, originalText: 'Before', correctedText: 'After', suggestedVocabularyLine: 'After',
    suggestionKind: 'remember-word', status: 'new', createdAt: stamp }; }
  const initial = await profileStore.get();
  await writeJson(config.profileFile, { ...initial, defaultVocabulary: ['Retain globally'], correctionEvents: ['complete', 'other'].map(correction) });
  const target = project('complete');
  const associated = await historyStore.checkpoint(target, 'Synthetic history', 'restore');
  assert.ok(associated);
  const recovery = path.join(config.historyDir, 'complete', 'media-replacements', 'retired');
  const retiredSource = await write(path.join(config.uploadDir, 'retired.wav'), source);
  const backupSource = await write(path.join(recovery, 'source'), source);
  await writeJson(path.join(recovery, 'snapshot.json'), { id: 'retired', version: 1, history: [], sourceFile: 'source',
    sourceSha256: createHash('sha256').update(source).digest('hex'), project: { ...target, media: { ...target.media, filename: 'retired.wav' } } });
  const files = await Promise.all([
    write(path.join(config.uploadDir, 'complete.wav'), source),
    write(path.join(config.cacheDir, 'complete', 'normalized.wav'), source),
    write(path.join(config.cacheDir, 'media-previews', 'complete', 'preview.mp4'), source),
    write(path.join(config.cacheDir, 'complete', 'runs', 'saved-complete', 'checkpoint.json'), source),
    writeJson(path.join(config.proposalDir, 'remove-me.json'), { summary: { projectId: 'complete', expiresAt: iso(Date.now() + week) } }),
  ]);
  const exportFile = await write(path.join(config.exportDir, 'retain.srt'), source);
  const temp = await write(path.join(config.contributionTempDir, 'complete-queued.1.a1b2c3d4.wav'), source);
  const candidate = (id: string, projectId: string, status: string) => ({ id, projectId, status, originalText: 'Private text',
    correctedText: 'Private correction', correctionEventIds: [`correction-${projectId}`], attempts: 0 });
  await writeJson(config.contributionStateFile, { version: 1, candidates: [candidate('complete-queued', 'complete', 'queued'),
    candidate('complete-rejected', 'complete', 'rejected'), candidate('receipt', 'complete', 'submitted'), candidate('other-queued', 'other', 'queued')] });
  const { instanceId } = await moved(await move('complete'));
  const state = await readJson(config.contributionStateFile);
  assert.deepEqual(state.candidates.map((entry: { id: string }) => entry.id), ['receipt', 'other-queued']);
  assert.equal(state.candidates[0].originalText, '');
  assert.equal(state.candidates[1].originalText, 'Private text');
  assert.equal(await hasFile(temp), false);
  assert.equal(await hasFile(recordFile('complete')), true);
  assert.equal((await profileStore.get()).correctionEvents.some((event) => event.id === 'correction-complete'), true);
  assert.equal((await remove('complete', instanceId)).status, 204);
  for (const file of [...files, retiredSource, backupSource, recordFile('complete'), path.join(config.historyDir, 'complete')]) assert.equal(await hasFile(file), false, file);
  assert.deepEqual((await readJson(config.jobsFile)).map((entry: { id: string }) => entry.id), ['saved-activity', 'saved-other']);
  const after = await profileStore.get();
  assert.deepEqual(after.correctionEvents.map((event) => event.id), ['correction-other']);
  assert.deepEqual(after.defaultVocabulary, ['Retain globally']);
  assert.deepEqual((await readJson(config.contributionStateFile)).candidates.map((entry: { id: string }) => entry.id), ['receipt', 'other-queued']);
  assert.equal(await fs.readFile(exportFile, 'utf8'), source);
});

for (const id of ['proposal-fault', 'fs-fault']) test(`a ${id} leaves a resumable record and the next sweep finishes`, async () => {
  const media = await write(path.join(config.uploadDir, `${id}.wav`), source);
  const proposal = await writeJson(path.join(config.proposalDir, `${id}.json`), { summary: { projectId: id } });
  const { instanceId } = await moved(await move(id));
  const original = fs.rm;
  fs.rm = async (file, options) => {
    if (file === (id === 'fs-fault' ? media : proposal)) throw new Error('synthetic deletion failure');
    return original(file, options);
  };
  try { await expectCode(await remove(id, instanceId), 500, 'purge_incomplete'); }
  finally { fs.rm = original; }
  assert.ok((await readJson(recordFile(id))).deletion.purgeStartedAt);
  assert.equal((await store.listBinned()).find((entry) => entry.id === id)?.purging, true);
  await expectCode(await restore(id, instanceId), 409, 'purging');
  await sweepProjectBin();
  for (const file of [media, proposal, recordFile(id)]) assert.equal(await hasFile(file), false);
});

test('a fresh process resumes a persisted partial purge even before its deadline', async () => {
  const state = path.join(root, 'restart');
  const item = { ...project('resumed'), deletion: marker(Date.now(), { purgeStartedAt: iso(Date.now()) }) };
  await seed(state, [item]);
  const cache = await write(path.join(state, 'data', 'cache', item.id, 'retained'), source);
  const result = await probe(state, 'await sweepProjectBin();');
  assert.deepEqual(result.bin, []);
  assert.equal(await hasFile(recordFile(item.id, state)), false);
  assert.equal(await hasFile(cache), false);
});

test('sweep is single-flight, removes expired projects and continues after one failure', async () => {
  const now = Date.now();
  await store.moveToBin('sweep-fault', now - week - 1000);
  await store.moveToBin('expired-sweep', now - week - 1000);
  await store.moveToBin('unexpired-sweep', now);
  const media = await write(path.join(config.uploadDir, 'sweep-fault.wav'), source);
  const entered = barrier(), release = barrier();
  const original = fs.rm;
  let attempts = 0;
  fs.rm = async (file, options) => {
    if (file === media) { attempts++; entered.release(); await release.waiting; throw new Error('synthetic'); }
    return original(file, options);
  };
  const first = sweepProjectBin(now);
  try {
    await entered.waiting;
    await sweepProjectBin(now);
    assert.equal(attempts, 1);
    assert.equal(await hasFile(recordFile('expired-sweep')), true);
  } finally { release.release(); await first; fs.rm = original; }
  assert.equal(await hasFile(recordFile('expired-sweep')), false);
  assert.equal((await readJson(recordFile('unexpired-sweep'))).deletion.purgeStartedAt, undefined);
  assert.ok((await readJson(recordFile('sweep-fault'))).deletion.purgeStartedAt);
  await sweepProjectBin(now);
});

test('upgrade clears a marker when a downgraded Studio saved a later revision', async () => {
  const state = path.join(root, 'downgraded');
  const edited = { ...project('edited'), updatedAt: iso(Date.now()), title: 'New edits', deletion: marker(Date.now() - week - 1000) };
  await seed(state, [edited]);
  const result = await probe(state, 'await sweepProjectBin();');
  assert.deepEqual(result.bin, []);
  assert.equal(result.active[0].title, 'New edits');
  assert.equal((await readJson(recordFile('edited', state))).deletion, undefined);
  assert.equal((await readJson(recordFile('edited', state))).updatedAt, edited.updatedAt);
});

test('a restore wins against a stale sweep snapshot and re-bin rejects a stale Delete now', async () => {
  const { instanceId, restoreUntil } = await moved(await move('race'));
  const media = await write(path.join(config.uploadDir, 'race.wav'), source);
  const original = store.listPurgeCandidates;
  const captured = barrier(), resume = barrier();
  store.listPurgeCandidates = async (now) => {
    const candidates = await original(now);
    captured.release(); await resume.waiting;
    return candidates;
  };
  const sweep = sweepProjectBin(Date.parse(restoreUntil) + 1);
  try { await captured.waiting; assert.equal((await restore('race', instanceId)).status, 200); }
  finally { resume.release(); await sweep; store.listPurgeCandidates = original; }
  assert.ok(await store.get('race'));
  assert.equal(await fs.readFile(media, 'utf8'), source);
  const second = await moved(await move('race'));
  assert.notEqual(second.instanceId, instanceId);
  await expectCode(await remove('race', instanceId), 409, 'instance_mismatch');
  assert.equal(await fs.readFile(media, 'utf8'), source);
  assert.equal((await readJson(recordFile('race'))).deletion.instanceId, second.instanceId);
  assert.equal((await restore('race', second.instanceId)).status, 200);
});

test('Activity GET, SSE and detail hide a binned job and republish it on restore', async () => {
  const response = await fetch(origin + '/api/jobs/events', { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let stream = '';
  async function snapshot() {
    while (!stream.includes('\n\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += decoder.decode(chunk.value, { stream: true });
    }
    const end = stream.indexOf('\n\n');
    const event = stream.slice(0, end);
    stream = stream.slice(end + 2);
    return JSON.parse(event.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as Array<{ id: string }>;
  }
  try {
    assert.equal((await snapshot()).some((item) => item.id === 'saved-activity'), true);
    assert.equal((await request('/api/jobs/saved-activity')).status, 200);
    const { instanceId } = await moved(await move('activity'));
    assert.equal((await snapshot()).some((item) => item.id === 'saved-activity'), false);
    assert.deepEqual(await (await request('/api/jobs?projectId=activity')).json(), []);
    assert.equal((await request('/api/jobs/saved-activity')).status, 404);
    assert.equal((await request('/api/jobs/saved-activity/cancel', 'POST')).status, 404);
    assert.equal((await request('/api/jobs/transcribe', 'POST', { projectId: 'activity', expectedMedia: project('activity').media })).status, 404);
    assert.equal((await request('/api/jobs/saved-activity/resume', 'POST')).status, 400);
    assert.equal((await readJson(config.jobsFile)).some((item: { id: string }) => item.id === 'saved-activity'), true);
    assert.equal((await restore('activity', instanceId)).status, 200);
    assert.equal((await snapshot()).some((item) => item.id === 'saved-activity'), true);
    assert.equal((await request('/api/jobs/saved-activity')).status, 200);
    assert.equal((await (await request('/api/jobs?projectId=activity')).json()).length, 1);
  } finally { await reader.cancel(); }
});

test('a durably queued job blocks moving its project', async () => {
  const entered = barrier(), release = barrier();
  const original = fs.rename;
  fs.rename = async (from, to) => {
    if (to === config.jobsFile && (await readJson(String(from))).some((item: { projectId: string; status: string }) => item.projectId === 'active-job' && item.status === 'running')) {
      entered.release(); await release.waiting;
      throw new Error('fixture stops worker before processing');
    }
    return original(from, to);
  };
  try {
    await jobStore.create('transcribe', 'active-job', {});
    await entered.waiting;
    assert.equal(jobStore.hasActiveForProject('active-job'), true);
    await expectCode(await move('active-job'), 409, 'job_active');
    assert.ok(await store.get('active-job'));
  } finally { release.release(); fs.rename = original; }
});

test('binned project refuses correction add-project and upload reuse without side effects', async () => {
  const state = await profileStore.get();
  await moved(await move('other'));
  await expectCode(await request('/api/profile/corrections/correction-other/action', 'POST', { action: 'add-project' }), 409, 'project_binned');
  assert.deepEqual(await profileStore.get(), state);
  await moved(await move(uploadId));
  const before = (await fs.readdir(config.uploadDir)).sort();
  const form = new FormData();
  form.append('media', new Blob([source], { type: 'audio/wav' }), 'test.wav');
  form.append('creationAttemptId', uploadId);
  await expectCode(await fetch(origin + '/api/projects', { method: 'POST', body: form }), 409, 'project_binned');
  assert.deepEqual((await fs.readdir(config.uploadDir)).sort(), before);
});

test('purge refuses duplicate and unreadable records while a healthy neighbour still purges', async () => {
  for (const id of ['duplicate', 'unreadable']) {
    const file = await write(path.join(config.uploadDir, `${id}.wav`), source);
    const { instanceId } = await moved(await move(id));
    const record = await fs.readFile(recordFile(id), 'utf8');
    const disputed = await write(recordFile(id === 'duplicate' ? 'wrong-filename' : id), id === 'duplicate' ? record : '{ unreadable');
    await expectCode(await remove(id, instanceId), 409, 'storage_blocked');
    assert.equal(await fs.readFile(file, 'utf8'), source);
    assert.equal(await fs.readFile(disputed, 'utf8'), id === 'duplicate' ? record : '{ unreadable');
    assert.equal((await store.listBinned()).find((item) => item.id === id)?.purging, true);
  }
  const shared = await write(path.join(config.uploadDir, 'neighbour.wav'), source);
  const { instanceId } = await moved(await move('shared'));
  assert.equal((await remove('shared', instanceId)).status, 204);
  assert.ok(await store.get('neighbour'));
  assert.equal(await fs.readFile(shared, 'utf8'), source);
  const outside = await write(path.join(root, 'outside.wav'), source);
  const unsafe = await moved(await move('unsafe'));
  assert.equal((await remove('unsafe', unsafe.instanceId)).status, 204);
  assert.equal(await fs.readFile(outside, 'utf8'), source);
  const valid = await moved(await move('neighbour'));
  assert.equal((await remove('neighbour', valid.instanceId)).status, 204);
  assert.equal(await hasFile(shared), false);
});

test('legacy reconciliation preserves a binned record when the migration marker is absent', async () => {
  const state = path.join(root, 'legacy');
  const item = { ...project('saved'), deletion: marker(Date.now()) };
  await seed(state, [item], false);
  const legacy = await writeJson(path.join(state, 'data', 'projects.json'), [{ ...project('saved'), title: 'Legacy' }]);
  const result = await probe(state, 'await store.list();');
  assert.deepEqual(result.active, []);
  assert.equal(result.bin[0].instanceId, item.deletion.instanceId);
  assert.equal(result.status.restartRequired, false);
  assert.equal(result.status.missingProjectCount, 0);
  assert.deepEqual(await readJson(recordFile('saved', state)), item);
  assert.deepEqual(await readJson(path.join(state, 'data', 'projects.legacy-v0.7.json')), await readJson(legacy));
});

test('startup normalizes a future clock once and leaves an invalid marker blocked', async () => {
  const state = path.join(root, 'clock');
  const now = Date.now();
  const item = { ...project('future'), deletion: marker(now + 2 * 24 * 60 * 60 * 1000) };
  const invalid = { ...project('invalid'), deletion: marker(now - week - 10_000, { restoreUntil: iso(now - week) }) };
  await seed(state, [item, invalid]);
  const result = await probe(state, 'await sweepProjectBin();');
  const corrected = (await readJson(recordFile('future', state))).deletion;
  assert.equal(corrected.instanceId, item.deletion.instanceId);
  assert.ok(Date.parse(corrected.binnedAt) >= now && Date.parse(corrected.binnedAt) <= Date.now());
  assert.equal(Date.parse(corrected.restoreUntil) - Date.parse(corrected.binnedAt), week);
  assert.equal(result.bin.find((entry: { id: string }) => entry.id === 'invalid').purging, true);
  assert.deepEqual(await readJson(recordFile('invalid', state)), invalid);
  await probe(state, 'await sweepProjectBin();');
  assert.deepEqual((await readJson(recordFile('future', state))).deletion, corrected);
});

test('rename preserves revision and proposals and both restore paths keep the current title', async () => {
  const id = 'rename';
  const original = project(id);
  const oldSnapshot = { ...original, deletion: marker(Date.now()) };
  const history = await historyStore.checkpoint(oldSnapshot, 'Synthetic old title', 'restore');
  assert.ok(history);
  const proposalId = 'rename-proposal';
  await writeJson(path.join(config.proposalDir, `${proposalId}.json`), { summary: { id: proposalId, projectId: id, expiresAt: iso(Date.now() + week) }, sourceUpdatedAt: original.updatedAt });
  const url = `${projectUrl(id)}/title`;
  for (const title of ['', '  ', 'a\tb', 'a\u0000b', 'x'.repeat(121)]) assert.equal((await request(url, 'PUT', { title, expectedTitle: original.title })).status, 400);
  const result = await request(url, 'PUT', { title: '  My   title  ', expectedTitle: original.title });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { id, title: 'My title' });
  const conflict = await request(url, 'PUT', { title: 'Other', expectedTitle: original.title });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).title, 'My title');
  assert.equal((await store.get(id))!.updatedAt, original.updatedAt);
  assert.equal((await request(`${projectUrl(id)}/regeneration-proposals/${proposalId}`)).status, 200);
  const restored = await request(`${projectUrl(id)}/history/${history.id}/restore`, 'POST', { expectedMedia: original.media });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).title, 'My title');
  assert.equal((await readJson(recordFile(id))).deletion, undefined);
  const current = (await store.get(id))!;
  await write(path.join(config.uploadDir, current.media.filename), source);
  const recovery = path.join(config.historyDir, id, 'media-replacements', 'retired');
  await write(path.join(recovery, 'source'), source);
  await writeJson(path.join(recovery, 'snapshot.json'), { id: 'retired', version: 1, history: [], sourceFile: 'source',
    sourceSha256: createHash('sha256').update(source).digest('hex'), retainedBytes: source.length, project: oldSnapshot });
  const recovered = await request(`${projectUrl(id)}/media-replacements/retired/restore`, 'POST', { expectedMedia: current.media, expectedUpdatedAt: current.updatedAt });
  assert.equal(recovered.status, 200);
  const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
  cancelScheduledProjectPrewarm(id);
  assert.equal((await store.get(id))!.title, 'My title');
  assert.equal((await readJson(recordFile(id))).deletion, undefined);
  assert.notEqual((await store.get(id))!.media.filename, current.media.filename);
  assert.equal(await proposalStore.get(proposalId), null, 'media recovery keeps its existing proposal invalidation');
});
