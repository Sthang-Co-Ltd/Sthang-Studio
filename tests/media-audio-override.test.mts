import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CAPTION_APPEARANCE, serializeCaptionFile, type CaptionProject, type CaptionSegment } from '../packages/shared/src/index.js';

// Isolated, deterministic PCM fixtures only. No user projects, source media or models.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audio-override-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { historyStore } = await import('../apps/server/src/services/history-store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { default: projectsRouter } = await import('../apps/server/src/routes/projects.js');
const { createMediaReplacementService } = await import('../apps/server/src/services/media-replacement.js');
const { buildAssDocument } = await import('../apps/server/src/services/caption-renderer.js');
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api/projects', projectsRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const projectIds = new Set<string>();
const rate = 48_000;
const durationMs = 2000;

function pcm(samples: Float64Array) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const source = Float64Array.from({ length: rate * 2 }, (_, i) => {
  const t = i / rate;
  return (0.12 * Math.sin(2 * Math.PI * (173 * t + 17 * t * t)) + 0.07 * Math.sin(2 * Math.PI * 611 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4.1 * t));
});
const sourceBytes = pcm(source);
const variants = {
  louder: pcm(source.map((sample) => sample * 1.7)),
  quieter: pcm(source.map((sample) => sample * 0.4)),
  music: pcm(source.map((sample, i) => sample + 0.06 * Math.sin(2 * Math.PI * 367 * i / rate))),
  sfx: pcm(source.map((sample, i) => sample + (i >= rate && i < rate + 1200 ? 0.17 * Math.sin(2 * Math.PI * 2300 * i / rate) : 0))),
};

after(async () => {
  for (const id of projectIds) cancelScheduledProjectPrewarm(id);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function seed(id: string): Promise<CaptionProject> {
  projectIds.add(id);
  const filename = `${id}-original.wav`;
  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.writeFile(path.join(config.uploadDir, filename), sourceBytes);
  const captions: CaptionSegment[] = [
    { id: 'reviewed', text: 'Reviewed words', startMs: 153, endMs: 1467, approved: true, textLocked: true, timingLocked: true,
      timingSource: 'manual', timingQuality: 'high', confidence: 0.93,
      wordTiming: { version: 1, text: 'Reviewed words', words: [
        { id: 'reviewed-word-1', startOffset: 0, endOffset: 8, startMs: 153, endMs: 803, source: 'manual' },
        { id: 'reviewed-word-2', startOffset: 9, endOffset: 14, startMs: 861, endMs: 1467, source: 'aligned', needsReview: false },
      ] } },
    { id: 'unapproved', text: 'Next', startMs: 1600, endMs: 1900, approved: false, textLocked: false, timingLocked: false,
      wordTiming: { version: 1, text: 'Next', words: [{ id: 'next-word', startOffset: 0, endOffset: 4, startMs: 1620, endMs: 1870, source: 'manual' }] } },
  ];
  const project: CaptionProject = {
    id, title: 'Synthetic accepted audio changes', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    media: { filename, originalName: filename, mimeType: 'audio/wav', size: sourceBytes.length, url: `/media/${filename}` },
    mode: 'single-line', captions, captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, highlightMode: 'word', textColor: '#19ABCA' },
    transcript: { language: 'en', fullText: 'Reviewed words Next', segments: structuredClone(captions), tokens: [
      { id: 'original-token', text: 'Reviewed words Next', startMs: 153, endMs: 1900, spaceBefore: false, timingSource: 'stt', confidence: 0.8 },
    ] },
    transcriptNeedsSync: true, engineVersion: 'synthetic-reviewed-engine',
    transcriptionContext: { description: 'Keep original context', vocabulary: ['Fixture | alias'] },
    pipelineCache: { mediaFingerprint: 'old-source', normalizedAudioCached: true, normalizedAudioDurationMs: durationMs },
  };
  await store.upsert(project);
  cancelScheduledProjectPrewarm(id);
  await historyStore.checkpoint(project, 'Reviewed synthetic audio', 'manual-save');
  return project;
}
async function readDisk(id: string): Promise<CaptionProject> {
  return JSON.parse(await fs.readFile(path.join(projectDir, `${id}.json`), 'utf8'));
}
function preserved(project: CaptionProject) {
  return { captions: project.captions, transcript: project.transcript, transcriptNeedsSync: project.transcriptNeedsSync,
    captionAppearance: project.captionAppearance, transcriptionContext: project.transcriptionContext, engineVersion: project.engineVersion,
    id: project.id, title: project.title, mode: project.mode, createdAt: project.createdAt };
}
function exportsFor(project: CaptionProject) {
  const input = { captions: project.captions, appearance: project.captionAppearance, durationMs };
  return { data: serializeCaptionFile(input, 'data').text, wordSrt: serializeCaptionFile(input, 'word-srt').text,
    wordVtt: serializeCaptionFile(input, 'word-vtt').text, ass: buildAssDocument(project.captions, project.captionAppearance, 640, 360) };
}
async function replace(project: CaptionProject, bytes = variants.louder, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ mode: 'preserve', expectedMedia: JSON.stringify(project.media), expectedUpdatedAt: project.updatedAt, ...fields })) form.append(key, value);
  form.append('media', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'synthetic-replacement.wav');
  try { return await fetch(`${baseUrl}/${project.id}/replace-media`, { method: 'POST', body: form }); }
  finally { cancelScheduledProjectPrewarm(project.id); }
}
interface Challenge { token: string; expiresAt: string }
async function challenge(project: CaptionProject, bytes = variants.louder): Promise<Challenge> {
  const response = await replace(project, bytes);
  assert.equal(response.status, 422, await response.clone().text());
  const result = await response.json() as { code: string; preserveAudioConfirmation?: Challenge };
  assert.equal(result.code, 'MEDIA_AUDIO_MISMATCH');
  assert.ok(result.preserveAudioConfirmation?.token, 'only a fully checked audio mismatch may offer confirmation');
  assert.ok(Date.parse(result.preserveAudioConfirmation.expiresAt) > Date.now());
  assert.deepEqual(await readDisk(project.id), project, 'asking for confirmation must not publish replacement');
  return result.preserveAudioConfirmation;
}
async function assertUnchanged(project: CaptionProject) {
  assert.deepEqual(await readDisk(project.id), project);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), sourceBytes);
  const backups = await fetch(`${baseUrl}/${project.id}/media-replacements`);
  assert.deepEqual(await backups.json(), []);
}

test('louder, quieter, added music and added SFX require explicit confirmation and retain exact reviewed timing exports', async (t) => {
  for (const [name, bytes] of Object.entries(variants)) await t.test(name, async () => {
    const project = await seed(`accepted-${name}`);
    const beforeExports = exportsFor(project);
    const confirmation = await challenge(project, bytes);
    const response = await replace(project, bytes, { audioChangeConfirmation: confirmation.token });
    assert.equal(response.status, 200, await response.clone().text());
    const next = await response.json() as CaptionProject & { mediaCompatibility: { audioMatches?: boolean } };
    assert.deepEqual(preserved(next), preserved(project));
    assert.deepEqual(exportsFor(next), beforeExports, 'word highlight ASS, word SRT/VTT and full caption data remain exact');
    assert.equal(next.mediaAlignment?.state, 'unverified-audio-change');
    assert.equal(next.mediaAlignment?.sourceRevision, project.updatedAt);
    assert.ok(Number.isFinite(Date.parse(next.mediaAlignment!.acceptedAt)), 'acceptance must have durable provenance');
    assert.equal(next.mediaCompatibility?.audioMatches, false, 'accepted difference must not be certified as matching audio');
    assert.deepEqual(await fs.readFile(path.join(config.uploadDir, next.media.filename)), bytes);
    assert.deepEqual(preserved(await readDisk(project.id)), preserved(project));
    assert.notEqual(next.updatedAt, project.updatedAt);
  });
});

test('missing or unaccepted confirmation keeps source, project, History and backups unchanged', async () => {
  const project = await seed('unaccepted');
  const beforeHistory = await historyStore.list(project.id, project.media);
  await challenge(project);
  await assertUnchanged(project);
  assert.deepEqual(await historyStore.list(project.id, project.media), beforeHistory);
  const response = await replace(project, variants.louder, { audioChangeConfirmation: '' });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json() as { code: string }).code, 'MEDIA_REPLACEMENT_INPUT');
  await assertUnchanged(project);
});

test('malformed, altered and cross-project confirmation cannot authorize preservation', async () => {
  const project = await seed('wrong-confirmation');
  const confirmation = await challenge(project);
  const other = await seed('wrong-confirmation-other');
  for (const [target, token] of [[project, 'true'], [project, `${confirmation.token}tampered`], [other, confirmation.token]] as const) {
    const response = await replace(target, variants.louder, { audioChangeConfirmation: token });
    assert.ok([400, 409, 422].includes(response.status), await response.clone().text());
    await assertUnchanged(target);
  }
});

test('confirmation is bound to exact selected bytes even when replacement size is unchanged', async () => {
  const project = await seed('different-selected-file');
  assert.equal(variants.louder.length, variants.quieter.length);
  const confirmation = await challenge(project, variants.louder);
  const response = await replace(project, variants.quieter, { audioChangeConfirmation: confirmation.token });
  assert.equal(response.status, 409, await response.clone().text());
  await assertUnchanged(project);
});

test('source-file changes invalidate a confirmation even without a project revision or size change', async () => {
  const project = await seed('source-bytes-changed');
  const confirmation = await challenge(project);
  await fs.writeFile(path.join(config.uploadDir, project.media.filename), variants.quieter);
  const response = await replace(project, variants.louder, { audioChangeConfirmation: confirmation.token });
  assert.equal(response.status, 409, await response.clone().text());
  assert.deepEqual(await readDisk(project.id), project);
  assert.deepEqual(await fs.readFile(path.join(config.uploadDir, project.media.filename)), variants.quieter);
  const backups = await fetch(`${baseUrl}/${project.id}/media-replacements`);
  assert.deepEqual(await backups.json(), []);
});

test('confirmation expires and must be reviewed again', async (t) => {
  const project = await seed('expired-confirmation');
  const confirmation = await challenge(project);
  const clock = t.mock.method(Date, 'now', () => Date.parse(confirmation.expiresAt) + 1000);
  try {
    const response = await replace(project, variants.louder, { audioChangeConfirmation: confirmation.token });
    assert.equal(response.status, 409, await response.clone().text());
    await assertUnchanged(project);
  } finally { clock.mock.restore(); }
});

test('a newer caption edit invalidates confirmation even with matching current media and replacement bytes', async () => {
  const project = await seed('stale-confirmation');
  const confirmation = await challenge(project);
  const edited = { ...project, captions: project.captions.map((caption) => ({ ...caption, approved: !caption.approved })), updatedAt: '2026-01-03T00:00:00.000Z' };
  await store.upsert(edited);
  const response = await replace(edited, variants.louder, { audioChangeConfirmation: confirmation.token });
  assert.equal(response.status, 409, await response.clone().text());
  await assertUnchanged(edited);
});

test('cancelling an accepted replacement before publication leaves all retained data unchanged', async () => {
  const project = await seed('cancel-confirmation');
  const confirmation = await challenge(project);
  const uploadedPath = path.join(config.uploadDir, 'cancelled-upload');
  await fs.writeFile(uploadedPath, variants.louder);
  const service = createMediaReplacementService();
  await assert.rejects(service.replaceProjectMedia(project.id, { path: uploadedPath, originalname: 'louder.wav', mimetype: 'audio/wav', size: variants.louder.length }, {
    mode: 'preserve', expectedMedia: project.media, expectedUpdatedAt: project.updatedAt,
    audioChangeConfirmation: confirmation.token, signal: AbortSignal.abort(),
  }), { code: 'MEDIA_REPLACEMENT_CANCELLED' });
  await assertUnchanged(project);
  await assert.rejects(fs.stat(uploadedPath), { code: 'ENOENT' });
});

test('double-clicked accepted replacement publishes once; a replay cannot replace the newer source', async () => {
  const project = await seed('double-confirmation');
  const confirmation = await challenge(project);
  const responses = await Promise.all([replace(project, variants.louder, { audioChangeConfirmation: confirmation.token }), replace(project, variants.louder, { audioChangeConfirmation: confirmation.token })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const next = await responses.find((response) => response.status === 200)!.json() as CaptionProject;
  assert.deepEqual(preserved(next), preserved(project));
  const backups = await fetch(`${baseUrl}/${project.id}/media-replacements`);
  assert.equal((await backups.json() as unknown[]).length, 1);
  const diskBeforeReplay = await readDisk(project.id);
  const replay = await replace(next, variants.louder, { audioChangeConfirmation: confirmation.token });
  assert.equal(replay.status, 409, await replay.clone().text());
  assert.deepEqual(await readDisk(project.id), diskBeforeReplay);
});

test('two separately confirmed replacement files cannot race across the same project revision', async () => {
  const project = await seed('two-replacements');
  const first = await challenge(project, variants.louder);
  const second = await challenge(project, variants.music);
  const responses = await Promise.all([
    replace(project, variants.louder, { audioChangeConfirmation: first.token }),
    replace(project, variants.music, { audioChangeConfirmation: second.token }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const next = await readDisk(project.id);
  assert.deepEqual(preserved(next), preserved(project));
  const bytes = await fs.readFile(path.join(config.uploadDir, next.media.filename));
  assert.ok(bytes.equals(variants.louder) || bytes.equals(variants.music));
  const backups = await fetch(`${baseUrl}/${project.id}/media-replacements`);
  assert.equal((await backups.json() as unknown[]).length, 1);
});

test('changed duration, caption beyond EOF and corrupt media never offer the audio-only override', async (t) => {
  const short = pcm(source.slice(0, rate));
  for (const [name, bytes, beyondEof] of [['duration', short, false], ['caption-eof', variants.louder, true], ['corrupt', Buffer.from('not valid media'), false]] as const) await t.test(name, async () => {
    let project = await seed(`unsafe-${name}`);
    if (beyondEof) {
      project.captions[0].endMs = 2500;
      project = await store.upsert(project);
    }
    const response = await replace(project, bytes);
    assert.equal(response.status, 422, await response.clone().text());
    const result = await response.json() as { code: string; preserveAudioConfirmation?: unknown };
    assert.ok(['MEDIA_TIMELINE_MISMATCH', 'MEDIA_AUDIO_UNVERIFIABLE'].includes(result.code));
    assert.equal(result.preserveAudioConfirmation, undefined);
    await assertUnchanged(project);
  });
});

test('unchanged audio keeps verified preservation and explicit reset still clears captions and transcript', async () => {
  const original = await seed('unchanged-regression');
  const same = await replace(original, sourceBytes);
  assert.equal(same.status, 200, await same.clone().text());
  const verified = await same.json() as CaptionProject;
  assert.deepEqual(preserved(verified), preserved(original));
  assert.equal(verified.mediaAlignment, undefined);
  const reset = await replace(verified, variants.music, { mode: 'reset' });
  assert.equal(reset.status, 200, await reset.clone().text());
  const cleared = await reset.json() as CaptionProject;
  assert.deepEqual(cleared.captions, []);
  assert.equal(cleared.transcript, null);
  assert.equal(cleared.transcriptNeedsSync, false);
  assert.equal(cleared.mediaAlignment, undefined);
});

test('regrouping cannot silently replace retained reviewed timings from the older transcript', async () => {
  const project = await seed('retained-regrouping');
  const confirmation = await challenge(project, variants.music);
  const response = await replace(project, variants.music, { audioChangeConfirmation: confirmation.token });
  assert.equal(response.status, 200, await response.clone().text());
  const next = await readDisk(project.id);
  const beforeHistory = await historyStore.list(project.id, next.media);
  const regroup = await fetch(`${baseUrl}/${project.id}/resegment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedMedia: next.media, mode: 'single-line' }),
  });
  assert.equal(regroup.status, 409, await regroup.clone().text());
  assert.equal((await regroup.json() as { code: string }).code, 'MEDIA_ALIGNMENT_UNVERIFIED');
  assert.deepEqual(await readDisk(project.id), next);
  assert.deepEqual(await historyStore.list(project.id, next.media), beforeHistory);
  assert.deepEqual(exportsFor(await readDisk(project.id)), exportsFor(project));
});
