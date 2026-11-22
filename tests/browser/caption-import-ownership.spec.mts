import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, parseCaptionData, type CaptionSegment } from '../../packages/shared/src/index.js';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let previewGate: ReturnType<typeof deferred> | null;
let restoreGate: ReturnType<typeof deferred> | null;
let previewCalls: number;
let previewResponses: number;
let restoreCalls: number;
const revision = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const current = () => state.projects[0];
const captionsMode = (page: Page) => page.getByRole('group', { name: 'Export type', exact: true }).getByRole('button', { name: /Captions file/ });
const videoMode = (page: Page) => page.getByRole('group', { name: 'Export type', exact: true }).getByRole('button', { name: /Captioned video/ });
const heading = (page: Page) => page.getByRole('heading', { name: 'Review caption import', exact: true });
const review = (page: Page) => page.locator('.caption-restore-review');
const checks = (page: Page) => page.getByRole('region', { name: 'Check before export', exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function file() {
  return { name: 'owned-preview.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createCaptionData({
    captions: [{ id: 'import-source', text: 'Imported ខ្មែរ caption', startMs: 400, endMs: 1700 }], durationMs: 4000,
  }))) };
}

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  previewGate = null; restoreGate = null; previewCalls = 0; previewResponses = 0; restoreCalls = 0;
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
    if (action === 'restore-preview') {
      previewCalls++;
      const gate = previewGate;
      if (gate) await gate.promise;
      await route.fulfill({ json: { revision, candidateDigest: digest, candidate, warnings: [] } });
      previewResponses++;
      return;
    }
    if (action === 'restore') {
      restoreCalls++;
      if (body.confirmed !== true || body.expectedCandidateDigest !== digest) return route.fulfill({ status: 428, json: { error: 'Unconfirmed synthetic import.' } });
      const gate = restoreGate;
      if (gate) await gate.promise;
      current().captions = candidate.captions.map((caption, index) => ({ ...caption, id: `restored-${index}`, approved: false })) as CaptionSegment[];
      current().transcriptNeedsSync = true;
      return route.fulfill({ json: current() });
    }
    return route.fulfill({ status: 404, json: { error: 'Unknown synthetic import action.' } });
  });
});
test.afterEach(() => { previewGate?.release(); restoreGate?.release(); });

async function openImport(page: Page) {
  await openProject(page);
  await page.evaluate(() => {
    document.querySelector('video')?.pause();
    (window as any).__importOwnershipNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__importOwnershipReveals = [];
    const reveal = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      if (this.id === 'caption-restore-title') (window as any).__importOwnershipReveals.push(options);
      reveal.call(this, options);
    };
  });
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  await captionsMode(page).click();
  await page.locator('.handoff-advanced > summary').click();
}
async function chooseFile(page: Page) {
  await page.locator('.handoff-restore input[type=file]').setInputFiles(file());
  await expect.poll(() => previewCalls).toBe(1);
}
async function unchanged(page: Page, captions: CaptionSegment[]) {
  expect(current().captions).toEqual(captions);
  expect(restoreCalls).toBe(0);
  await sameNodes(page);
}
async function sameNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__importOwnershipNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { focused: document.activeElement === node, visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
      uncovered: hit === node || (hit !== null && node.contains(hit)) };
  })).toEqual({ focused: true, visible: true, uncovered: true });
}

test('an ordinary narrow-screen import reveals its heading instantly and Keep continues from Captions file', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openImport(page);
  const before = structuredClone(current().captions);
  const gate = deferred(); previewGate = gate;
  try {
    await chooseFile(page);
    await expect(captionsMode(page)).toBeFocused();
    gate.release();
    await visibleFocus(heading(page));
    expect(await page.evaluate(() => (window as any).__importOwnershipReveals)).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'instant' }]);
    await expect(checks(page)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('caption-import-preview-390.png') });
    await page.getByRole('button', { name: 'Keep current captions', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(review(page)).toHaveCount(0);
    await expect(captionsMode(page)).toBeFocused();
    await expect(checks(page)).toBeVisible();
    await unchanged(page, before);
  } finally { gate.release(); }
});

test('a delayed preview preserves newer caption-text focus without changing its draft or the evidence nodes', async ({ page }) => {
  await openImport(page);
  const before = structuredClone(current().captions);
  const gate = deferred(); previewGate = gate;
  try {
    await chooseFile(page);
    const text = page.getByLabel('Caption 1 text', { exact: true });
    await text.focus();
    gate.release();
    await expect(review(page)).toBeVisible();
    await expect(text).toBeFocused();
    await expect(text).toHaveValue(before[0].text);
    expect(await page.evaluate(() => (window as any).__importOwnershipReveals)).toEqual([]);
    await unchanged(page, before);
  } finally { gate.release(); }
});

test('a delayed preview yields to newer Accuracy navigation and its context draft', async ({ page }) => {
  await openImport(page);
  const before = structuredClone(current().captions);
  const gate = deferred(); previewGate = gate;
  try {
    await chooseFile(page);
    await page.locator('.stage-rail').getByRole('button', { name: 'Captions', exact: true }).click();
    await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
    const context = page.locator('#accuracy-context-description');
    await context.fill('Newer context កម្ពុជា');
    gate.release();
    await expect.poll(() => previewResponses).toBe(1);
    await expect(context).toBeFocused();
    await expect(context).toHaveValue('Newer context កម្ពុជា');
    await expect(review(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__importOwnershipReveals)).toEqual([]);
    await unchanged(page, before);
  } finally { gate.release(); }
});

test('switching to video during a pending preview keeps its checks and retains the import for a deliberate return', async ({ page }) => {
  await openImport(page);
  const before = structuredClone(current().captions);
  const gate = deferred(); previewGate = gate;
  try {
    await chooseFile(page);
    await videoMode(page).click();
    await expect(checks(page)).toBeVisible();
    gate.release();
    await expect.poll(() => previewResponses).toBe(1);
    await expect(page.getByRole('button', { name: 'Recheck video export support', exact: true })).toBeEnabled();
    await expect(videoMode(page)).toBeFocused();
    await expect(videoMode(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(checks(page)).toBeVisible();
    await expect(review(page)).toHaveCount(0);
    await captionsMode(page).click();
    await expect(review(page)).toContainText('Imported ខ្មែរ caption');
    await expect(captionsMode(page)).toBeFocused();
    await expect(checks(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__importOwnershipReveals)).toEqual([]);
    await unchanged(page, before);
  } finally { gate.release(); }
});

test('an existing preview stays retained across output choices while video blockers remain visible and authoritative', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  // Valid caption data remains transferable when its saved rendering font is
  // unavailable on this PC. Only styled output requires that font.
  state.capabilities = { ...structuredClone(capabilities),
    fonts: capabilities.fonts.filter((font) => font.name !== current().captionAppearance!.fontFamily) };
  await openImport(page);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  const before = structuredClone(current().captions);
  await chooseFile(page);
  await expect(heading(page)).toBeFocused();
  await videoMode(page).click();
  await expect(checks(page)).toBeVisible();
  await expect(checks(page)).toContainText('Saved font selection is unavailable');
  await expect(checks(page)).toContainText('Blocks this output');
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeDisabled();
  await expect(review(page)).toHaveCount(0);
  await captionsMode(page).click();
  await expect(review(page)).toContainText('Imported ខ្មែរ caption');
  await expect(captionsMode(page)).toBeFocused();
  await expect(checks(page)).toHaveCount(0);
  await unchanged(page, before);
});

test('confirmed delayed replacement keeps the existing Captions file continuation and applies the candidate once', async ({ page }) => {
  await openImport(page);
  const appearance = structuredClone(current().captionAppearance);
  await chooseFile(page);
  await expect(heading(page)).toBeFocused();
  const gate = deferred(); restoreGate = gate;
  try {
    await page.getByRole('button', { name: 'Replace captions', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => restoreCalls).toBe(1);
    await expect(captionsMode(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Replacing…', exact: true })).toBeDisabled();
    gate.release();
    await expect(review(page)).toHaveCount(0);
    await expect(captionsMode(page)).toBeFocused();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Imported ខ្មែរ caption');
    expect(current().captionAppearance).toEqual(appearance);
    expect(current().captions[0].approved).toBe(false);
    expect(restoreCalls).toBe(1);
    await sameNodes(page);
  } finally { gate.release(); }
});
