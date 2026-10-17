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

// Hosted font requests remain blocked. This separate qualification loads the
// exact licensed fixture through the owned frontend, then verifies actual glyph
// usage in Chromium. It does not claim Google Fonts endpoint availability.
for (const width of [1440, 375, 320]) {
  test(`loaded Plus Jakarta face and major interfaces at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1000 });
    const evidence: Array<{ surface: string; fonts: unknown }> = [];
    const loadFace = async () => {
      const result = await page.evaluate(async () => {
        const face = new FontFace('Plus Jakarta Sans', 'url("/__interface-font/plus-jakarta-sans.ttf")', { weight: '200 800', style: 'normal' });
        await face.load();
        document.fonts.add(face);
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return { status: face.status, weights: [400, 500, 600, 700, 800].map((weight) => document.fonts.check(`${weight} 16px "Plus Jakarta Sans"`, 'Studio Export Review')) };
      });
      expect(result.status).toBe('loaded');
      expect(result.weights).toEqual([true, true, true, true, true]);
    };
    const capture = async (surface: string, selector: string) => {
      await expect(page.locator(selector).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const session = await page.context().newCDPSession(page);
      let fonts;
      try {
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const { root } = await session.send('DOM.getDocument');
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        expect(nodeId).toBeGreaterThan(0);
        ({ fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId }));
        expect(fonts.some((font) => font.isCustomFont && font.glyphCount > 0 && /Plus Jakarta Sans/.test(font.familyName))).toBe(true);
      } finally { await session.detach(); }
      evidence.push({ surface, fonts });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/interface-typography/${width}-${surface}.png`, fullPage: true, animations: 'disabled' });
    };
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
    await loadFace();
    await capture('home', 'h1');
    await openProject(page);
    await loadFace();
    await capture('editor', '.header-actions > button > span');
    const controls = await page.locator('.header-actions > button, .workspace-tools-menu > summary').evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height, fits: item.scrollWidth <= item.clientWidth + 1 };
    }).filter((item) => item.width > 0 && item.height > 0));
    for (const control of controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(width);
      expect(control.fits).toBe(true);
    }
    await page.getByLabel('Open project tools', { exact: true }).click();
    await capture('tools', '.workspace-tools-menu > summary > span');
    await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
    await capture('correct-everywhere', '.find-replace-modal .modal-head strong');
    await page.keyboard.press('Escape');
    await expect(page.locator('.find-replace-modal')).toHaveCount(0);
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toBeVisible();
    await capture('activity', '#activity-title');
    await page.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
    await expect(page.getByRole('button', { name: 'Approve & next', exact: true })).toBeVisible();
    await capture('review', '.review-approve-next');
    await openProject(page);
    await loadFace();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
    await capture('appearance', '#caption-appearance-workspace-title');
    await testInfo.attach(`actual-font-evidence-${width}`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  });
}
