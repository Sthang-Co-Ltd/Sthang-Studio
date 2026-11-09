import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    // Playwright records assertion and fixture teardown failures separately.
    await closeOwnedBrowserContext(context);
  },
});

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
});
const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const approve = (page: Page) => review(page).getByRole('button', { name: 'Approve & next', exact: true });
const completion = (page: Page) => page.getByRole('region', { name: 'All flagged captions reviewed', exact: true });
function cleanCaptions() {
  state.projects[0].captions.forEach((caption, index) => {
    caption.text = ['សួស្តី', 'អរគុណ', 'កម្ពុជា'][index]; caption.timingQuality = 'high'; caption.timingSource = 'stt'; caption.approved = false;
  });
}
async function openReview(page: Page) {
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(review(page)).toBeVisible();
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test('last approval offers deliberate next actions, preserves drafts and editor nodes, and Undo restores the queue', async ({ page }, info) => {
  cleanCaptions();
  state.projects[0].captions[0].timingQuality = 'low';
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } }));
  await openReview(page);
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.fill('កែសម្រួល');
  await page.evaluate(() => { (window as any).__completionNodes = [document.querySelector('video'), document.querySelector('.caption-panel')]; });
  await approve(page).click();
  await expect(completion(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All flagged captions reviewed', exact: true })).toBeFocused();
  await expect(approve(page)).toHaveCount(0);
  await expect(page.locator('.header-actions .tool-badge')).toHaveCount(0);
  await expect(page.locator('.editor-toolbar').getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Export workspace' })).toHaveCount(0);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(completion(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath('review-complete.png') });
  const undo = page.locator('.review-undo-toast').getByRole('button', { name: 'Undo', exact: true });
  await undo.focus(); await undo.press('Enter');
  await expect(approve(page)).toBeEnabled();
  await expect(approve(page)).toBeFocused();
  await expect(page.locator('.header-actions .tool-badge')).toHaveText('1');
  await expect(completion(page)).toHaveCount(0);
  await expect(text).toHaveValue('កែសម្រួល');
  await approve(page).click();
  await completion(page).getByRole('button', { name: 'Show all captions', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('.caption-row')).toHaveCount(3);
  await expect(text).toHaveValue('កែសម្រួល');
  await expect(page.locator('.header-actions').getByRole('button', { name: /^Review/ })).toBeFocused();
  expect(await page.evaluate(() => (window as any).__completionNodes.every((node: Element, i: number) => node === document.querySelector(i ? '.caption-panel' : 'video')))).toBe(true);
  expect(state.projects[0].captions[0].text).toBe('សួស្តី');
});

test('row approval cancels a pending post-edit replay on the final flagged caption', async ({ page }) => {
  cleanCaptions();
  state.projects[0].captions[0].timingQuality = 'low';
  await openReview(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('កែសម្រួល');
  await page.locator('.caption-row').getByRole('button', { name: 'Approve caption and move to the next review item', exact: true }).click();
  await expect(completion(page)).toBeVisible();
  // Cross the task/timer boundary that previously restarted completed playback.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.getByRole('heading', { name: 'All flagged captions reviewed', exact: true })).toBeFocused();
});

test('approval-suppressed flags still produce reviewed completion and Export opens without downloading', async ({ page }) => {
  cleanCaptions();
  state.projects[0].captions[0].timingQuality = 'medium';
  await openReview(page);
  await approve(page).click();
  await expect(completion(page)).toBeVisible();
  await completion(page).getByRole('button', { name: 'Continue to Export', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Export workspace', exact: true })).toBeVisible();
  await expect(page.locator('#export-checks-heading')).toBeFocused();
  expect(state.requests.some((request) => /\/export(?:$|\/)|\/render/.test(request.path) && request.method === 'POST')).toBe(false);
});

test('a clean initial project says no automatic risks and never claims review or approval', async ({ page }) => {
  cleanCaptions();
  await openReview(page);
  const clean = page.getByRole('region', { name: 'No automatic risks detected', exact: true });
  await expect(clean).toBeVisible();
  await expect(completion(page)).toHaveCount(0);
  await expect(clean).toContainText('You can still check the wording');
  await expect(approve(page)).toHaveCount(0);
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
  await clean.getByRole('button', { name: 'Show all captions', exact: true }).click();
  await expect(page.locator('.caption-row')).toHaveCount(3);
});

test('skipped captions remain pending and an approved flagged project retains completion on entry', async ({ page }) => {
  cleanCaptions();
  state.projects[0].captions[0].timingQuality = 'low';
  state.projects[0].captions[1].timingQuality = 'low';
  await openReview(page);
  await review(page).getByRole('button', { name: 'Skip', exact: true }).click();
  await approve(page).click();
  await expect(completion(page)).toHaveCount(0);
  await expect(page.locator('.caption-row')).toHaveCount(1);
  await approve(page).click();
  await expect(completion(page)).toBeVisible();
  await expect.poll(() => state.projects[0].captions.slice(0, 2).every((caption) => caption.approved)).toBe(true);
  await openReview(page);
  await expect(completion(page)).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 960, height: 540 }, { width: 390, height: 844 }]) {
  test.describe(`readability ${viewport.width}`, () => {
    test.use({ viewport });
    test('timestamp errors wrap beside the field without changing valid timing', async ({ page }, info) => {
      await openProject(page);
      const start = page.getByLabel('Caption 1 start time', { exact: true });
      await start.fill('bad'); await start.press('Enter');
      await expect(start).toHaveAttribute('aria-invalid', 'true');
      const error = start.locator('..').getByRole('alert');
      await expect(error).toContainText('Use m:ss');
      expect(await error.evaluate((node) => ({ size: parseFloat(getComputedStyle(node).fontSize), wrapping: getComputedStyle(node).whiteSpace, fits: node.scrollWidth <= node.clientWidth + 1 })))
        .toEqual({ size: 12, wrapping: 'normal', fits: true });
      expect(state.projects[0].captions[0].startMs).toBe(200);
      await expectNoOverflow(page);
      await page.screenshot({ path: info.outputPath(`timing-error-${viewport.width}.png`) });
      await start.press('Escape');
      await expect(start).toHaveValue('00:00.200');
      await expect(error).toHaveCount(0);
      await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
      const fine = page.getByLabel('Fine timing start', { exact: true });
      await expect(fine).toBeEnabled();
      await fine.fill('100'); await fine.press('Enter');
      await expect(fine.locator('..').getByRole('alert')).toContainText('Latest');
      await expectNoOverflow(page);
      await fine.press('Escape');
      await fine.fill('0.25'); await fine.press('Enter');
      await expect(fine).toHaveValue('00:00.250');
      await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
    });
  });
}

test.describe('touch completion', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('completion actions wrap and remain reachable with touch', async ({ page }, info) => {
    cleanCaptions();
    state.projects[0].captions[0].timingQuality = 'low';
    state.projects[0].captions[0].approved = true;
    await openReview(page);
    const button = completion(page).getByRole('button', { name: 'Continue to Export', exact: true });
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoOverflow(page);
    await page.screenshot({ path: info.outputPath('review-complete-touch.png') });
    await button.tap();
    await expect(page.getByRole('complementary', { name: 'Export workspace', exact: true })).toBeVisible();
  });
});
