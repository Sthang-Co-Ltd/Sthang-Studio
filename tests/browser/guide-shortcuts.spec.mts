import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);

for (const [platform, width] of [['Win32', 1440], ['Win32', 390], ['MacIntel', 820]] as const) test(`Quick guide exposes scoped ${platform} shortcuts at ${width}px`, async ({ page }, info) => {
  await installFixture(page);
  await page.addInitScript((platform) => Object.defineProperty(navigator, 'platform', { value: platform }), platform);
  await page.setViewportSize({ width, height: 900 });
  await openProject(page);
  const before = await page.getByLabel('Caption 1 text', { exact: true }).inputValue();
  await page.getByLabel('Open project tools', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Quick guide', exact: true }).click();
  const guide = page.getByRole('complementary', { name: 'Sthang Studio guide', exact: true });
  const shortcuts = guide.locator('.guide-shortcuts');
  await expect(shortcuts).not.toHaveAttribute('open', '');
  await shortcuts.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(shortcuts).toHaveAttribute('open', '');
  await expect(shortcuts.getByRole('heading', { name: 'Editing and playback', exact: true })).toBeVisible();
  await expect(shortcuts.getByRole('heading', { name: 'Review only', exact: true })).toBeVisible();
  await expect(shortcuts).toContainText(platform === 'MacIntel' ? 'Command+S' : 'Ctrl+S');
  await expect(shortcuts).toContainText(platform === 'MacIntel' ? 'Option+Left / Right' : 'Alt+Left / Right');
  await expect(shortcuts).toContainText('Skip without approving');
  await expect(shortcuts).toContainText('outside text fields and controls');
  await shortcuts.scrollIntoViewIfNeeded();
  expect(await guide.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(guide.getByRole('button', { name: 'Close guide', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath(`guide-${platform}-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(before);
});
