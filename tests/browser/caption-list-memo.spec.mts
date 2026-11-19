import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { markFixtureCaption } from './word-highlight-routes.mjs';

const test = base.extend<{ markedTracks: boolean }>({ markedTracks: [false, { option: true }], context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page, markedTracks }) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const first = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 1000 }, (_, index) => ({
    ...first, id: `list-memo-${index}`, text: `កម្ពុជា caption ${index}`,
    startMs: 200 + index * 1000, endMs: 800 + index * 1000, approved: false,
  }));
  if (markedTracks) state.projects[0].captions = state.projects[0].captions.map(markFixtureCaption);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const target = window as any;
    target.__captionListBuilds = [];
    target.__captionRowRenders = [];
    target.__STHANG_TEST_HOOKS__ = { ...(target.__STHANG_TEST_HOOKS__ || {}),
      onCaptionListBuild: (count: number) => target.__captionListBuilds.push(count),
      onCaptionRowRender: (id: string) => target.__captionRowRenders.push(id) };
  });
});
async function tick(page: Page, time: number) {
  await page.locator('video').evaluate((node: HTMLVideoElement, value) => {
    node.pause(); node.currentTime = value; node.dispatchEvent(new Event('timeupdate'));
  }, time);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function reset(page: Page) { await page.evaluate(() => { (window as any).__captionListBuilds = []; }); }
const builds = (page: Page) => page.evaluate(() => (window as any).__captionListBuilds as number[]);

test('unchanged clock ticks reuse the thousand-row element list, including an open menu', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(1000);
  await tick(page, .25);
  expect((await builds(page)).some((count) => count === 1000)).toBe(true);
  await reset(page);
  for (const time of [.27, .30, .33]) await tick(page, time);
  expect(await builds(page)).toEqual([]);

  await page.getByRole('button', { name: 'More actions for caption 1', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
  await expect(menu).toBeVisible();
  await tick(page, .35); await reset(page);
  for (const time of [.37, .40]) await tick(page, time);
  expect(await builds(page)).toEqual([]);
  // The cached menu still delegates current keyboard ownership and live actions.
  await page.keyboard.press('l');
  await expect(menu.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'More actions for caption 1', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Unlock text', exact: true }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).not.toHaveAttribute('readonly', '');
});

test('cached-list menu actions retain a newer independent draft and their current row revision', async ({ page }) => {
  await openProject(page);
  await tick(page, .25);
  const field = page.getByLabel('Caption 501 text', { exact: true });
  const text = 'កម្ពុជា current independent draft';
  await field.fill(text);
  const more = page.getByRole('button', { name: 'More actions for caption 1', exact: true });
  await more.click();
  const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
  await expect(menu).toBeVisible();
  await tick(page, .3);
  await menu.getByRole('menuitem', { name: 'Lock timing', exact: true }).click();
  await expect(page.getByLabel('Caption 1 start time', { exact: true })).toBeDisabled();
  await expect(field).toHaveValue(text);
  await more.click();
  await menu.getByRole('menuitem', { name: 'Unlock timing', exact: true }).click();
  await expect(page.getByLabel('Caption 1 start time', { exact: true })).toBeEnabled();
  await expect(field).toHaveValue(text);
  await expect(page.locator('.caption-row')).toHaveCount(1000);
});

test.describe('with marked word timings', () => {
  test.use({ markedTracks: true });

  test('editing one caption only rerenders the edited row', async ({ page }) => {
    await openProject(page);
    await expect(page.locator('.caption-row')).toHaveCount(1000);
    await tick(page, .25);
    const field = page.getByLabel('Caption 501 text', { exact: true });
    await field.focus();
    await page.evaluate(() => { (window as any).__captionRowRenders = []; });
    await field.fill('កម្ពុជា caption 500 edited');
    await expect(page.locator('.save-action')).toBeEnabled();

    const rendered = await page.evaluate(() => (window as any).__captionRowRenders as string[]);
    expect([...new Set(rendered)]).toEqual(['list-memo-500']);
    await expect(field).toHaveValue('កម្ពុជា caption 500 edited');
  });
});
