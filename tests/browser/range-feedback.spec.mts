import { test, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
});

const exact = (page: Page, label: string) => page.getByLabel(`Exact ${label}`, { exact: true });
const field = (input: Locator) => input.locator('xpath=ancestor::div[contains(@class,"appearance-number-control")]');
const feedback = (input: Locator) => field(input).locator('.appearance-number-feedback');

async function openAppearance(page: Page, more = false) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  if (more) await page.getByText('More appearance', { exact: true }).click();
}

async function commit(input: Locator, value: string, key: 'Enter' | 'Tab' = 'Enter') {
  await input.fill(value); await input.press(key);
}

for (const key of ['Enter', 'Tab'] as const) test(`typed values explain maximum and minimum clamps with ${key}, including an already-current boundary`, async ({ page }) => {
  await openAppearance(page);
  const size = exact(page, 'size');
  const position = exact(page, 'position');
  const originalPosition = await position.inputValue();
  await commit(size, '999', key);
  await expect(size).toHaveValue('120');
  await expect(feedback(size)).toHaveText('Adjusted to 120 px — the maximum.');
  await expect(feedback(size)).toHaveAttribute('role', 'status');
  const described = (await size.getAttribute('aria-describedby'))!.split(' ');
  expect(described).toContain(await feedback(size).getAttribute('id'));
  expect(described).toHaveLength(2); // Existing “At 1080p” context is retained.
  await expect(position).toHaveValue(originalPosition);
  await expect(feedback(position)).toHaveCount(0);
  await commit(size, '999', key);
  await expect(feedback(size)).toHaveText('Adjusted to 120 px — the maximum.');
  await commit(position, '-20', key);
  await expect(position).toHaveValue('3');
  await expect(feedback(position)).toHaveText('Adjusted to 3 % — the minimum.');
  await commit(position, '-20', key);
  await expect(feedback(position)).toHaveText('Adjusted to 3 % — the minimum.');
  await expect(size).toHaveValue('120');
});

test('step rounding stays one undoable edit and Undo or Redo does not revive old feedback', async ({ page }) => {
  await openAppearance(page, true);
  const outline = exact(page, 'outline');
  const original = await outline.inputValue();
  await commit(outline, '2.26');
  await expect(outline).toHaveValue('2.5');
  await expect(feedback(outline)).toHaveText('Rounded to 2.5 px — nearest 0.5 px step.');
  await page.locator('.appearance-history').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(outline).toHaveValue(original);
  await expect(feedback(outline)).toHaveCount(0);
  await page.locator('.appearance-history').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(outline).toHaveValue('2.5');
  await expect(feedback(outline)).toHaveCount(0);
});

test('untouched fractional values, valid changes, empty drafts and Escape stay quiet', async ({ page }) => {
  state.projects[0].captionAppearance = { ...state.projects[0].captionAppearance!, backgroundEnabled: true, backgroundOpacity: 0.554 };
  await openAppearance(page, true);
  const opacity = exact(page, 'background opacity');
  const outline = exact(page, 'outline');
  const originalOutline = await outline.inputValue();
  await expect(opacity).toHaveValue('55.4');
  await opacity.focus(); await opacity.press('Tab');
  await expect(opacity).toHaveValue('55.4');
  await expect(feedback(opacity)).toHaveCount(0);
  expect(state.projects[0].captionAppearance!.backgroundOpacity).toBe(0.554);
  await commit(opacity, '61');
  await expect(opacity).toHaveValue('61');
  await expect(feedback(opacity)).toHaveCount(0);
  await opacity.fill('999'); await opacity.press('Escape');
  await expect(opacity).toHaveValue('61');
  await expect(feedback(opacity)).toHaveCount(0);
  await opacity.fill(''); await opacity.press('Tab');
  await expect(opacity).toHaveValue('61');
  await expect(feedback(opacity)).toHaveCount(0);
  await expect(outline).toHaveValue(originalOutline);
});

test('new typing, per-setting Reset and slider interaction clear accepted-value feedback', async ({ page }) => {
  await openAppearance(page);
  const size = exact(page, 'size');
  const original = await size.inputValue();
  await commit(size, '999');
  await expect(feedback(size)).toBeVisible();
  await size.fill('119');
  await expect(feedback(size)).toHaveCount(0);
  await size.press('Enter');
  await expect(size).toHaveValue('119');
  await expect(feedback(size)).toHaveCount(0);
  await commit(size, '999');
  await field(size).getByRole('button', { name: /^Reset size to/ }).click();
  await expect(size).toHaveValue(original);
  await expect(feedback(size)).toHaveCount(0);
  await commit(size, '999');
  const slider = page.getByRole('slider', { name: 'Size slider', exact: true });
  await slider.focus();
  await expect(feedback(size)).toBeVisible();
  await slider.press('ArrowLeft');
  await expect(size).toHaveValue('119');
  await expect(feedback(size)).toHaveCount(0);
  await expect(feedback(size)).toHaveCount(0);
});

test.describe('mobile feedback', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('long rounding feedback wraps inside its field with readable text and no page overflow', async ({ page }, info) => {
    await openAppearance(page, true);
    const outline = exact(page, 'outline');
    await commit(outline, '2.26');
    const status = feedback(outline);
    await expect(status).toHaveText('Rounded to 2.5 px — nearest 0.5 px step.');
    await status.evaluate((node) => node.scrollIntoView({ block: 'end', behavior: 'instant' }));
    expect(await status.evaluate((node) => ({
      readable: parseFloat(getComputedStyle(node).fontSize) >= 12,
      wrapping: getComputedStyle(node).whiteSpace,
      fits: node.scrollWidth <= node.clientWidth + 1,
    }))).toEqual({ readable: true, wrapping: 'normal', fits: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('range-feedback-mobile.png') });
  });
});
