import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const original = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 18 }, (_, index) => ({
    ...original, id: `menu-${index + 1}`, text: `កម្ពុជា caption ${index + 1}`,
    startMs: 100 + index * 200, endMs: 270 + index * 200,
    timingQuality: 'high' as const, approved: false,
  }));
  // The previous row must explain this prerequisite without clipping its label.
  state.projects[0].captions[8].timingLocked = true;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const trigger = (page: Page) => page.getByLabel('More actions for caption 8', { exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Caption 8 actions', exact: true });

async function openEditor(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await openProject(page);
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  await trigger(page).evaluate((node: HTMLElement) => node.focus({ preventScroll: true }));
  await expect(page.locator('[data-caption-id="menu-8"]')).toHaveClass(/selected-range/);
  await page.evaluate(() => {
    (window as any).__captionMenuEvidence = [document.querySelector('video'), document.querySelector('.caption-list'), document.querySelector('.caption-panel')];
  });
}

async function placeTrigger(page: Page, edge: 'top' | 'bottom') {
  await trigger(page).evaluate((button: HTMLElement, edge) => {
    const list = button.closest<HTMLElement>('.caption-list')!;
    const workbench = list.closest<HTMLElement>('.editor-workbench')!;
    const preview = workbench.querySelector<HTMLElement>('.stage-column')!;
    if (getComputedStyle(preview).position === 'sticky') {
      // Bring the caption scrollport immediately below the persistent evidence.
      workbench.scrollTop += list.getBoundingClientRect().top - preview.getBoundingClientRect().bottom - 8;
    }
    const bounds = list.getBoundingClientRect();
    const workbenchBounds = workbench.getBoundingClientRect();
    let top = Math.max(bounds.top, workbenchBounds.top);
    for (const overlay of [preview, workbench.querySelector<HTMLElement>('.editor-toolbar'), list.parentElement?.querySelector<HTMLElement>('.panel-head')]) {
      if (overlay && getComputedStyle(overlay).position === 'sticky') top = Math.max(top, overlay.getBoundingClientRect().bottom);
    }
    const bottom = Math.min(bounds.bottom, workbenchBounds.bottom, innerHeight);
    const box = button.getBoundingClientRect();
    const desired = edge === 'top' ? top + 12 : bottom - box.height - 12;
    list.scrollTop += box.top - desired;
  }, edge);
  await expect.poll(() => trigger(page).evaluate((button) => {
    const list = button.closest('.caption-list')!.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return box.top >= list.top && box.bottom <= Math.min(list.bottom, innerHeight);
  })).toBe(true);
}

async function expectUsableFocus(page: Page, caption = 8) {
  const activeMenu = page.getByRole('menu', { name: `Caption ${caption} actions`, exact: true });
  await expect.poll(() => activeMenu.evaluate((panel: HTMLElement) => {
    const item = document.activeElement as HTMLElement | null;
    if (!item || !panel.contains(item)) return false;
    const bounds = panel.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    const top = bounds.top + panel.clientTop;
    const bottom = top + panel.clientHeight;
    const center = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
    return target.top >= top - 1 && target.bottom <= bottom + 1 && Boolean(center && item.contains(center));
  })).toBe(true);
  const bounds = (await activeMenu.boundingBox())!;
  const list = (await page.locator('.caption-list').boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(Math.max(0, list.y));
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(Math.min(page.viewportSize()!.height, list.y + list.height) + 1);
}

async function expectEvidencePreserved(page: Page) {
  expect(await page.evaluate(() => (window as any).__captionMenuEvidence.every((node: Element, index: number) => node === document.querySelector(['video', '.caption-list', '.caption-panel'][index])))).toBe(true);
}

for (const viewport of [{ width: 1440, height: 600 }, { width: 390, height: 844 }]) {
  for (const edge of ['top', 'bottom'] as const) test(`row menu has visible keyboard actions at the ${edge} edge in ${viewport.width}px`, async ({ page }, info) => {
    await openEditor(page, viewport);
    await placeTrigger(page, edge);
    const scrollBefore = await page.locator('.caption-list').evaluate((node) => node.scrollTop);
    const captionBefore = structuredClone(state.projects[0].captions);
    await trigger(page).press('ArrowUp');
    await expect(menu(page).getByRole('menuitem', { name: 'Delete caption', exact: true })).toBeFocused();
    await expectUsableFocus(page);
    if (viewport.width === 390) {
      const targets = await menu(page).getByRole('menuitem').evaluateAll((nodes) => nodes.map((node) => ({ height: node.getBoundingClientRect().height, content: (node as HTMLElement).scrollHeight, inner: (node as HTMLElement).clientHeight })));
      expect(targets.every((target) => target.height >= 44 && target.content <= target.inner)).toBe(true);
      await expect(menu(page).getByText('Unlock the next caption first', { exact: true })).toBeVisible();
    }
    await page.keyboard.press('Home');
    await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
    await expectUsableFocus(page);
    await page.keyboard.press('End');
    await expectUsableFocus(page);
    expect(await page.locator('.caption-list').evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, 0);
    await page.screenshot({ path: info.outputPath(`caption-menu-${viewport.width}-${edge}.png`) });
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    expect(state.projects[0].captions).toEqual(captionBefore);
    await expectEvidencePreserved(page);
  });
}

test('an open row menu follows caption scrolling and pane resizing without scrolling the evidence', async ({ page }) => {
  await openEditor(page, { width: 1440, height: 800 });
  await placeTrigger(page, 'bottom');
  await trigger(page).press('ArrowDown');
  await expect(menu(page)).toHaveClass(/menu-up/);
  await placeTrigger(page, 'top');
  await expect(menu(page)).not.toHaveClass(/menu-up/);
  await expectUsableFocus(page);
  await page.keyboard.press('Escape');

  await placeTrigger(page, 'top');
  await trigger(page).press('ArrowUp');
  const before = (await menu(page).boundingBox())!.height;
  await page.locator('.caption-panel').evaluate((panel: HTMLElement) => { panel.style.height = '300px'; });
  await expect.poll(async () => (await menu(page).boundingBox())!.height).toBeLessThan(before);
  await expectUsableFocus(page);
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
  await expectEvidencePreserved(page);
});

test('scrolling the mobile workbench updates an open menu and dismisses before its trigger is obscured', async ({ page }) => {
  await openEditor(page, { width: 390, height: 844 });
  await placeTrigger(page, 'bottom');
  await trigger(page).press('ArrowDown');
  await expectUsableFocus(page);
  await page.locator('.editor-workbench').evaluate((workbench) => { workbench.scrollTop += 12; });
  await expect(menu(page)).toBeVisible();
  await expectUsableFocus(page);
  await page.locator('.editor-workbench').evaluate((workbench) => { workbench.scrollTop += 400; });
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger(page)).toBeFocused();
  await expectEvidencePreserved(page);
});

test('opening the visible first mobile row reveals one complete action once without changing Follow', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const first = page.getByLabel('More actions for caption 1', { exact: true });
  const firstMenu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
  const workbench = page.locator('.editor-workbench');
  const before = await workbench.evaluate((node) => node.scrollTop);
  const captionsBefore = structuredClone(state.projects[0].captions);
  await page.evaluate(() => {
    (window as any).__captionMenuEvidence = [document.querySelector('video'), document.querySelector('.caption-list'), document.querySelector('.caption-panel')];
  });
  // Match the real first-open case: its trigger is visible, but a complete
  // 44px menu action does not yet fit beneath it within the phone viewport.
  expect(await first.evaluate((node) => innerHeight - node.getBoundingClientRect().bottom - 8)).toBeLessThan(58);
  await first.click();
  await expect(firstMenu).toBeVisible();
  await expectUsableFocus(page, 1);
  const shift = await workbench.evaluate((node, before) => node.scrollTop - before, before);
  expect(shift).toBeGreaterThan(0);
  expect(shift).toBeLessThanOrEqual(60);
  await expect(page.locator('.panel-tools').getByRole('button', { name: 'Follow playback', exact: true, pressed: true })).toBeVisible();
  expect(await firstMenu.getByRole('menuitem').first().evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('caption-menu-mobile-opening-reveal.png') });

  // A later user scroll back is authoritative: do not chase it with another reveal.
  await workbench.evaluate((node, before) => { node.scrollTop = before; }, before);
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(first).toBeFocused();
  expect(await workbench.evaluate((node) => node.scrollTop)).toBeCloseTo(before, 0);
  expect(state.projects[0].captions).toEqual(captionsBefore);
  await expectEvidencePreserved(page);
});
