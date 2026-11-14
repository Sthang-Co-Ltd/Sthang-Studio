import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

for (const width of [1440, 390]) test('pasted timestamp notation stays exact and invalid drafts stay recoverable at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await openProject(page);
  const start = page.getByLabel('Caption 1 start time', { exact: true });
  const text = page.getByLabel('Caption 1 text', { exact: true });
  const originalText = await text.inputValue();
  await start.fill(' 00:00:00,350 ');
  await start.press('Enter');
  await expect(start).toHaveValue('00:00.350');
  await start.evaluate((input: HTMLInputElement) => input.blur());
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(350);

  await start.fill('០០:០០.៤០០');
  await start.press('Enter');
  await expect(start).toHaveValue('00:00.400');
  await start.evaluate((input: HTMLInputElement) => input.blur());
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(400);
  expect(state.projects[0].captions[0].endMs).toBe(1000);
  await expect(text).toHaveValue(originalText);

  await start.fill('00:99,000');
  await start.press('Enter');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await expect(start).toHaveValue('00:99,000');
  expect(state.projects[0].captions[0].startMs).toBe(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('timestamp-error-' + width + '.png') });
  await start.press('Escape');
  await expect(start).toHaveValue('00:00.400');
  await expect(start).not.toHaveAttribute('aria-invalid', 'true');

  await start.fill(' 00:00:01,500 ');
  await start.press('Enter');
  await expect(start).toHaveAttribute('aria-invalid', 'true');
  await expect(start.locator('..')).toContainText('Latest');
  await start.press('Escape');
  await expect(start).toHaveValue('00:00.400');
  expect(state.projects[0].captions[0].startMs).toBe(400);
});

test('timestamp Enter during Khmer composition does not commit the unfinished input', async ({ page }) => {
  await openProject(page);
  const start = page.getByLabel('Caption 1 start time', { exact: true });
  await start.fill('០០:០០.៤០០');
  await start.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  await expect(start).toHaveValue('០០:០០.៤០០');
  expect(state.projects[0].captions[0].startMs).toBe(200);
  await start.press('Enter');
  await expect(start).toHaveValue('00:00.400');
});
