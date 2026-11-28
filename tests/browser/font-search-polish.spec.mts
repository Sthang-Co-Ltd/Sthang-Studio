import { test, expect, type Page } from '@playwright/test';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.fonts.push(...Array.from({ length: 26 }, (_, index) => ({ name: `Khmer Test ${String(index + 1).padStart(2, '0')}`, source: 'user-installed' as const, available: true, boldAvailable: true })));
});
async function openSearch(page: Page) {
  await openProject(page); await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
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
// Use the locally discovered Khmer face and real native render for the ink check.
test('audition paints a mixed Khmer caption and leaves the project alone while browsing', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  state.native = true;
  const family = state.fonts[0].name;
  const { discoverCaptionFonts, publicCaptionFonts } = await import('../../apps/server/src/services/font-library.js');
  const available = publicCaptionFonts(await discoverCaptionFonts());
  const second = available.find((font) => font.name !== family && /moul|muol/i.test(font.name))
    ?? available.find((font) => font.name !== family);
  if (second) {
    state.fonts.push(second);
    state.capabilities = { ...capabilities, fonts: available };
  }
  const text = 'សួស្តី Studio 2026';
  state.projects[0].captions[1].text = text;
  let attempts = 0;
  await page.route('**/api/video-export/*/preview', async (route) => {
    const body = route.request().postDataJSON();
    if (body.resolution === '720p' && body.captions[0]?.startMs === 0 && body.captions[0]?.text === text
      && body.appearance.fontFamily === family && ++attempts === 1) return route.fulfill({ status: 429, body: '' });
    return route.fallback();
  });
  await openProject(page);
  await page.getByLabel('Caption 2 text', { exact: true }).click();
  await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Find Khmer font', exact: true });
  await input.fill(family);
  const sample = page.getByRole('figure', { name: 'Font preview' }).getByRole('img', { name: text, exact: true });
  await expect(sample).toBeVisible({ timeout: 15000 });
  await expect(sample).toBeInViewport({ ratio: 1 });
  expect(attempts).toBe(2);
  expect(await sample.evaluate((node: HTMLCanvasElement) => {
    const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data;
    return pixels.some((alpha, i) => i % 4 === 3 && alpha > 50);
  })).toBe(true);
  await page.locator('.appearance-font-search-wrap').screenshot({ path: info.outputPath('khmer-font-audition.png') });
  if (second) {
    await input.fill(second.name);
    await expect(page.locator('.font-specimen figcaption')).toHaveText(second.name);
    await expect(sample).toBeVisible();
    await page.locator('.appearance-font-search-wrap').screenshot({ path: info.outputPath('second-khmer-face.png') });
  }
  await input.fill('Khmer Test 01');
  await expect(page.getByText('Exact font preview unavailable')).toBeVisible();
  await expect(sample).toHaveCount(0);
  await input.press('Escape');
  await expect(input).toBeFocused();
  expect(state.requests.filter(({ method, path }) => method === 'PUT' && path.endsWith('/appearance'))).toHaveLength(0);
});

test('changing candidates cancels a scheduled busy-render retry', async ({ page }) => {
  const input = await openSearch(page);
  const calls: string[] = [];
  await page.route('**/api/video-export/*/preview', async (route) => {
    const family = route.request().postDataJSON().appearance.fontFamily;
    if (!family.startsWith('Khmer Test')) return route.fallback();
    calls.push(family);
    return route.fulfill({ status: family === 'Khmer Test 01' ? 429 : 400, body: '' });
  });
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
  await input.fill('Khmer Test 01');
  await page.clock.runFor(250);
  await expect.poll(() => calls).toEqual(['Khmer Test 01']);
  await input.fill('Khmer Test 02');
  await page.clock.runFor(2000);
  await expect(page.getByText('Exact font preview unavailable')).toBeVisible();
  expect(calls).toEqual(['Khmer Test 01', 'Khmer Test 02']);
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
