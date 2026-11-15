import { test as base, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);

for (const width of [1440, 390]) test(`font search leaves modified text/navigation keys alone at ${width}px`, async ({ page }) => {
  const state = await installFixture(page);
  state.fonts.push(...Array.from({ length: 26 }, (_, index) => ({ name: `Khmer Test ${String(index + 1).padStart(2, '0')}`, source: 'user-installed' as const, available: true, boldAvailable: true })));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width, height: 1000 });
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find Khmer font', exact: true });
  const picker = page.getByLabel('Khmer font', { exact: true });
  const original = await picker.inputValue();
  await input.fill('Khmer Test');
  const active = await input.getAttribute('aria-activedescendant');
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'altGraph'] as const) for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
    const prevented = await input.evaluate((node, { modifier, key }) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, [modifier]: true });
      if (modifier === 'altGraph') Object.defineProperty(event, 'getModifierState', { value: (value: string) => value === 'AltGraph' });
      node.dispatchEvent(event); return event.defaultPrevented;
    }, { modifier, key });
    expect(prevented, `${modifier}+${key}`).toBe(false);
    await expect(picker).toHaveValue(original); await expect(input).toHaveValue('Khmer Test');
    await expect(input).toHaveAttribute('aria-activedescendant', active!);
    await expect(page.getByRole('listbox', { name: 'Matching Khmer fonts', exact: true })).toBeVisible();
  }
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(picker).toHaveValue('Khmer Test 02'); await expect(input).toHaveValue('');
  await page.locator('.appearance-history').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(picker).toHaveValue(original);
});
