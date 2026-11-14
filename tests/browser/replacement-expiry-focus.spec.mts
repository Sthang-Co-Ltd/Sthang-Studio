import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { hydrateCaptionWordTimings } from '@kcs/shared';
import { cleanFixtures, fixtureMedia, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
const epoch = Date.parse('2026-11-14T12:00:00.000Z');
const label = 'I accept the existing times and will check their alignment.';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Replace media', exact: true });
const checkbox = (page: Page) => dialog(page).getByRole('checkbox', { name: label, exact: true });
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.projects[0] = hydrateCaptionWordTimings(state.projects[0]);
  state.projects[0].captions[0].approved = true;
  state.projects[0].transcriptionContext = { description: 'Saved synthetic context', vocabulary: ['SavedBrand'] };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date(epoch) });
});
async function audioWarning(page: Page) {
  const requests: Array<{ mode?: string; confirmation?: string }> = [];
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataBuffer()?.toString('utf8') || '';
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1];
    requests.push({ mode: field('mode'), confirmation: field('audioChangeConfirmation') });
    // Return only a new warning. This fixture never grants a saved replacement.
    return route.fulfill({ status: 422, json: { error: 'Synthetic replacement audio differs.', code: 'MEDIA_AUDIO_MISMATCH',
      preserveAudioConfirmation: { token: `synthetic-expiry-token-${requests.length}`, expiresAt: new Date(epoch + requests.length * 60_000).toISOString() } } });
  });
  await openProject(page);
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__replacementExpiryNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
  await page.getByLabel('Open project tools', { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /^Replace media/ }).click();
  await (await chooser).setFiles({ name: 'synthetic-expiry-review.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
  await dialog(page).getByRole('button', { name: 'Replace and keep captions', exact: true }).click();
  await expect(checkbox(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Replace and keep existing times', exact: true })).toBeDisabled();
  return requests;
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { focused: document.activeElement === node, visible: rect.width > 0 && rect.height > 0
      && rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1
      && (hit === node || (hit !== null && node.contains(hit))) };
  })).toEqual({ focused: true, visible: true });
}
async function unchanged(page: Page, original: string) {
  expect(JSON.stringify(state.projects)).toBe(original);
  expect(await page.evaluate(() => (window as any).__replacementExpiryNodes.every((node: Element, index: number) =>
    node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  expect(state.jobs).toEqual([]);
}

for (const width of [1440, 390]) test(`expired focused audio consent hands off visibly and rechecks without its old token at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const original = JSON.stringify(state.projects);
  const requests = await audioWarning(page);
  await checkbox(page).focus(); await page.keyboard.press('Space');
  await expect(checkbox(page)).toBeChecked(); await expect(checkbox(page)).toBeFocused();
  await page.clock.fastForward(61_000);
  await expect(checkbox(page)).toHaveCount(0);
  await expect(dialog(page).getByText('The audio check expired. Check the replacement again before continuing.', { exact: true })).toBeVisible();
  await visibleFocus(dialog(page).getByRole('button', { name: 'Cancel', exact: true }));
  await page.screenshot({ path: info.outputPath(`replacement-expiry-focus-${width}.png`), animations: 'disabled' });
  expect(requests).toEqual([{ mode: 'preserve', confirmation: undefined }]);
  const recheck = dialog(page).getByRole('button', { name: 'Check replacement again', exact: true });
  await recheck.focus(); await page.keyboard.press('Enter');
  await expect(checkbox(page)).toBeVisible(); await expect(checkbox(page)).not.toBeChecked();
  await expect(dialog(page).getByRole('button', { name: 'Replace and keep existing times', exact: true })).toBeDisabled();
  expect(requests).toEqual([{ mode: 'preserve', confirmation: undefined }, { mode: 'preserve', confirmation: undefined }]);
  await unchanged(page, original);
});

test('consent expiry leaves a newer dialog control focused and closing cancels future handoff', async ({ page }) => {
  const original = JSON.stringify(state.projects);
  const requests = await audioWarning(page);
  await checkbox(page).check();
  const newer = dialog(page).getByRole('button', { name: 'Cancel media replacement', exact: true });
  await newer.focus();
  await page.clock.fastForward(61_000);
  await expect(checkbox(page)).toHaveCount(0); await expect(newer).toBeFocused();
  await dialog(page).getByRole('button', { name: 'Check replacement again', exact: true }).click();
  await expect(checkbox(page)).toBeVisible();
  await newer.focus();
  await newer.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  await page.clock.fastForward(61_000);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  expect(requests).toEqual([{ mode: 'preserve', confirmation: undefined }, { mode: 'preserve', confirmation: undefined }]);
  await unchanged(page, original);
});
