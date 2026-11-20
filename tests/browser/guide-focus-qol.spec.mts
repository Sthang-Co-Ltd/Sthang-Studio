import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
});
const guide = (page: Page) => page.getByRole('complementary', { name: 'Sthang Studio guide', exact: true });
const closeGuide = (page: Page) => guide(page).getByRole('button', { name: 'Close guide', exact: true });
const tools = (page: Page) => page.getByLabel('Open project tools', { exact: true });

async function openGuide(page: Page) {
  await tools(page).focus();
  await tools(page).press('Enter');
  await page.keyboard.press('q');
  const item = page.getByRole('menuitem', { name: 'Quick guide', exact: true });
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(guide(page)).toBeVisible();
  await expect(closeGuide(page)).toBeFocused();
}
async function keepEditorEvidence(page: Page) {
  await page.evaluate(() => { (window as any).__guideEvidence = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function expectEditorEvidence(page: Page, draft?: string) {
  expect(await page.evaluate(() => (window as any).__guideEvidence.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  if (draft) await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(draft);
}

for (const width of [1440, 390]) {
  test(`Home and Tools Guide entry, dismissal and free Tab keep useful focus at ${width}px`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const homeGuide = page.getByRole('button', { name: 'Guide', exact: true });
    await homeGuide.focus();
    const homeHint = page.getByRole('tooltip').filter({ hasText: 'Open guide' });
    await expect(homeHint).toBeVisible();
    await homeGuide.press('Enter');
    await expect(closeGuide(page)).toBeFocused();
    await expect(homeHint).toHaveCount(0);
    expect(await guide(page).getAttribute('aria-modal')).toBeNull();
    if (width === 390) {
      const box = (await closeGuide(page).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath(`guide-focus-home-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(guide(page)).toHaveCount(0);
    await expect(homeGuide).toBeFocused();
    await homeGuide.press('Enter'); await closeGuide(page).click();
    await expect(homeGuide).toBeFocused();

    await openProject(page);
    await keepEditorEvidence(page);
    await openGuide(page);
    await expect(guide(page).getByText('Captions generated', { exact: true })).toBeVisible();
    await expect(guide(page).getByRole('button', { name: /Captions generated/, disabled: false })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`guide-focus-editor-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(guide(page)).toHaveCount(0); await expect(tools(page)).toBeFocused();
    await openGuide(page);
    await page.keyboard.press('Shift+Tab');
    expect(await guide(page).evaluate((node) => node.contains(document.activeElement))).toBe(false);
    // The preceding control can own a legitimate tooltip. Check the separate
    // newer-editing-focus contract from an unhinted caption field.
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    const wording = await caption.inputValue();
    await caption.focus();
    await expect(caption).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(guide(page)).toHaveCount(0);
    await expect(caption).toBeFocused();
    await expect(caption).toHaveValue(wording);
    await expectEditorEvidence(page);
  });

  test(`Guide respects composing Escape and foreground surfaces, and Settings returns to Tools at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await openProject(page); await keepEditorEvidence(page); await openGuide(page);
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      await closeGuide(page).dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
      await expect(guide(page)).toBeVisible();
    }
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
    await expect(find).toBeVisible(); await expect(guide(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(find).toBeHidden(); await expect(guide(page)).toBeVisible();
    await expect(closeGuide(page)).toBeFocused();
    await tools(page).focus(); await tools(page).press('Enter');
    await expect(page.getByRole('menu', { name: 'Project tools', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tools(page)).toBeFocused(); await expect(guide(page)).toBeVisible();
    await closeGuide(page).focus();
    await guide(page).getByRole('button', { name: /Connect AI/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible(); await expect(guide(page)).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden(); await expect(tools(page)).toBeFocused();
    await expectEditorEvidence(page);
  });

  test(`Guide workspace handoffs focus their destination and preserve draft/evidence at ${width}px`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: width === 390 ? 'reduce' : 'no-preference' });
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic unsaved guide draft' } }));
    await openProject(page);
    const draft = 'កម្ពុជា guide draft';
    await page.getByLabel('Caption 1 text', { exact: true }).fill(draft);
    await keepEditorEvidence(page);
    await page.evaluate(() => {
      (window as any).__guideReveals = [];
      const reveal = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        if (this.matches('#accuracy-context-description,.inspector-heading')) (window as any).__guideReveals.push(options);
        reveal.call(this, options);
      };
    });
    for (const destination of [
      { action: /Add accuracy context/, name: 'Accuracy', field: true },
      { action: /Review flagged captions/, name: 'Review', field: false },
      { action: /Export/, name: 'Export', field: false },
    ]) {
      await openGuide(page);
      await page.evaluate(() => { (window as any).__guideReveals = []; });
      const action = guide(page).getByRole('button', { name: destination.action });
      if (destination.name === 'Review') { await action.focus(); await action.press('Enter'); }
      else await action.click();
      await expect(guide(page)).toHaveCount(0);
      const workspace = page.getByRole('complementary', { name: `${destination.name} workspace`, exact: true });
      await expect(workspace).toBeVisible();
      if (destination.field) await expect(page.getByLabel('What is this clip about?', { exact: true })).toBeFocused();
      else await expect(workspace.getByRole('group', { name: `${destination.name} workspace`, exact: true })).toBeFocused();
      await expect.poll(() => page.evaluate(() => (window as any).__guideReveals.length)).toBeGreaterThan(0);
      expect(await page.evaluate(() => (window as any).__guideReveals.every((options: ScrollIntoViewOptions) => options.behavior === 'instant' && options.block === 'nearest' && options.inline === 'nearest'))).toBe(true);
      await expectEditorEvidence(page, draft);
      if (destination.field) await page.screenshot({ path: info.outputPath(`guide-focus-accuracy-${width}.png`) });
      if (!destination.field) {
        if (destination.name === 'Review') {
          expect(await workspace.locator('.inspector-heading').evaluate((node) => node.matches(':focus-visible'))).toBe(true);
          await page.screenshot({ path: info.outputPath(`guide-focus-review-${width}.png`) });
        }
        await page.keyboard.press('Tab');
        await expect(workspace.locator('.inspector-heading button').first()).toBeFocused();
      }
    }
  });
}

test('Guide does not report timing ready when the system status check failed', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic health failure' } }));
  await openProject(page);
  await openGuide(page);
  await expect(guide(page).getByRole('button', { name: /Khmer timing/i })).toBeEnabled();
  await expect(guide(page).getByText('Timing ready', { exact: true })).toHaveCount(0);
});

test('a newer focus choice wins over a Guide workspace handoff', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProject(page); await keepEditorEvidence(page); await openGuide(page);
  await guide(page).getByRole('button', { name: /Add accuracy context/ }).evaluate((button: HTMLButtonElement) => {
    button.click();
    document.querySelector<HTMLTextAreaElement>('.caption-row textarea')?.focus({ preventScroll: true });
  });
  await expect(page.getByRole('complementary', { name: 'Accuracy workspace', exact: true })).toBeVisible();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeFocused();
  await expectEditorEvidence(page);
});
