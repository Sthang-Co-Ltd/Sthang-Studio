import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const checks = (page: Page) => page.getByRole('region', { name: 'Check before export', exact: true });
const heading = (page: Page) => checks(page).getByRole('heading', { name: 'Check before export', exact: true });
const retry = (page: Page) => checks(page).getByRole('button', { name: 'Retry appearance load', exact: true });
const ass = (page: Page) => page.getByRole('button', { name: 'Download ASS', exact: true });
const layout = (page: Page) => checks(page).getByRole('button', { name: 'Check layout', exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function activate(page: Page, target: Locator) { await target.focus(); await page.keyboard.press('Enter'); }
async function visibleFocus(target: Locator) {
  await expect(target).toBeFocused();
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      && rect.left >= 0 && rect.right <= innerWidth + 1 && (hit === node || (hit !== null && node.contains(hit)));
  })).toBe(true);
}
async function remember(page: Page) {
  await page.evaluate(() => { (window as any).__exportCheckRetryNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function unchanged(page: Page, before: string, failedAppearanceSave = false) {
  expect(JSON.stringify({ projects: state.projects, jobs: state.jobs })).toBe(before);
  expect(await page.evaluate(() => (window as any).__exportCheckRetryNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  // A native preview POST renders pixels without changing the project.
  expect(state.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)
    && !(request.method === 'POST' && request.path === '/api/video-export/landscape/preview')
    && !(failedAppearanceSave && request.method === 'PUT' && request.path === '/api/video-export/landscape/appearance'))).toHaveLength(0);
}
async function pending(page: Page) {
  await expect(checks(page)).toContainText('Loading saved caption appearance');
  await expect(retry(page)).toHaveCount(0);
  await expect(ass(page)).toBeDisabled();
  await expect(layout(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
}
async function settled(page: Page, succeeds: boolean) {
  await expect(checks(page)).not.toContainText('Loading saved caption appearance');
  if (succeeds) {
    await expect(retry(page)).toHaveCount(0);
    await expect(ass(page)).toBeEnabled();
    await expect(layout(page)).toBeEnabled();
  } else {
    await expect(retry(page)).toBeEnabled();
    await expect(ass(page)).toBeDisabled();
    await expect(layout(page)).toBeDisabled();
  }
}
test('retrying video support retains keyboard focus while settings return', async ({ page }) => {
  const gate = deferred();
  let rechecks = 0;
  await page.route('**/api/video-export/*/capabilities*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') !== '1')
      return route.fulfill({ status: 503, json: { error: 'Video tools could not be checked.' } });
    rechecks++;
    await gate.promise;
    return route.fallback();
  });
  try {
    await openProject(page);
    await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByText('Video export check failed', { exact: true })).toBeVisible();
    const support = checks(page).getByRole('button', { name: 'Recheck video export support', exact: true });
    await activate(page, support);
    await expect(support).toHaveAttribute('aria-busy', 'true');
    await visibleFocus(support);
    await page.keyboard.press('Enter');
    gate.release();
    await expect(page.getByLabel('Resolution', { exact: true })).toBeVisible();
    await visibleFocus(support);
    expect(rechecks).toBe(1);
  } finally { gate.release(); }
});

async function failedAppearance(page: Page) {
  await openProject(page);
  let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | null = null;
  let reads = 0;
  const gates: ReturnType<typeof deferred>[] = [];
  const completed: Promise<void>[] = [];
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const captured = attempt;
    if (!captured) return route.fulfill({ status: 503, json: { error: 'Synthetic appearance read failure' } });
    const done = deferred(); completed.push(done.promise); reads++;
    try {
      await captured.gate.promise;
      await route.fulfill(captured.succeeds ? { json: state.projects[0] }
        : { status: 503, json: { error: 'Synthetic repeated appearance read failure' } });
    } catch (error) { if (!page.isClosed() && route.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error; }
    finally { done.release(); }
  };
  await page.route('**/api/projects/landscape/appearance', handler);
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await page.getByRole('group', { name: 'Export type', exact: true }).getByRole('button', { name: /Captions file/ }).click();
  await page.getByLabel('Caption destination', { exact: true }).selectOption('premiere');
  await page.locator('.handoff-advanced > summary').click();
  await page.getByRole('group', { name: 'Advanced caption format' }).getByRole('button', { name: /^ASS\b/ }).click();
  await expect(retry(page)).toBeEnabled();
  await remember(page);
  return {
    next(succeeds: boolean) { const gate = deferred(); gates.push(gate); attempt = { succeeds, gate }; return gate; },
    reads: () => reads,
    async dispose() { gates.forEach((gate) => gate.release()); await page.unroute('**/api/projects/landscape/appearance', handler); await Promise.all(completed); },
  };
}

for (const width of [1440, 390]) test(`appearance-load Retry keeps a visible keyboard target through repeated failure and success at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const attempts = await failedAppearance(page);
  const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
  try {
    for (const succeeds of [false, false, true]) {
      const initial = attempts.reads(); const gate = attempts.next(succeeds);
      try {
        await activate(page, retry(page));
        await visibleFocus(heading(page)); await pending(page);
        await expect.poll(attempts.reads).toBe(initial + 1);
        await page.keyboard.press('Enter');
        expect(attempts.reads()).toBe(initial + 1);
        if (initial === 0) await page.screenshot({ path: info.outputPath(`export-appearance-retry-focus-${width}.png`), animations: 'disabled' });
        gate.release(); await settled(page, succeeds); await visibleFocus(heading(page));
        await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('premiere');
        await expect(page.getByRole('group', { name: 'Advanced caption format' }).getByRole('button', { name: /^ASS\b/ })).toHaveAttribute('aria-pressed', 'true');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await unchanged(page, before);
      } finally { gate.release(); }
    }
    await page.getByRole('group', { name: 'Export type', exact: true }).getByRole('button', { name: /Captioned video/ }).click();
    await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
  } finally { await attempts.dispose(); }
});

test('appearance-load Retry respects its exact trigger and newer editor or modal focus', async ({ page }) => {
  const attempts = await failedAppearance(page);
  const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
  try {
    for (const owner of ['unfocused trigger', 'newer editor', 'newer modal']) {
      const succeeds = owner === 'newer modal';
      await page.setViewportSize({ width: owner === 'unfocused trigger' ? 1440 : 390, height: 1000 });
      const gate = attempts.next(succeeds);
      const editor = page.getByLabel('Caption 1 text', { exact: true });
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      try {
        if (owner === 'unfocused trigger') {
          await editor.focus();
          await retry(page).dispatchEvent('click');
          await pending(page); await expect(editor).toBeFocused();
        } else {
          await activate(page, retry(page)); await visibleFocus(heading(page)); await pending(page);
          if (owner === 'newer editor') await editor.focus();
          else {
            await page.getByLabel('Open project tools', { exact: true }).click();
            await page.getByRole('menuitem', { name: /^Settings/ }).click();
            await dialog.getByRole('button', { name: 'Profile', exact: true }).click();
            await dialog.getByLabel('Key terms for all projects', { exact: true }).focus();
          }
        }
        gate.release(); await settled(page, succeeds);
        if (succeeds) await expect(dialog.getByLabel('Key terms for all projects', { exact: true })).toBeFocused();
        else await expect(editor).toBeFocused();
        await unchanged(page, before);
      } finally { gate.release(); }
    }
  } finally { await attempts.dispose(); }
});

test('Retry in Appearance retains its separate navigation and repair focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await openProject(page); await remember(page);
  const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
  await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  state.appearanceFailure = true;
  await page.getByLabel(/^Size /).fill('90');
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  const recover = checks(page).getByRole('button', { name: 'Retry in Appearance', exact: true });
  await expect(recover).toBeEnabled();
  await activate(page, recover);
  await expect(checks(page)).toHaveCount(0);
  await expect(page.getByLabel(/^Size /)).toHaveValue('90');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.locator('#export-repair-title')).toBeFocused();
  await unchanged(page, before, true);
});

test('history appearance Retry keeps its summary visible and preserves newer focus at 390px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.route('**/api/caption-handoff/landscape/export-history', (route) => route.fulfill({ json: [
    { version: 1, format: 'ass', preparedAt: '2026-01-01T00:00:00Z', fingerprint: 'a'.repeat(64) },
  ] }));
  const attempts = await failedAppearance(page);
  const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
  const history = page.locator('.export-history');
  const summary = history.locator(':scope > summary');
  const recover = history.getByRole('button', { name: 'Retry appearance comparison', exact: true });
  try {
    await summary.click();
    await expect(history).toContainText('Freshness unknown');
    await summary.evaluate((node) => { (window as any).__exportHistoryRetrySummary = node; });
    for (const succeeds of [false, true]) {
      const initial = attempts.reads(); const gate = attempts.next(succeeds);
      try {
        await activate(page, recover); await visibleFocus(summary); await pending(page);
        await expect(recover).toHaveCount(0);
        await expect.poll(attempts.reads).toBe(initial + 1);
        if (!succeeds) await page.screenshot({ path: info.outputPath('export-history-appearance-retry-focus-390.png'), animations: 'disabled' });
        const newer = page.getByLabel('Caption 1 text', { exact: true });
        if (succeeds) await newer.focus();
        gate.release(); await settled(page, succeeds);
        if (succeeds) {
          await expect(history).not.toContainText('Freshness unknown');
          await expect(newer).toBeFocused();
        } else { await expect(recover).toBeEnabled(); await visibleFocus(summary); }
        expect(await summary.evaluate((node) => node === (window as any).__exportHistoryRetrySummary)).toBe(true);
        await unchanged(page, before);
      } finally { gate.release(); }
    }
  } finally { await attempts.dispose(); }
});
