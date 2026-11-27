import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { openPanelArrangement } from './editor-layout-tools.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); }
    finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
type Pane = 'preview' | 'captions' | 'inspector';
type Key = KeyboardEventInit & { altGraph?: boolean; prevented?: boolean };
const initial: Pane[] = ['preview', 'captions', 'inspector'];
const middle: Pane[] = ['captions', 'preview', 'inspector'];
const variants: Key[] = [
  { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
  { isComposing: true }, { keyCode: 229 }, { altGraph: true }, { prevented: true },
];
let state: FixtureState;
let captions: FixtureState['projects'][number]['captions'];
let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = []; page.on('pageerror', (error) => errors.push(error.message));
  state = await installFixture(page);
  captions = structuredClone(state.projects[0].captions);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.setViewportSize({ width: 2048, height: 1041 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('sthang:editor-layout:v2', JSON.stringify({ preview: .36, inspector: .28, order: ['preview', 'captions', 'inspector'] })));
  // Keep a real unsaved caption draft through the focus changes.
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic unsaved caption' } }));
});
test.afterEach(() => expect(errors).toEqual([]));

const header = (page: Page) => page.locator('.stage-column').getByRole('button', { name: 'Preview panel', exact: true });
const popup = (page: Page) => page.getByRole('region', { name: 'Arrange panels', exact: true });
const popupGrip = (page: Page) => popup(page).getByRole('button', { name: 'Drag Preview panel to reorder', exact: true });
const divider = (page: Page) => page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true });
const saved = (page: Page) => page.evaluate(() => localStorage.getItem('sthang:editor-layout:v2')!);
const widths = (page: Page) => page.locator('.refined-editor').evaluate((root) =>
  ['.stage-column', '.caption-panel', '.workspace-inspector'].map((selector) => root.querySelector(selector)!.getBoundingClientRect().width));
async function order(page: Page): Promise<Pane[]> {
  return page.locator('.refined-editor').evaluate((root) =>
    [['preview', '.stage-column'], ['captions', '.caption-panel'], ['inspector', '.workspace-inspector']]
      .map(([pane, selector]) => ({ pane, x: root.querySelector(selector)!.getBoundingClientRect().left }))
      .sort((a, b) => a.x - b.x).map(({ pane }) => pane)) as Promise<Pane[]>;
}
async function dispatch(target: Locator, value: Key) {
  return target.evaluate((node, value) => {
    const { altGraph, prevented, ...init } = value;
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (altGraph) {
      const original = event.getModifierState.bind(event);
      Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' || original(modifier) });
    }
    // This represents an event handled before layout's capture listener.
    if (prevented) event.preventDefault();
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, value);
}
async function setup(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.fill('Keep layout draft ខ្មែរ');
  await text.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 9));
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.pause(); video.currentTime = 1.6; video.dispatchEvent(new Event('timeupdate'));
    (window as any).__layoutKeyNodes = [video, document.querySelector('.caption-list')];
  });
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(1600);
}
async function kept(page: Page) {
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Keep layout draft ខ្មែរ');
  expect(await page.getByLabel('Caption 1 text', { exact: true }).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([3, 9]);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  expect(state.projects[0].captions).toEqual(captions);
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.workspace-inspector')).toBeVisible();
  expect(await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    return video.paused && Math.abs(video.currentTime - 1.6) < .1
      && (window as any).__layoutKeyNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video'));
  })).toBe(true);
}

for (const surface of ['header', 'popup'] as const) test(surface + ' keys', async ({ page }, info) => {
  await setup(page);
  if (surface === 'popup') await openPanelArrangement(page);
  const grip = surface === 'header' ? header(page) : popupGrip(page);
  await grip.press('ArrowRight');
  await expect.poll(() => order(page)).toEqual(middle);
  await expect(grip).toBeFocused();
  const before = await saved(page);
  // Preview starts in the middle, so every rejected direction could move it.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) for (const variant of variants) {
    const value = { key, ...variant };
    expect(await dispatch(grip, value), JSON.stringify(value)).toBe(Boolean(variant.prevented));
    expect(await order(page), JSON.stringify(value)).toEqual(middle);
    expect(await saved(page), JSON.stringify(value)).toBe(before);
    await expect(grip).toBeFocused();
  }
  const steps: Array<[string, Pane[]]> = [
    ['ArrowLeft', initial], ['End', ['captions', 'inspector', 'preview']], ['Home', initial], ['ArrowRight', middle],
  ];
  for (const [key, next] of steps) {
    await grip.press(key);
    await expect.poll(() => order(page)).toEqual(next);
    await expect(grip).toBeFocused();
    expect(JSON.parse(await saved(page))).toEqual({ ...JSON.parse(before), order: next });
  }
  await kept(page);
  if (surface === 'header') await page.screenshot({ path: info.outputPath('layout-keys.png'), animations: 'disabled', fullPage: true });
});

test('divider keys', async ({ page }) => {
  await setup(page);
  const handle = divider(page); await handle.focus();
  const before = await saved(page); const original = await widths(page);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) for (const variant of variants) {
    if (variant.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) continue;
    const value = { key, ...variant };
    expect(await dispatch(handle, value), JSON.stringify(value)).toBe(Boolean(variant.prevented));
    expect(await widths(page), JSON.stringify(value)).toEqual(original);
    expect(await saved(page), JSON.stringify(value)).toBe(before);
    await expect(handle).toBeFocused();
  }
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'altGraph'] as const) {
    const value = { key: 'ArrowRight', shiftKey: true, [modifier]: true };
    expect(await dispatch(handle, value), JSON.stringify(value)).toBe(false);
    expect(await widths(page)).toEqual(original); expect(await saved(page)).toBe(before);
  }
  const steps: Array<[string, number]> = [['ArrowRight', 16], ['ArrowLeft', -16], ['Shift+ArrowRight', 48], ['Shift+ArrowLeft', -48]];
  for (const [key, delta] of steps) {
    const prior = await widths(page);
    await handle.press(key);
    await expect.poll(() => widths(page)).toEqual([prior[0] + delta, prior[1] - delta, prior[2]]);
    await expect(handle).toBeFocused();
  }
  await handle.press('Home');
  expect(await handle.getAttribute('aria-valuenow')).toBe(await handle.getAttribute('aria-valuemin'));
  await handle.press('End');
  expect(await handle.getAttribute('aria-valuenow')).toBe(await handle.getAttribute('aria-valuemax'));
  await expect(handle).toBeFocused();
  expect(JSON.parse(await saved(page)).order).toEqual(initial);
  await kept(page);
});

test('header Escape', async ({ page }) => {
  await setup(page);
  const grip = header(page);
  // Settle the fixture's intentional blur-save failure before freezing drag geometry.
  await grip.focus();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.toast-stack').evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  const before = await saved(page); const original = await widths(page);
  const source = (await grip.boundingBox())!; const target = (await page.locator('.workspace-inspector').boundingBox())!;
  try {
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 5 });
    await expect(page.locator('.editor-pane-floating')).toHaveCount(1);
    await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order', 'captions,inspector,preview');
    for (const variant of variants) {
      const value = { key: 'Escape', ...variant };
      expect(await dispatch(grip, value), JSON.stringify(value)).toBe(Boolean(variant.prevented));
      await expect(page.locator('.editor-pane-floating')).toHaveCount(1);
      await expect(page.locator('.refined-editor')).toHaveAttribute('data-header-drag-order', 'captions,inspector,preview');
      expect(await saved(page)).toBe(before);
    }
    // A real foreground dialog owns its plain Escape while capture stays live.
    await page.getByLabel('Caption 1 text', { exact: true }).focus();
    await page.keyboard.press('Control+f');
    const dialog = page.getByRole('dialog', { name: 'Correct everywhere', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Find', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await expect(page.locator('.editor-pane-floating')).toHaveCount(1);
    expect(await saved(page)).toBe(before);
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-pane-floating,.editor-pane-shifting')).toHaveCount(0);
    await page.mouse.up();
    expect(await order(page)).toEqual(initial); expect(await widths(page)).toEqual(original);
    expect(await saved(page)).toBe(before); await kept(page);
  } finally { await page.mouse.up(); }
});

test('popup Escape', async ({ page }) => {
  await setup(page);
  await openPanelArrangement(page);
  const grip = popupGrip(page); const before = await saved(page);
  const source = (await grip.boundingBox())!;
  const target = (await popup(page).getByRole('button', { name: 'Drag Tool panel to reorder', exact: true }).boundingBox())!;
  try {
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
    await expect(page.locator('.editor-panel-ghost')).toBeVisible();
    for (const variant of variants) {
      const value = { key: 'Escape', ...variant };
      expect(await dispatch(grip, value), JSON.stringify(value)).toBe(Boolean(variant.prevented));
      await expect(page.locator('.editor-panel-ghost')).toBeVisible();
      await expect(page.locator('.editor-arrange-panel.is-drop-target')).toHaveAttribute('data-panel', 'inspector');
      expect(await saved(page)).toBe(before);
    }
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.editor-panel-ghost')).toHaveCount(0); await expect(popup(page)).toBeVisible();
    expect(await order(page)).toEqual(initial); expect(await saved(page)).toBe(before);
    await kept(page);
  } finally { await page.mouse.up(); }
});

test('divider Escape', async ({ page }) => {
  await setup(page);
  const handle = divider(page); const before = await saved(page); const original = await widths(page);
  const source = (await handle.boundingBox())!;
  try {
    await page.mouse.move(source.x + source.width / 2, source.y + 40);
    await page.mouse.down(); await page.mouse.move(source.x + source.width / 2 + 80, source.y + 40, { steps: 5 });
    await expect(page.locator('.refined-editor')).toHaveClass(/is-resizing/);
    const draft = await widths(page); expect(draft[0] - original[0]).toBe(80);
    for (const variant of variants) {
      const value = { key: 'Escape', ...variant };
      expect(await dispatch(handle, value), JSON.stringify(value)).toBe(Boolean(variant.prevented));
      await expect(page.locator('.refined-editor')).toHaveClass(/is-resizing/);
      expect(await widths(page)).toEqual(draft); expect(await saved(page)).toBe(before);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.refined-editor')).not.toHaveClass(/is-resizing/);
    await page.mouse.up();
    expect(await widths(page)).toEqual(original); expect(await saved(page)).toBe(before);
    expect(await order(page)).toEqual(initial); await kept(page);
  } finally { await page.mouse.up(); }
});
