import { test, expect, type Page, type Response } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject, CaptionProjectSummary, RegenerationProposal } from '@kcs/shared';
import { prepareOwnedStateRoot, requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';
import { cleanupOwnedApiClients, startOwnedApi, stopOwnedApi, type OwnedApi } from './owned-api-harness.mjs';
import { closeOwnedBrowserContext, continueOwnedRoute, fetchOwnedRoute, installBrowserNetworkGuard } from './owned-browser-routes.mjs';

const harness = requireHarnessConfig();
const cases = ['captions', 'context', 'queued', 'sequential', 'disjoint', 'appearance', 'restored-appearance', 'restored-context-foreign', 'restored-captions-foreign', 'proposal', 'proposal-accept', 'storage'] as const;
type Case = typeof cases[number];
const idFor = (name: Case) => `disk-stale-${name}`;
const titleFor = (name: Case) => `Stale save ${name} authority`;
const fixtures = new Map<Case, CaptionProject>();
let root = '';
let server: OwnedApi | null = null;
let detachChildExit: (() => void) | null = null;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  root = await prepareOwnedStateRoot(harness, 'stale-save-state-');
  const uploads = path.join(root, 'uploads');
  const projects = path.join(root, 'data', 'projects');
  await Promise.all([fs.mkdir(uploads, { recursive: true }), fs.mkdir(projects, { recursive: true })]);
  const media = path.join(uploads, 'stale-save-source.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=0x204060:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media,
  ], { timeout: 30_000, windowsHide: true });
  const mediaStat = await fs.stat(media);
  for (const name of cases) {
    const id = idFor(name);
    const value: CaptionProject = {
      id, title: titleFor(name), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: mediaStat.size, url: `/media/${id}.mp4` },
      mode: 'phrase', transcript: null, engineVersion: '0.7.10',
      transcriptionContext: { description: 'Original saved description', vocabulary: ['OriginalBrand | original alias'] },
      captions: [
        { id: 'c1', startMs: 200, endMs: 1200, text: 'ORIGINAL FIRST CAPTION', approved: false, textLocked: false, timingLocked: false },
        { id: 'c2', startMs: 1500, endMs: 2800, text: 'ORIGINAL SECOND CAPTION', approved: false, textLocked: false, timingLocked: false },
      ],
    };
    fixtures.set(name, value);
    await fs.copyFile(media, path.join(uploads, value.media.filename));
    await fs.writeFile(path.join(projects, `${id}.json`), `${JSON.stringify(value)}\n`, 'utf8');
  }
  await fs.writeFile(path.join(projects, 'order.json'), JSON.stringify(cases.map(idFor)), 'utf8');
  await fs.writeFile(path.join(projects, '.per-project-v1'), 'fixture\n', 'utf8');
  server = await startOwnedApi(root);
});

test.afterAll(async () => {
  // Retain state after unconfirmed startup/exit, following the owned API harness.
  if (server) {
    await stopOwnedApi(server);
    await fs.rm(verifyOwnedStateRoot(root, harness), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test.beforeEach(async ({ context }) => {
  test.setTimeout(60_000);
  await installBrowserNetworkGuard(context, harness);
  if (!server) throw new Error('Owned stale-save API is not ready.');
  const owned = server;
  owned.assertAlive();
  const abortPages = () => {
    for (const page of context.pages()) void page.close({ reason: 'Owned synthetic API exited.' }).catch(() => {});
  };
  owned.child.once('exit', abortPages);
  detachChildExit = () => owned.child.off('exit', abortPages);
  owned.assertAlive();
});

test.afterEach(async ({ context }) => {
  try {
    await cleanupOwnedApiClients(server, [
      async () => {
        for (const page of context.pages()) {
          if (!page.isClosed()) {
            page.once('dialog', async (dialog) => {
              expect(dialog.type()).toBe('beforeunload');
              await dialog.accept();
            });
            await page.goto('about:blank');
          }
        }
      },
      () => closeOwnedBrowserContext(context),
    ]);
  } finally {
    detachChildExit?.();
    detachChildExit = null;
  }
});

async function preparePage(page: Page, name: Case) {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: {
    provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
    secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
  } }));
  // Home exposes six recent entries. Filter its real summary response to this
  // case; project reads, saves, revision locks and History remain the real API.
  await page.route('**/api/projects?summary=1', async (route) => {
    const response = await fetchOwnedRoute(route);
    try {
      expect(response.status()).toBe(200);
      const summaries = await response.json() as CaptionProjectSummary[];
      await route.fulfill({ response, json: summaries.filter((item) => item.id === idFor(name)) });
    } finally { await response.dispose(); }
  });
}

async function open(page: Page, name: Case) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
  await expect(page.locator('video')).toHaveAttribute('src', `/media/${idFor(name)}.mp4`);
}

async function clients(page: Page, name: Case) {
  const other = await page.context().newPage();
  await preparePage(page, name);
  await preparePage(other, name);
  await open(page, name);
  await open(other, name);
  return other;
}

const captionField = (page: Page, index = 1) => page.getByLabel(`Caption ${index} text`, { exact: true });
const conflict = (page: Page) => page.locator('.save-failure').filter({ hasText: 'Saved project changed.' });
const isPut = (response: Response, name: Case, field: 'captions' | 'context') => response.url().endsWith(`/api/projects/${idFor(name)}/${field}`) && response.request().method() === 'PUT';
async function disk(name: Case): Promise<CaptionProject> {
  return JSON.parse(await fs.readFile(path.join(root, 'data', 'projects', `${idFor(name)}.json`), 'utf8'));
}
async function history(name: Case) {
  const directory = path.join(root, 'data', 'history', idFor(name));
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return Promise.all(names.sort().map(async (name) => [name, await fs.readFile(path.join(directory, name), 'utf8')]));
}
async function settledFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function saveCaption(page: Page, name: Case, text: string, index = 1) {
  await captionField(page, index).fill(text);
  const response = page.waitForResponse((value) => isPut(value, name, 'captions'));
  await page.keyboard.press('Control+s');
  expect((await response).status()).toBe(200);
  await expect(page.locator('.save-action')).toBeDisabled();
  await expect(page.locator('.save-action')).toHaveText('Saved');
}
async function accuracy(page: Page) {
  const button = page.getByRole('button', { name: /^Accuracy/ });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  return {
    description: page.getByLabel('What is this clip about?', { exact: true }),
    vocabulary: page.getByLabel('Exact terms to preserve', { exact: true }),
  };
}
async function saveContext(page: Page, name: Case, text: string) {
  const fields = await accuracy(page);
  await fields.description.fill(text);
  const response = page.waitForResponse((value) => isPut(value, name, 'context'));
  await page.keyboard.press('Control+s');
  expect((await response).status()).toBe(200);
  await expect(page.locator('.save-action')).toHaveText('Saved');
}
function traffic(page: Page, name: Case) {
  const counts = { reads: 0, captions: 0, context: 0 };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === `/api/projects/${idFor(name)}`) counts.reads += 1;
    if (request.method() === 'PUT' && url.pathname === `/api/projects/${idFor(name)}/captions`) counts.captions += 1;
    if (request.method() === 'PUT' && url.pathname === `/api/projects/${idFor(name)}/context`) counts.context += 1;
  });
  return counts;
}
async function downloadEdits(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download edits', exact: true }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('sthang-unfinished-draft.json');
  const filename = await file.path();
  if (!filename) throw new Error('Local draft download did not produce a file.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function restoreBothFields(page: Page, name: Case) {
  const caption = `RECOVERED CAPTION FOR ${name}`;
  const description = `RECOVERED ACCURACY FOR ${name}`;
  await page.clock.install();
  const fields = await accuracy(page);
  await fields.description.fill(description);
  await captionField(page).fill(caption);
  await expect.poll(() => page.evaluate(({ caption, description }) => Object.keys(localStorage).some((key) => {
    const raw = localStorage.getItem(key);
    return key.startsWith('sthang-studio:unfinished-edits:') && !!raw && raw.includes(caption) && raw.includes(description);
  }), { caption, description })).toBe(true);
  const savedBeforeReload = await disk(name);
  expect(savedBeforeReload.captions).toEqual(fixtures.get(name)!.captions);
  expect(savedBeforeReload.transcriptionContext).toEqual(fixtures.get(name)!.transcriptionContext);
  page.once('dialog', async (dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  const notice = page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
  await expect(notice.getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await notice.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(captionField(page)).toHaveValue(caption);
  await expect((await accuracy(page)).description).toHaveValue(description);
  return { caption, description };
}

test('two real clients keep a stale caption local, stop retries, and preserve a conflicting recovery after reload', async ({ page }) => {
  const name = 'captions';
  const other = await clients(page, name);
  await other.clock.install();
  const counts = traffic(other, name);
  await saveCaption(page, name, 'WINNING CAPTION FROM CLIENT A');
  const canonical = await disk(name);
  const checkpoints = await history(name);
  const local = '  សេចក្ដីព្រាង B នៅទីនេះ  \nsecond local line';
  await captionField(other).fill(local);
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  await expect(captionField(other)).toHaveValue(local);
  await expect(other.locator('.save-action')).toBeDisabled();
  await expect(other.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
  expect(counts.captions).toBe(0, 'the stale preflight must never submit an overwriting PUT');
  const stopped = { ...counts };
  await captionField(other).blur();
  await other.keyboard.press('Control+s');
  await other.clock.fastForward(61_000);
  await settledFrame(other);
  expect(counts).toEqual(stopped);
  expect(await disk(name)).toEqual(canonical);
  expect(await history(name)).toEqual(checkpoints);
  const copy = await downloadEdits(other);
  expect(copy.captions[0].text).toBe(local);

  other.once('dialog', async (dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); });
  await other.getByRole('button', { name: 'Reload saved project', exact: true }).click();
  await other.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  await expect(captionField(other)).toHaveValue(canonical.captions[0].text);
  const recovery = other.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Restore draft', exact: true }).and(recovery.locator('button:enabled'))).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Download draft', exact: true })).toBeEnabled();
  expect(await disk(name)).toEqual(canonical);
  expect(await history(name)).toEqual(checkpoints);
});

test('two real clients preserve exact raw Accuracy fields after a conflicting save', async ({ page }) => {
  const name = 'context';
  const other = await clients(page, name);
  const counts = traffic(other, name);
  await saveContext(page, name, 'WINNING ACCURACY DESCRIPTION FROM CLIENT A');
  const canonical = await disk(name);
  const fields = await accuracy(other);
  const description = '  សេចក្ដីពណ៌នា B\nបន្ទាត់ទីពីរ  ';
  const vocabulary = '  TS១១ | alias \n\n Brand | B alias  ';
  await fields.description.fill(description);
  await fields.vocabulary.fill(vocabulary);
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  await expect(fields.description).toHaveValue(description);
  await expect(fields.vocabulary).toHaveValue(vocabulary);
  await expect(other.getByRole('button', { name: 'Save for project', exact: true })).toBeDisabled();
  const stopped = { ...counts };
  await other.keyboard.press('Control+s');
  await fields.vocabulary.blur();
  await settledFrame(other);
  expect(counts).toEqual(stopped);
  expect(counts.context).toBe(0);
  const copy = await downloadEdits(other);
  expect(copy.accuracy).toEqual({ description, vocabulary });
  expect(await disk(name)).toEqual(canonical);
});

test('a real 409 after preflight cancels the caption callback already queued behind it', async ({ page }) => {
  const name = 'queued';
  const other = await clients(page, name);
  const gate = deferred();
  let requests = 0;
  await other.route(`**/api/projects/${idFor(name)}/captions`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    requests += 1;
    if (requests === 1) await gate.promise;
    await continueOwnedRoute(route);
  });
  try {
    await captionField(other).fill('FIRST CLIENT B SAVE WAITS AFTER PREFLIGHT');
    await other.keyboard.press('Control+s');
    await expect.poll(() => requests).toBe(1);
    await captionField(other).fill('NEWER CLIENT B TYPING QUEUED BEHIND THE FIRST SAVE');
    await captionField(other).blur();
    await settledFrame(other);
    expect(requests).toBe(1);
    await saveCaption(page, name, 'CLIENT A WINS WHILE B PUT IS HELD');
    const canonical = await disk(name);
    const checkpoints = await history(name);
    const response = other.waitForResponse((value) => isPut(value, name, 'captions'));
    gate.resolve();
    expect((await response).status()).toBe(409);
    await expect(conflict(other)).toBeVisible();
    await settledFrame(other);
    expect(requests).toBe(1, 'the already queued stale caption callback must not send another PUT');
    await expect(captionField(other)).toHaveValue('NEWER CLIENT B TYPING QUEUED BEHIND THE FIRST SAVE');
    const frozenDraft = await other.evaluate((projectId) => Object.keys(localStorage)
      .filter((key) => key.startsWith('sthang-studio:unfinished-edits:v1:'))
      .map((key) => JSON.parse(localStorage.getItem(key)!))
      .find((entry) => entry.projectId === projectId
        && entry.captions?.[0]?.text === 'NEWER CLIENT B TYPING QUEUED BEHIND THE FIRST SAVE'), idFor(name));
    expect(frozenDraft).toBeDefined();
    const original = fixtures.get(name)!;
    expect(JSON.parse(frozenDraft.basis.captions)[2].map((caption: unknown[]) => caption[1]))
      .toEqual(original.captions.map((caption) => caption.text));

    // Returning to this client's original text is still a conflict with A's
    // saved caption. Keep a comparison draft instead of clearing it as clean.
    await captionField(other).fill(original.captions[0].text);
    await captionField(other).blur();
    await settledFrame(other);
    expect(requests).toBe(1);
    await expect(conflict(other)).toBeVisible();
    await expect(captionField(other)).toHaveValue(original.captions[0].text);
    const currentDraft = await other.evaluate(({ projectId, ownerId }) => Object.keys(localStorage)
      .filter((key) => key.startsWith('sthang-studio:unfinished-edits:v1:'))
      .map((key) => JSON.parse(localStorage.getItem(key)!))
      .find((entry) => entry.projectId === projectId && entry.ownerId === ownerId),
    { projectId: idFor(name), ownerId: frozenDraft.ownerId });
    expect(currentDraft).toBeDefined();
    expect(currentDraft.captions).toEqual(original.captions.map(({ id, text, startMs, endMs, textLocked, timingLocked }) => ({
      id, text, startMs, endMs, textLocked: Boolean(textLocked), timingLocked: Boolean(timingLocked),
    })));
    expect(currentDraft.basis).toEqual(frozenDraft.basis);
    expect(await disk(name)).toEqual(canonical);
    expect(await history(name)).toEqual(checkpoints);
  } finally { gate.resolve(); }
});

test('same-client queued saves retain newer typing and use the preceding acknowledgement', async ({ page }) => {
  const name = 'sequential';
  await preparePage(page, name);
  await open(page, name);
  const acknowledgement = deferred();
  const writes: Array<{ expectedUpdatedAt: string; captions: Array<{ text: string }> }> = [];
  let firstPersisted: CaptionProject | null = null;
  await page.route(`**/api/projects/${idFor(name)}/captions`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes.push(route.request().postDataJSON());
    const response = await fetchOwnedRoute(route);
    try {
      const body = await response.body();
      if (writes.length === 1) {
        firstPersisted = JSON.parse(body.toString()).project as CaptionProject;
        await acknowledgement.promise;
      }
      await route.fulfill({ response, body });
    } finally { await response.dispose(); }
  });
  try {
    await captionField(page).fill('FIRST OWN SAVE');
    await page.keyboard.press('Control+s');
    await expect.poll(() => firstPersisted !== null).toBe(true);
    await captionField(page).fill('NEWER OWN TYPING MUST SURVIVE THE OLD ACK');
    await captionField(page).blur();
    await settledFrame(page);
    expect(writes).toHaveLength(1);
    expect((await disk(name)).captions[0].text).toBe('FIRST OWN SAVE');
    await expect(captionField(page)).toHaveValue('NEWER OWN TYPING MUST SURVIVE THE OLD ACK');
    acknowledgement.resolve();
    await expect.poll(() => writes.length).toBe(2);
    await expect(page.locator('.save-action')).toHaveText('Saved');
    expect(writes[1].expectedUpdatedAt).toBe(firstPersisted!.updatedAt);
    expect((await disk(name)).captions[0].text).toBe('NEWER OWN TYPING MUST SURVIVE THE OLD ACK');
    await expect(conflict(page)).toHaveCount(0);
  } finally { acknowledgement.resolve(); }
});

test('disjoint caption and Accuracy writes succeed without laundering the other field baseline', async ({ page }) => {
  const name = 'disjoint';
  const other = await clients(page, name);
  await saveContext(page, name, 'FIRST CONTEXT FROM A');
  await saveCaption(other, name, 'CAPTION FROM B PRESERVES A CONTEXT');
  expect((await disk(name)).transcriptionContext?.description).toBe('FIRST CONTEXT FROM A');
  // This context ACK contains B captions, which A has never adopted.
  await saveContext(page, name, 'SECOND CONTEXT FROM A PRESERVES B CAPTION');
  const canonical = await disk(name);
  expect(canonical.captions[0].text).toBe('CAPTION FROM B PRESERVES A CONTEXT');
  const aCounts = traffic(page, name);
  await captionField(page).fill('STALE A CAPTION AFTER ITS CONTEXT ACK');
  await page.keyboard.press('Control+s');
  await expect(conflict(page)).toBeVisible();
  expect(aCounts.captions).toBe(0);
  // Conversely, B's caption ACK must not silently adopt A's Accuracy fields.
  const bCounts = traffic(other, name);
  const fields = await accuracy(other);
  await fields.description.fill('STALE B CONTEXT AFTER ITS CAPTION ACK');
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  expect(bCounts.context).toBe(0);
  expect(await disk(name)).toEqual(canonical);
});

test('a pending own appearance save completes before the caption revision check and write', async ({ page }) => {
  const name = 'appearance';
  await preparePage(page, name);
  await open(page, name);
  const counts = traffic(page, name);
  const acknowledgement = deferred();
  let appearancePersisted = false;
  await page.route(`**/api/video-export/${idFor(name)}/appearance`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const response = await fetchOwnedRoute(route);
    try {
      expect(response.status()).toBe(200);
      const body = await response.body();
      appearancePersisted = true;
      await acknowledgement.promise;
      await route.fulfill({ response, body });
    } finally { await response.dispose(); }
  });
  try {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
    await page.getByLabel(/^Size /).fill('88');
    await page.getByLabel(/^Size /).blur();
    await expect.poll(() => appearancePersisted).toBe(true);
    const readsBefore = counts.reads;
    await captionField(page).fill('CAPTION SAVED AFTER OWN APPEARANCE ACK');
    await page.keyboard.press('Control+s');
    await settledFrame(page);
    expect(counts.reads).toBe(readsBefore, 'preflight must wait for the reserved appearance lane');
    expect(counts.captions).toBe(0);
    acknowledgement.resolve();
    await expect(page.locator('.save-action')).toHaveText('Saved');
    const saved = await disk(name);
    expect(saved.captions[0].text).toBe('CAPTION SAVED AFTER OWN APPEARANCE ACK');
    expect(saved.captionAppearance?.fontSize1080).toBe(88);
    await expect(conflict(page)).toHaveCount(0);
  } finally { acknowledgement.resolve(); }
});

test('a restored caption draft accepts an unrelated Appearance revision without becoming new correction evidence', async ({ page }) => {
  const name = 'restored-appearance';
  await preparePage(page, name);
  await open(page, name);
  const original = fixtures.get(name)!;
  const local = 'សេចក្ដីព្រាងមុនប្ដូររូបរាង';
  await captionField(page).fill(local);
  await expect.poll(() => page.evaluate((value) => Object.keys(localStorage).some((key) =>
    key.startsWith('sthang-studio:unfinished-edits:') && localStorage.getItem(key)?.includes(value)), local)).toBe(true);
  page.once('dialog', async (dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  const notice = page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
  await expect(notice.getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await page.clock.install();
  await notice.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(captionField(page)).toHaveValue(local);

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByLabel(/^Size /).fill('88');
  await page.getByLabel(/^Size /).blur();
  await page.clock.fastForward(1_000);
  await expect.poll(async () => {
    const current = await disk(name);
    return current.captionAppearance?.fontSize1080 === 88 ? current : null;
  }).not.toBeNull();
  const revised = await disk(name);
  expect(revised.updatedAt).not.toBe(original.updatedAt);
  expect(revised.captions).toEqual(original.captions);

  let savedPayload: { expectedUpdatedAt: string; recoveryExpectedUpdatedAt?: string; recordCorrections?: boolean } | null = null;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(`/api/projects/${idFor(name)}/captions`)) {
      savedPayload = request.postDataJSON();
    }
  });
  const saveResponse = page.waitForResponse((response) => isPut(response, name, 'captions'));
  await page.keyboard.press('Control+s');
  expect((await saveResponse).status()).toBe(200);
  await expect(page.locator('.save-action')).toHaveText('Saved');
  expect(savedPayload).toMatchObject({ expectedUpdatedAt: revised.updatedAt, recoveryExpectedUpdatedAt: revised.updatedAt, recordCorrections: false });
  const saved = await disk(name);
  expect(saved.captions[0]).toMatchObject({ text: local, approved: false });
  expect((await history(name)).length).toBeGreaterThan(0);
  await expect(conflict(page)).toHaveCount(0);
});

test('recovered caption acknowledgement cannot adopt another client’s Accuracy edit', async ({ page }) => {
  const name = 'restored-context-foreign';
  const other = await clients(page, name);
  const draft = await restoreBothFields(other, name);
  await saveContext(page, name, 'FOREIGN ACCURACY SAVED BY CLIENT A');
  const counts = traffic(other, name);
  const captionResponse = other.waitForResponse((response) => isPut(response, name, 'captions'));
  await other.keyboard.press('Control+s');
  expect((await captionResponse).status()).toBe(200);
  await expect(conflict(other)).toBeVisible();
  expect(counts.captions).toBe(1);
  expect(counts.context).toBe(0, 'the caption ACK must not authorize overwriting foreign Accuracy');
  const current = await disk(name);
  expect(current.captions[0].text).toBe(draft.caption);
  expect(current.transcriptionContext?.description).toBe('FOREIGN ACCURACY SAVED BY CLIENT A');
  await expect((await accuracy(other)).description).toHaveValue(draft.description);
  await expect(other.locator('.save-action')).toBeDisabled();
});

test('recovered Accuracy acknowledgement cannot adopt another client’s captions', async ({ page }) => {
  const name = 'restored-captions-foreign';
  const other = await clients(page, name);
  const draft = await restoreBothFields(other, name);
  await saveCaption(page, name, 'FOREIGN CAPTION SAVED BY CLIENT A');
  const counts = traffic(other, name);
  const contextResponse = other.waitForResponse((response) => isPut(response, name, 'context'));
  await (await accuracy(other)).description.blur();
  await other.getByRole('button', { name: 'Save for project', exact: true }).click();
  expect((await contextResponse).status()).toBe(200);
  expect(counts.context).toBe(1);
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  expect(counts.captions).toBe(0, 'the Accuracy ACK must not authorize overwriting foreign captions');
  const current = await disk(name);
  expect(current.captions[0].text).toBe('FOREIGN CAPTION SAVED BY CLIENT A');
  expect(current.transcriptionContext?.description).toBe(draft.description);
  await expect(captionField(other)).toHaveValue(draft.caption);
  await expect(other.locator('.save-action')).toBeDisabled();
});

test('discarding a proposal cannot lend a foreign caption revision to an ordinary failed draft', async ({ page }) => {
  const name = 'proposal';
  const other = await clients(page, name);
  const original = fixtures.get(name)!;
  const proposal: RegenerationProposal = {
    id: 'stale-save-proposal', projectId: original.id, projectTitle: original.title,
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    startMs: 200, endMs: 1200, lockedCaptionsPreserved: 0, unchangedCount: 1,
    changes: [], currentCaptions: [original.captions[0]], proposedCaptions: [original.captions[0]], passNumber: 1, strategy: 'standard',
  };
  await other.route('**/api/jobs', (route) => route.fulfill({ json: [{
    id: 'stale-save-completed-proposal', type: 'regenerate-range', projectId: original.id, projectTitle: original.title,
    status: 'completed', stage: 'completed', progress: 100, message: 'Synthetic proposal ready', canResume: false,
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, completedAt: proposal.createdAt, proposalId: proposal.id,
  }] }));
  await other.route(`**/api/projects/${original.id}/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));
  let rejected = 0;
  await other.route(`**/api/projects/${original.id}/regeneration-proposals/${proposal.id}/apply`, async (route) => {
    expect(route.request().postDataJSON().mode).toBe('reject');
    rejected += 1;
    // The proposal is a synthetic UI offer. Its rejection reports the actual
    // unchanged disk project, including the other client's real caption write.
    await route.fulfill({ json: await disk(name) });
  });
  // Refresh the existing page while still clean so Activity discovers this offer.
  await other.reload();
  await other.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  await other.getByLabel('Open project tools', { exact: true }).click();
  await other.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await other.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  const dock = other.getByRole('region', { name: 'Live regeneration review', exact: true });
  await expect(dock).toBeVisible();
  let failedWrites = 0;
  let failWrites = true;
  await other.route(`**/api/projects/${original.id}/captions`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    if (failWrites) {
      failedWrites += 1;
      return route.fulfill({ status: 503, json: { error: 'Synthetic temporary caption storage failure' } });
    }
    await continueOwnedRoute(route);
  });
  await captionField(other).fill('ORDINARY FAILED DRAFT MUST KEEP ITS ORIGINAL BASIS');
  // Blur into an unchanged caption while the temporary failure still holds.
  // Clicking the proposal decision later therefore cannot first commit text.
  await captionField(other, 2).focus();
  await expect.poll(() => failedWrites).toBe(1);
  await expect(other.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await saveCaption(page, name, 'FOREIGN SECOND CAPTION FROM A', 2);
  const canonical = await disk(name);
  await dock.getByRole('button', { name: 'Keep current', exact: true }).click();
  await expect(dock).toHaveCount(0);
  expect(rejected).toBe(1);
  await expect(captionField(other)).toHaveValue('ORDINARY FAILED DRAFT MUST KEEP ITS ORIGINAL BASIS');
  await expect(captionField(other, 2)).toHaveValue(original.captions[1].text);
  failWrites = false;
  const counts = traffic(other, name);
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  expect(counts.captions).toBe(0, 'the unrelated full-project reply cannot authorize this whole-list overwrite');
  expect(await disk(name)).toEqual(canonical);
});

test('accepting a caption mutation keeps newer typing but prevents its stale full-list save', async ({ page }) => {
  const name = 'proposal-accept';
  const other = await clients(page, name);
  const original = fixtures.get(name)!;
  const proposal: RegenerationProposal = {
    id: 'stale-save-accepted-proposal', projectId: original.id, projectTitle: original.title,
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    startMs: 1500, endMs: 2800, lockedCaptionsPreserved: 0, unchangedCount: 1,
    changes: [], currentCaptions: [original.captions[1]], proposedCaptions: [original.captions[1]], passNumber: 1, strategy: 'standard',
  };
  await other.route('**/api/jobs', (route) => route.fulfill({ json: [{
    id: 'stale-save-accepted-job', type: 'regenerate-range', projectId: original.id, projectTitle: original.title,
    status: 'completed', stage: 'completed', progress: 100, message: 'Synthetic proposal ready', canResume: false,
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, completedAt: proposal.createdAt, proposalId: proposal.id,
  }] }));
  await other.route(`**/api/projects/${original.id}/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));
  let accepted = 0;
  await other.route(`**/api/projects/${original.id}/regeneration-proposals/${proposal.id}/apply`, async (route) => {
    expect(route.request().postDataJSON().mode).toBe('all');
    accepted += 1;
    // A real guarded write from client A represents the accepted committed
    // result; this controlled proposal reply uses that exact saved snapshot.
    await route.fulfill({ json: await disk(name) });
  });
  await other.reload();
  await other.getByRole('button', { name: new RegExp(titleFor(name)) }).click();
  await other.getByLabel('Open project tools', { exact: true }).click();
  await other.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await other.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  const dock = other.getByRole('region', { name: 'Live regeneration review', exact: true });
  await expect(dock).toBeVisible();
  let failedWrites = 0;
  await other.route(`**/api/projects/${original.id}/captions`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    failedWrites += 1;
    await route.fulfill({ status: 503, json: { error: 'Synthetic temporary storage failure' } });
  });
  const local = 'NEWER TYPING MUST NOT ERASE AN ACCEPTED PROPOSAL';
  await captionField(other).fill(local);
  await captionField(other, 2).focus();
  await expect.poll(() => failedWrites).toBe(1);
  await saveCaption(page, name, 'ACCEPTED SECOND CAPTION FROM COMMITTED RESULT', 2);
  const canonical = await disk(name);
  await dock.getByRole('button', { name: 'Accept proposed range', exact: true }).click();
  await expect(dock).toHaveCount(0);
  expect(accepted).toBe(1);
  await expect(conflict(other)).toBeVisible();
  await expect(captionField(other)).toHaveValue(local);
  await expect(captionField(other, 2)).toHaveValue(original.captions[1].text);
  await expect(other.locator('.save-action')).toBeDisabled();
  const counts = traffic(other, name);
  await other.keyboard.press('Control+s');
  await settledFrame(other);
  expect(counts.captions).toBe(0, 'a retained whole-list draft cannot overwrite accepted saved captions');
  expect(await disk(name)).toEqual(canonical);
  const copy = await downloadEdits(other);
  expect(copy.captions[0].text).toBe(local);
});

test('unavailable browser recovery requires a deliberate reload decision and Cancel preserves the conflicting draft', async ({ page }) => {
  const name = 'storage';
  const other = await clients(page, name);
  await other.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('sthang-studio:unfinished-edits:')) throw new DOMException('Synthetic storage quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await saveCaption(page, name, 'SAVED A CAPTION WHILE B RECOVERY IS UNAVAILABLE');
  const canonical = await disk(name);
  const local = 'B DRAFT EXISTS ONLY IN THIS OPEN EDITOR';
  await captionField(other).fill(local);
  await other.keyboard.press('Control+s');
  await expect(conflict(other)).toBeVisible();
  await other.getByRole('button', { name: 'Reload saved project', exact: true }).click();
  const confirmation = other.getByRole('alertdialog', { name: 'Reload without a recovery copy?', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Reload anyway', exact: true })).toBeVisible();
  await confirmation.locator('.studio-confirm-cancel').click();
  await expect(confirmation).toHaveCount(0);
  await expect(captionField(other)).toHaveValue(local);
  await expect(conflict(other)).toBeVisible();
  expect(await disk(name)).toEqual(canonical);
  expect(await other.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
});
