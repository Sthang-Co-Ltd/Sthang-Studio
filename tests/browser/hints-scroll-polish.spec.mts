import { test, expect } from '@playwright/test';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => { await installFixture(page); });

test('pointer hints wait, remain hoverable and dismiss without closing the workspace', async ({ page }, info) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
  expect(identity.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
  await info.attach('frontend-identity', { body: JSON.stringify({ buildId: identity.buildId }), contentType: 'application/json' });
  const current = page.getByRole('button', { name: 'Current', exact: true });
  await current.hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Jump to the caption at the playhead');
  await expect(tip.locator('kbd')).toHaveText('J');
  await expect(current).not.toHaveAttribute('title');
  await tip.hover();
  await page.waitForTimeout(550);
  await expect(tip).toBeVisible();
  await page.screenshot({ path: info.outputPath('hoverable-hint.png') });
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveCount(0);
});

test('keyboard hints retain existing descriptions and focus; pointer clicks do not leave orphan hints', async ({ page }) => {
  await openProject(page);
  const current = page.getByRole('button', { name: 'Current', exact: true });
  await current.evaluate((node) => {
    const description = document.createElement('span'); description.id = 'existing-hint'; description.hidden = true; description.textContent = 'Existing description';
    document.body.append(description); node.setAttribute('aria-describedby', description.id);
  });
  await page.keyboard.press('Tab');
  await current.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const id = await page.getByRole('tooltip').getAttribute('id');
  expect((await current.getAttribute('aria-describedby'))?.split(' ')).toEqual(['existing-hint', id]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(current).toBeFocused();
  await expect(current).toHaveAttribute('aria-describedby', 'existing-hint');
  await page.waitForTimeout(500);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Export', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Export SRT');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('pending hints leave Escape to the workspace and open menus suppress background hints', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Current', exact: true }).hover();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveCount(0);
  const row = page.getByLabel('More actions for caption 1', { exact: true });
  await row.click();
  await row.hover();
  await page.waitForTimeout(600);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

for (const width of [1440, 390]) test(`hints remain inside a ${width}px viewport with reduced motion`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProject(page);
  const back = page.getByRole('button', { name: 'Back to projects', exact: true });
  await back.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
  expect(await tip.evaluate((node) => node.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`hint-${width}.png`) });
});

test('scroll cues follow long inspector and sheet boundaries without resizing evidence', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByText('More appearance', { exact: true }).click();
  const pane = page.locator('.inspector-content');
  await expect.poll(() => pane.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.evaluate(() => { (window as any).__evidence = [document.querySelector('video'), document.querySelector('.caption-panel')]; });
  const before = await page.locator('.caption-panel').boundingBox();
  for (const position of ['top', 'middle', 'bottom']) {
    await pane.evaluate((node, where) => { node.scrollTop = where === 'top' ? 0 : where === 'middle' ? (node.scrollHeight - node.clientHeight) / 2 : node.scrollHeight; }, position);
    await page.screenshot({ path: info.outputPath(`inspector-${position}.png`) });
  }
  expect(await page.locator('.caption-panel').boundingBox()).toEqual(before);
  expect(await page.evaluate(() => (window as any).__evidence.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-panel' : 'video')))).toBe(true);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  const sheet = page.locator('.ai-settings-body');
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings-short.png') });
  await page.setViewportSize({ width: 1440, height: 520 });
  await expect.poll(() => sheet.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await sheet.evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('settings-top.png') });
  await sheet.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.screenshot({ path: info.outputPath('settings-bottom.png') });
});
