import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  const project = state.projects[0];
  const original = project.captions[0];
  project.captions = Array.from({ length: 1000 }, (_, index) => {
    const caption = { ...original, id: `heavy-${index}`, text: `កម្ពុជា caption ${index}`,
      startMs: 200 + index * 1000, endMs: 800 + index * 1000, approved: false };
    delete caption.wordTiming;
    return caption;
  });
  // The source remains the ordinary short fixture: only first-cue playback is
  // exercised. Long-list tests concern mounted rows and exact user intent.
  project.transcript!.segments = structuredClone(project.captions);
  project.transcript!.tokens = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const target = window as any;
    target.__ux17RowRenders = [];
    target.__STHANG_TEST_HOOKS__ = { ...(target.__STHANG_TEST_HOOKS__ || {}),
      onCaptionRowRender: (id: string) => target.__ux17RowRenders.push(id) };
  });
});

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function clock(page: Page, time: number) {
  await page.locator('video').evaluate((node: HTMLVideoElement, value) => {
    node.pause(); node.currentTime = value; node.dispatchEvent(new Event('timeupdate'));
  }, time);
  await settle(page);
}
async function resetRenders(page: Page) { await page.evaluate(() => { (window as any).__ux17RowRenders = []; }); }
async function renders(page: Page): Promise<string[]> { return page.evaluate(() => (window as any).__ux17RowRenders); }
async function save(page: Page) {
  const button = page.locator('.save-action');
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  await button.click();
  await expect(button.locator('.save-action-label')).toHaveText('Saved');
}
const row = (page: Page, id: string) => page.locator(`.caption-row[data-caption-id="${id}"]`);

test('a thousand mounted caption fields skip unchanged playback renders and keep the typing caret', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(1000);
  await clock(page, .25);
  await resetRenders(page);
  for (const time of [.27, .30, .34]) await clock(page, time);
  expect(await renders(page)).toEqual([]);

  const field = page.getByLabel('Caption 501 text', { exact: true });
  await field.focus();
  await settle(page);
  await resetRenders(page);
  const value = 'កម្ពុជា caption 500 edited';
  await field.fill(value);
  await settle(page);
  const changed = await renders(page);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every((id) => id === 'heavy-500')).toBe(true);
  await field.evaluate((node: HTMLTextAreaElement) => {
    node.setSelectionRange(3, 3);
    (window as any).__ux17Evidence = [document.querySelector('video'), document.querySelector('.caption-list'), node];
  });
  await resetRenders(page);
  await clock(page, .36);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(value);
  expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([3, 3]);
  expect(await renders(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__ux17Evidence.every((node: Element, index: number) =>
    node === (index === 0 ? document.querySelector('video') : index === 1 ? document.querySelector('.caption-list') : document.querySelector('[aria-label="Caption 501 text"]'))))).toBe(true);
  await expect(page.locator('.caption-row')).toHaveCount(1000);
});

test('latest timing and approval actions compose without losing another native field draft in a heavy list', async ({ page }) => {
  await openProject(page);
  const start = page.getByLabel('Caption 1 start time', { exact: true });
  await start.fill('0.350');
  // Blur commits the first timing edit before the following approval click.
  await row(page, 'heavy-1').getByRole('button', { name: 'Approve caption', exact: true }).click();
  await expect(start).toHaveValue('00:00.350');
  await expect(row(page, 'heavy-1').locator('.row-approve')).toHaveAttribute('aria-pressed', 'true');
  await save(page);
  expect(state.projects[0].captions[0].startMs).toBe(350);
  expect(state.projects[0].captions[1].approved).toBe(true);

  await start.fill('unfinished timestamp');
  await row(page, 'heavy-2').getByRole('button', { name: 'Approve caption', exact: true }).click();
  await expect(start).toHaveValue('unfinished timestamp');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await expect(row(page, 'heavy-2').locator('.row-approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.caption-row')).toHaveCount(1000);
});

test('a heavy-list row menu reopened after another cue edit keeps both current changes', async ({ page }) => {
  await openProject(page);
  const middle = row(page, 'heavy-500');
  await middle.getByRole('button', { name: 'More actions for caption 501', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Caption 501 actions', exact: true });
  await expect(menu).toBeVisible();
  // Real editing leaves the menu first. Reopening must use the new draft and
  // handlers, rather than an old memoized row callback that loses this text.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  const otherText = 'កម្ពុជា caption 0 — newer independent edit';
  await page.getByLabel('Caption 1 text', { exact: true }).fill(otherText);
  await middle.getByRole('button', { name: 'More actions for caption 501', exact: true }).click();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Lock text', exact: true }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(otherText);
  await expect(middle.getByLabel('Caption 501 text', { exact: true })).toHaveAttribute('readonly', '');
  await middle.getByRole('button', { name: 'More actions for caption 501', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: 'Unlock text', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Unlock text', exact: true }).click();
  await expect(middle.getByLabel('Caption 501 text', { exact: true })).not.toHaveAttribute('readonly', '');
  await save(page);
  expect(state.projects[0].captions[0].text).toBe(otherText);
  expect(state.projects[0].captions[500].textLocked).toBe(false);
  expect(state.projects[0].captions[499].textLocked).not.toBe(true);
  await expect(page.locator('.caption-row')).toHaveCount(1000);
});
