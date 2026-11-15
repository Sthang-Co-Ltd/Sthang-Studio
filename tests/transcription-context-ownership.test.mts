import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionProject, type TranscriptionContext } from '@kcs/shared';

// Exercise the real completion/write/history boundary with owned synthetic state.
// No generation, model, media preparation or external request runs in these cases.
const parent = await fs.realpath(os.tmpdir());
const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'studio-transcription-ownership-')));
const owner = randomUUID();
await fs.writeFile(path.join(root, '.owner'), owner);
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.LOCALAPPDATA = root;
process.env.XDG_CONFIG_HOME = root;
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { commitTranscriptionResult, StaleProjectMediaError } = await import('../apps/server/src/services/project-processing.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');

after(async () => {
  assert.equal(await fs.realpath(root), root);
  assert.equal(path.dirname(root), parent);
  assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function project(id: string, context?: TranscriptionContext): CaptionProject {
  return {
    id, title: 'Original synthetic project', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', mode: 'phrase',
    media: { filename: id + '.mp4', originalName: id + '.mp4', mimeType: 'video/mp4', size: 42, url: '/media/' + id + '.mp4' },
    ...(context === undefined ? {} : { transcriptionContext: structuredClone(context) }),
    captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE },
    transcript: null, captions: [{ id: 'old', text: 'Previous saved caption', startMs: 0, endMs: 1000 }],
  };
}
function generated(start: CaptionProject): CaptionProject {
  return {
    ...structuredClone(start),
    transcriptionContext: { description: 'Context used by this job', vocabulary: ['Job term'] },
    transcript: { language: 'km', fullText: 'Generated ខ្មែរ', segments: [], vocabularyTerms: ['Job term'], contextMode: 'full' },
    captions: [{ id: 'generated', text: 'Generated ខ្មែរ', startMs: 100, endMs: 1100 }],
    pipelineCache: { mediaFingerprint: 'synthetic-generation-fingerprint', normalizedAudioCached: true, normalizedAudioDurationMs: 1200 },
    engineVersion: '0.7.10', transcriptNeedsSync: false, updatedAt: '2026-01-02T00:00:00.000Z',
  };
}
async function disk(id: string) {
  return JSON.parse(await fs.readFile(path.join(root, 'data', 'projects', id + '.json'), 'utf8')) as CaptionProject;
}
async function seed(value: CaptionProject) {
  const saved = await store.upsert(value);
  cancelScheduledProjectPrewarm(value.id);
  return saved;
}

const startingContext = { description: 'Before generation', vocabulary: ['Original term'] };
const savedContexts: Array<{ label: string; initial?: TranscriptionContext; saved: TranscriptionContext }> = [
  { label: 'newer description and glossary', initial: startingContext, saved: { description: 'Newer saved ខ្មែរ context', vocabulary: ['Newer term'] } },
  { label: 'explicitly cleared context', initial: startingContext, saved: { description: '', vocabulary: [] } },
  { label: 'an explicit empty form after an absent legacy context', saved: { description: '', vocabulary: [] } },
];
for (const [index, scenario] of savedContexts.entries()) test('transcription completion preserves ' + scenario.label + ' and current project choices', async () => {
  const start = project('newer-' + index, scenario.initial);
  await seed(start);
  const result = generated(start);
  // This save lands after generation captured its inputs and before completion.
  const current = await store.withProjectWrite(start.id, async (value, persist) => {
    assert.ok(value);
    return persist({ ...value, title: 'Newer saved project name', mode: 'single-line',
      transcriptionContext: structuredClone(scenario.saved), generationModel: 'gemini-4-hydrogen',
      media: { ...value.media, originalName: 'Current source label.mp4' },
      updatedAt: '2026-01-03T00:00:00.000Z' }, { updateGenerationModel: true });
  });
  await store.setCaptionAppearance(start.id, { ...DEFAULT_CAPTION_APPEARANCE, fontSize1080: 91 });
  const beforeCompletion = (await store.get(start.id))!;
  const committed = await commitTranscriptionResult(result, start.media, structuredClone(start.transcriptionContext));
  assert.deepEqual(committed.transcriptionContext, scenario.saved);
  assert.equal(committed.title, current.title);
  assert.equal(committed.mode, current.mode);
  assert.deepEqual(committed.media, current.media);
  assert.equal(committed.generationModel, 'gemini-4-hydrogen');
  assert.equal(committed.captionAppearance?.fontSize1080, 91);
  assert.deepEqual(committed.captions, result.captions);
  assert.deepEqual(committed.transcript, result.transcript, 'generation evidence still describes the submitted job');
  assert.deepEqual(committed.pipelineCache, result.pipelineCache);
  assert.equal(committed.transcriptNeedsSync, false);
  assert.equal(committed.engineVersion, result.engineVersion);
  assert.deepEqual(await disk(start.id), committed, 'the preserved values must be durable, not only a returned projection');
  const history = await historyStore.list(start.id, start.media);
  assert.equal(history.length, 1);
  assert.equal(history[0].label, 'Before full regeneration');
  assert.deepEqual((await historyStore.get(start.id, history[0].id, start.media))?.snapshot, beforeCompletion);
  assert.deepEqual(result.transcriptionContext, { description: 'Context used by this job', vocabulary: ['Job term'] });
});

test('an unchanged saved context still adopts the submitted request context with generated results', async () => {
  const start = project('unchanged', startingContext);
  await seed(start);
  const result = generated(start);
  const committed = await commitTranscriptionResult(result, start.media, structuredClone(start.transcriptionContext));
  assert.deepEqual(committed.transcriptionContext, result.transcriptionContext);
  assert.deepEqual(committed.captions, result.captions);
  assert.deepEqual(committed.transcript, result.transcript);
  assert.deepEqual(await disk(start.id), committed);
});

test('transcription completion rejects replaced media before writing or checkpointing', async () => {
  const start = project('replaced', startingContext);
  await seed(start);
  const result = generated(start);
  const replacement = { ...start, media: { ...start.media, filename: 'replacement.mp4', size: 84 },
    transcriptionContext: { description: 'Replacement context', vocabulary: ['Replacement term'] }, captions: [] };
  const persistedReplacement = await seed(replacement);
  const before = await fs.readFile(path.join(root, 'data', 'projects', start.id + '.json'), 'utf8');
  await assert.rejects(commitTranscriptionResult(result, start.media, start.transcriptionContext), StaleProjectMediaError);
  assert.equal(await fs.readFile(path.join(root, 'data', 'projects', start.id + '.json'), 'utf8'), before);
  assert.deepEqual(await store.get(start.id), persistedReplacement);
  assert.deepEqual(await historyStore.list(start.id), []);
});

test('transcription completion cannot recreate a removed project', async () => {
  const start = project('missing', startingContext);
  await assert.rejects(commitTranscriptionResult(generated(start), start.media, start.transcriptionContext), /Project not found/);
  assert.equal(await store.get(start.id), null);
  assert.deepEqual(await historyStore.list(start.id), []);
});
