import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => { await installFixture(page); });

// The isolated fixture blocks hosted requests. This checks the CSS cascade and
// offline layout, not successful loading or glyph metrics of the hosted face.
for (const width of [1440, 390, 375, 320]) {
  test(`interface font cascade keeps Khmer caption editing separate at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openProject(page);
    await expect(page.locator('html')).toHaveCSS('font-family', /^"Plus Jakarta Sans", "Noto Sans Khmer", system-ui, sans-serif$/);
    await expect(page.getByLabel('Open project tools', { exact: true })).toHaveCSS('font-family', /^"Plus Jakarta Sans",/);
    await expect(page.locator('.caption-row textarea').first()).toHaveCSS('font-family', /^"Noto Sans Khmer", "Plus Jakarta Sans", sans-serif$/);
    await expect(page.locator('.time-stack input').first()).toHaveCSS('font-family', /monospace/);
    await expect(page.locator('.time-stack input').first()).toHaveCSS('font-size', '11px');
    await expect(page.locator('.caption-row textarea').first()).toHaveCSS('font-size', width <= 620 ? '14px' : '15px');
    const rowFit = await page.locator('.caption-row').first().evaluate((row) => {
      const text = row.querySelector('.caption-text-cell')!.getBoundingClientRect();
      const times = row.querySelector('.time-stack')!.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return { textTop: text.top, timesBottom: times.bottom, textWidth: text.width, rowWidth: rowRect.width };
    });
    if (width <= 420) {
      expect(rowFit.textTop).toBeGreaterThanOrEqual(rowFit.timesBottom);
      expect(rowFit.textWidth).toBeGreaterThan(rowFit.rowWidth * 0.8);
    }
    const editorFit = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('.header-actions > button, .workspace-tools-menu > summary, .caption-row:first-child .time-stack input, .caption-row:first-child textarea')];
      return elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
          fits: element.scrollWidth <= element.clientWidth + 1,
          isHeader: Boolean(element.closest('.header-actions')) };
      }).filter((element) => element.width > 0 && element.height > 0);
    });
    expect(editorFit.length).toBeGreaterThan(3);
    for (const rect of editorFit) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.fits).toBe(true);
      if (rect.isHeader) expect(rect.height).toBeGreaterThanOrEqual(width <= 620 ? 44 : 36);
    }
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
    const modal = page.locator('.find-replace-modal');
    await expect(modal).toBeVisible();
    const fit = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('.find-replace-modal input, .find-replace-modal select, .find-replace-modal .modal-actions button')];
      return {
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        controls: controls.map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        }),
      };
    });
    expect(fit.pageFits).toBe(true);
    expect(fit.controls.length).toBeGreaterThan(0);
    for (const rect of fit.controls) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThanOrEqual(width <= 620 ? 44 : 34);
    }
    await expect(modal.locator('select').first()).toHaveCSS('font-family', /^"Plus Jakarta Sans",/);
    await expect(modal.getByLabel('Find', { exact: true })).toHaveCSS('font-family', /^"Plus Jakarta Sans",/);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.caption-row textarea').first()).toBeVisible();
  });
}
