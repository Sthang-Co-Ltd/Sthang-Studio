import { test, expect } from '@playwright/test';
import type { ProjectStorageStatus } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState; let value: ProjectStorageStatus; let unavailable: boolean; let rechecks: number;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); unavailable = false; rechecks = 0;
  value = { schemaVersion: 1, checkedAt: '2026-01-01T00:00:00Z', loadedProjectCount: 2, readableProjectCount: 2,
    unreadableProjectCount: 1, missingProjectCount: 0, duplicateProjectCount: 0, directoryUnreadable: false,
    orderUnreadable: true, legacyUnreadable: false, migrationPending: false, restartRequired: true };
  await page.route('**/api/system/project-storage*', (route) => {
    if (new URL(route.request().url()).searchParams.get('recheck') === '1') rechecks++;
    return route.fulfill({ status: unavailable ? 503 : 200, json: unavailable ? { error: 'Synthetic unavailable storage' } : value });
  });
});

test('a storage warning keeps healthy work usable and opens precise recovery guidance', async ({ page }, info) => {
  const original = JSON.stringify(state.projects);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeEnabled();
  await expect(page.locator('.toast-stack')).toContainText('Existing files were kept');
  await page.getByRole('button', { name: 'Review storage', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toContainText('1 project file could not be read'); await expect(panel).toContainText('project order could not be read');
  await expect(panel).toContainText('Stop Studio before restoring');
  await page.screenshot({ path: info.outputPath('storage-desktop.png') });
  expect(state.requests.some((request) => request.path === '/api/system/doctor')).toBe(false);
  value = { ...value, unreadableProjectCount: 0, orderUnreadable: false, readableProjectCount: 3, restartRequired: true };
  await panel.getByRole('button', { name: 'Recheck saved projects' }).click();
  await expect(panel).toContainText('3 readable project files'); await expect(panel).toContainText('Restart Studio after recovery');
  expect(rechecks).toBe(1); expect(JSON.stringify(state.projects)).toBe(original);
  expect(state.requests.filter((request) => request.method !== 'GET' && /(?:jobs|project-storage|replace-media)/.test(request.path))).toEqual([]);
});

test('unknown storage is retryable and does not prevent opening a project', async ({ page }) => {
  unavailable = true; await openProject(page);
  await expect(page.locator('.toast-stack')).toContainText('storage could not be checked');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
  unavailable = false; value = { ...value, unreadableProjectCount: 0, orderUnreadable: false, restartRequired: false };
  await page.getByRole('button', { name: 'Retry storage check', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry storage check', exact: true })).toHaveCount(0);
  expect(rechecks).toBe(1);
});

test('an empty readable list is not presented as a new library while storage is unresolved', async ({ page }) => {
  state.projects = []; value = { ...value, loadedProjectCount: 0, readableProjectCount: 0 };
  await page.goto('/'); await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project storage needs a check' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toHaveCount(0);
  await page.locator('.project-library-empty').getByRole('button', { name: 'Review storage' }).click();
  await expect(page.getByRole('region', { name: 'Saved project storage' })).toBeVisible();
});

test('missing indexed files never imply that their projects were loaded into the session', async ({ page }) => {
  state.projects = [];
  value = { ...value, loadedProjectCount: 0, readableProjectCount: 0,
    unreadableProjectCount: 0, missingProjectCount: 2, orderUnreadable: false };
  await page.goto('/');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project storage needs a check' })).toBeVisible();
  await page.locator('.project-library-empty').getByRole('button', { name: 'Review storage' }).click();
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toContainText('0 loaded in this session');
  await expect(panel).toContainText('2 indexed or previously loaded project files are missing');
  await expect(panel).toContainText('Back up any work still available in this session');
  await expect(panel).not.toContainText('2 loaded projects');
});

test('dismissing an unavailable storage notice keeps an empty library unresolved until a successful retry', async ({ page }) => {
  state.projects = []; unavailable = true;
  await page.goto('/');
  await expect(page.locator('.toast-stack')).toContainText('storage could not be checked');
  await page.getByRole('button', { name: 'Dismiss storage check notice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry storage check', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project storage needs a check' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toHaveCount(0);
  const reviewStorage = page.locator('.project-library-empty').getByRole('button', { name: 'Review storage', exact: true });
  await reviewStorage.focus();
  await expect(reviewStorage).toBeFocused();
  await reviewStorage.press('Enter');
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toContainText('storage could not be checked');
  unavailable = false;
  value = { ...value, loadedProjectCount: 0, readableProjectCount: 0, unreadableProjectCount: 0,
    orderUnreadable: false, restartRequired: false };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/system/project-storage*', async (route) => { await held; return route.fallback(); });
  const recheck = panel.getByRole('button', { name: 'Recheck saved projects', exact: true });
  try {
    await recheck.focus();
    await expect(recheck).toBeFocused();
    await recheck.press('Enter');
    await expect(panel).toContainText('Checking saved project files');
    await expect(recheck).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Project storage needs a check' })).toBeVisible();
  } finally { release(); }
  await expect(panel).toContainText('No project read errors were found at the last check');
  await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
  expect(rechecks).toBe(1);
  expect(state.requests.some((request) => request.path === '/api/system/doctor')).toBe(false);
});

test('a failed recheck does not keep a previously verified empty library healthy after notice dismissal', async ({ page }) => {
  state.projects = [];
  value = { ...value, loadedProjectCount: 0, readableProjectCount: 0, unreadableProjectCount: 0,
    orderUnreadable: false, restartRequired: false };
  await page.goto('/');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
  // The storage-only recheck remains separate from the full System check.
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System check', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toContainText('No project read errors were found at the last check');
  unavailable = true;
  await panel.getByRole('button', { name: 'Recheck saved projects', exact: true }).click();
  await expect(panel).toContainText('storage could not be checked');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss storage check notice', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System check', exact: true }).click();
  await expect(panel).toContainText('storage could not be checked');
  await expect(panel).not.toContainText('No project read errors were found at the last check');
  await expect(panel.getByRole('button', { name: 'Recheck saved projects', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project storage needs a check' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toHaveCount(0);
});

for (const obsoleteFailure of [false, true]) test(`a superseded storage ${obsoleteFailure ? 'failure' : 'warning'} cannot overwrite a newer successful check`, async ({ page }) => {
  state.projects = [];
  let fresh = false; let waiting = 0; let completed = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Simulate a transport that still returns after cancellation, so this checks
  // sequence ownership rather than relying on the browser to drop stale replies.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => fetch(input,
      String(input).includes('/api/system/project-storage') ? { ...init, signal: undefined } : init);
  });
  await page.route('**/api/health*', (route) => fresh ? route.fallback()
    : route.fulfill({ status: 503, json: { error: 'Synthetic unavailable system status' } }));
  await page.route('**/api/system/project-storage*', async (route) => {
    if (fresh) return route.fulfill({ json: { ...value, loadedProjectCount: 0, readableProjectCount: 0,
      unreadableProjectCount: 0, orderUnreadable: false, restartRequired: false } });
    waiting++;
    await held;
    await route.fulfill({ status: obsoleteFailure ? 503 : 200,
      json: obsoleteFailure ? { error: 'Synthetic obsolete storage failure' } : value });
    completed++;
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Retry startup', exact: true })).toBeVisible();
    await expect.poll(() => waiting).toBeGreaterThan(0);
    fresh = true;
    await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
    const obsoleteResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system/project-storage');
    release();
    await (await obsoleteResponse).finished();
    await expect.poll(() => completed).toBe(waiting);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry storage check', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review storage', exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('mobile storage details wrap and retain labeled touch actions', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Review storage', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toBeVisible(); await panel.scrollIntoViewIfNeeded();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await panel.getByRole('button', { name: 'Recheck saved projects' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('storage-mobile.png') });
});
