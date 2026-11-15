import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.captionAppearances = [{ id: 'retained-look', name: 'Saved Khmer look', appearance: { ...state.projects[0].captionAppearance!, fontSize1080: 44 }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const fonts = (page: Page) => page.getByLabel('Khmer font', { exact: true });
const presets = (page: Page) => page.getByLabel('Preset', { exact: true });
const name = (page: Page) => page.getByLabel('Save current appearance as', { exact: true });
async function appearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
}
async function management(page: Page) {
  await page.locator('.appearance-presets-disclosure>summary').click();
  await page.locator('.appearance-preset-tools>summary').click();
  await expect(name(page)).toBeVisible();
}
async function remember(page: Page) {
  await page.evaluate(() => { (window as any).__appearanceReadNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function unchanged(page: Page, before: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(before);
  expect(await page.evaluate(() => (window as any).__appearanceReadNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function frames(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function noAppearanceOverflow(page: Page) {
  const geometry = await page.locator('.caption-appearance-workspace').evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const rect = ({ x, y, width, height, right }: DOMRect) => ({ x, y, width, height, right });
    return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, rect: rect(bounds), escaping: Array.from(node.querySelectorAll('*')).filter((child) => child.getClientRects().length && child.getBoundingClientRect().right > bounds.right + 1).slice(0, 12).map((child) => ({ tag: child.tagName, class: child.className, rect: rect(child.getBoundingClientRect()), scrollWidth: child.scrollWidth })) };
  });
  expect(geometry.scrollWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

for (const width of [1440, 390]) for (const resource of ['fonts', 'presets'] as const) {
  test(`${resource} read retry preserves appearance and newer form focus at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await openProject(page);
    const before = structuredClone(state.projects[0].captions);
    await remember(page);
    const gate = deferred(); const finished = deferred();
    let reads = 0; let phase: 'failure' | 'held' = 'failure';
    const endpoint = resource === 'fonts' ? '**/api/video-export/fonts*' : '**/api/profile';
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      reads += 1;
      if (phase === 'failure') return route.fulfill({ status: 503, json: { error: `Synthetic ${resource} read failure` } });
      await gate.promise;
      try { await route.fulfill({ json: resource === 'fonts' ? { fonts: state.fonts } : state.profile }); }
      finally { finished.release(); }
    });
    try {
      await appearance(page);
      const label = resource === 'fonts' ? 'Retry fonts' : 'Retry appearance presets';
      const retry = () => page.getByRole('button', { name: label, exact: true });
      await expect(retry()).toBeEnabled();
      await retry().evaluate((button) => button.scrollIntoView({ block: 'end', behavior: 'instant' }));
      await noAppearanceOverflow(page);
      await page.screenshot({ path: info.outputPath(`appearance-${resource}-unavailable-${width}.png`), animations: 'disabled' });
      if (resource === 'fonts') {
        await expect(fonts(page).locator('option:checked')).toContainText('not yet verified');
        await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeDisabled();
        await expect(page.getByText(/is unavailable on this PC/)).toHaveCount(0);
      }
      await management(page);
      await name(page).fill('Keep my preset draft');
      await page.getByLabel('Exact size', { exact: true }).fill('78');
      await page.getByLabel('Exact size', { exact: true }).press('Enter');
      const retryBox = (await retry().boundingBox())!;
      if (width === 390) expect(retryBox.height).toBeGreaterThanOrEqual(44);
      const openingReads = reads;
      await retry().evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
      await expect.poll(() => reads).toBe(openingReads + 1);
      await expect(retry()).toBeEnabled();
      await expect(name(page)).toHaveValue('Keep my preset draft');
      await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('78');
      phase = 'held';
      await retry().evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
      await expect.poll(() => reads).toBe(openingReads + 2);
      const pending = page.getByRole('button', { name: resource === 'fonts' ? 'Checking fonts…' : 'Loading presets…', exact: true });
      await expect(pending).toBeDisabled(); await expect(pending).toHaveAttribute('aria-busy', 'true');
      await pending.evaluate((button: HTMLButtonElement) => button.click());
      expect(reads).toBe(openingReads + 2);
      await name(page).fill('Newer name while retrying');
      gate.release(); await finished.promise;
      await expect(retry()).toHaveCount(0);
      await expect(name(page)).toBeFocused();
      await expect(name(page)).toHaveValue('Newer name while retrying');
      await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('78');
      await expect(presets(page)).toHaveValue('');
      if (resource === 'fonts') {
        await expect(fonts(page).locator('option:checked')).not.toContainText('not yet verified');
        await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeEnabled();
      } else await expect(presets(page).locator('option[value="retained-look"]')).toHaveCount(1);
      await noAppearanceOverflow(page);
      await page.screenshot({ path: info.outputPath(`appearance-${resource}-recovered-${width}.png`) });
      await unchanged(page, before);
    } finally { gate.release(); }
  });
}

test('a font mutation remains authoritative over an older pending discovery', async ({ page }) => {
  await openProject(page); await remember(page);
  const gate = deferred(); const finished = deferred(); const original = structuredClone(state.fonts);
  await page.route('**/api/video-export/fonts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate.promise;
    try { await route.fulfill({ json: { fonts: original } }); } finally { finished.release(); }
  });
  try {
    await appearance(page);
    await page.locator('.appearance-font-file-input').setInputFiles({ name: 'Synthetic.ttf', mimeType: 'font/ttf', buffer: Buffer.from('owned synthetic font fixture') });
    await expect(fonts(page)).toHaveValue('Creator Khmer');
    gate.release(); await finished.promise; await frames(page);
    await expect(fonts(page)).toHaveValue('Creator Khmer');
    await expect(fonts(page).locator('option:checked')).not.toContainText('unavailable');
    await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Retry fonts', exact: true })).toHaveCount(0);
  } finally { gate.release(); }
});

test('a saved preset remains authoritative over an older pending preset read', async ({ page }) => {
  await openProject(page);
  const gate = deferred(); const finished = deferred(); const stale = { ...structuredClone(state.profile), captionAppearances: [] };
  let phase: 'opening' | 'mutation' = 'opening';
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET' || phase === 'mutation') return route.fallback();
    await gate.promise;
    try { await route.fulfill({ json: stale }); } finally { finished.release(); }
  });
  try {
    await appearance(page); await management(page);
    await name(page).fill('New acknowledged look');
    phase = 'mutation';
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.locator('.appearance-preset-notice')).toHaveText('Saved “New acknowledged look”.');
    const chosen = await presets(page).inputValue();
    expect(chosen).toBeTruthy();
    gate.release(); await finished.promise; await frames(page);
    await expect(presets(page)).toHaveValue(chosen);
    await expect(presets(page).locator(`option[value="${chosen}"]`)).toHaveText('New acknowledged look');
    await expect(presets(page).locator('option[value="retained-look"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Retry appearance presets', exact: true })).toHaveCount(0);
  } finally { gate.release(); }
});

test('closing during a font retry allows a fresh visit and ignores the old response and focus handoff', async ({ page }) => {
  await openProject(page); await remember(page);
  const gate = deferred(); const finished = deferred(); let reads = 0;
  let phase: 'failure' | 'held' | 'fresh' = 'failure';
  await page.route('**/api/video-export/fonts*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads += 1;
    if (phase === 'failure') return route.fulfill({ status: 503, json: { error: 'Synthetic first discovery failure' } });
    if (phase === 'held') {
      await gate.promise;
      try { await route.fulfill({ json: { fonts: [] } }); } finally { finished.release(); }
    } else return route.fulfill({ json: { fonts: state.fonts } });
  });
  try {
    await appearance(page);
    const retry = page.getByRole('button', { name: 'Retry fonts', exact: true });
    await expect(retry).toBeEnabled();
    const openingReads = reads;
    phase = 'held';
    await retry.click();
    await expect.poll(() => reads).toBe(openingReads + 1);
    await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await expect(page.locator('.caption-appearance-workspace')).toHaveCount(0);
    phase = 'fresh';
    await appearance(page);
    await expect.poll(() => reads).toBeGreaterThan(openingReads + 1);
    await expect(fonts(page)).toBeEnabled();
    await expect(fonts(page).locator('option:checked')).not.toContainText('unavailable');
    const size = page.getByLabel('Exact size', { exact: true }); await size.focus();
    gate.release(); await finished.promise; await frames(page);
    await expect(size).toBeFocused();
    await expect(fonts(page).locator('option:checked')).not.toContainText('unavailable');
    await expect(page.getByRole('button', { name: 'Retry fonts', exact: true })).toHaveCount(0);
  } finally { gate.release(); }
});
