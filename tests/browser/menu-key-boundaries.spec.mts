import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
type Key = KeyboardEventInit & { altGraph?: boolean };
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic unsaved caption' } }));
});
async function dispatch(page: Page, init: Key) {
  return page.evaluate((init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (init.altGraph) Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' });
    document.activeElement?.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);
}
async function setup(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Keep draft ខ្មែរ');
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    video.pause(); video.currentTime = 1.6;
    (window as any).__menuKeyNodes = [video, document.querySelector('.caption-list')];
  });
}
async function keptEditor(page: Page) {
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Keep draft ខ្មែរ');
  expect(state.projects[0].captions[0].text).not.toBe('Keep draft ខ្មែរ');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  expect(await page.evaluate(() => {
    const video = document.querySelector('video')!;
    return video.paused && Math.abs(video.currentTime - 1.6) < .1
      && (window as any).__menuKeyNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video'));
  })).toBe(true);
}
async function visibleAction(action: Locator) {
  await expect.poll(() => action.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const uncovered = [box.top + 3, box.top + box.height / 2, box.bottom - 3].every((y) => {
      const hit = document.elementFromPoint(box.left + box.width / 2, y);
      return hit === node || (hit !== null && node.contains(hit));
    });
    return { focused: document.activeElement === node, uncovered,
      visible: box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
  })).toEqual({ focused: true, uncovered: true, visible: true });
}

// Read the same usable bounds as CaptionEditor's menu placement policy. The
// recovery notice now reserves an in-flow footer on small screens, so a late
// warning only dismisses a menu when its focused action cannot fit safely.
async function captionMenuGeometry(page: Page, listSpace: 'safe' | 'insufficient' | null = null) {
  return page.evaluate((constrain) => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions for caption 1"]');
    const menu = document.querySelector<HTMLElement>('.caption-action-menu[role="menu"]');
    const list = document.querySelector<HTMLElement>('.caption-list');
    const workbench = list?.closest<HTMLElement>('.editor-workbench');
    const stack = document.querySelector<HTMLElement>('.workspace > .toast-stack');
    const first = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    const last = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []).at(-1);
    if (!trigger || !menu || !list || !workbench || !first || !stack) throw new Error('Expected mounted caption menu, trigger and recovery stack.');
    const style = getComputedStyle(menu);
    const minimumHeight = first.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + menu.offsetHeight - menu.clientHeight;
    if (constrain) {
      // Supply stable, measured space independent of browser font/layout
      // differences. The safe case fits one action but clips the final one;
      // the insufficient case keeps the trigger visible with no usable action.
      list.scrollTop = 0;
      const listBefore = list.getBoundingClientRect();
      const triggerBefore = trigger.getBoundingClientRect();
      const roomBelow = constrain === 'safe' ? minimumHeight + 96 : Math.max(8, minimumHeight - 18);
      const height = Math.ceil(triggerBefore.bottom - listBefore.top + roomBelow + 8);
      list.style.flex = `0 0 ${height}px`;
      list.style.height = `${height}px`;
      list.style.maxHeight = `${height}px`;
      list.style.minHeight = '0';
    }
    const buttonBox = trigger.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const workbenchBox = workbench.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const firstBox = first.getBoundingClientRect();
    const footerBox = stack.querySelector<HTMLElement>('.save-failure')?.getBoundingClientRect();
    const focusedAction = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement) ? document.activeElement : null;
    const focusedBox = focusedAction?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    let top = Math.max(listBox.top, workbenchBox.top, viewport?.offsetTop ?? 0);
    let bottom = Math.min(listBox.bottom, workbenchBox.bottom, viewportBottom);
    const overlays = [list.parentElement?.querySelector<HTMLElement>('.panel-head'), workbench.querySelector<HTMLElement>('.editor-toolbar'), workbench.querySelector<HTMLElement>('.stage-column')];
    for (const overlay of overlays) {
      if (!overlay || getComputedStyle(overlay).position !== 'sticky') continue;
      const bounds = overlay.getBoundingClientRect();
      if (bounds.left < listBox.right && bounds.right > listBox.left && bounds.top <= buttonBox.top) top = Math.max(top, bounds.bottom);
    }
    if (getComputedStyle(stack).position === 'fixed') {
      const bounds = stack.getBoundingClientRect();
      if (bounds.height > 0 && bounds.left < menuBox.right && bounds.right > menuBox.left) bottom = Math.min(bottom, bounds.top - 8);
    }
    const above = Math.max(0, buttonBox.top - top - 8);
    const below = Math.max(0, bottom - buttonBox.bottom - 8);
    const up = below < menu.scrollHeight && above > below;
    const availableHeight = Math.floor(up ? above : below);
    const hitSamples = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      return [box.top + 3, box.top + box.height / 2, box.bottom - 3].map((y) => {
        const hit = document.elementFromPoint(x, y);
        return hit === node || Boolean(hit && node.contains(hit));
      });
    };
    return {
      minimumHeight, availableHeight, above, below, up,
      triggerInsideBounds: buttonBox.top >= top - 1 && buttonBox.bottom <= bottom + 1,
      triggerHits: hitSamples(trigger), firstHits: hitSamples(first),
      focusedHits: focusedAction ? hitSamples(focusedAction) : [],
      firstAboveFooter: Boolean(footerBox && firstBox.bottom <= footerBox.top),
      focusedAboveFooter: Boolean(footerBox && focusedBox && focusedBox.bottom <= footerBox.top),
      footerPosition: getComputedStyle(stack).position,
      listTop: listBox.top, listBottom: listBox.bottom,
      triggerTop: buttonBox.top, triggerBottom: buttonBox.bottom,
      menuTop: menuBox.top, menuBottom: menuBox.bottom,
      footerTop: footerBox?.top ?? null,
      scrollTop: menu.scrollTop, menuClientHeight: menu.clientHeight, menuScrollHeight: menu.scrollHeight,
      lastInitiallyClipped: Boolean(last && last.getBoundingClientRect().bottom > menuBox.bottom - 1),
      focusedFirst: document.activeElement === first,
    };
  }, listSpace);
}

async function holdLateSave(page: Page) {
  let release!: () => void;
  let saves = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves++;
    await gate;
    await route.fulfill({ status: 503, json: { error: 'Synthetic late save failure' } });
  });
  return { release, saves: () => saves };
}

const deniedCaptionSave = (page: Page) => page.waitForResponse((response) => response.request().method() === 'PUT'
  && response.url().includes('/api/projects/landscape/captions') && response.status() === 503);
const combinations: Key[] = [
  ...['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].flatMap((key) => [
    { key, ctrlKey: true }, { key, metaKey: true }, { key, altKey: true }, { key, altGraph: true },
    { key, keyCode: 229 }, { key, isComposing: true },
  ]),
  ...['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].map((key) => ({ key, shiftKey: true })),
];
for (const width of [1440, 390]) for (const kind of ['tools', 'caption'] as const) {
  test(`${kind} menu respects key boundaries at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await setup(page);
    const trigger = kind === 'tools' ? page.getByLabel('Open project tools', { exact: true }) : page.getByLabel('More actions for caption 1', { exact: true });
    const menu = page.getByRole('menu', { name: kind === 'tools' ? 'Project tools' : 'Caption 1 actions', exact: true });
    await trigger.focus();
    await expect(page.locator('.toast-stack .save-failure')).toBeVisible();
    for (const init of combinations.filter((key) => key.key === 'ArrowDown' || key.key === 'ArrowUp')) {
      expect(await dispatch(page, init), JSON.stringify(init)).toBe(false);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
    }
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    const first = menu.getByRole('menuitem').filter({ visible: true }).first();
    await expect(first).toBeFocused();
    await visibleAction(first);
    for (const init of combinations) {
      expect(await dispatch(page, init), JSON.stringify(init)).toBe(false);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(first).toBeFocused();
    }
    // Uppercase typeahead and ordinary menu navigation remain native actions.
    await page.keyboard.press(kind === 'tools' ? 'Shift+h' : 'Shift+l');
    await expect(menu.getByRole('menuitem', { name: kind === 'tools' ? /^History/ : 'Lock text', exact: kind === 'caption' })).toBeFocused();
    await page.keyboard.press('Home'); await expect(first).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(first).not.toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(first).toBeFocused();
    await visibleAction(first);
    if (width === 390) await page.screenshot({ path: info.outputPath(`menu-keys-${kind}-390.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(trigger).toBeFocused();
    await keptEditor(page);
  });
}

test('late save warning keeps a fully exposed caption action usable and scrolls to its final action', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const held = await holdLateSave(page);
  try {
    await setup(page);
    const trigger = page.getByLabel('More actions for caption 1', { exact: true });
    const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
    const first = menu.getByRole('menuitem').first();
    const last = menu.getByRole('menuitem').last();
    await trigger.focus();
    await expect.poll(held.saves).toBe(1);
    await page.keyboard.press('ArrowDown');
    await visibleAction(first);
    const safeBefore = await captionMenuGeometry(page, 'safe');
    expect(safeBefore.triggerInsideBounds).toBe(true);
    expect(safeBefore.availableHeight).toBeGreaterThanOrEqual(safeBefore.minimumHeight);

    const failedResponse = deniedCaptionSave(page);
    held.release();
    expect((await failedResponse).status()).toBe(503);
    await expect(page.locator('.toast-stack').getByRole('alert').filter({ hasText: "Couldn't save changes" })).toBeVisible();
    await expect(page.locator('.workspace')).toHaveClass(/has-save-failure/);

    // The in-flow footer still leaves a complete first action above it. A
    // menu that fits must stay open, keep its focus, and scroll its own contents.
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => {
      const geometry = await captionMenuGeometry(page);
      return geometry.menuClientHeight <= geometry.availableHeight + 2 && geometry.menuScrollHeight > geometry.menuClientHeight && geometry.lastInitiallyClipped;
    }).toBe(true);
    await visibleAction(first);
    const afterWarning = await captionMenuGeometry(page);
    expect(afterWarning.footerPosition).toBe('static');
    expect(afterWarning.triggerInsideBounds).toBe(true);
    expect(afterWarning.triggerHits).toEqual([true, true, true]);
    expect(afterWarning.availableHeight).toBeGreaterThanOrEqual(afterWarning.minimumHeight);
    expect(afterWarning.focusedFirst).toBe(true);
    expect(afterWarning.firstHits).toEqual([true, true, true]);
    expect(afterWarning.firstAboveFooter).toBe(true);
    expect(afterWarning.lastInitiallyClipped).toBe(true);

    await page.keyboard.press('End');
    await visibleAction(last);
    const afterEnd = await captionMenuGeometry(page);
    expect(afterEnd.scrollTop).toBeGreaterThan(afterWarning.scrollTop);
    expect(afterEnd.focusedHits).toEqual([true, true, true]);
    expect(afterEnd.focusedAboveFooter).toBe(true);
    await page.keyboard.press('Home');
    await visibleAction(first);
    const afterHome = await captionMenuGeometry(page);
    expect(afterHome.firstHits).toEqual([true, true, true]);
    await info.attach('late-save-menu-safe-geometry', {
      body: JSON.stringify({ safeBefore, afterWarning, afterEnd, afterHome }, null, 2), contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('late-save-menu-390.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await keptEditor(page);
  } finally { held.release(); }
});

test('late recovery footer closes a caption menu only when less than one action fits', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1100 });
  const held = await holdLateSave(page);
  try {
    await setup(page);
    const trigger = page.getByLabel('More actions for caption 1', { exact: true });
    const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
    await trigger.focus();
    await expect.poll(held.saves).toBe(1);
    await page.keyboard.press('ArrowDown');
    await visibleAction(menu.getByRole('menuitem').first());
    const beforeWarning = await captionMenuGeometry(page, 'safe');
    expect(beforeWarning.triggerInsideBounds).toBe(true);
    expect(beforeWarning.availableHeight).toBeGreaterThanOrEqual(beforeWarning.minimumHeight);

    const failedResponse = deniedCaptionSave(page);
    held.release();
    expect((await failedResponse).status()).toBe(503);
    await expect(page.locator('.toast-stack').getByRole('alert').filter({ hasText: "Couldn't save changes" })).toBeVisible();
    await expect(page.locator('.workspace')).toHaveClass(/has-save-failure/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const before = await captionMenuGeometry(page);
    expect(before.availableHeight).toBeGreaterThanOrEqual(before.minimumHeight);

    // Deliberately reduce only the test page's caption scrollport. Measure the
    // trigger and both directions synchronously before ResizeObserver closes it.
    const constrained = await captionMenuGeometry(page, 'insufficient');
    expect(constrained.triggerInsideBounds).toBe(true);
    expect(constrained.triggerHits).toEqual([true, true, true]);
    expect(constrained.above).toBeLessThan(constrained.minimumHeight);
    expect(constrained.below).toBeLessThan(constrained.minimumHeight);
    expect(constrained.availableHeight).toBeLessThan(constrained.minimumHeight);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await info.attach('late-save-menu-insufficient-geometry', {
      body: JSON.stringify({ beforeWarning, before, constrained }, null, 2), contentType: 'application/json',
    });
    await keptEditor(page);
  } finally { held.release(); }
});

for (const width of [1440, 390]) test(`project details keeps unrelated chords at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await setup(page);
  const trigger = page.getByRole('button', { name: 'Project details', exact: true });
  const panel = page.getByRole('dialog', { name: 'Project details', exact: true });
  const close = panel.getByRole('button', { name: 'Close project details', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  const ignored: Key[] = [
    ...combinations.filter((key) => key.key === 'Escape'),
    { key: 'f', ctrlKey: true, shiftKey: true }, { key: 'f', metaKey: true, altKey: true },
    { key: 'f', ctrlKey: true, metaKey: true }, { key: 'f', ctrlKey: true, altGraph: true },
    { key: 'f', ctrlKey: true, keyCode: 229 }, { key: 'f', metaKey: true, isComposing: true },
  ];
  for (const init of ignored) {
    expect(await dispatch(page, init), JSON.stringify(init)).toBe(false);
    await expect(panel).toBeVisible(); await expect(close).toBeFocused();
  }
  await page.screenshot({ path: info.outputPath(`project-details-keys-${width}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused(); await keptEditor(page);
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    await page.keyboard.press('Enter'); await expect(close).toBeFocused();
    expect(await dispatch(page, { key: 'f', [modifier]: true })).toBe(true);
    await expect(panel).toHaveCount(0);
    const find = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
    await expect(find).toBeVisible(); await expect(find.getByLabel('Find', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(find).toHaveCount(0); await expect(trigger).toBeFocused();
  }
  await keptEditor(page);
});
