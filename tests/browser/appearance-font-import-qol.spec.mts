import { test as base, expect, type Page } from '@playwright/test';
import { appearance, cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); }
    finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.projects[0].captionAppearance = { ...appearance, bold: true };
  state.fonts.push({ name: 'Later Khmer', available: true, boldAvailable: true, source: 'windows-system' });
  state.profile.captionAppearances = [{
    id: 'later-preset', name: 'Later choice',
    appearance: { ...appearance, fontFamily: 'Later Khmer', bold: true, textColor: '#EE8877' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const font = (page: Page) => page.getByLabel('Khmer font', { exact: true });
const notice = (page: Page) => page.locator('.appearance-font-notice');
const upload = (page: Page) => page.locator('.appearance-font-file-input').setInputFiles({
  name: 'creator-khmer.ttf', mimeType: 'font/ttf', buffer: Buffer.from('owned synthetic font fixture'),
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openAppearance(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(font(page)).toBeEnabled();
  await expect(font(page)).not.toHaveAttribute('aria-busy', 'true');
}
async function libraryContainsImportedFont(page: Page) {
  await expect(font(page).locator('optgroup[label="Added to Studio"] option')).toHaveText('Creator Khmer · regular only');
  const manager = page.locator('.appearance-font-manager');
  if (await manager.getAttribute('open') === null) await manager.locator(':scope > summary').click();
  await expect(manager.locator('.appearance-font-manager-row').filter({ hasText: 'Creator Khmer' })).toContainText('Regular only');
}

test('ordinary import selects its added family, discloses Regular fallback and saves that appearance', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openAppearance(page);
  await upload(page);
  await expect(font(page)).toHaveValue('Creator Khmer');
  await expect(notice(page)).toContainText('Creator Khmer is selected.');
  await expect(notice(page)).toContainText('No Bold face; using Regular.');
  await libraryContainsImportedFont(page);
  await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe('Creator Khmer');
  expect(state.projects[0].captionAppearance?.bold).toBe(false);
  await page.screenshot({ path: info.outputPath('font-import-ordinary-1440.png') });
});

for (const choice of ['font', 'weight', 'preset', 'undo', 'reset'] as const) {
  test(`a delayed import keeps a newer ${choice} decision and still publishes the library`, async ({ page }, info) => {
    const width = choice === 'font' || choice === 'reset' ? 390 : 1440;
    await page.setViewportSize({ width, height: 1000 });
    const gate = deferred();
    let imports = 0;
    await page.route('**/api/video-export/fonts', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      imports++;
      await gate.promise;
      return route.fallback();
    });
    try {
      await openAppearance(page);
      const originalFont = await font(page).inputValue();
      if (choice === 'undo') await font(page).selectOption('Later Khmer');
      if (choice === 'reset') await page.getByRole('button', { name: 'Reset look', exact: true }).click();
      if (choice === 'preset') {
        await expandAppearanceSection(page, 'presets');
        await page.getByLabel('Preset', { exact: true }).selectOption('later-preset');
      }
      await upload(page);
      await expect.poll(() => imports).toBe(1);
      await expect(page.getByRole('button', { name: 'Adding…', exact: true })).toBeDisabled();
      if (choice === 'font') await font(page).selectOption('Later Khmer');
      else if (choice === 'weight') {
        await page.locator('.appearance-more > summary').click();
        await page.getByRole('button', { name: 'Bold', exact: true }).click();
      } else if (choice === 'preset') {
        await page.getByLabel('Preset', { exact: true }).selectOption('');
      } else if (choice === 'undo') await page.getByRole('button', { name: 'Undo', exact: true }).click();
      else await page.getByRole('button', { name: 'Reset look', exact: true }).click();
      const expectedFont = choice === 'font' || choice === 'preset' ? 'Later Khmer' : originalFont;
      const expectedBold = choice !== 'weight';
      await expect(font(page)).toHaveValue(expectedFont);
      gate.release();
      await expect(page.getByRole('button', { name: 'Add font…', exact: true })).toBeEnabled();
      await expect(notice(page)).toContainText('Added “Creator Khmer”.');
      await expect(notice(page)).toContainText('Your newer appearance choices are kept.');
      await expect(notice(page)).not.toContainText('is selected');
      await expect(font(page)).toHaveValue(expectedFont);
      if (choice === 'preset') await expect(page.getByLabel('Preset', { exact: true })).toHaveValue('');
      await libraryContainsImportedFont(page);
      await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe(expectedFont);
      await expect.poll(() => state.projects[0].captionAppearance?.bold).toBe(expectedBold);
      if (choice === 'preset') expect(state.projects[0].captionAppearance?.textColor).toBe('#EE8877');
      if (choice === 'reset') {
        await expect.poll(() => state.projects[0].captionAppearance?.textColor).toBe(appearance.textColor);
        await expect.poll(() => state.projects[0].captionAppearance?.outlineColor).toBe(appearance.outlineColor);
      }
      expect(imports).toBe(1);
      if (choice === 'font') {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('font-import-newer-choice-390.png') });
      }
    } finally { gate.release(); }
  });
}

test('an unrelated newer color keeps ordinary import selection and the current color', async ({ page }) => {
  const gate = deferred();
  let imports = 0;
  await page.route('**/api/video-export/fonts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    imports++;
    await gate.promise;
    return route.fallback();
  });
  try {
    await openAppearance(page);
    await upload(page);
    await expect.poll(() => imports).toBe(1);
    await page.getByLabel('Text color', { exact: true }).evaluate((input: HTMLInputElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('The native color input setter is unavailable.');
      setValue.call(input, '#123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    gate.release();
    await expect(font(page)).toHaveValue('Creator Khmer');
    await expect(notice(page)).toContainText('Creator Khmer is selected.');
    await expect(page.getByLabel('Text color', { exact: true })).toHaveValue('#123456');
    await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe('Creator Khmer');
    await expect.poll(() => state.projects[0].captionAppearance?.textColor).toBe('#123456');
    expect(state.projects[0].captionAppearance?.bold).toBe(false);
    expect(imports).toBe(1);
  } finally { gate.release(); }
});
