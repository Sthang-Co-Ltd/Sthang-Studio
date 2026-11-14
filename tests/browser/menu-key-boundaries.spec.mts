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

test('late save warning keeps the caption menu reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  let release!: () => void; let saves = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects/landscape/captions', async (route) => {
    saves++; await gate;
    await route.fulfill({ status: 503, json: { error: 'Synthetic late save failure' } });
  });
  try {
    await setup(page);
    const trigger = page.getByLabel('More actions for caption 1', { exact: true });
    const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
    await trigger.focus(); await expect.poll(() => saves).toBe(1);
    await page.keyboard.press('ArrowDown');
    await visibleAction(menu.getByRole('menuitem').filter({ visible: true }).first());
    release(); await expect(page.locator('.toast-stack .save-failure')).toBeVisible();
    // A late obstruction leaves too little room here: return to the trigger
    // instead of leaving an active action underneath the recovery notice.
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await visibleAction(menu.getByRole('menuitem').filter({ visible: true }).first());
    await page.screenshot({ path: info.outputPath('late-save-menu-390.png'), animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await keptEditor(page);
  } finally { release(); }
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
