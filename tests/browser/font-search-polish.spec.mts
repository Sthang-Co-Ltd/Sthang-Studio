import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.fonts.push(...Array.from({ length: 26 }, (_, index) => ({ name: `Khmer Test ${String(index + 1).padStart(2, '0')}`, source: 'user-installed' as const, available: true, boldAvailable: true })));
});
async function openSearch(page: Page) {
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  return page.getByRole('combobox', { name: 'Find Khmer font', exact: true });
}
for (const width of [1440, 390]) test(`font search ${width} browses with arrows, cancels without changes, then commits one explicit choice`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const input = await openSearch(page);
  const picker = page.getByLabel('Khmer font', { exact: true });
  const original = await picker.inputValue();
  await input.fill('Khmer Test');
  await expect(page.getByRole('option', { name: /Khmer Test 01.*Regular/, selected: true })).toHaveCount(1);
  await input.press('ArrowDown');
  await expect(page.getByRole('option', { name: /Khmer Test 02.*Regular/, selected: true })).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect(picker).toHaveValue(original);
  const selectedId = await input.getAttribute('aria-activedescendant');
  expect(selectedId).toBe(await page.getByRole('listbox').getByRole('option', { selected: true }).getAttribute('id'));
  await page.screenshot({ path: info.outputPath(`font-search-${width}.png`) });
  await input.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(picker).toHaveValue(original);
  await expect(input).toHaveValue('Khmer Test');
  await input.press('ArrowDown'); await input.press('ArrowDown'); await input.press('Enter');
  await expect(picker).toHaveValue('Khmer Test 02');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await page.locator('.appearance-history').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(picker).toHaveValue(original);
});

test('Khmer IME composition and legacy composition keys cannot select a font', async ({ page }) => {
  const input = await openSearch(page);
  const picker = page.getByLabel('Khmer font', { exact: true }); const original = await picker.inputValue();
  await input.fill('Khmer Test');
  await input.dispatchEvent('compositionstart', { data: 'ក' });
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(picker).toHaveValue(original);
  await expect(input).toHaveValue('Khmer Test');
  await input.dispatchEvent('compositionend', { data: 'ក' });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  await expect(picker).toHaveValue(original);
  await input.press('Enter');
  await expect(picker).toHaveValue('Khmer Test 01');
});

test('empty results and Tab do not commit a font, while pointer selection still works', async ({ page }) => {
  const input = await openSearch(page); const picker = page.getByLabel('Khmer font', { exact: true }); const original = await picker.inputValue();
  await input.fill('No such font'); await input.press('Enter');
  await expect(page.getByText('No matching Khmer fonts', { exact: true })).toBeVisible();
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.fill('Khmer Test 03'); await input.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(picker).toHaveValue(original);
  await input.focus();
  await page.getByRole('listbox').getByRole('option', { name: /Khmer Test 03/ }).click();
  await expect(picker).toHaveValue('Khmer Test 03');
});
