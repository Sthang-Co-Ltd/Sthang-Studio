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
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
  state.projects[0].captions.forEach((caption) => { caption.timingQuality = 'low'; caption.approved = false; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

type Key = KeyboardEventInit & { altGraph?: boolean };
async function key(page: Page, init: Key, focused = false) {
  // Synthetic dispatch tests browser chords without invoking real reloads,
  // downloads, window actions or browser navigation.
  return page.evaluate(({ init, focused }) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (init.altGraph) {
      const original = event.getModifierState.bind(event);
      Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' || original(modifier) });
    }
    (focused ? document.activeElement : document.body)?.dispatchEvent(event);
    return event.defaultPrevented;
  }, { init, focused });
}

async function blur(page: Page) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

async function openWorkspace(page: Page, workspace: 'review' | 'timing' | 'normal') {
  await openProject(page);
  if (workspace === 'review') await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
  if (workspace === 'timing') {
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await expect(page.locator('.fine-timing')).toBeVisible();
    await expect(page.locator('.waveform-loading')).toHaveCount(0);
    await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  }
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    video.pause();
    (window as any).__shortcutPlays = 0;
    video.play = () => { (window as any).__shortcutPlays++; return Promise.resolve(); };
    (window as any).__shortcutNodes = [video, document.querySelector('.caption-list')];
  });
  await blur(page);
}

async function snapshot(page: Page) {
  return page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll<HTMLElement>('.caption-row')).map((row) => ({
      id: row.dataset.captionId, approved: row.classList.contains('approved'), selected: row.classList.contains('selected-range'),
      text: row.querySelector('textarea')?.value,
      times: Array.from(row.querySelectorAll('input')).map((input) => input.value),
    })),
    playhead: Math.round(document.querySelector<HTMLVideoElement>('video')!.currentTime * 1000),
    plays: (window as any).__shortcutPlays,
    focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
    workspace: document.querySelector('.workspace-inspector:not([hidden])')?.getAttribute('aria-label'),
  }));
}

async function expectNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__shortcutNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}

const modified: Key[] = [
  ...['r', 'e', 'j', 'a', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'Escape'].flatMap((key) => [{ key, ctrlKey: true }, { key, metaKey: true }]),
  ...['r', 'e', 'j', 'a', 's', 'Enter', ' ', 'Escape'].map((key) => ({ key, altKey: true })),
  ...['r', 'e', 'j', 'a', 'Enter', ' ', 'ArrowDown'].map((key) => ({ key, shiftKey: true })),
  { key: 'ArrowRight', altKey: true, ctrlKey: true }, { key: 'ArrowLeft', altKey: true, metaKey: true },
  { key: 'ArrowRight', altKey: true, shiftKey: true }, { key: 'z', ctrlKey: true, altKey: true },
  { key: 'z', ctrlKey: true, metaKey: true },
];
const composition: Key[] = [
  ...['a', 'Enter', 'Escape', 'r', 'ArrowDown'].flatMap((key) => [{ key, isComposing: true }, { key, keyCode: 229 }, { key, altGraph: true }]),
  { key: 'ArrowRight', altKey: true, isComposing: true }, { key: 'ArrowRight', altKey: true, keyCode: 229 },
  { key: 'z', ctrlKey: true, isComposing: true }, { key: 'z', metaKey: true, keyCode: 229 },
];

test('modified and composing keys do not approve, navigate, replay, edit or dismiss Review', async ({ page }) => {
  await openWorkspace(page, 'review');
  const before = await snapshot(page);
  for (const init of [...modified, ...composition]) expect(await key(page, init), JSON.stringify(init)).toBe(false);
  expect(await snapshot(page)).toEqual(before);
  await expect(page.getByRole('complementary', { name: 'Review workspace', exact: true })).toBeVisible();
  await expectNodes(page);
});

test('Fine timing ignores unrelated chords, composition and AltGraph without using timing Undo', async ({ page }) => {
  await openWorkspace(page, 'timing');
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.250');
  await blur(page);
  const before = await snapshot(page);
  for (const init of [...modified, ...composition]) expect(await key(page, init), JSON.stringify(init)).toBe(false);
  expect(await snapshot(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expectNodes(page);
});

test('only exact Ctrl or Command Save and Find chords run, including while editing', async ({ page }) => {
  await openWorkspace(page, 'normal');
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.fill('Keep this unfinished wording');
  const before = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  for (const init of [
    { key: 's', ctrlKey: true, shiftKey: true }, { key: 's', metaKey: true, altKey: true },
    { key: 's', ctrlKey: true, isComposing: true }, { key: 's', metaKey: true, keyCode: 229 },
    { key: 's', ctrlKey: true, altGraph: true }, { key: 'f', ctrlKey: true, shiftKey: true },
    { key: 'f', metaKey: true, isComposing: true }, { key: 'f', ctrlKey: true, keyCode: 229 },
  ]) expect(await key(page, init, true), JSON.stringify(init)).toBe(false);
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(before);
  await expect(page.locator('.find-replace-modal')).toHaveCount(0);
  await expect(text).toBeFocused();

  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    const wording = `Saved with ${modifier}`;
    await text.fill(wording);
    expect(await key(page, { key: 's', [modifier]: true }, true)).toBe(true);
    await expect.poll(() => state.projects[0].captions[0].text).toBe(wording);
    expect(await key(page, { key: 'f', [modifier]: true }, true)).toBe(true);
    await expect(page.locator('.find-replace-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.find-replace-modal')).toHaveCount(0);
  }
  await expectNodes(page);
});

test('bare playback and editing keys and exact Alt nudge remain available', async ({ page }) => {
  await openWorkspace(page, 'normal');
  expect(await key(page, { key: 'r' })).toBe(true);
  expect(await page.evaluate(() => (window as any).__shortcutPlays)).toBe(1);
  expect(await key(page, { key: ' ' })).toBe(true);
  expect(await page.evaluate(() => (window as any).__shortcutPlays)).toBe(2);
  expect(await key(page, { key: 'e' })).toBe(true);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeFocused();
  await blur(page);
  expect(await key(page, { key: 'j' })).toBe(true);
  expect(await key(page, { key: 'ArrowRight', altKey: true })).toBe(true);
  await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.250');
  expect(await key(page, { key: 'ArrowLeft', altKey: true })).toBe(true);
  await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.200');
  await expectNodes(page);
});

test('Review navigation remains available and held bare approval makes one decision', async ({ page }) => {
  await openWorkspace(page, 'review');
  const selected = (id: string) => page.locator(`[data-caption-id="${id}"]`);
  expect(await key(page, { key: 's' })).toBe(true);
  await expect(selected('c2')).toHaveClass(/selected-range/);
  expect(await key(page, { key: 'ArrowUp' })).toBe(true);
  await expect(selected('c1')).toHaveClass(/selected-range/);
  expect(await key(page, { key: 'a' })).toBe(true);
  await expect(selected('c1')).toHaveCount(0);
  await expect(selected('c2')).toHaveClass(/selected-range/);
  const after = await snapshot(page);
  for (const repeated of ['a', 'Enter']) expect(await key(page, { key: repeated, repeat: true })).toBe(true);
  expect(await snapshot(page)).toEqual(after);
  expect(await key(page, { key: 'Enter' })).toBe(true);
  await expect(selected('c2')).toHaveCount(0);
  await expect(selected('c3')).toHaveClass(/selected-range/);
  await expectNodes(page);
});

test('Fine timing retains exact nudge, Ctrl or Command Undo and Shift Redo, and bare Replay', async ({ page }) => {
  await openWorkspace(page, 'timing');
  const start = page.getByLabel('Fine timing start', { exact: true });
  expect(await key(page, { key: 'ArrowRight', altKey: true })).toBe(true);
  await expect(start).toHaveValue('00:00.250');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    expect(await key(page, { key: 'z', [modifier]: true })).toBe(true);
    await expect(start).toHaveValue('00:00.200');
    expect(await key(page, { key: 'z', [modifier]: true, shiftKey: true })).toBe(true);
    await expect(start).toHaveValue('00:00.250');
  }
  expect(await key(page, { key: 'r' })).toBe(true);
  expect(await page.evaluate(() => (window as any).__shortcutPlays)).toBe(1);
  await expectNodes(page);
});

for (const kind of ['primary', 'row'] as const) test(`held Enter on the ${kind} approval control makes one decision and separate keys still work`, async ({ page }) => {
  await openWorkspace(page, 'review');
  const approve = (id: string) => kind === 'primary'
    ? page.getByRole('button', { name: 'Approve & next', exact: true })
    : page.locator(`[data-caption-id="${id}"]`).getByRole('button', { name: 'Approve caption and move to the next review item', exact: true });
  await approve('c1').focus();
  await page.keyboard.down('Enter');
  await expect(page.locator('[data-caption-id="c1"]')).toHaveCount(0);
  await expect(approve('c2')).toBeFocused();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await expect(page.locator('[data-caption-id="c2"]')).toBeVisible();
  await expect(page.locator('.caption-row')).toHaveCount(2);
  await page.keyboard.up('Enter');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-caption-id="c2"]')).toHaveCount(0);
  await expect(approve('c3')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-caption-id="c3"]')).toHaveCount(0);
  await expect(page.locator('.review-completion')).toBeVisible();
  await expectNodes(page);
});
