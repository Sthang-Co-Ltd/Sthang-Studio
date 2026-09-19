import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  buildCaptionWordTiming,
  createCaptionData,
  hydrateCaptionWordTimings,
  normalizeCaptionAppearance,
  parseCaptionData,
  serializeCaptionFile,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '../packages/shared/src/index.js';
import type { CaptionHandoffDependencies, CaptionHandoffService } from '../apps/server/src/services/caption-handoff.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-caption-handoff-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';

const {
  captionHandoffRevision,
  createCaptionHandoffService,
} = await import('../apps/server/src/services/caption-handoff.js');
const { createCaptionHandoffRouter } = await import('../apps/server/src/routes/caption-handoff.js');
const { buildAssDocument } = await import('../apps/server/src/services/caption-renderer.js');

function token(id: string, text: string, startMs: number, endMs: number, spaceBefore = false): TimedToken {
  return { id, text, startMs, endMs, spaceBefore, timingSource: 'stt', confidence: 0.99, alignmentScore: 0.99 };
}

function cue(id: string, text: string, startMs: number, endMs: number, ready = false): CaptionSegment {
  const caption: CaptionSegment = { id, text, startMs, endMs, approved: true, timingSource: 'stt', timingQuality: 'high' };
  if (ready) {
    const timing = buildCaptionWordTiming(caption, [token(`${id}-token`, text, startMs + 20, endMs - 20)]);
    assert.ok(timing);
    caption.wordTiming = timing;
  }
  return caption;
}

function projectFixture(id = 'handoff-project', captions = [cue('cue-1', 'Hello captions', 100, 900, true)]): CaptionProject {
  return {
    id,
    title: 'PRIVATE PROJECT TITLE SHOULD NOT EXPORT',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    media: {
      filename: 'private-source-name.mp4',
      originalName: 'private-original-name.mp4',
      mimeType: 'video/mp4',
      size: 12345,
      url: '/media/private-source-name.mp4',
    },
    transcript: null,
    captions,
    mode: 'phrase',
    captionAppearance: normalizeCaptionAppearance({
      fontFamily: 'Khmer UI',
      textColor: '#FFFFFF',
      outlineColor: '#000000',
      highlightMode: 'word',
      highlightColor: '#D7FF4F',
    }),
    engineVersion: 'test',
  };
}

interface Harness {
  service: CaptionHandoffService;
  getCurrent(): CaptionProject;
  setCurrent(project: CaptionProject): void;
  setActive(value: boolean): void;
  counts(): { checkpoints: number; persists: number; geometry: number; mediaDuration: number };
  checkpointSnapshots(): CaptionProject[];
}

function makeHarness(initial: CaptionProject, options: { width?: number; height?: number; durationMs?: number } = {}): Harness {
  let current = structuredClone(initial);
  let active = false;
  let persists = 0;
  let geometry = 0;
  let mediaDuration = 0;
  const checkpoints: CaptionProject[] = [];
  const dependencies: CaptionHandoffDependencies = {
    getProject: async (id) => id === current.id ? structuredClone(current) : null,
    withProjectWrite: async (id, operation) => {
      if (id !== current.id) return operation(null, async () => { throw new Error('unexpected persist'); });
      return operation(structuredClone(current), async (next) => {
        persists += 1;
        current = structuredClone(next);
        return structuredClone(current);
      });
    },
    checkpoint: async (project) => { checkpoints.push(structuredClone(project)); },
    hasActiveForProject: () => active,
    geometry: async () => {
      geometry += 1;
      return { width: options.width || 1280, height: options.height || 720 };
    },
    mediaDuration: async () => {
      mediaDuration += 1;
      return options.durationMs || 5_000;
    },
    buildAss: (captions, appearance, width, height) => buildAssDocument(captions, appearance, width, height),
  };
  return {
    service: createCaptionHandoffService(dependencies),
    getCurrent: () => structuredClone(current),
    setCurrent: (project) => { current = structuredClone(project); },
    setActive: (value) => { active = value; },
    counts: () => ({ checkpoints: checkpoints.length, persists, geometry, mediaDuration }),
    checkpointSnapshots: () => structuredClone(checkpoints),
  };
}

let activeService: CaptionHandoffService = makeHarness(projectFixture()).service;
const proxyService: CaptionHandoffService = {
  summary: (...args) => activeService.summary(...args),
  export: (...args) => activeService.export(...args),
  restorePreview: (...args) => activeService.restorePreview(...args),
  restore: (...args) => activeService.restore(...args),
};

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/api/caption-handoff', createCaptionHandoffRouter(proxyService));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}/api/caption-handoff`;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function post(projectId: string, suffix: string, body: unknown) {
  return fetch(`${baseUrl}/${projectId}/${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function summary(projectId: string) {
  return fetch(`${baseUrl}/${projectId}/summary`, { cache: 'no-store' });
}

function precondition(project: CaptionProject, revision: string) {
  return { expectedMedia: { filename: project.media.filename, size: project.media.size }, expectedRevision: revision };
}

function readStoreZip(buffer: Buffer) {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0, 'bundle ZIP entries must use bounded STORE mode');
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014B50, 'central ZIP directory should follow local STORE entries');
  return entries;
}

test('summary and plain SRT export use only the saved snapshot with no media probe', async () => {
  const project = projectFixture('plain-export');
  const harness = makeHarness(project);
  activeService = harness.service;

  const response = await summary(project.id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const value = await response.json();
  assert.equal(value.captionCount, 1);
  assert.equal(value.snapshot.kind, 'sthang-caption-data');
  assert.equal(value.snapshot.captions[0].text, project.captions[0].text);
  assert.equal('id' in value.snapshot.captions[0], false);
  assert.deepEqual(value.media, { filename: project.media.filename, size: project.media.size });
  assert.equal(harness.counts().geometry, 0);
  assert.equal(harness.counts().mediaDuration, 0);

  const exported = await post(project.id, 'export', {
    format: 'srt',
    ...precondition(project, value.revision),
    captions: [{ text: 'CLIENT PAYLOAD MUST BE IGNORED', startMs: 0, endMs: 1 }],
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') || '', /^attachment; filename="sthang-captions\.srt"$/);
  assert.match(exported.headers.get('content-type') || '', /application\/x-subrip/);
  assert.match(exported.headers.get('cache-control') || '', /no-store/);
  const text = await exported.text();
  assert.match(text, /Hello captions/);
  assert.doesNotMatch(text, /CLIENT PAYLOAD MUST BE IGNORED/);
  assert.doesNotMatch(text, /PRIVATE PROJECT TITLE/);
  assert.equal(harness.counts().geometry, 0);
  assert.equal(harness.counts().mediaDuration, 0);

  const changed = harness.getCurrent();
  changed.captionAppearance = normalizeCaptionAppearance({ ...changed.captionAppearance, textColor: '#AABBCC' });
  harness.setCurrent(changed);
  assert.notEqual(captionHandoffRevision(changed), value.revision, 'appearance must participate in snapshot revision');
  const stale = await post(project.id, 'export', { format: 'srt', ...precondition(project, value.revision) });
  assert.equal(stale.status, 409);
});

test('persisted transcript audio duration participates in handoff revision and fences an old export', async () => {
  const project = projectFixture('duration-revision');
  project.transcript = {
    language: 'en', fullText: 'Hello captions', segments: structuredClone(project.captions),
    timing: { audioDurationMs: 5_000 },
  } as NonNullable<CaptionProject['transcript']>;
  const harness = makeHarness(project);
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();
  assert.equal(basis.snapshot.durationMs, 5_000);

  const changed = harness.getCurrent();
  changed.transcript!.timing!.audioDurationMs = 5_001.25;
  harness.setCurrent(changed);
  assert.notEqual(captionHandoffRevision(changed), basis.revision);
  const stale = await post(project.id, 'export', { format: 'srt', ...precondition(project, basis.revision) });
  assert.equal(stale.status, 409);
});

test('portable snapshot preserves fractional milliseconds while SRT rounds only the derivative file', async () => {
  const fractional = cue('fractional', 'Fractional timing', 100.375, 900.625, false);
  const project = projectFixture('fractional-export', [fractional]);
  const harness = makeHarness(project);
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();
  assert.equal(basis.snapshot.captions[0].startMs, 100.375);
  assert.equal(basis.snapshot.captions[0].endMs, 900.625);

  const response = await post(project.id, 'export', { format: 'srt', ...precondition(project, basis.revision) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-sthang-handoff-warnings') || '', /rounded/i);
  const srt = await response.text();
  assert.match(srt, /00:00:00,100 --> 00:00:00,901/);
  assert.equal(harness.counts().geometry, 0);
  assert.equal(harness.counts().mediaDuration, 0);
});

test('a clean legacy project exports the same hydrated word snapshot as the editor without persisting it', async () => {
  const project = projectFixture('legacy-handoff', [cue('legacy', 'one two', 100, 1200)]);
  project.transcript = {
    language: 'en', fullText: 'one two', segments: structuredClone(project.captions),
    tokens: [token('one', 'one', 150, 500), token('two', 'two', 650, 1100, true)],
  };
  const harness = makeHarness(project);
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();
  assert.equal(basis.readyWordCaptionCount, 1);
  assert.deepEqual(basis.snapshot.captions, createCaptionData({ captions: hydrateCaptionWordTimings(project).captions }).captions);
  const exported = await post(project.id, 'export', { format: 'word-srt', ...precondition(project, basis.revision) });
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /00:00:00,650 --> 00:00:01,100\r\ntwo/);
  assert.equal(harness.getCurrent().captions[0].wordTiming, undefined);
  assert.equal(harness.counts().persists, 0);
  assert.equal(harness.counts().geometry, 0);
});

test('bundle contains fixed safe caption files, styled ASS, honest README, and omits unready word files', async () => {
  const project = projectFixture('bundle-export', [
    cue('ready', 'Ready word', 100, 800, true),
    cue('missing', 'Missing timing', 700, 1_400, false),
  ]);
  const harness = makeHarness(project, { width: 1280, height: 720 });
  activeService = harness.service;
  const summaryValue = await (await summary(project.id)).json();
  assert.equal(summaryValue.readyWordCaptionCount, 1);
  assert.deepEqual(summaryValue.formats.wordTimed, []);

  const response = await post(project.id, 'export', { format: 'bundle', ...precondition(project, summaryValue.revision) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('x-sthang-handoff-warnings') || '', /word-by-word SRT\/VTT were omitted/i);
  const zip = Buffer.from(await response.arrayBuffer());
  const entries = readStoreZip(zip);
  assert.deepEqual([...entries.keys()], [
    'captions.srt', 'captions.vtt', 'captions.ttml', 'caption-data.json', 'captions-styled.ass', 'README.txt',
  ]);
  assert.equal(entries.has('captions-word-by-word.srt'), false);
  assert.equal(entries.has('captions-word-by-word.vtt'), false);
  assert.match(entries.get('captions-styled.ass')!.toString('utf8'), /PlayResX: 1280/);
  assert.match(entries.get('captions-styled.ass')!.toString('utf8'), /PlayResY: 720/);
  const readme = entries.get('README.txt')!.toString('utf8');
  assert.match(readme, /CapCut Mobile does not currently provide direct subtitle-file import/i);
  assert.match(readme, /Cloud Sync is an external service/i);
  assert.match(readme, /overlaps are preserved exactly/i);
  assert.match(readme, /does not silently retime/i);
  assert.match(readme, /does not carry Sthang styling or spoken-word highlights/i);
  assert.match(readme, /render-oriented styled events/i);
  assert.doesNotMatch(zip.toString('utf8'), /PRIVATE PROJECT TITLE SHOULD NOT EXPORT/);
  assert.doesNotMatch(zip.toString('utf8'), /private-source-name\.mp4/);
  assert.doesNotMatch(zip.toString('utf8'), /\/media\/private-source-name\.mp4/);
  assert.equal(harness.counts().geometry, 1);

  const wordExport = await post(project.id, 'export', { format: 'word-srt', ...precondition(project, summaryValue.revision) });
  assert.equal(wordExport.status, 409);
});

test('bundle includes word-level files only when every caption has ready word timing', async () => {
  const project = projectFixture('ready-bundle', [cue('ready', 'Single', 100, 900, true)]);
  const harness = makeHarness(project);
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();
  assert.deepEqual(basis.formats.wordTimed, ['word-srt', 'word-vtt']);
  const response = await post(project.id, 'export', { format: 'bundle', ...precondition(project, basis.revision) });
  assert.equal(response.status, 200);
  const entries = readStoreZip(Buffer.from(await response.arrayBuffer()));
  assert.equal(entries.has('captions-word-by-word.srt'), true);
  assert.equal(entries.has('captions-word-by-word.vtt'), true);
  assert.match(entries.get('README.txt')!.toString('utf8'), /does not guarantee native highlight animation/i);
});

test('standalone ASS fails closed before geometry for invalid or centisecond-collapsed captions', async () => {
  const collapsedProject = projectFixture('collapsed-ass', [cue('tiny', 'Tiny ASS', 100.1, 104.9, false)]);
  const collapsedHarness = makeHarness(collapsedProject);
  activeService = collapsedHarness.service;
  const collapsedBasis = await (await summary(collapsedProject.id)).json();
  const collapsed = await post(collapsedProject.id, 'export', { format: 'ass', ...precondition(collapsedProject, collapsedBasis.revision) });
  assert.equal(collapsed.status, 400);
  assert.match((await collapsed.json()).error, /10 ms ASS timing grid/i);
  assert.equal(collapsedHarness.counts().geometry, 0, 'ASS preflight must fail before any geometry/FFmpeg-adjacent work');

  const invalidProject = projectFixture('invalid-ass');
  const invalidHarness = makeHarness(invalidProject);
  activeService = invalidHarness.service;
  const validBasis = await (await summary(invalidProject.id)).json();
  const invalidCurrent = invalidHarness.getCurrent();
  invalidCurrent.captions[0].endMs = invalidCurrent.captions[0].startMs;
  invalidHarness.setCurrent(invalidCurrent);
  const invalid = await post(invalidProject.id, 'export', { format: 'ass', ...precondition(invalidProject, validBasis.revision) });
  assert.equal(invalid.status, 409);
  assert.match((await invalid.json()).error, /invalid or changed/i);
  assert.equal(invalidHarness.counts().geometry, 0);
});

test('restore preview is read-only and confirmed restore checkpoints then replaces captions with new unapproved identities', async () => {
  const project = projectFixture('restore-project', [cue('old-id', 'Before restore', 100, 900, true)]);
  const oldAppearance = structuredClone(project.captionAppearance);
  const harness = makeHarness(project, { durationMs: 5_000 });
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();

  const importedCue = cue('not-exported-id', 'Imported wording', 250.25, 1_250.875, true);
  importedCue.approved = true;
  const candidateDocument = createCaptionData({
    captions: [importedCue],
    appearance: normalizeCaptionAppearance({ textColor: '#00FF00' }),
    durationMs: 4_000.125,
  });
  const data = serializeCaptionFile({ captions: [importedCue], appearance: candidateDocument.appearance, durationMs: 4_000.125 }, 'data').text;
  assert.deepEqual(parseCaptionData(data), candidateDocument);

  const before = harness.getCurrent();
  const previewResponse = await post(project.id, 'restore-preview', { data, ...precondition(project, basis.revision) });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.candidate, candidateDocument);
  assert.equal(preview.captionCount, 1);
  assert.match(preview.warnings.join(' '), /appearance.*will not be restored/i);
  assert.match(preview.warnings.join(' '), /unapproved/i);
  assert.match(preview.warnings.join(' '), /duration.*differs.*not retimed/i);
  assert.deepEqual(harness.getCurrent(), before, 'preview must not mutate the saved project');
  assert.deepEqual(harness.counts(), { checkpoints: 0, persists: 0, geometry: 0, mediaDuration: 1 });

  const mismatch = await post(project.id, 'restore', {
    data, ...precondition(project, basis.revision), confirmed: true, expectedCandidateDigest: '0'.repeat(64),
  });
  assert.equal(mismatch.status, 409);
  assert.equal(harness.counts().checkpoints, 0);
  assert.equal(harness.counts().persists, 0);

  const restoreResponse = await post(project.id, 'restore', {
    data, ...precondition(project, basis.revision), confirmed: true, expectedCandidateDigest: preview.candidateDigest,
  });
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json();
  assert.equal(restored.id, project.id);
  assert.equal('project' in restored, false, 'route returns CaptionProject directly');
  assert.equal(restored.captions.length, 1);
  assert.equal(restored.captions[0].text, 'Imported wording');
  assert.equal(restored.captions[0].startMs, 250.25);
  assert.equal(restored.captions[0].endMs, 1_250.875);
  assert.notEqual(restored.captions[0].id, project.captions[0].id);
  assert.notEqual(restored.captions[0].id, 'not-exported-id');
  assert.equal(restored.captions[0].approved, false);
  assert.deepEqual(restored.captionAppearance, oldAppearance, 'captions-only restore must preserve current appearance');
  assert.equal(restored.transcriptNeedsSync, true);
  assert.equal(harness.counts().checkpoints, 1);
  assert.equal(harness.counts().persists, 1);
  assert.equal(harness.checkpointSnapshots()[0].captions[0].text, 'Before restore');

  const stale = await post(project.id, 'restore-preview', { data, ...precondition(project, basis.revision) });
  assert.equal(stale.status, 409);
});

test('restore preview canonicalizes unsorted captions once and confirmed restore commits that exact order/digest', async () => {
  const project = projectFixture('ordered-restore', [cue('old', 'Before', 100, 900, false)]);
  const harness = makeHarness(project, { durationMs: 5_000 });
  activeService = harness.service;
  const basis = await (await summary(project.id)).json();
  const late = cue('late', 'Later', 2_000, 2_800, false);
  const earlyA = cue('early-a', 'Early A', 500, 1_100, false);
  const earlyB = cue('early-b', 'Early B', 500, 1_000, false);
  const data = serializeCaptionFile({ captions: [late, earlyA, earlyB], durationMs: 5_000 }, 'data').text;

  const previewResponse = await post(project.id, 'restore-preview', { data, ...precondition(project, basis.revision) });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.deepEqual(preview.candidate.captions.map((item: CaptionSegment) => item.text), ['Early B', 'Early A', 'Later']);
  assert.match(preview.warnings.join(' '), /reordered by start time/i);

  const restoreResponse = await post(project.id, 'restore', {
    data, ...precondition(project, basis.revision), confirmed: true, expectedCandidateDigest: preview.candidateDigest,
  });
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json();
  assert.deepEqual(restored.captions.map((item: CaptionSegment) => item.text), preview.candidate.captions.map((item: CaptionSegment) => item.text));
});

test('restore rejects existing locks, sub-40ms cues, media overflow, active jobs, and missing confirmation', async () => {
  const lockedProject = projectFixture('guarded-restore', [{ ...cue('locked', 'Protected', 100, 900, true), textLocked: true }]);
  const harness = makeHarness(lockedProject, { durationMs: 1_500 });
  activeService = harness.service;
  const basis = await (await summary(lockedProject.id)).json();
  const normalData = serializeCaptionFile({ captions: [cue('candidate', 'Candidate', 100, 700, false)] }, 'data').text;

  const locked = await post(lockedProject.id, 'restore-preview', { data: normalData, ...precondition(lockedProject, basis.revision) });
  assert.equal(locked.status, 409);
  assert.match((await locked.json()).error, /locked captions/i);
  assert.equal(harness.counts().persists, 0);

  const unlocked = harness.getCurrent();
  unlocked.captions[0].textLocked = false;
  harness.setCurrent(unlocked);
  const unlockedSummary = await (await summary(unlocked.id)).json();
  const tooShort = JSON.stringify({ kind: 'sthang-caption-data', version: 1, captions: [{ text: 'Tiny', startMs: 100, endMs: 120 }] });
  const shortResponse = await post(unlocked.id, 'restore-preview', { data: tooShort, ...precondition(unlocked, unlockedSummary.revision) });
  assert.equal(shortResponse.status, 400);
  assert.match((await shortResponse.json()).error, /40 ms/i);

  const overflowData = serializeCaptionFile({ captions: [cue('overflow', 'Too late', 1_200, 1_700, false)] }, 'data').text;
  const overflow = await post(unlocked.id, 'restore-preview', { data: overflowData, ...precondition(unlocked, unlockedSummary.revision) });
  assert.equal(overflow.status, 409);
  assert.match((await overflow.json()).error, /after the current source media/i);

  const subMillisecondOverflow = JSON.stringify({ kind: 'sthang-caption-data', version: 1, captions: [{ text: 'Outside the source', startMs: 1200, endMs: 1500.5 }] });
  const preciseOverflow = await post(unlocked.id, 'restore-preview', { data: subMillisecondOverflow, ...precondition(unlocked, unlockedSummary.revision) });
  assert.equal(preciseOverflow.status, 409, 'even a fractional overrun must not publish a cue outside the source');

  const normalPreview = await post(unlocked.id, 'restore-preview', { data: normalData, ...precondition(unlocked, unlockedSummary.revision) });
  assert.equal(normalPreview.status, 200);
  const preview = await normalPreview.json();
  const unconfirmed = await post(unlocked.id, 'restore', {
    data: normalData, ...precondition(unlocked, unlockedSummary.revision), expectedCandidateDigest: preview.candidateDigest,
  });
  assert.equal(unconfirmed.status, 428);
  harness.setActive(true);
  const busy = await post(unlocked.id, 'restore', {
    data: normalData, ...precondition(unlocked, unlockedSummary.revision), expectedCandidateDigest: preview.candidateDigest, confirmed: true,
  });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /active processing job/i);
  assert.equal(harness.counts().persists, 0);
  assert.equal(harness.counts().checkpoints, 0);
});
