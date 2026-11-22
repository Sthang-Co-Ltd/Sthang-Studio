import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
let writes: { generationModel: string }[];
let failure: boolean;
let hold: ReturnType<typeof deferred> | null;
const disclosure = (page: Page) => page.locator('.generation-options');
const summary = (page: Page) => disclosure(page).locator(':scope > summary');
const picker = (page: Page) => page.getByRole('group', { name: 'Caption model', exact: true });
const selectedChoice = (page: Page) => picker(page).getByRole('radio', { checked: true });
const applyModel = (page: Page) => disclosure(page).getByRole('button', { name: 'Apply model', exact: true });
const saveError = (page: Page) => page.getByRole('alert').filter({ hasText: 'Synthetic AI options save failure.' });
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
  await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  await expect(disclosure(page)).toBeVisible();
  await summary(page).focus(); await page.keyboard.press('Enter');
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press('Tab'); await expect(selectedChoice(page)).toBeFocused();
  await page.evaluate(() => { document.querySelector('video')?.pause(); (window as any).__generationFocusNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function browseToHydrogen(page: Page) {
  await expect(selectedChoice(page)).toBeFocused();
  await expect(selectedChoice(page)).toHaveValue('automatic');
  for (const model of ['gemini-3.8-flash', 'gemini-4-hydrogen']) {
    await page.keyboard.press('ArrowDown');
    await expect(selectedChoice(page)).toHaveValue(model);
    await expect(selectedChoice(page)).toBeFocused();
    expect(writes).toEqual([]);
  }
  await expect(summary(page)).toContainText('Automatic');
}

async function applyWithKeyboard(page: Page) {
  await browseToHydrogen(page);
  await page.keyboard.press('Tab');
  await expect(applyModel(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => writes.map((body) => body.generationModel)).toEqual(['gemini-4-hydrogen']);
  await expect(picker(page).getByRole('radio', { disabled: true })).toHaveCount(4);
  await expect(summary(page)).toContainText('Automatic');
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

for (const width of [1440, 390]) {
  test(`two arrow presses browse to Hydrogen and Apply saves it once at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await openOptions(page);
    const before = structuredClone(state.projects[0].captions);
    hold = deferred();
    try {
      await applyWithKeyboard(page);
      await visibleFocus(applyModel(page));
      await page.keyboard.press('Enter');
      const time = await page.locator('video').evaluate((node: HTMLVideoElement) => node.currentTime);
      await page.keyboard.press('r');
      expect(await page.locator('video').evaluate((node: HTMLVideoElement) => node.paused && node.currentTime)).toBe(time);
      await page.screenshot({ path: info.outputPath(`model-focus-pending-${width}.png`), animations: 'disabled' });
      hold.release();
      await expect(summary(page)).toContainText('Gemini 4 Hydrogen');
      await expect(summary(page).locator('.generation-model-mark')).toHaveAttribute('data-model-family', 'gemini');
      await expect(selectedChoice(page)).toBeEnabled();
      await expect(applyModel(page)).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(selectedChoice(page)).toBeFocused();
      await expect(selectedChoice(page)).toHaveValue('gemini-4-hydrogen');
      expect(writes).toHaveLength(1);
      await keptEvidence(page, before);
    } finally { hold.release(); }
  });
}

test('failed Apply retains the Hydrogen draft and retries only on a second Apply', async ({ page }) => {
  await openOptions(page);
  hold = deferred(); failure = true;
  try {
    await applyWithKeyboard(page);
    hold.release();
    await expect(saveError(page)).toBeVisible();
    await expect(selectedChoice(page)).toHaveValue('gemini-4-hydrogen');
    await expect(summary(page)).toContainText('Automatic');
    await expect(applyModel(page)).toBeEnabled();
    await expect(applyModel(page)).toBeFocused();
    expect(writes).toHaveLength(1);
    failure = false;
    await page.keyboard.press('Enter');
    await expect(summary(page)).toContainText('Gemini 4 Hydrogen');
    expect(writes.map((body) => body.generationModel)).toEqual(['gemini-4-hydrogen', 'gemini-4-hydrogen']);
  } finally { hold.release(); }
});

test('model-save completion leaves newer caption editing and its draft focused', async ({ page }) => {
  await openOptions(page); const before = structuredClone(state.projects[0].captions);
  hold = deferred();
  try {
    await applyWithKeyboard(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Newer caption draft កម្ពុជា');
    hold.release();
    await expect(summary(page)).toContainText('Gemini 4 Hydrogen');
    await expect(caption).toBeFocused(); await expect(caption).toHaveValue('Newer caption draft កម្ពុជា');
    expect(writes).toHaveLength(1); await keptEvidence(page, before);
  } finally { hold.release(); }
});

test('closing AI options during a failed save stays closed without a late focus move on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openOptions(page);
  const before = structuredClone(state.projects[0].captions);
  hold = deferred(); failure = true;
  try {
    await applyWithKeyboard(page);
    await summary(page).press('Enter');
    await expect(disclosure(page)).not.toHaveAttribute('open');
    await expect(summary(page)).toBeFocused();
    const mark = summary(page).locator('.generation-model-mark');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute('data-model-family', 'automatic');
    hold.release();
    await expect(saveError(page)).toBeVisible();
    await expect(disclosure(page)).not.toHaveAttribute('open');
    await expect(summary(page)).toBeFocused();
    await expect(summary(page)).toContainText('Automatic');
    expect(writes).toHaveLength(1); await keptEvidence(page, before);
  } finally { hold.release(); }
});

test('leaving during Apply preserves navigation focus and the next project’s saved model', async ({ page }) => {
  state.projects[1].generationModel = 'gemini-3.6-flash';
  await openOptions(page);
  hold = deferred();
  try {
    await applyWithKeyboard(page);
    const back = page.getByRole('button', { name: 'Back to Home', exact: true });
    await back.press('Enter');
    await expect(back).toBeFocused();
    await expect(disclosure(page).getByRole('status')).toHaveText('Saving choice…');
    hold.release();
    await expect(page.locator('.empty-stage .dropzone')).toBeFocused();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
    await summary(page).press('Enter');
    await expect(summary(page)).toBeFocused();
    await expect(selectedChoice(page)).toBeEnabled();
    await expect(summary(page)).toContainText('Gemini 3.6 Flash');
    await expect(selectedChoice(page)).toHaveValue('gemini-3.6-flash');
    expect(writes).toHaveLength(1);
  } finally { hold.release(); }
});
