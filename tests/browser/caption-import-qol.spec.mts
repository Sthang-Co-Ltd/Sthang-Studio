import { test as base, expect, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, parseCaptionData, type CaptionSegment, type ProcessingJob } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let restoreCalls: number;
let restoreGate: Promise<void> | null;
const revision = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const blocked = 'Wait for caption processing to finish before replacing captions.';
const current = () => state.projects[0];
const captionOutput = (page: Page) => page.getByRole('button', { name: /Captions file/ });
const replace = (page: Page) => page.getByRole('button', { name: 'Replace captions', exact: true });
const preview = (page: Page) => page.locator('.caption-restore-review');

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  restoreCalls = 0;
  restoreGate = null;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/caption-handoff/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (action === 'export-history') return route.fulfill({ json: [] });
    if (action === 'summary') return route.fulfill({ json: { revision, captionCount: current().captions.length,
      snapshot: createCaptionData({ captions: hydrateCaptionWordTimings(current()).captions, appearance: current().captionAppearance, durationMs: 4000 }),
      media: { filename: current().media.filename, size: current().media.size } } });
    const body = route.request().postDataJSON();
    if (body.expectedRevision !== revision || body.expectedMedia.filename !== current().media.filename || body.expectedMedia.size !== current().media.size) {
      return route.fulfill({ status: 409, json: { error: 'Stale synthetic import.' } });
    }
    const candidate = parseCaptionData(body.data);
    if (action === 'restore-preview') return route.fulfill({ json: { revision, candidateDigest: digest, candidate, warnings: [] } });
    if (action === 'restore') {
      restoreCalls++;
      if (body.confirmed !== true || body.expectedCandidateDigest !== digest) return route.fulfill({ status: 428, json: { error: 'Unconfirmed synthetic import.' } });
      if (restoreGate) await restoreGate;
      current().captions = candidate.captions.map((caption, index) => ({ ...caption, id: `restored-${index}`, approved: false })) as CaptionSegment[];
      current().transcriptNeedsSync = true;
      return route.fulfill({ json: current() });
    }
    return route.fulfill({ status: 404, json: { error: 'Unknown synthetic import action.' } });
  });
});

function job(type: ProcessingJob['type']): ProcessingJob {
  return { id: 'active-import-job', type, projectId: 'landscape', projectTitle: 'Audit landscape', status: 'running', stage: 'working',
    progress: 40, message: 'Synthetic work in progress.', canResume: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
}
function file() {
  return { name: 'review.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createCaptionData({
    captions: [{ id: 'import-source', text: 'Imported ខ្មែរ caption', startMs: 400, endMs: 1700 }], durationMs: 4000,
  }))) };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openImport(page: Page) {
  await openProject(page);
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__importQolNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await captionOutput(page).click();
  await page.locator('.handoff-advanced > summary').click();
  await page.locator('.handoff-restore input[type=file]').setInputFiles(file());
  await expect(page.getByRole('heading', { name: 'Review caption import', exact: true })).toBeFocused();
}
async function expectNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__importQolNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}

test('caption processing explains the blocked replacement, then cancellation clears only that prerequisite', async ({ page }, info) => {
  state.jobs = [job('transcribe')];
  const before = structuredClone(current().captions);
  await openImport(page);
  await expect(replace(page)).toBeDisabled();
  await expect(replace(page)).toHaveAccessibleDescription(blocked);
  const reason = preview(page).getByText(blocked, { exact: true });
  await expect(reason).toBeVisible();
  expect(await replace(page).getAttribute('aria-describedby')).toBe(await reason.getAttribute('id'));
  await expect(page.getByRole('button', { name: 'Keep current captions', exact: true })).toBeEnabled();
  await replace(page).evaluate((button: HTMLButtonElement) => button.click());
  expect(restoreCalls).toBe(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await reason.scrollIntoViewIfNeeded();
    expect(await preview(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('caption-import-processing-' + width + '.png') });
  }
  state.jobs[0] = { ...state.jobs[0], status: 'cancelled', updatedAt: '2026-01-02' };
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await expect(replace(page)).toBeEnabled();
  await expect(reason).toHaveCount(0);
  expect(await replace(page).getAttribute('aria-describedby')).toBeNull();
  await expect(preview(page)).toContainText('Imported ខ្មែរ caption');
  expect(restoreCalls).toBe(0);
  expect(current().captions).toEqual(before);
  await expectNodes(page);
});

test('a video export stays independent and a confirmed delayed import keeps useful focus through completion', async ({ page }) => {
  state.jobs = [job('export-video')];
  const gate = deferred();
  restoreGate = gate.promise;
  const appearance = structuredClone(current().captionAppearance);
  await openImport(page);
  await expect(replace(page)).toBeEnabled();
  await expect(preview(page).getByText(blocked, { exact: true })).toHaveCount(0);
  try {
    await replace(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => restoreCalls).toBe(1);
    await expect(captionOutput(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Replacing…', exact: true })).toBeDisabled();
    gate.release();
    await expect(preview(page)).toHaveCount(0);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Imported ខ្មែរ caption');
    await expect(captionOutput(page)).toBeFocused();
    expect(current().captionAppearance).toEqual(appearance);
    expect(current().captions[0].approved).toBe(false);
    expect(restoreCalls).toBe(1);
    await expectNodes(page);
  } finally { gate.release(); }
});

test('Keep current captions preserves a newer draft and returns keyboard focus without scrolling caption evidence', async ({ page }) => {
  await openImport(page);
  const before = structuredClone(current().captions);
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic draft remains unsaved' } }));
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Keep this newer draft កម្ពុជា');
  await expect(replace(page)).toBeDisabled();
  const keep = page.getByRole('button', { name: 'Keep current captions', exact: true });
  await keep.focus();
  const scrollBefore = await page.locator('.caption-list').evaluate((node) => node.scrollTop);
  await page.keyboard.press('Enter');
  await expect(preview(page)).toHaveCount(0);
  await expect(captionOutput(page)).toBeFocused();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Keep this newer draft កម្ពុជា');
  expect(await page.locator('.caption-list').evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, 0);
  expect(current().captions).toEqual(before);
  expect(restoreCalls).toBe(0);
  await expectNodes(page);
});

test('a late import response never takes focus from newer Accuracy editing', async ({ page }) => {
  const gate = deferred();
  restoreGate = gate.promise;
  await openImport(page);
  try {
    await replace(page).click();
    await expect.poll(() => restoreCalls).toBe(1);
    await expect(captionOutput(page)).toBeFocused();
    await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
    const context = page.locator('#accuracy-context-description');
    await context.fill('Newer context draft កម្ពុជា');
    gate.release();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Imported ខ្មែរ caption');
    await expect(context).toBeFocused();
    await expect(context).toHaveValue('Newer context draft កម្ពុជា');
    await expect(page.getByRole('complementary', { name: 'Accuracy workspace', exact: true })).toBeVisible();
    expect(restoreCalls).toBe(1);
    await expectNodes(page);
  } finally { gate.release(); }
});
