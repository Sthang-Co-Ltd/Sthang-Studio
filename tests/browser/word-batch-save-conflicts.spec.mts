import { test, expect, type BrowserContext, type Page, type Response } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildCaptionWordTiming,
  DEFAULT_CAPTION_APPEARANCE,
  resolveCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '@kcs/shared';
import { prepareOwnedStateRoot, requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';
import { cleanupOwnedApiClients, startOwnedApi, stopOwnedApi, type OwnedApi } from './owned-api-harness.mjs';
import { closeOwnedBrowserContext, fetchOwnedRoute, installBrowserNetworkGuard } from './owned-browser-routes.mjs';

const harness = requireHarnessConfig();
const scenarios = [
  { action: 'apply', foreign: true },
  { action: 'undo', foreign: true },
  { action: 'apply', foreign: false },
  { action: 'undo', foreign: false },
] as const;
const cleanupScenarios = [
  { name: 'spacing-preflight', endpoint: 'normalize-khmer-spacing', busyLabel: 'Cleaning Khmer spacing…' },
  { name: 'timing-preflight', endpoint: 'postprocess-timing', busyLabel: 'Snapping and smoothing caption timing…' },
] as const;
type Action = typeof scenarios[number]['action'];
type BatchCase = `${Action}-${'foreign' | 'own'}`;
type Case = BatchCase | typeof cleanupScenarios[number]['name'] | 'target-edit';
const caseFor = (action: Action, foreign: boolean): BatchCase => `${action}-${foreign ? 'foreign' : 'own'}`;
const fixtureCases: Case[] = [...scenarios.map(({ action, foreign }) => caseFor(action, foreign)), ...cleanupScenarios.map(({ name }) => name), 'target-edit'];
const idFor = (name: Case) => `disk-word-batch-${name}`;
const titleFor = (name: Case) => `Word batch ${name} save authority`;
const fixtures = new Map<Case, CaptionProject>();
const preparedTimings = new Map<Case, NonNullable<CaptionSegment['wordTiming']>>();
const additionalContexts = new Set<BrowserContext>();
let root = '';
let server: OwnedApi | null = null;
let detachChildExit: (() => void) | null = null;

interface BatchRequest {
  expectedMedia: { filename: string; size: number };
  changes: Array<{ before: CaptionSegment; after: CaptionSegment }>;
  action?: Action;
}
interface BatchResponse { project: CaptionProject; appliedCount: number }
interface CaptionWrite {
  request: { captions: CaptionSegment[]; expectedUpdatedAt: string; source: string };
  status?: number;
  response?: { project?: CaptionProject };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test.beforeAll(async () => {
  root = await prepareOwnedStateRoot(harness, 'word-batch-save-state-');
  const uploads = path.join(root, 'uploads');
  const projects = path.join(root, 'data', 'projects');
  await Promise.all([fs.mkdir(uploads, { recursive: true }), fs.mkdir(projects, { recursive: true })]);
  const media = path.join(uploads, 'word-batch-save-source.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=0x204060:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media,
  ], { timeout: 30_000, windowsHide: true });
  const mediaStat = await fs.stat(media);
  for (const name of fixtureCases) {
    const id = idFor(name);
    const first: CaptionSegment = {
      id: 'c1', text: 'ខ្មែរ AI', startMs: 200, endMs: 1200,
      approved: true, textLocked: false, timingLocked: false, timingSource: 'stt', timingQuality: 'high',
    };
    const tokens: TimedToken[] = [
      { id: 'c1-w0', text: 'ខ្មែរ', startMs: 220, endMs: 620, spaceBefore: false, timingSource: 'stt', confidence: .99, alignmentScore: .99 },
      { id: 'c1-w1', text: 'AI', startMs: 720, endMs: 1100, spaceBefore: true, timingSource: 'stt', confidence: .99, alignmentScore: .99 },
    ];
    const ready = buildCaptionWordTiming(first, tokens);
    if (!ready) throw new Error('Synthetic first caption word timing could not be built.');
    preparedTimings.set(name, ready);
    first.wordTiming = {
      ...ready,
      words: ready.words.map((word, index) => index === 0 ? { ...word, source: 'estimated' as const, needsReview: true } : word),
    };
    const project: CaptionProject = {
      id, title: titleFor(name), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: mediaStat.size, url: `/media/${id}.mp4` },
      mode: 'phrase', transcript: null, engineVersion: '0.7.10',
      transcriptionContext: { description: 'Synthetic batch save race', vocabulary: [] },
      captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: process.platform === 'win32' ? 'Khmer UI' : 'Noto Sans Khmer', highlightMode: 'word' },
      captions: [
        first,
        // These captions remain editable. Their timing locks keep preparation
        // and later text edits from requesting any extra alignment candidates.
        { id: 'c2', text: 'ORIGINAL SECOND CAPTION', startMs: 1500, endMs: 2300, approved: false, textLocked: false, timingLocked: true },
        { id: 'c3', text: 'ORIGINAL THIRD CAPTION', startMs: 2600, endMs: 3600, approved: false, textLocked: false, timingLocked: true },
      ],
    };
    if (name.endsWith('-preflight')) {
      // A static hybrid transcript exposes the actual grouping/Review controls.
      // Cleanup operates on this local evidence; it never invokes an aligner.
      const transcriptTokens: TimedToken[] = [
        ...tokens,
        ...project.captions.slice(1).map((caption) => ({
          id: `synthetic-${caption.id}`, text: caption.text, startMs: caption.startMs, endMs: caption.endMs,
          spaceBefore: true, timingSource: 'stt' as const, confidence: 1, quality: 'anchored' as const,
        })),
      ];
      project.transcript = {
        language: 'km', fullText: project.captions.map((caption) => caption.text).join(' '),
        segments: structuredClone(project.captions), tokens: transcriptTokens,
        timing: {
          engine: 'kfa-local', provider: 'local', model: 'synthetic', sttTranscript: 'Synthetic cleanup evidence',
          audioDurationMs: 4000, totalTokens: transcriptTokens.length, anchoredTokens: transcriptTokens.length,
          interpolatedTokens: 0, lowConfidenceTokens: 0, alignmentCoverage: 1, meanAlignmentScore: 1,
        },
      };
    }
    fixtures.set(name, project);
    await fs.copyFile(media, path.join(uploads, project.media.filename));
    await fs.writeFile(path.join(projects, `${id}.json`), `${JSON.stringify(project)}\n`, 'utf8');
  }
  await fs.writeFile(path.join(projects, 'order.json'), JSON.stringify(fixtureCases.map(idFor)), 'utf8');
  await fs.writeFile(path.join(projects, '.per-project-v1'), 'fixture\n', 'utf8');
  server = await startOwnedApi(root);
});

test.afterAll(async () => {
  // Keep the owned state if the child has not confirmed that it stopped.
  if (server) {
    await stopOwnedApi(server);
    await fs.rm(verifyOwnedStateRoot(root, harness), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test.beforeEach(async ({ context }) => {
  await installBrowserNetworkGuard(context, harness);
  if (!server) throw new Error('Owned word-batch API is not ready.');
  const owned = server;
  owned.assertAlive();
  const abortPages = () => {
    for (const owner of [context, ...additionalContexts]) {
      for (const page of owner.pages()) void page.close({ reason: 'Owned synthetic API exited.' }).catch(() => {});
    }
  };
  owned.child.once('exit', abortPages);
  detachChildExit = () => owned.child.off('exit', abortPages);
  owned.assertAlive();
});

test.afterEach(async ({ context }) => {
  try {
    await cleanupOwnedApiClients(server, [context, ...additionalContexts].flatMap((owner) => [
      async () => {
        for (const page of owner.pages()) {
          if (!page.isClosed()) {
            page.once('dialog', async (dialog) => {
              expect(dialog.type()).toBe('beforeunload');
              await dialog.accept();
            });
            await page.goto('about:blank');
          }
        }
      },
      () => closeOwnedBrowserContext(owner),
    ]));
  } finally {
    additionalContexts.clear();
    detachChildExit?.();
    detachChildExit = null;
  }
});

async function preparePage(page: Page) {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/health', async (route) => {
    const response = await fetchOwnedRoute(route);
    try {
      const health = await response.json();
      // Capability-only fixture: the isolated child intentionally has no Python
      // runtime. The candidate below is synthetic; no model is invoked or
      // downloaded. All project reads, writes, batch operations and History use
      // the actual owned API and its isolated disk store without substitutions.
      await route.fulfill({ response, json: { ...health, timing: { ...health.timing, configured: true } } });
    } finally { await response.dispose(); }
  });
}

async function open(page: Page, name: Case) {
  await page.goto('/');
  await openFromHome(page, name);
}

async function openFromHome(page: Page, name: Case) {
  // The real isolated API has no AI credential and opens Settings once per
  // document. Dismiss that actual dialog, including after a recovery reload.
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  await expect(captionField(page, 1)).toBeVisible();
  await expect(page.locator('video')).toHaveAttribute('src', `/media/${idFor(name)}.mp4`);
}

async function clients(page: Page, name: Case) {
  const browser = page.context().browser();
  if (!browser) throw new Error('A second owned browser context is required.');
  const context = await browser.newContext({
    baseURL: harness.webOrigin, serviceWorkers: 'block', acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  additionalContexts.add(context);
  await installBrowserNetworkGuard(context, harness);
  const other = await context.newPage();
  await preparePage(page);
  await preparePage(other);
  if (name === 'target-edit') {
    // The home launcher shows only six recent projects. This seventh, isolated
    // race fixture stays discoverable without changing any real project writes.
    for (const client of [page, other]) {
      await client.route('**/api/projects?summary=1', async (route) => {
        const response = await fetchOwnedRoute(route);
        try {
          expect(response.status()).toBe(200);
          const summaries = await response.json() as Array<{ id: string }>;
          await route.fulfill({ response, json: summaries.filter((item) => item.id === idFor(name)) });
        } finally { await response.dispose(); }
      });
    }
  }
  await open(page, name);
  await open(other, name);
  return other;
}

const captionField = (page: Page, index: number) => page.getByLabel(`Caption ${index} text`, { exact: true });
const conflict = (page: Page) => page.locator('.save-failure').filter({ hasText: 'Saved project changed.' });
const isCaptionPut = (response: Response, name: Case) => response.url().endsWith(`/api/projects/${idFor(name)}/captions`) && response.request().method() === 'PUT';
async function disk(name: Case): Promise<CaptionProject> {
  return JSON.parse(await fs.readFile(path.join(root, 'data', 'projects', `${idFor(name)}.json`), 'utf8'));
}
async function history(name: Case): Promise<Record<string, string>> {
  const directory = path.join(root, 'data', 'history', idFor(name));
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return Object.fromEntries(await Promise.all(names.sort().map(async (filename) => [filename, await fs.readFile(path.join(directory, filename), 'utf8')])));
}
async function settledFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function saveForeignCaption(page: Page, name: Case, text: string) {
  await captionField(page, 2).fill(text);
  const response = page.waitForResponse((value) => isCaptionPut(value, name));
  await page.keyboard.press('Control+s');
  expect((await response).status()).toBe(200);
  await expect(page.locator('.save-action')).toHaveText('Saved');
  await expect(page.locator('.save-action')).toBeDisabled();
}
const editable = (captions: CaptionSegment[]) => captions.map(({ id, text, startMs, endMs, textLocked, timingLocked }) => ({
  id, text, startMs, endMs, textLocked: Boolean(textLocked), timingLocked: Boolean(timingLocked),
}));
async function recoveries(page: Page, name: Case) {
  return page.evaluate((projectId) => Object.keys(localStorage)
    .filter((key) => key.startsWith('sthang-studio:unfinished-edits:v1:'))
    .map((key) => JSON.parse(localStorage.getItem(key)!))
    .filter((entry) => entry.projectId === projectId), idFor(name));
}
async function editorEvidence(page: Page, name: Case) {
  return {
    texts: await Promise.all([1, 2, 3].map((index) => captionField(page, index).inputValue())),
    saveAction: await page.locator('.save-action').textContent(),
    recovery: await recoveries(page, name),
  };
}
async function downloadDraft(page: Page, label: 'Download edits' | 'Download draft') {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('sthang-unfinished-draft.json');
  const filename = await file.path();
  if (!filename) throw new Error('The unfinished-draft download did not produce a file.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

for (const { action, foreign } of scenarios) {
  const name = caseFor(action, foreign);
  test(`${action}: a held batch acknowledgement ${foreign ? 'cannot lend a foreign caption revision to autosave or queued saves' : 'keeps accepted timing and newer typing saveable without a foreign change'}`, async ({ page }, testInfo) => {
    const other = await clients(page, name);
    await other.clock.install();
    const original = fixtures.get(name)!;
    const firstText = `CLIENT B TYPED WHILE THE ${action.toUpperCase()} ACK WAS HELD`;
    const newestText = `សេចក្ដីព្រាង B ថ្មី ${action}\nNEWER THIRD CAPTION MUST SURVIVE`;
    const foreignText = `FOREIGN SECOND CAPTION FROM CLIENT A BEFORE ${action.toUpperCase()}`;
    const batchGate = deferred();
    const saveGate = deferred();
    const batches: BatchRequest[] = [];
    const writes: CaptionWrite[] = [];
    const preflights: Array<{ status: number; project: CaptionProject }> = [];
    let heldBatch: BatchResponse | null = null;
    let heldBatchRequest: BatchRequest | null = null;
    let firstPreflight = false;
    const candidateIds: string[] = [];
    const evidence: Record<string, unknown> = { action, foreign, fixture: original };

    await other.route(`**/api/projects/${idFor(name)}/caption-word-timing`, async (route) => {
      const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
      candidateIds.push(caption.id);
      expect(caption).toEqual(original.captions[0]);
      await route.fulfill({ json: {
        basis: caption, wordTiming: preparedTimings.get(name), sourceRevision: `synthetic-word-batch-${name}`, warnings: [],
      } });
    });
    await other.route(`**/api/projects/${idFor(name)}/caption-word-timing/batch-apply`, async (route) => {
      const request = route.request().postDataJSON() as BatchRequest;
      batches.push(structuredClone(request));
      const response = await fetchOwnedRoute(route);
      try {
        const body = await response.body();
        expect(response.status()).toBe(200);
        if ((request.action || 'apply') === action) {
          // This hold begins only after the real server persisted the batch and
          // History checkpoint. It delays delivery, never fakes the result.
          heldBatchRequest = structuredClone(request);
          heldBatch = JSON.parse(body.toString()) as BatchResponse;
          await batchGate.promise;
        }
        await route.fulfill({ response, body });
      } finally { await response.dispose(); }
    });
    await other.route(`**/api/projects/${idFor(name)}/captions`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const write: CaptionWrite = { request: structuredClone(route.request().postDataJSON()) };
      writes.push(write);
      const response = await fetchOwnedRoute(route);
      try {
        const body = await response.body();
        write.status = response.status();
        write.response = JSON.parse(body.toString());
        await route.fulfill({ response, body });
      } finally { await response.dispose(); }
    });

    try {
      await other.getByRole('button', { name: 'Appearance', exact: true }).click();
      await other.getByRole('button', { name: 'Prepare word highlights', exact: true }).click();
      const prepared = other.getByRole('region', { name: 'Prepared word timings', exact: true });
      await expect(prepared).toContainText('1 ready');
      expect(candidateIds).toEqual(['c1']);

      if (action === 'undo') {
        await prepared.getByRole('button', { name: 'Use ready timings', exact: true }).click();
        await expect(other.getByRole('region', { name: 'Applied word timings', exact: true }).getByRole('button', { name: 'Undo batch', exact: true })).toBeEnabled();
        const cleanApplied = await disk(name);
        expect(cleanApplied.captions[0]).toEqual({ ...original.captions[0], wordTiming: preparedTimings.get(name), approved: false });
        evidence.cleanApplyBeforeUndo = cleanApplied;
        // A must actually adopt the clean apply before making its own c2 edit.
        // B stays open with the genuine Undo offer and its older c2 baseline.
        await open(page, name);
      }
      if (foreign) await saveForeignCaption(page, name, foreignText);
      const beforeBatch = await disk(name);
      const historyBeforeBatch = await history(name);
      evidence.beforeBatch = beforeBatch;
      evidence.historyBeforeBatch = historyBeforeBatch;
      await expect(captionField(other, 2)).toHaveValue(original.captions[1].text);

      const busyLabel = action === 'apply' ? 'Applying word highlights…' : 'Undoing prepared word timings…';
      await other.getByRole('button', { name: action === 'apply' ? 'Use ready timings' : 'Undo batch', exact: true }).click();
      await expect.poll(() => heldBatch !== null).toBe(true);
      await expect(other.getByText(busyLabel, { exact: true })).toBeVisible();
      const persistedBatch = heldBatch!.project;
      const afterBatch = await disk(name);
      const historyAfterBatch = await history(name);
      evidence.afterBatchBeforeAcknowledgement = afterBatch;
      evidence.historyAfterBatch = historyAfterBatch;
      expect(afterBatch).toEqual(persistedBatch);
      expect(heldBatch!.appliedCount).toBe(1);
      expect(heldBatchRequest!.changes).toHaveLength(1);
      expect(heldBatchRequest!.changes[0].before.id).toBe('c1');
      expect(afterBatch.captions).toEqual(beforeBatch.captions.map((caption) => caption.id === 'c1'
        ? { ...caption, wordTiming: action === 'apply' ? preparedTimings.get(name) : original.captions[0].wordTiming, approved: action === 'undo' }
        : caption));
      expect(resolveCaptionWordTiming(afterBatch.captions[0]).state).toBe(action === 'apply' ? 'ready' : 'partial');
      const newCheckpointFiles = Object.keys(historyAfterBatch).filter((filename) => filename !== 'index.json' && !(filename in historyBeforeBatch));
      expect(newCheckpointFiles).toHaveLength(1);
      const batchCheckpoint = JSON.parse(historyAfterBatch[newCheckpointFiles[0]]);
      expect(batchCheckpoint.label).toBe(action === 'apply' ? 'Before applying prepared word timings' : 'Before undoing prepared word timings');
      expect(batchCheckpoint.source).toBe('timing-fix');
      expect(batchCheckpoint.snapshot.captions).toEqual(beforeBatch.captions);
      expect(batchCheckpoint.snapshot.media).toEqual(beforeBatch.media);

      await captionField(other, 3).fill(firstText);
      if (action === 'apply') await captionField(other, 3).blur();
      evidence.editorWhileBatchAcknowledgementHeld = await editorEvidence(other, name);
      expect(writes).toHaveLength(0);
      expect(await disk(name)).toEqual(afterBatch);

      await other.route(`**/api/projects/${idFor(name)}`, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        if (!firstPreflight) {
          firstPreflight = true;
          await saveGate.promise;
        }
        const response = await fetchOwnedRoute(route);
        try {
          const body = await response.body();
          preflights.push({ status: response.status(), project: JSON.parse(body.toString()) });
          await route.fulfill({ response, body });
        } finally { await response.dispose(); }
      });

      batchGate.resolve();
      await expect(other.getByText(busyLabel, { exact: true })).toHaveCount(0);
      await expect(captionField(other, 3)).toHaveValue(firstText);
      await settledFrame(other);
      if (action === 'apply') {
        // The owned API profile uses a 60s autosave delay. Advance its real
        // browser timer deterministically instead of waiting on wall-clock time.
        await other.clock.fastForward(61_000);
      } else await other.keyboard.press('Control+s');
      await expect.poll(async () => firstPreflight || await conflict(other).isVisible()).toBe(true);

      // If the batch is safe, this blur queues a second ordinary save behind
      // the held preflight. If it conflicts, the exact newer input must remain
      // editable while that callback and later retries stay stopped.
      await captionField(other, 3).fill(newestText);
      await captionField(other, 3).blur();
      await settledFrame(other);
      expect(writes).toHaveLength(0);
      saveGate.resolve();
      await expect.poll(async () => {
        if (await conflict(other).isVisible()) return true;
        return writes.length === 2 && writes.every((write) => write.status === 200)
          && (await other.locator('.save-action').textContent())?.trim() === 'Saved';
      }).toBe(true);

      const afterSaves = await disk(name);
      const historyAfterSaves = await history(name);
      const finalEditor = await editorEvidence(other, name);
      evidence.afterOrdinarySaves = afterSaves;
      evidence.historyAfterOrdinarySaves = historyAfterSaves;
      evidence.editorAfterOrdinarySaves = finalEditor;

      // Keep these persisted-state assertions ahead of conflict UI assertions.
      // The unfixed client sends successful whole-list PUTs and erases A's c2;
      // the attached evidence records that real overwrite, not just a missing
      // notice or an intercepted request that never reached the server.
      expect(afterSaves.captions[1]).toEqual(afterBatch.captions[1]);
      expect(afterSaves.captions[0]).toEqual(afterBatch.captions[0]);
      expect(finalEditor.texts).toEqual([original.captions[0].text, original.captions[1].text, newestText]);
      await expect(other.locator('.appearance-highlight-readiness')).toContainText(`${action === 'apply' ? 1 : 0} of 3 captions have usable word timing`);

      if (foreign) {
        expect(afterSaves).toEqual(afterBatch);
        expect(historyAfterSaves).toEqual(historyAfterBatch);
        expect(writes.filter((write) => write.status === 200)).toHaveLength(0);
        await expect(conflict(other)).toBeVisible();
        await expect(other.locator('.save-action')).toBeDisabled();
        await expect(other.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
        const expectedDraft = editable(original.captions.map((caption) => caption.id === 'c3' ? { ...caption, text: newestText } : caption));
        expect(finalEditor.recovery).toHaveLength(1);
        expect(finalEditor.recovery[0].captions).toEqual(expectedDraft);
        const comparisonCaptions = JSON.parse(finalEditor.recovery[0].basis.captions)[2];
        expect(comparisonCaptions.map((caption: unknown[]) => caption[1])).toEqual(original.captions.map((caption) => caption.text));
        const stopped = { writes: writes.length, reads: preflights.length };
        await other.keyboard.press('Control+s');
        await captionField(other, 3).focus();
        await captionField(other, 3).blur();
        await other.clock.fastForward(61_000);
        await settledFrame(other);
        expect({ writes: writes.length, reads: preflights.length }).toEqual(stopped);
        const downloaded = await downloadDraft(other, 'Download edits');
        expect(downloaded.captions).toEqual(expectedDraft);
        evidence.downloadedComparisonDraft = downloaded;

        other.once('dialog', async (dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); });
        await other.getByRole('button', { name: 'Reload saved project', exact: true }).click();
        await openFromHome(other, name);
        await expect(captionField(other, 2)).toHaveValue(foreignText);
        await expect(captionField(other, 3)).toHaveValue(original.captions[2].text);
        const recovery = other.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
        await expect(recovery).toBeVisible();
        await expect(recovery.getByRole('button', { name: 'Restore draft', exact: true }).and(recovery.locator('button:enabled'))).toHaveCount(0);
        await expect(recovery.getByRole('button', { name: 'Download draft', exact: true })).toBeEnabled();
        expect((await downloadDraft(other, 'Download draft')).captions).toEqual(expectedDraft);
        expect(await disk(name)).toEqual(afterBatch);
        expect(await history(name)).toEqual(historyAfterBatch);
      } else {
        const firstDraft = afterBatch.captions.map((caption) => caption.id === 'c3' ? { ...caption, text: firstText } : caption);
        const newestDraft = afterBatch.captions.map((caption) => caption.id === 'c3' ? { ...caption, text: newestText } : caption);
        expect(writes).toHaveLength(2);
        expect(writes.map((write) => write.status)).toEqual([200, 200]);
        expect(writes.map((write) => write.request.source)).toEqual([action === 'apply' ? 'autosave' : 'manual-save', 'text-edit']);
        expect(writes[0].request.captions).toEqual(firstDraft);
        expect(writes[1].request.captions).toEqual(newestDraft);
        expect(writes[0].request.expectedUpdatedAt).toBe(afterBatch.updatedAt);
        expect(writes[1].request.expectedUpdatedAt).toBe(writes[0].response!.project!.updatedAt);
        expect(afterSaves.captions).toEqual(newestDraft);
        expect(afterSaves.media).toEqual(afterBatch.media);
        expect(afterSaves.captionAppearance).toEqual(afterBatch.captionAppearance);
        expect(afterSaves.transcriptionContext).toEqual(afterBatch.transcriptionContext);
        for (const [filename, raw] of Object.entries(historyAfterBatch)) {
          if (filename !== 'index.json') expect(historyAfterSaves[filename]).toBe(raw);
        }
        expect(finalEditor.recovery).toEqual([]);
        await expect(conflict(other)).toHaveCount(0);
        await expect(other.locator('.save-action')).toHaveText('Saved');
        await expect(other.locator('.save-action')).toBeDisabled();
      }
    } finally {
      // Release every route even after an assertion fails, so teardown cannot
      // leave a pending request or remove a guard around a live editor.
      batchGate.resolve();
      saveGate.resolve();
      evidence.batchRequests = batches;
      evidence.heldBatchResponse = heldBatch;
      evidence.ordinaryPreflights = preflights;
      evidence.ordinaryCaptionWrites = writes;
      const evidencePath = testInfo.outputPath('word-batch-before-after.json');
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
      await testInfo.attach('word-batch-before-after.json', { path: evidencePath, contentType: 'application/json' });
    }
  });
}

test('typing on the prepared target during its held acknowledgement cannot undo accepted word timing', async ({ page }) => {
  const name: Case = 'target-edit';
  const other = await clients(page, name);
  await other.clock.install();
  const gate = deferred();
  let held: BatchResponse | null = null;
  const writes: CaptionWrite[] = [];

  await other.route(`**/api/projects/${idFor(name)}/caption-word-timing`, async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    expect(caption.id).toBe('c1');
    await route.fulfill({ json: { basis: caption, wordTiming: preparedTimings.get(name), sourceRevision: 'target-edit-evidence', warnings: [] } });
  });
  await other.route(`**/api/projects/${idFor(name)}/caption-word-timing/batch-apply`, async (route) => {
    const response = await fetchOwnedRoute(route);
    try {
      expect(response.status()).toBe(200);
      const body = await response.body();
      held = JSON.parse(body.toString()) as BatchResponse;
      await gate.promise;
      await route.fulfill({ response, body });
    } finally { await response.dispose(); }
  });
  await other.route(`**/api/projects/${idFor(name)}/captions`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const entry: CaptionWrite = { request: structuredClone(route.request().postDataJSON()) };
    writes.push(entry);
    const response = await fetchOwnedRoute(route);
    try {
      entry.status = response.status();
      entry.response = await response.json();
      await route.fulfill({ response, json: entry.response });
    } finally { await response.dispose(); }
  });

  try {
    await other.getByRole('button', { name: 'Appearance', exact: true }).click();
    await other.getByRole('button', { name: 'Prepare word highlights', exact: true }).click();
    await expect(other.getByRole('region', { name: 'Prepared word timings', exact: true })).toContainText('1 ready');
    await other.getByRole('button', { name: 'Use ready timings', exact: true }).click();
    await expect.poll(() => held !== null).toBe(true);
    const savedBatch = await disk(name);
    const savedHistory = await history(name);
    expect(savedBatch.captions[0].wordTiming).toEqual(preparedTimings.get(name));
    const latestTyping = 'LOCAL WORDING TYPED WHILE TARGET APPLY ACK IS HELD';
    await captionField(other, 1).fill(latestTyping);
    await captionField(other, 2).focus();
    expect(writes).toHaveLength(0);
    gate.resolve();
    await expect(other.getByText('Applying word highlights…', { exact: true })).toHaveCount(0);
    await expect(captionField(other, 1)).toHaveValue(latestTyping);
    await other.keyboard.press('Control+s');
    await expect.poll(async () => writes.length > 0 || await conflict(other).isVisible()).toBe(true);

    // The batch owns accepted timing; target-local input is kept for manual
    // comparison if it cannot be merged without replacing that saved timing.
    expect(await disk(name)).toEqual(savedBatch);
    expect(await history(name)).toEqual(savedHistory);
    expect(writes).toHaveLength(0);
    await expect(conflict(other)).toBeVisible();
    await expect(other.locator('.save-action')).toBeDisabled();
    const downloaded = await downloadDraft(other, 'Download edits');
    expect(downloaded.captions[0].text).toBe(latestTyping);
  } finally { gate.resolve(); }
});

for (const { name, endpoint, busyLabel } of cleanupScenarios) {
  test(`${endpoint}: a stale editor stops before cleanup and retains input entered during its preflight`, async ({ page }, testInfo) => {
    const other = await clients(page, name);
    await other.clock.install();
    const original = fixtures.get(name)!;
    await saveForeignCaption(page, name, `FOREIGN SECOND CAPTION BEFORE ${endpoint}`);
    const canonical = await disk(name);
    const canonicalHistory = await history(name);
    const gate = deferred();
    const reads: Array<{ status: number; project: CaptionProject }> = [];
    const cleanups: Array<{ request: unknown; status?: number; response?: unknown; delivered?: boolean }> = [];
    let captionPuts = 0;
    const evidence: Record<string, unknown> = { endpoint, beforeCleanup: canonical, historyBeforeCleanup: canonicalHistory };

    await other.route(`**/api/projects/${idFor(name)}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await fetchOwnedRoute(route);
      try {
        const body = await response.body();
        reads.push({ status: response.status(), project: JSON.parse(body.toString()) });
        await gate.promise;
        await route.fulfill({ response, body });
      } finally { await response.dispose(); }
    });
    await other.route(`**/api/projects/${idFor(name)}/${endpoint}`, async (route) => {
      const entry: typeof cleanups[number] = { request: route.request().postDataJSON() };
      cleanups.push(entry);
      const response = await fetchOwnedRoute(route);
      try {
        const body = await response.body();
        entry.status = response.status();
        entry.response = JSON.parse(body.toString());
        // The unfixed caller skips preflight. Hold its real committed response
        // as the alternate terminal path so this negative records disk changes.
        await gate.promise;
        await route.fulfill({ response, body });
        entry.delivered = true;
      } finally { await response.dispose(); }
    });
    other.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith(`/api/projects/${idFor(name)}/captions`)) captionPuts += 1;
    });

    try {
      const tools = other.getByRole('navigation', { name: 'Caption workspace tools', exact: true });
      if (endpoint === 'normalize-khmer-spacing') {
        await tools.getByRole('button', { name: 'Caption grouping', exact: true }).click();
        await other.getByRole('button', { name: 'Clean Khmer spacing', exact: true }).click();
      } else {
        await tools.getByRole('button', { name: /^Review/ }).click();
        await other.locator('.advanced-review-tools > summary').click();
        await other.getByRole('button', { name: 'Fix safe timing', exact: true }).click();
        await other.getByRole('alertdialog', { name: 'Apply safe timing cleanup?', exact: true })
          .getByRole('button', { name: 'Apply cleanup', exact: true }).click();
      }
      await expect.poll(() => reads.length > 0 || cleanups.some((entry) => entry.status !== undefined)).toBe(true);
      // Review filters out approved c1. Return to the full caption list before
      // editing, while the actual cleanup decision remains held by the gate.
      if (endpoint === 'postprocess-timing') await tools.getByRole('button', { name: /^Review/ }).click();
      const local = `សេចក្ដីព្រាង B ${endpoint}\nKEEP THIS NEW THIRD CAPTION`;
      await captionField(other, 3).fill(local);
      evidence.editorWhileDecisionHeld = await editorEvidence(other, name);
      expect(captionPuts).toBe(0);
      gate.resolve();
      await expect.poll(async () => cleanups.some((entry) => entry.delivered) || await conflict(other).isVisible()).toBe(true);
      await expect(other.getByText(busyLabel, { exact: true })).toHaveCount(0);
      const after = await disk(name);
      const afterHistory = await history(name);
      const retained = await editorEvidence(other, name);
      evidence.afterCleanupAttempt = after;
      evidence.historyAfterCleanupAttempt = afterHistory;
      evidence.retainedEditor = retained;

      // Assert the real transaction boundary before the notice: an unfixed
      // cleanup can mutate revision/timing/History even if wording is unchanged.
      expect(after).toEqual(canonical);
      expect(afterHistory).toEqual(canonicalHistory);
      expect(cleanups).toHaveLength(0);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toEqual({ status: 200, project: canonical });
      expect(retained.texts).toEqual([original.captions[0].text, original.captions[1].text, local]);
      const expectedDraft = editable(original.captions.map((caption) => caption.id === 'c3' ? { ...caption, text: local } : caption));
      expect(retained.recovery).toHaveLength(1);
      expect(retained.recovery[0].captions).toEqual(expectedDraft);
      expect(JSON.parse(retained.recovery[0].basis.captions)[2].map((caption: unknown[]) => caption[1]))
        .toEqual(original.captions.map((caption) => caption.text));
      await expect(conflict(other)).toBeVisible();
      await expect(other.locator('.save-action')).toBeDisabled();
      await captionField(other, 3).blur();
      await other.keyboard.press('Control+s');
      await other.clock.fastForward(61_000);
      await settledFrame(other);
      expect(captionPuts).toBe(0);
      expect(reads).toHaveLength(1);
      expect(cleanups).toHaveLength(0);
      const downloaded = await downloadDraft(other, 'Download edits');
      expect(downloaded.captions).toEqual(expectedDraft);
      evidence.downloadedDraft = downloaded;
      expect(await disk(name)).toEqual(canonical);
      expect(await history(name)).toEqual(canonicalHistory);
    } finally {
      gate.resolve();
      evidence.projectReads = reads;
      evidence.cleanupRequests = cleanups;
      evidence.ordinaryCaptionPutCount = captionPuts;
      const evidencePath = testInfo.outputPath('cleanup-preflight-before-after.json');
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
      await testInfo.attach('cleanup-preflight-before-after.json', { path: evidencePath, contentType: 'application/json' });
    }
  });
}
