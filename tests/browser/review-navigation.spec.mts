import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
  const original = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 18 }, (_, index) => ({
    ...original, id: `ux-${index + 1}`, text: `កម្ពុជា caption ${index + 1}`,
    startMs: 100 + index * 200, endMs: 270 + index * 200,
    timingSource: 'stt' as const, timingQuality: 'low' as const, approved: false,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
});

const row = (page: Page, id: string) => page.locator(`.caption-row[data-caption-id="${id}"]`);
const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const skip = (page: Page) => review(page).getByRole('button', { name: 'Skip', exact: true });
const approveRow = (page: Page, id: string) => row(page, id).getByRole('button', { name: 'Approve caption and move to the next review item', exact: true });

async function openReview(page: Page) {
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(review(page)).toBeVisible();
  await expect(row(page, 'ux-1')).toHaveClass(/selected-range/);
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
}

async function spyOnListScroll(page: Page) {
  await page.locator('.caption-list').evaluate((list: HTMLElement) => {
    (window as any).__reviewScrollCalls = [];
    const original = list.scrollTo.bind(list);
    list.scrollTo = ((options: ScrollToOptions) => {
      (window as any).__reviewScrollCalls.push(options);
      original(options);
    }) as typeof list.scrollTo;
  });
}

test('Skip keeps nearby Review items in place rather than recentering every decision', async ({ page }) => {
  await openReview(page);
  await page.waitForTimeout(100); // The caller schedules navigation by 40 ms.
  await spyOnListScroll(page);
  const before = await page.locator('.caption-list').evaluate((list) => list.scrollTop);

  await skip(page).click();
  await expect(row(page, 'ux-2')).toHaveClass(/selected-range/);
  await skip(page).click();
  await expect(row(page, 'ux-3')).toHaveClass(/selected-range/);
  await page.waitForTimeout(100);

  expect(await page.evaluate(() => (window as any).__reviewScrollCalls)).toEqual([]);
  expect(await page.locator('.caption-list').evaluate((list) => list.scrollTop)).toBeCloseTo(before, 0);
  await expect(skip(page)).toBeFocused();
});

test('row approval preserves the next caption position and transfers keyboard focus through rapid decisions', async ({ page }) => {
  await openReview(page);
  const list = page.locator('.caption-list');
  await list.evaluate((node) => { node.scrollTop = 520; });
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);

  const targets = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.caption-list')!;
    const rect = list.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.caption-row'));
    const current = rows.find((candidate, index) => index < rows.length - 3 &&
      candidate.getBoundingClientRect().top >= rect.top + 135 &&
      candidate.getBoundingClientRect().bottom <= rect.bottom - 180);
    const next = current?.nextElementSibling as HTMLElement | null;
    const later = next?.nextElementSibling as HTMLElement | null;
    return { current: current?.dataset.captionId, next: next?.dataset.captionId, later: later?.dataset.captionId };
  });
  expect(targets.current).toBeTruthy();
  expect(targets.next).toBeTruthy();
  expect(targets.later).toBeTruthy();

  const next = row(page, targets.next!);
  const nextPosition = await next.evaluate((node) => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top);
  await approveRow(page, targets.current!).click();
  await expect(row(page, targets.current!)).toHaveCount(0);
  await expect(approveRow(page, targets.next!)).toBeFocused();
  await expect(next).toHaveClass(/selected-range/);
  expect(await next.evaluate((node) => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top)).toBeCloseTo(nextPosition, 0);

  await page.keyboard.press('Enter');
  await expect(row(page, targets.next!)).toHaveCount(0);
  await expect(approveRow(page, targets.later!)).toBeFocused();
  await expect(row(page, targets.later!)).toHaveClass(/selected-range/);
});

test('Approve & next preserves a surviving decision row without stealing focus from the primary action', async ({ page }) => {
  await openReview(page);
  const list = page.locator('.caption-list');
  await list.evaluate((node) => { node.scrollTop = 520; });
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  const targets = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.caption-list')!;
    const rect = list.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.caption-row'));
    const current = rows.find((candidate, index) => index < rows.length - 2 &&
      candidate.getBoundingClientRect().top >= rect.top + 135 &&
      candidate.getBoundingClientRect().bottom <= rect.bottom - 180);
    return { current: current?.dataset.captionId, next: (current?.nextElementSibling as HTMLElement | null)?.dataset.captionId };
  });
  expect(targets.current).toBeTruthy();
  expect(targets.next).toBeTruthy();
  await row(page, targets.current!).click();
  await expect(row(page, targets.current!)).toHaveClass(/selected-range/);
  const next = row(page, targets.next!);
  const before = await next.evaluate((node) => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top);

  const approve = review(page).getByRole('button', { name: 'Approve & next', exact: true });
  await approve.click();
  await expect(row(page, targets.current!)).toHaveCount(0);
  await expect(next).toHaveClass(/selected-range/);
  expect(await next.evaluate((node) => node.getBoundingClientRect().top - node.parentElement!.getBoundingClientRect().top)).toBeCloseTo(before, 0);
  await expect(approve).toBeFocused();
});

test('reduced-motion Review navigation never requests smooth scrolling for an offscreen target', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReview(page);
  const list = page.locator('.caption-list');
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  await spyOnListScroll(page);

  await skip(page).click();
  await expect(row(page, 'ux-2')).toHaveClass(/selected-range/);
  await expect.poll(() => page.evaluate(() => (window as any).__reviewScrollCalls.length)).toBeGreaterThan(0);
  const calls = await page.evaluate(() => (window as any).__reviewScrollCalls as ScrollToOptions[]);
  expect(calls.every((call) => call.behavior === 'instant')).toBe(true);
  await expect(skip(page)).toBeFocused();
});
