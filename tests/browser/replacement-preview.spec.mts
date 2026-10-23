import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openCorrection(page: import('@playwright/test').Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
  return page.locator('.find-replace-modal');
}

test('before/after stays exact for Khmer, locked matches and regex, then applies once', async ({ page }, info) => {
  state.projects[0].captions[0].text = 'ខ្មែរ CapCut';
  state.projects[0].captions[1].text = 'ខ្មែរ CapCut';
  state.projects[0].captions[1].textLocked = true;
  const panel = await openCorrection(page);
  await panel.getByLabel('Find', { exact: true }).fill('ខ្មែរ');
  await panel.getByLabel('Replace with', { exact: true }).fill('កម្ពុជា');
  await expect(panel.locator('.find-before').first()).toHaveText('ខ្មែរ CapCut');
  await expect(panel.locator('.find-after').first()).toHaveText('កម្ពុជា CapCut');
  await expect(panel.locator('.find-after').nth(1)).toHaveText('ខ្មែរ CapCut');
  await expect(panel).toContainText('After · locked, unchanged');
  await page.screenshot({ path: info.outputPath('replacement-desktop.png') });
  await panel.locator('label:has-text("Match") select').selectOption('regex');
  await panel.getByLabel('Find', { exact: true }).fill('(Cap)(Cut)');
  await panel.getByLabel('Replace with', { exact: true }).fill('$2-$1');
  await expect(panel.locator('.find-after').first()).toHaveText('ខ្មែរ Cut-Cap');
  await panel.getByRole('button', { name: 'Replace editable matches' }).click();
  await expect(page.locator('.caption-row textarea').first()).toHaveValue('ខ្មែរ Cut-Cap');
  await expect(page.locator('.caption-row textarea').nth(1)).toHaveValue('ខ្មែរ CapCut');
});

test('deletion, unchanged proposals and invalid regex are clear before applying', async ({ page }) => {
  const panel = await openCorrection(page);
  await panel.getByLabel('Find', { exact: true }).fill('Third caption');
  await panel.getByLabel('Replace with', { exact: true }).fill('Third caption');
  await expect(panel.getByRole('button', { name: 'Replace editable matches' })).toBeDisabled();
  await panel.getByLabel('Replace with', { exact: true }).fill('');
  await expect(panel.locator('.find-after')).toHaveText('Empty caption text');
  await panel.locator('label:has-text("Match") select').selectOption('regex');
  await panel.getByLabel('Find', { exact: true }).fill('[');
  await expect(panel).toContainText('Invalid regular expression');
  await expect(panel.getByRole('button', { name: 'Replace editable matches' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.caption-row textarea').nth(2)).toHaveValue('Third caption');
});

test('every proposal is reachable and mobile copy wraps without horizontal overflow', async ({ page }, info) => {
  state.projects[0].captions = Array.from({ length: 65 }, (_, index) => ({ id: `many-${index}`, text: `ខ្មែរ ${index} ${'LongWord'.repeat(12)}`, startMs: index * 50, endMs: index * 50 + 40 }));
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openCorrection(page);
  await panel.getByLabel('Find', { exact: true }).fill('ខ្មែរ');
  await panel.getByLabel('Replace with', { exact: true }).fill('កម្ពុជា');
  await expect(panel.locator('.find-after')).toHaveCount(30);
  await panel.getByRole('button', { name: 'Next matches' }).click();
  await panel.getByRole('button', { name: 'Next matches' }).click();
  await expect(panel.locator('.find-after')).toHaveCount(5);
  await expect(panel.locator('.find-after').last()).toContainText('កម្ពុជា 64');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('replacement-mobile.png') });
  await panel.getByLabel('Replace with', { exact: true }).fill('ថ្មី');
  await expect(panel.getByRole('navigation', { name: 'Replacement preview pages' })).toContainText('Page 1 of 3');
});
