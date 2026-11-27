import { test as base, expect, type Page } from '@playwright/test';
import { summarizeProject, type ProjectStorageStatus } from '@kcs/shared';
import { cleanFixtures, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const title = (page: Page) => page.getByRole('heading', { name: 'All projects', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry projects', exact: true });

async function failedLibrary(page: Page) {
  let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | null = null;
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    const current = attempt;
    if (current) await current.gate.promise;
    return current?.succeeds
      ? route.fulfill({ json: state.projects.map(summarizeProject) })
      : route.fulfill({ status: 503, json: { error: 'Synthetic project list failure' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(retry(page)).toBeVisible();
  return (succeeds: boolean) => {
    const gate = deferred();
    attempt = { succeeds, gate };
    return gate;
  };
}
async function waitForLibraryResult(page: Page, succeeds: boolean) {
  if (succeeds) await expect(page.locator('.project-library-summary h2')).toHaveText('2 projects');
  else await expect(retry(page)).toBeVisible();
}

for (const owner of ['Search', 'Sort', 'Settings'] as const) test('project retry preserves newer ' + owner + ' focus after failure and success', async ({ page }) => {
  const nextAttempt = await failedLibrary(page);
  for (const succeeds of [false, true]) {
    const gate = nextAttempt(succeeds);
    try {
      await retry(page).click();
      await expect(page.getByRole('heading', { name: 'Loading projects…', exact: true })).toBeVisible();
      await expect(title(page)).toBeFocused();
      if (owner === 'Search') {
        const search = page.getByRole('searchbox', { name: 'Search projects', exact: true });
        const query = succeeds ? 'Audit' : 'landscape';
        await search.fill(query);
        gate.release();
        await waitForLibraryResult(page, succeeds);
        await expect(search).toBeFocused();
        await expect(search).toHaveValue(query);
      } else if (owner === 'Sort') {
        const sort = page.getByRole('combobox', { name: 'Sort projects', exact: true });
        const value = succeeds ? 'created' : 'title';
        await sort.selectOption(value);
        await sort.focus();
        gate.release();
        await waitForLibraryResult(page, succeeds);
        await expect(sort).toBeFocused();
        await expect(sort).toHaveValue(value);
      } else {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'Profile', exact: true }).click();
        const glossary = settings.getByLabel('Key terms for all projects', { exact: true });
        await glossary.fill('Newer Settings draft កម្ពុជា');
        gate.release();
        await waitForLibraryResult(page, succeeds);
        // A modal trap can mask an unwanted external focus call by returning to
        // Close. The edited field itself must retain ownership of focus.
        await expect(glossary).toBeFocused();
        await expect(glossary).toHaveValue('Newer Settings draft កម្ពុជា');
        await expect(settings).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();
      }
    } finally { gate.release(); }
  }
});

test('a user who waits for project retry receives useful failure and result focus', async ({ page }) => {
  const nextAttempt = await failedLibrary(page);
  for (const succeeds of [false, true]) {
    const gate = nextAttempt(succeeds);
    try {
      await retry(page).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Loading projects…', exact: true })).toBeVisible();
      await expect(title(page)).toBeFocused();
      gate.release();
      await waitForLibraryResult(page, succeeds);
      if (succeeds) await expect(page.locator('.project-library-summary h2')).toBeFocused();
      else await expect(retry(page)).toBeFocused();
    } finally { gate.release(); }
  }
});

test('storage rechecks retain one live status, announce failure and finish with current counts', async ({ page }, info) => {
  const original = JSON.stringify(state.projects);
  const value: ProjectStorageStatus = { schemaVersion: 1, checkedAt: '2026-01-01T00:00:00Z', loadedProjectCount: 2, readableProjectCount: 2,
    unreadableProjectCount: 0, missingProjectCount: 0, duplicateProjectCount: 0, directoryUnreadable: false, orderUnreadable: false,
    legacyUnreadable: false, migrationPending: false, restartRequired: false };
  let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | null = null;
  let rechecks = 0;
  await page.route('**/api/system/project-storage*', async (route) => {
    const current = attempt;
    if (new URL(route.request().url()).searchParams.get('recheck') === '1') rechecks++;
    if (current) await current.gate.promise;
    return current && !current.succeeds
      ? route.fulfill({ status: 503, json: { error: 'Synthetic storage check failure' } })
      : route.fulfill({ json: current ? { ...value, checkedAt: '2026-01-02T00:00:00Z', readableProjectCount: 3, restartRequired: true } : value });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const system = settings.getByRole('button', { name: 'System check', exact: true });
  await system.click();
  const panel = settings.getByRole('region', { name: 'Saved project storage', exact: true });
  const status = panel.getByRole('status');
  const recheck = panel.getByRole('button', { name: 'Recheck saved projects', exact: true });
  await expect(status).toHaveText('Storage check complete. 2 loaded in this session · 2 readable project files at last check');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  await status.evaluate((node) => { (window as any).__storageQolStatus = node; });
  for (const succeeds of [false, true]) {
    const gate = deferred();
    attempt = { succeeds, gate };
    try {
      await recheck.click();
      await expect(status).toHaveText('Checking saved project files…');
      await expect(recheck).toBeDisabled();
      await expect(panel.getByText('2 loaded in this session · 2 readable project files at last check', { exact: true })).toBeVisible();
      await system.focus();
      gate.release();
      await expect(recheck).toBeEnabled();
      if (succeeds) {
        await expect(panel.getByRole('alert')).toHaveCount(0);
        await expect(status).toHaveText('Storage check complete. 2 loaded in this session · 3 readable project files at last check');
        await expect(panel).toContainText('Restart Studio after recovery.');
      } else {
        await expect(panel.getByRole('alert')).toHaveText('Saved project storage could not be checked. Your files were not changed. Try the check again.');
        await expect(status).toHaveText('Storage check unavailable. Last loaded results are shown.');
        await expect(panel.getByText('2 loaded in this session · 2 readable project files at last check', { exact: true })).toBeVisible();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await panel.scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: info.outputPath(`storage-recovery-${width}.png`), animations: 'disabled' });
        }
      }
      expect(await status.evaluate((node) => node === (window as any).__storageQolStatus)).toBe(true);
      await expect(system).toBeFocused();
    } finally { gate.release(); }
  }
  expect(rechecks).toBe(2);
  expect(JSON.stringify(state.projects)).toBe(original);
  expect(state.requests.some((request) => request.path === '/api/system/doctor')).toBe(false);
  expect(state.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});
