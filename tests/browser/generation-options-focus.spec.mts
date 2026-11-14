import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
let writes: any[];
let failure: boolean;
let hold: ReturnType<typeof deferred> | null;
const disclosure = (page: Page) => page.locator('.generation-options');
const summary = (page: Page) => disclosure(page).locator(':scope > summary');
const picker = (page: Page) => page.getByRole('combobox', { name: 'Caption model', exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); writes = []; failure = false; hold = null;
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/projects/landscape/generation-model', async (route) => {
    const body = route.request().postDataJSON(); writes.push(body);
    await hold?.promise;
    if (failure) return route.fulfill({ status: 503, json: { error: 'Synthetic AI options save failure. Try again.' } });
    state.projects[0].generationModel = body.generationModel;
    await route.fulfill({ json: state.projects[0] });
  });
});
async function openOptions(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await expect(disclosure(page)).toBeVisible();
  await summary(page).focus(); await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press('Tab'); await expect(picker(page)).toBeFocused();
  await page.evaluate(() => { document.querySelector('video')?.pause(); (window as any).__generationFocusNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function chooseWithKeyboard(page: Page) {
  await expect(picker(page)).toHaveValue('automatic');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].generationModel).toBe('gemini-3.8-flash');
  await expect(picker(page)).toBeDisabled();
  await expect(summary(page)).toBeFocused();
  await expect(disclosure(page).getByRole('status')).toHaveText('Saving choice…');
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    const points = [top + 2, top + height / 2, bottom - 2];
    return { focused: document.activeElement === node,
      inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: points.every((y) => { const hit = document.elementFromPoint(left + width / 2, y); return hit === node || (hit !== null && node.contains(hit)); }),
      rect: { left, top, right, bottom, width, height } };
  })).toMatchObject({ focused: true, inViewport: true, uncovered: true });
}
async function keptEvidence(page: Page, captions: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(captions);
  expect(await page.evaluate(() => (window as any).__generationFocusNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  expect(state.requests.filter((request) => request.path === '/api/system/llm-settings' && request.method !== 'GET')).toEqual([]);
}

for (const width of [1440, 390]) for (const result of ['success', 'failure'] as const) {
  test(`native model selection keeps a useful keyboard target through held ${result} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await openOptions(page);
    const before = structuredClone(state.projects[0].captions);
    hold = deferred(); failure = result === 'failure';
    try {
      await chooseWithKeyboard(page); await visibleFocus(summary(page));
      const time = await page.locator('video').evaluate((node: HTMLVideoElement) => node.currentTime);
      await page.keyboard.press('r');
      expect(await page.locator('video').evaluate((node: HTMLVideoElement) => node.paused && node.currentTime)).toBe(time);
      await page.screenshot({ path: info.outputPath(`model-focus-pending-${result}-${width}.png`), animations: 'disabled' });
      hold.release(); await expect(picker(page)).toBeEnabled();
      await expect(picker(page)).toHaveValue(result === 'success' ? 'gemini-3.8-flash' : 'automatic');
      await expect(summary(page)).toBeFocused();
      if (result === 'failure') await expect(page.getByRole('alert').filter({ hasText: 'Synthetic AI options save failure.' })).toBeVisible();
      await page.keyboard.press('Tab'); await expect(picker(page)).toBeFocused();
      expect(writes).toHaveLength(1); await keptEvidence(page, before);
    } finally { hold.release(); }
  });
}

test('model-save completion leaves newer caption editing and its draft focused', async ({ page }) => {
  await openOptions(page); const before = structuredClone(state.projects[0].captions);
  hold = deferred();
  try {
    await chooseWithKeyboard(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Newer caption draft កម្ពុជា');
    hold.release(); await expect(picker(page)).toBeEnabled();
    await expect(picker(page)).toHaveValue('gemini-3.8-flash');
    await expect(caption).toBeFocused(); await expect(caption).toHaveValue('Newer caption draft កម្ពុជា');
    expect(writes).toHaveLength(1); await keptEvidence(page, before);
  } finally { hold.release(); }
});

test('closing AI options during a failed save stays closed without a late focus move on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openOptions(page);
  const before = structuredClone(state.projects[0].captions);
  hold = deferred(); failure = true;
  try {
    await chooseWithKeyboard(page);
    await page.keyboard.press('Enter'); await expect(disclosure(page)).not.toHaveAttribute('open');
    await expect(summary(page)).toBeFocused();
    hold.release();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic AI options save failure.' })).toBeVisible();
    await expect(disclosure(page)).not.toHaveAttribute('open'); await expect(summary(page)).toBeFocused();
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    await expect(picker(page)).toBeFocused(); await expect(picker(page)).toBeEnabled(); await expect(picker(page)).toHaveValue('automatic');
    expect(writes).toHaveLength(1); await keptEvidence(page, before);
  } finally { hold.release(); }
});
