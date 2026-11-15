import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { summarizeProject } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, project, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh projects', exact: true });
const status = (page: Page) => page.locator('.project-library-refresh [role="status"]');
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search projects', exact: true });
const sort = (page: Page) => page.getByRole('combobox', { name: 'Sort projects', exact: true });
async function library(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(refresh(page)).toBeVisible();
  await expect(refresh(page)).not.toHaveAttribute('aria-busy', 'true');
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const width of [1440, 390]) test(`entering the collection adopts remote additions, updates and removals using metadata only at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const requests: string[] = [];
  page.on('request', (request) => { if (/\/api\/projects(?:\?|\/|$)/.test(request.url())) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
  const updated = { ...state.projects[0], title: 'Current Khmer project កម្ពុជា', captions: state.projects[0].captions.slice(0, 1), updatedAt: '2026-02-01T00:00:00Z' };
  state.projects = [project('remote-new'), updated];
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Audit remote-new', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Audit second', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Current Khmer project កម្ពុជា', exact: true })).toContainText('1 caption');
  await search(page).fill('កម្ពុជា');
  await expect(page.locator('.project-library-summary h2')).toHaveText('1 of 2 projects');
  const focused = search(page);
  await focused.focus();
  await page.screenshot({ path: info.outputPath(`current-project-collection-${width}.png`), animations: 'disabled' });
  await expect(focused).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await refresh(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every((url) => { const value = new URL(url); return value.pathname === '/api/projects' && value.searchParams.get('summary') === '1'; })).toBe(true);
  expect(state.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

for (const width of [1440, 390]) for (const owner of ['Search', 'Sort', 'Settings'] as const) test(`refresh retains loaded projects and newer ${owner} focus through failure and retry at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await library(page);
  const before = structuredClone(state.projects);
  let attempt: { gate: ReturnType<typeof deferred>; fails: boolean } | null = null;
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    const current = attempt;
    const snapshot = state.projects.map(summarizeProject);
    if (current) await current.gate.promise;
    return current?.fails ? route.fulfill({ status: 503, json: { error: 'Synthetic collection refresh failure' } }) : route.fulfill({ json: snapshot });
  });
  for (const fails of [true, false]) {
    const gate = deferred(); attempt = { gate, fails };
    try {
      await refresh(page).focus(); await refresh(page).press('Enter');
      await expect(status(page)).toHaveText('Refreshing projects…');
      await expect(refresh(page)).toBeFocused();
      await expect(refresh(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('button', { name: 'Open Audit landscape', exact: true })).toBeVisible();
      let target: Locator;
      if (owner === 'Search') {
        target = search(page); await target.fill('Audit');
      } else if (owner === 'Sort') {
        target = sort(page); await target.selectOption('title'); await target.focus();
      } else {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: 'Profile', exact: true }).click();
        target = settings.getByLabel('Global protected vocabulary', { exact: true }); await target.fill('Newer Settings text កម្ពុជា');
      }
      gate.release();
      await expect(refresh(page)).not.toHaveAttribute('aria-busy', 'true');
      await expect(target).toBeFocused();
      await expect(page.getByRole('button', { name: 'Open Audit landscape', exact: true })).toBeVisible();
      if (fails) await expect(status(page)).toContainText('Last loaded projects are shown; this list may be out of date.');
      else await expect(status(page)).toHaveText('Project list loaded.');
      if (owner === 'Settings') await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings', exact: true }).click();
      else if (owner === 'Search') await expect(search(page)).toHaveValue('Audit');
      else await expect(sort(page)).toHaveValue('title');
    } finally { gate.release(); }
  }
  expect(state.projects).toEqual(before);
  expect(state.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

for (const width of [1440, 390]) test(`returning to a stale tab refreshes metadata while retaining search, sort, page and focus at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  state.projects = Array.from({ length: 30 }, (_, index) => project(`clip-${index + 1}`));
  await library(page);
  await search(page).fill('Audit'); await sort(page).selectOption('title');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  const gate = deferred(); let reads = 0;
  state.projects = [project('zz-new'), ...state.projects.slice(0, 29)];
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    reads++; await gate.promise; return route.fulfill({ json: state.projects.map(summarizeProject) });
  });
  try {
    await search(page).focus(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => reads).toBe(1); await expect(status(page)).toHaveText('Refreshing projects…');
    await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    gate.release(); await expect(status(page)).toHaveText('Project list loaded.');
    await expect(search(page)).toBeFocused(); await expect(search(page)).toHaveValue('Audit');
    await expect(sort(page)).toHaveValue('title'); await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Audit zz-new', exact: true })).toBeVisible();
    expect(state.requests.filter((request) => /^\/api\/projects\//.test(request.path))).toEqual([]);
    expect(state.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  } finally { gate.release(); }
});

for (const width of [1440, 390]) test(`a delayed metadata refresh cannot undo a later project publication at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await library(page);
  const gate = deferred(); let reads = 0;
  const snapshot = state.projects.map(summarizeProject);
  await page.route(/\/api\/projects\?summary=1$/, async (route) => {
    reads++; await gate.promise; return route.fulfill({ json: snapshot });
  });
  try {
    await refresh(page).click(); await expect.poll(() => reads).toBe(1);
    state.projects[0] = { ...state.projects[0], title: 'Newer opened project កម្ពុជា', captions: [...state.projects[0].captions,
      { id: 'new-cue', text: 'New saved cue', startMs: 3400, endMs: 3900, approved: false }], updatedAt: '2026-03-01T00:00:00Z' };
    await page.getByRole('button', { name: 'Open Audit landscape', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Newer opened project/);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
    gate.release(); await expect(refresh(page)).not.toHaveAttribute('aria-busy', 'true'); await rendered(page);
    await expect(page.getByRole('button', { name: 'Open Newer opened project កម្ពុជា', exact: true })).toContainText('4 captions');
    await expect(page.getByRole('button', { name: 'Open Audit landscape', exact: true })).toHaveCount(0);
  } finally { gate.release(); }
});

test('returning to Home refreshes metadata while focus during active editing never reloads caption state', async ({ page }) => {
  await openProject(page);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  const before = await field.inputValue();
  const readsBefore = state.requests.filter((request) => request.path === '/api/projects/landscape').length;
  await page.evaluate(() => { (window as any).__projectSessionNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
  state.projects.unshift(project('other-tab'));
  await field.focus(); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await rendered(page);
  await expect(field).toHaveValue(before); await expect(field).toBeFocused();
  expect(state.requests.filter((request) => request.path === '/api/projects/landscape').length).toBe(readsBefore);
  expect(await page.evaluate(() => (window as any).__projectSessionNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true }).getByRole('button', { name: /Audit other-tab/ })).toBeVisible();
});
