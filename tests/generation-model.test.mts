import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { CaptionProject } from '../packages/shared/src/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-generation-model-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.LOCALAPPDATA = root;
process.env.XDG_CONFIG_HOME = root;
process.env.GEMINI_API_KEY = 'non-secret-offline-fixture';
process.env.GEMINI_MODEL = 'gemini-3.8-flash';
process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
process.env.LOCAL_KFA_ENABLED = 'false';
process.env.LOCAL_WHISPER_FALLBACK_ENABLED = 'false';

const { default: projects } = await import('../apps/server/src/routes/projects.js');
const { generationModelPair, isCaptionGenerationModel, resolveGenerationSettings } = await import('../apps/server/src/services/generation-settings.js');
const { withProcessingRun } = await import('../apps/server/src/services/run-context.js');
const { saveLlmSettings, publicLlmSettings } = await import('../apps/server/src/services/llm-settings.js');
const { store } = await import('../apps/server/src/services/store.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { config } = await import('../apps/server/src/config.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { runGeminiModelChain, geminiCheckpointSignature } = await import('../apps/server/src/services/gemini.js');
const { readRunCheckpoint, writeRunCheckpoint } = await import('../apps/server/src/services/run-checkpoints.js');
const app = express(); app.use(express.json()); app.use('/projects', projects);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await fs.rm(root, { recursive: true, force: true }); });

async function seed(id: string, generationModel?: CaptionProject['generationModel']) {
  const project: CaptionProject = { id, title: 'Synthetic generation choice', createdAt: '2026-10-25', updatedAt: '2026-10-25', mode: 'phrase',
    generationModel, media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 1, url: `/media/${id}.mp4` },
    transcript: null, captions: [{ id: 'c1', text: 'Original wording', startMs: 0, endMs: 1000 }], transcriptionContext: { description: 'Original context', vocabulary: ['Sthang'] } };
  await store.upsert(project); cancelScheduledProjectPrewarm(id); return project;
}
async function put(project: CaptionProject, generationModel: unknown, extra = {}) {
  return fetch(`${base}/projects/${project.id}/generation-model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    generationModel, expectedGenerationModel: project.generationModel ?? 'automatic', expectedMedia: { filename: project.media.filename, size: project.media.size }, ...extra,
  }) });
}
async function idle() {
  const deadline = Date.now() + 8000;
  while (jobStore.hasAnyActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  assert.equal(jobStore.hasAnyActive(), false);
}
async function storedJob(id: string) { return JSON.parse(await fs.readFile(config.jobsFile, 'utf8')).find((job: any) => job.id === id); }

test('allowlist and effective pair preserve Automatic defaults and isolate explicit models', () => {
  const defaults = { model: 'custom-primary', fallbackModel: 'custom-fallback' };
  for (const choice of [undefined, 'automatic'] as const) assert.deepEqual(generationModelPair(choice, defaults), defaults);
  for (const choice of ['gemini-3.8-flash', 'gemini-3.6-flash'] as const) assert.deepEqual(generationModelPair(choice, defaults), { model: choice, fallbackModel: '' });
  for (const value of [null, {}, 36, '', '3.6', 'models/gemini-3.6-flash', 'custom-model']) assert.equal(isCaptionGenerationModel(value), false);
  assert.deepEqual(defaults, { model: 'custom-primary', fallbackModel: 'custom-fallback' });
});

test('project choice is durable, guarded, and preserves captions/context/other projects/global defaults', async () => {
  let project = await seed('options'); const other = await seed('untouched');
  const globalBefore = await publicLlmSettings();
  for (const choice of ['gemini-3.8-flash', 'gemini-3.6-flash', 'automatic'] as const) {
    const response = await put(project, choice); assert.equal(response.status, 200);
    project = await response.json() as CaptionProject;
    assert.equal(project.generationModel, choice);
    assert.equal(project.updatedAt, '2026-10-25', 'future model choice must not expire caption proposals');
    assert.deepEqual(project.captions, other.captions); assert.deepEqual(project.transcriptionContext, other.transcriptionContext);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/projects/options.json'), 'utf8')).generationModel, choice);
  }
  assert.deepEqual(await publicLlmSettings(), globalBefore);
  assert.deepEqual(await store.get(other.id), other);
  assert.equal((await put(project, 'custom-model')).status, 400);
  assert.equal((await put(project, 'gemini-3.6-flash', { expectedMedia: null })).status, 428);
  assert.equal((await put(project, 'gemini-3.6-flash', { expectedMedia: { filename: 'old.mp4', size: 1 } })).status, 409);
  assert.equal((await put(project, 'gemini-3.6-flash', { expectedGenerationModel: 'gemini-3.8-flash' })).status, 409);
  assert.equal((await store.get(project.id))?.generationModel, 'automatic');
});

test('concurrent option saves compare the previous choice under the project write lock', async () => {
  const project = await seed('race');
  const responses = await Promise.all([put(project, 'gemini-3.6-flash'), put(project, 'gemini-3.8-flash')]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual((await store.get(project.id))?.captions, project.captions);
});

test('accepted jobs keep their model pair across preference/default changes and resume without storing keys', async () => {
  const project = await seed('snapshot', 'gemini-3.6-flash');
  const job = await jobStore.create('transcribe', project.id, {});
  await idle();
  const snapshot = await storedJob(job.id);
  assert.deepEqual(snapshot.payload.geminiModels, { model: 'gemini-3.6-flash', fallbackModel: '' });
  assert.equal(JSON.stringify(snapshot).includes('non-secret-offline-fixture'), false);
  assert.equal('payload' in (await jobStore.get(job.id))!, false);
  const requestChoice = await jobStore.create('transcribe', project.id, { generationModel: 'gemini-3.8-flash' }); await idle();
  assert.deepEqual((await storedJob(requestChoice.id)).payload.geminiModels, { model: 'gemini-3.8-flash', fallbackModel: '' }, 'the clicked request choice wins over a concurrently changed project preference');
  assert.equal((await put(project, 'gemini-3.8-flash')).status, 200);
  await saveLlmSettings({ model: 'custom-primary', fallbackModel: 'custom-fallback' });
  await jobStore.resume(job.id); await idle();
  assert.deepEqual((await storedJob(job.id)).payload.geminiModels, snapshot.payload.geminiModels);
  const automatic = await seed('automatic');
  const accepted = await jobStore.create('regenerate-range', automatic.id, { startMs: 0, endMs: 1000 }); await idle();
  assert.deepEqual((await storedJob(accepted.id)).payload.geminiModels, { model: 'custom-primary', fallbackModel: 'custom-fallback' });
  await saveLlmSettings({ model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.6-flash' });
});

test('parallel run scopes override current preferences independently without leaking between projects', async () => {
  const run = (model: string) => withProcessingRun({ projectId: model, runKey: 'synthetic', geminiModels: { model, fallbackModel: '' } }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    const llm = await resolveGenerationSettings('gemini-3.8-flash');
    return { model: llm.model, fallbackModel: llm.fallbackModel };
  });
  assert.deepEqual(await Promise.all([run('gemini-3.6-flash'), run('gemini-3.8-flash')]), [{ model: 'gemini-3.6-flash', fallbackModel: '' }, { model: 'gemini-3.8-flash', fallbackModel: '' }]);
  assert.equal((await resolveGenerationSettings()).fallbackModel, 'gemini-3.6-flash');
});

test('explicit choices never switch models on temporary failure, even with experimental rescue enabled', async () => {
  const retries = config.geminiMaxRetries; const rescue = config.geminiTranscriptionRescueEnabled;
  config.geminiMaxRetries = 0; config.geminiTranscriptionRescueEnabled = true;
  try {
    for (const model of ['gemini-3.8-flash', 'gemini-3.6-flash'] as const) {
      const calls: string[] = [];
      const ai = { interactions: { create: async (request: { model: string }) => { calls.push(request.model); throw Object.assign(new Error('Synthetic unavailable'), { status: 503 }); } } };
      await assert.rejects(runGeminiModelChain(ai as any, { uri: 'https://example.invalid/audio', mimeType: 'audio/wav' }, 'Synthetic transcription', [], undefined, generationModelPair(model, { model: 'ignored', fallbackModel: 'ignored' })));
      assert.deepEqual(calls, [model]);
    }
  } finally { config.geminiMaxRetries = retries; config.geminiTranscriptionRescueEnabled = rescue; }
});

test('same-job checkpoints require the effective model signature and never cross model choices', async () => {
  const file = path.join(root, 'synthetic.wav'); await fs.writeFile(file, Buffer.alloc(64));
  const settings = await resolveGenerationSettings('gemini-3.6-flash');
  const signature = await geminiCheckpointSignature(file, { description: 'Synthetic', vocabulary: [] }, undefined, settings);
  const otherSignature = await geminiCheckpointSignature(file, { description: 'Synthetic', vocabulary: [] }, undefined, { ...settings, model: 'gemini-3.8-flash' });
  const fallbackSignature = await geminiCheckpointSignature(file, { description: 'Synthetic', vocabulary: [] }, undefined, { ...settings, fallbackModel: 'gemini-3.8-flash' });
  assert.notEqual(signature, otherSignature); assert.notEqual(signature, fallbackSignature);
  await writeRunCheckpoint('checkpoint', 'job-one', 'gemini-standard', signature, { textModel: settings.model });
  assert.deepEqual(await readRunCheckpoint('checkpoint', 'job-one', 'gemini-standard', signature), { textModel: settings.model });
  assert.equal(await readRunCheckpoint('checkpoint', 'job-one', 'gemini-standard', otherSignature), null);
  assert.equal(await readRunCheckpoint('checkpoint', 'job-two', 'gemini-standard', signature), null);
});

test('caption/transcript and history-style writes cannot restore an older model preference', async () => {
  const before = await seed('late-caption');
  assert.equal((await put(before, 'gemini-3.6-flash')).status, 200);
  await store.upsert({ ...before, captions: [{ ...before.captions[0], text: 'New caption' }] }); cancelScheduledProjectPrewarm(before.id);
  let current = (await store.get(before.id))!;
  assert.equal(current.generationModel, 'gemini-3.6-flash');
  assert.notEqual(current.updatedAt, before.updatedAt, 'real content edits still advance the revision');
  await store.withProjectWrite(before.id, async (_latest, persist) => persist({ ...current, generationModel: 'automatic', captions: before.captions }));
  current = (await store.get(before.id))!;
  assert.equal(current.generationModel, 'gemini-3.6-flash');
});

test('a legacy queued job acquires Automatic once after process restart, independent of new project preferences', async () => {
  const legacyRoot = path.join(root, 'legacy-restart');
  const project = await seed('legacy-source', 'gemini-3.6-flash');
  await fs.mkdir(path.join(legacyRoot, 'data/projects'), { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'data/projects/legacy-source.json'), JSON.stringify(project));
  await fs.writeFile(path.join(legacyRoot, 'data/jobs.json'), JSON.stringify([{ id: 'legacy-job', type: 'transcribe', projectId: project.id, projectTitle: 'Synthetic legacy', status: 'queued', stage: 'queued', progress: 0, message: 'Queued', createdAt: '2026-10-25', updatedAt: '2026-10-25', canResume: false, payload: {} }]));
  const receipt = path.join(legacyRoot, 'receipt.json');
  const script = path.join(legacyRoot, 'restart.mts');
  await fs.writeFile(script, `import fs from 'node:fs/promises';
const { jobStore } = await import(${JSON.stringify(new URL('../apps/server/src/services/job-store.js', import.meta.url).href)});
const deadline = Date.now() + 4000;
while ((await jobStore.get('legacy-job'))?.status !== 'failed' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
const jobs = JSON.parse(await fs.readFile(${JSON.stringify(path.join(legacyRoot, 'data/jobs.json'))}, 'utf8'));
await fs.writeFile(${JSON.stringify(receipt)}, JSON.stringify(jobs.find(j => j.id === 'legacy-job')?.payload?.geminiModels));`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), windowsHide: true, timeout: 8000, encoding: 'utf8', env: {
    ...process.env, STHANG_STUDIO_STATE_ROOT: legacyRoot, STHANG_STUDIO_ENV_FILE: path.join(legacyRoot, 'absent.env'), LOCALAPPDATA: legacyRoot, XDG_CONFIG_HOME: legacyRoot,
  } });
  assert.equal(child.status, 0, 'isolated legacy restart fixture must complete');
  assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.6-flash' });
});
