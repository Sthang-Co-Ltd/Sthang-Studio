import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const summary = (page: Page) => page.locator('.export-preset-tools > summary');
const name = (page: Page) => page.getByLabel('Save video export preset as', { exact: true });
const resolution = (page: Page) => page.getByLabel('Resolution', { exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry saved presets', exact: true });
const remove = (page: Page) => page.locator('.export-preset-delete').getByRole('button', { name: 'Delete preset', exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
type Attempt = { succeeds: boolean; gate: ReturnType<typeof deferred> };
async function openPresets(page: Page) {
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  await expect(resolution(page)).toBeVisible();
  await summary(page).click();
  await resolution(page).selectOption('720p');
  await name(page).fill('Keep this unsaved preset');
  expect(await page.evaluate(() => {
    const nodes = ['video', '.caption-list', '.export-preset-tools > summary', '#video-export-preset-name', '#export-resolution-select']
      .map((selector) => document.querySelector(selector));
    (window as any).__exportPresetFocusNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
}
async function expectContinuity(page: Page, draft = 'Keep this unsaved preset', size = '720p') {
  await expect(name(page)).toHaveValue(draft);
  await expect(resolution(page)).toHaveValue(size);
  await expect(page.getByRole('button', { name: /Captioned video/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => ['video', '.caption-list', '.export-preset-tools > summary', '#video-export-preset-name', '#export-resolution-select']
    .every((selector, index) => document.querySelector(selector) === (window as any).__exportPresetFocusNodes[index]))).toBe(true);
  expect(state.jobs).toHaveLength(0);
  expect(state.requests.filter((request) => request.path === '/api/profile/video-export-settings' && request.method === 'PUT')).toEqual([]);
}
async function expectSummaryVisible(page: Page) {
  await expect(summary(page)).toBeFocused();
  await expect.poll(() => summary(page).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      && rect.left >= 0 && rect.right <= innerWidth && (hit === node || (hit !== null && node.contains(hit)));
  })).toBe(true);
}
async function failedPresets(page: Page) {
  await openProject(page);
  state.profile.lastVideoExportSettings = { resolution: '2160p', frameRate: 30, quality: 'high', codec: 'h264', encoder: 'software' };
  let attempt: Attempt | null = null;
  let reads = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const current = attempt;
    if (current) { reads++; await current.gate.promise; }
    return current?.succeeds ? route.fulfill({ json: state.profile })
      : route.fulfill({ status: 503, json: { error: 'Synthetic preset read failure' } });
  });
  await openPresets(page);
  await expect(retry(page)).toBeEnabled();
  return { next(succeeds: boolean) { const gate = deferred(); attempt = { succeeds, gate }; return gate; }, reads: () => reads };
}
async function waitForProfile(page: Page, succeeds: boolean) {
  await expect(page.locator('.export-preset-status').filter({ hasText: 'Loading saved video settings' })).toHaveCount(0);
  if (succeeds) await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
  else await expect(retry(page)).toBeEnabled();
}
async function managedPreset(page: Page) {
  state.profile.videoExportPresets = [{ id: 'focus-preset', name: 'Saved focus preset',
    settings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'software' },
    createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  await openProject(page);
  await openPresets(page);
  await page.getByLabel('Manage video export preset', { exact: true }).selectOption('focus-preset');
  let attempt: Attempt | null = null;
  let writes = 0;
  await page.route('**/api/profile/video-export-presets/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const current = attempt;
    if (!current) throw new Error('A canceled deletion must not make a request.');
    writes++;
    await current.gate.promise;
    if (!current.succeeds) return route.fulfill({ status: 503, json: { error: 'Synthetic preset deletion failure' } });
    state.profile = { ...state.profile, videoExportPresets: [] };
    return route.fulfill({ json: state.profile });
  });
  return { next(succeeds: boolean) { const gate = deferred(); attempt = { succeeds, gate }; return gate; }, writes: () => writes };
}
async function confirmDeletion(page: Page) {
  await remove(page).focus();
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('alertdialog', { name: 'Delete “Saved focus preset”?', exact: true });
  await confirmation.getByRole('button', { name: 'Delete preset', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeHidden();
  await expect(remove(page)).toBeDisabled();
  await expectSummaryVisible(page);
}
async function waitForDeletion(page: Page, succeeds: boolean) {
  if (succeeds) {
    await expect(remove(page)).toHaveCount(0);
    await expect(page.locator('.export-preset-status')).toHaveText('Deleted video preset “Saved focus preset”. Current settings are unchanged.');
  } else {
    await expect(page.locator('.export-preset-warning[role=alert]')).toContainText('Synthetic preset deletion failure');
    await expect(remove(page)).toBeEnabled();
  }
}

test('explicit preset retry keeps a persistent keyboard target through delayed failure and success', async ({ page }, info) => {
  const attempts = await failedPresets(page);
  for (const succeeds of [false, true]) {
    const width = succeeds ? 390 : 1440;
    await page.setViewportSize({ width, height: 900 });
    const gate = attempts.next(succeeds);
    try {
      await retry(page).focus();
      await page.keyboard.press('Enter');
      await expect(retry(page)).toHaveCount(0);
      await expectSummaryVisible(page);
      await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`export-preset-retry-focus-${width}.png`), animations: 'disabled' });
      gate.release();
      await waitForProfile(page, succeeds);
      await expect(summary(page)).toBeFocused();
      await expectContinuity(page);
    } finally { gate.release(); }
  }
  expect(attempts.reads()).toBe(2);
});

test('preset retry never takes focus from newer editing after a delayed failure or success', async ({ page }) => {
  const attempts = await failedPresets(page);
  for (const succeeds of [false, true]) {
    const gate = attempts.next(succeeds);
    const draft = succeeds ? 'Newer successful retry draft' : 'Newer failed retry draft';
    try {
      await retry(page).click();
      await expect(summary(page)).toBeFocused();
      await expect(page.locator('.export-preset-status').filter({ hasText: 'Loading saved video settings' })).toBeVisible();
      await resolution(page).selectOption('2160p');
      await name(page).fill(draft);
      gate.release();
      await waitForProfile(page, succeeds);
      await expect(name(page)).toBeFocused();
      await expectContinuity(page, draft, '2160p');
    } finally { gate.release(); }
  }
  expect(attempts.reads()).toBe(2);
});

test('cancel returns to Delete while confirmed delayed deletion keeps persistent focus on failure and success', async ({ page }) => {
  const attempts = await managedPreset(page);
  await remove(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toBeHidden();
  await expect(remove(page)).toBeFocused();
  expect(attempts.writes()).toBe(0);
  expect(state.profile.videoExportPresets).toHaveLength(1);
  await expectContinuity(page);
  for (const succeeds of [false, true]) {
    const gate = attempts.next(succeeds);
    try {
      await confirmDeletion(page);
      gate.release();
      await waitForDeletion(page, succeeds);
      await expect(summary(page)).toBeFocused();
      await expectContinuity(page);
    } finally { gate.release(); }
  }
  expect(attempts.writes()).toBe(2);
});

test('confirmed preset deletion preserves newer mobile form focus and choices on failure and success', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const attempts = await managedPreset(page);
  for (const succeeds of [false, true]) {
    const gate = attempts.next(succeeds);
    const draft = succeeds ? 'Newer successful delete draft' : 'Newer failed delete draft';
    try {
      await confirmDeletion(page);
      if (!succeeds) await page.screenshot({ path: info.outputPath('export-preset-delete-focus-390.png'), animations: 'disabled' });
      await resolution(page).selectOption('2160p');
      await name(page).fill(draft);
      gate.release();
      await waitForDeletion(page, succeeds);
      await expect(name(page)).toBeFocused();
      await expectContinuity(page, draft, '2160p');
    } finally { gate.release(); }
  }
  expect(attempts.writes()).toBe(2);
});
