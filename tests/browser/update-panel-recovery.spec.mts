import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { UpdateStatus } from '../../apps/web/src/api.js';
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
  await page.addInitScript(() => sessionStorage.setItem('sthang:updates-checked:v1', '1'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const panel = (page: Page) => page.getByRole('dialog', { name: 'Updates', exact: true });
const again = (page: Page) => panel(page).getByRole('button', { name: 'Check again', exact: true });
const download = (page: Page) => panel(page).getByRole('button', { name: 'Download & verify', exact: true });
const install = (page: Page) => panel(page).getByRole('button', { name: 'Install & restart', exact: true });
const checking = (page: Page) => panel(page).getByText('Checking for a signed update…', { exact: true });
const available = (downloaded: boolean): UpdateStatus => ({ status: 'available', currentVersion: 'synthetic-current', offer: {
  version: '999.0.0', publishedAt: '2026-01-01T00:00:00Z', releaseNotes: 'Synthetic release notes for an isolated read-only test.',
  manifestDigest: 'a'.repeat(64), downloaded,
} });
const current: UpdateStatus = { status: 'up-to-date', currentVersion: 'synthetic-current' };
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function mockUpdates(page: Page, initial: UpdateStatus | 'failure') {
  let response: { value: UpdateStatus | 'failure'; gate: ReturnType<typeof deferred> | null } = { value: initial, gate: null };
  const requests: Array<{ path: string; method: string }> = [];
  // Never delegate any updater request to a real service, including download
  // and install. These tests grant only a synthetic status-read response.
  await page.route(/\/api\/updates(?:\/.*)?$/, async (route) => {
    const request = { path: new URL(route.request().url()).pathname, method: route.request().method() };
    requests.push(request);
    if (request.path !== '/api/updates' || request.method !== 'GET') {
      await route.abort('blockedbyclient');
      throw new Error('The synthetic update recovery test forbids update mutations.');
    }
    const captured = response;
    await captured.gate?.promise;
    return captured.value === 'failure'
      ? route.fulfill({ status: 503, json: { error: 'Synthetic update status failure. Your installed version is unchanged.' } })
      : route.fulfill({ json: captured.value });
  });
  return { requests, next(value: UpdateStatus | 'failure') { const gate = deferred(); response = { value, gate }; return gate; } };
}
async function openUpdates(page: Page) {
  await openProject(page);
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__updateRecoveryNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Updates', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function expectVisibleRoot(dialog: Locator) {
  await expect.poll(() => dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { focused: document.activeElement === node,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1
        && rect.left >= 0 && rect.right <= innerWidth + 1 && (hit === node || (hit !== null && node.contains(hit))) };
  })).toEqual({ focused: true, visible: true });
}
async function expectPending(page: Page) {
  await expect(checking(page)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Close updates', exact: true })).toBeDisabled();
  await expectVisibleRoot(panel(page));
  await page.keyboard.press('Tab');
  await expect(panel(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
}
async function expectReadOnlyEvidence(page: Page, original: string, requests: Array<{ path: string; method: string }>, count: number) {
  expect(JSON.stringify({ projects: state.projects, profile: state.profile, jobs: state.jobs })).toBe(original);
  expect(await page.evaluate(() => (window as any).__updateRecoveryNodes.every((node: Element, index: number) =>
    node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  expect(requests).toEqual(Array.from({ length: count }, () => ({ path: '/api/updates', method: 'GET' })));
}

for (const downloaded of [false, true]) test(`an existing ${downloaded ? 'downloaded' : 'available'} offer retains manual retry after a failed recheck`, async ({ page }, info) => {
  const width = downloaded ? 390 : 1440;
  await page.setViewportSize({ width, height: 900 });
  const original = JSON.stringify({ projects: state.projects, profile: state.profile, jobs: state.jobs });
  const updates = await mockUpdates(page, available(downloaded));
  await openUpdates(page);
  await expect(downloaded ? install(page) : download(page)).toBeEnabled();
  expect(updates.requests).toHaveLength(1);
  const failed = updates.next('failure');
  try {
    await again(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expectPending(page);
    await expect(again(page)).toBeDisabled();
    await expect.poll(() => updates.requests.length).toBe(2);
    failed.release();
    await expect(checking(page)).toHaveCount(0);
    await expect(panel(page).getByText('Update status is unavailable', { exact: true })).toBeVisible();
    await expect(again(page)).toHaveCount(1);
    await expect(again(page)).toBeEnabled();
    await expect(download(page)).toHaveCount(0);
    await expect(install(page)).toHaveCount(0);
    await expect(panel(page)).toBeFocused();
    await page.screenshot({ path: info.outputPath(`update-offer-retry-${width}.png`), animations: 'disabled' });
  } finally { failed.release(); }
  const repaired = updates.next(current);
  try {
    await again(page).focus();
    await page.keyboard.press('Enter');
    await expectPending(page);
    repaired.release();
    await expect(panel(page).getByText('Studio is up to date', { exact: true })).toBeVisible();
    await expect(again(page)).toHaveCount(1);
    await expect(again(page)).toBeEnabled();
    await expect(download(page)).toHaveCount(0);
    await expect(install(page)).toHaveCount(0);
    await expect(panel(page)).toBeFocused();
  } finally { repaired.release(); }
  await expectReadOnlyEvidence(page, original, updates.requests, 3);
});

for (const width of [1440, 390]) test(`an initial update-read failure retries once with visible root focus at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const original = JSON.stringify({ projects: state.projects, profile: state.profile, jobs: state.jobs });
  const updates = await mockUpdates(page, 'failure');
  await openUpdates(page);
  await expect(panel(page).getByText('Update status is unavailable', { exact: true })).toBeVisible();
  await expect(again(page)).toHaveCount(1);
  const repaired = updates.next(available(false));
  try {
    await again(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expect(again(page)).toHaveCount(0);
    await expectPending(page);
    await expect.poll(() => updates.requests.length).toBe(2);
    if (width === 390) await page.screenshot({ path: info.outputPath('update-initial-retry-focus-390.png'), animations: 'disabled' });
    repaired.release();
    await expect(download(page)).toBeEnabled();
    await expect(again(page)).toHaveCount(1);
    await expect(again(page)).toBeEnabled();
    await expect(install(page)).toHaveCount(0);
    await expect(panel(page)).toBeFocused();
  } finally { repaired.release(); }
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  await expectReadOnlyEvidence(page, original, updates.requests, 2);
});
