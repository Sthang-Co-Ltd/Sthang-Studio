import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const closeTool = (page: Page) => page.getByRole('button', { name: 'Close tool', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry loading tool', exact: true });
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Opening a tool blurs the caption. Keep its attempted save unavailable so
  // this exercises an actual unsaved draft through each download state.
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic draft save remains unavailable' } }));
});
async function prepareEditor(page: Page) {
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unfinished draft ខ្មែរ');
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    video.pause(); video.currentTime = 1.6; video.playbackRate = 0.5;
    (window as any).__retryFocusEvidence = [document.documentElement, video, document.querySelector('.caption-list')];
  });
  const metadata = await page.evaluate(async () => (await fetch('/studio-workspaces.json')).json());
  expect(metadata.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
  return metadata.tools as Record<string, { entry: string; css: string[] }>;
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { focused: document.activeElement === node,
      inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: [top + 2, top + height / 2, bottom - 2].every((y) => { const hit = document.elementFromPoint(left + width / 2, y); return hit === node || (hit !== null && node.contains(hit)); }) };
  })).toEqual({ focused: true, inViewport: true, uncovered: true });
}
async function keptEditor(page: Page, draft = 'Unfinished draft ខ្មែរ') {
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(draft);
  expect(state.projects[0].captions[0].text).not.toBe(draft);
  expect(await page.evaluate(() => {
    const before = (window as any).__retryFocusEvidence;
    const video = document.querySelector('video')!;
    const unsaved = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unsaved);
    return before[0] === document.documentElement && before[1] === video && before[2] === document.querySelector('.caption-list')
      && video.paused && video.playbackRate === 0.5 && Math.abs(video.currentTime - 1.6) < .1 && unsaved.defaultPrevented;
  })).toBe(true);
}
const workspaces = [
  ['Fine timing', 'WaveformEditor', '.timing-waveform-surface'],
  ['Appearance', 'CaptionAppearanceWorkspace', '.caption-appearance-workspace'],
  ['Export', 'ExportWorkspace', '.export-workspace'],
] as const;
for (const width of [1440, 390]) for (const [label, name, ready] of workspaces) {
  test(`${label} retry keeps a visible keyboard target through repeated failure and success at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const assets = await prepareEditor(page);
    const failedRetry = deferred(); const successfulRetry = deferred();
    let requests = 0;
    await page.route(`**${assets[name].entry}*`, async (route) => {
      const request = ++requests;
      if (request === 1) return route.abort();
      await (request === 2 ? failedRetry.promise : successfulRetry.promise);
      return request === 2 ? route.abort() : route.fallback();
    });
    try {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(retry(page)).toBeVisible();
      await retry(page).focus(); await page.keyboard.press('Enter');
      await expect.poll(() => requests).toBe(2);
      await visibleFocus(closeTool(page));
      await expect(page.getByRole('status').filter({ hasText: `Opening ${label}…` })).toBeVisible();
      await page.keyboard.press('r'); await keptEditor(page);
      if (label === 'Appearance') await page.screenshot({ path: info.outputPath(`tool-retry-focus-${width}.png`), animations: 'disabled' });
      failedRetry.release(); await expect(retry(page)).toBeVisible();
      await expect(closeTool(page)).toBeFocused();
      await page.keyboard.press('Tab'); await expect(retry(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => requests).toBe(3);
      await visibleFocus(closeTool(page));
      successfulRetry.release(); await expect(page.locator(ready)).toBeVisible();
      await expect(closeTool(page)).toBeFocused(); await keptEditor(page);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.closest('.workspace-inspector') !== null)).toBe(true);
      expect(requests).toBe(3);
    } finally { failedRetry.release(); successfulRetry.release(); }
  });
}

for (const [label, name, ready] of workspaces.filter(([label]) => label !== 'Fine timing')) for (const succeeds of [false, true]) test(`late ${label} retry ${succeeds ? 'success' : 'failure'} keeps newer editing focused`, async ({ page }) => {
  const assets = await prepareEditor(page); const gate = deferred(); let requests = 0;
  await page.route(`**${assets[name].entry}*`, async (route) => {
    if (++requests === 1) return route.abort();
    await gate.promise;
    return succeeds ? route.fallback() : route.abort();
  });
  try {
    await page.getByRole('button', { name: label, exact: true }).click();
    await retry(page).focus(); await page.keyboard.press('Enter');
    await expect.poll(() => requests).toBe(2); await expect(closeTool(page)).toBeFocused();
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Newer unfinished draft កម្ពុជា');
    gate.release();
    await expect(succeeds ? page.locator(ready) : retry(page)).toBeVisible();
    await expect(caption).toBeFocused(); await keptEditor(page, 'Newer unfinished draft កម្ពុជា');
  } finally { gate.release(); }
});

test('Close tool remains usable during a retry and late loading does not reopen it on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const assets = await prepareEditor(page); const gate = deferred(); let requests = 0; let completed = false;
  await page.route(`**${assets.CaptionAppearanceWorkspace.entry}*`, async (route) => {
    if (++requests === 1) return route.abort();
    await gate.promise; await route.fallback(); completed = true;
  });
  try {
    const appearance = page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true });
    await appearance.click(); await retry(page).focus(); await page.keyboard.press('Enter');
    await expect.poll(() => requests).toBe(2); await visibleFocus(closeTool(page));
    await page.keyboard.press('Enter');
    await expect(page.locator('.workspace-inspector')).toBeHidden(); await expect(appearance).toBeFocused();
    gate.release(); await expect.poll(() => completed).toBe(true);
    await expect(page.locator('.workspace-inspector')).toBeHidden(); await expect(appearance).toBeFocused(); await keptEditor(page);
    await page.keyboard.press('Enter'); await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
    expect(requests).toBe(2);
  } finally { gate.release(); }
});
