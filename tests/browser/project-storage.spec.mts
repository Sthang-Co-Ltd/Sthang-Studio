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

test('mobile storage details wrap and retain labeled touch actions', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Review storage', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Saved project storage' });
  await expect(panel).toBeVisible(); await panel.scrollIntoViewIfNeeded();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await panel.getByRole('button', { name: 'Recheck saved projects' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('storage-mobile.png') });
});
