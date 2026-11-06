import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_CAPTION_APPEARANCE } from '@kcs/shared';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const tools = (page: Page) => page.getByLabel('Open project tools', { exact: true });
const exact = (page: Page, name: string) => page.getByRole('spinbutton', { name: `Exact ${name}`, exact: true });
const slider = (page: Page, name: string) => page.getByRole('slider', { name: `${name} slider`, exact: true });
async function appearance(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
}
async function setExact(page: Page, name: string, value: string) {
  await exact(page, name).fill(value); await exact(page, name).press('Enter');
}

for (const width of [2048, 1024, 390]) test(`precision controls preserve the evidence and fit at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1041 });
  await appearance(page);
  const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
  expect(identity.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
  await info.attach('frontend-identity', { body: JSON.stringify({ buildId: identity.buildId }), contentType: 'application/json' });
  await page.evaluate(() => { (window as any).__evidence = [document.querySelector('video'), document.querySelector('.caption-panel')]; });
  await setExact(page, 'size', '72');
  await expect(slider(page, 'Size')).toHaveValue('72');
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(72);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.evaluate(() => (window as any).__evidence.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-panel' : 'video')))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const field = exact(page, 'size');
  await field.scrollIntoViewIfNeeded();
  if (width === 390) {
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByRole('button', { name: /^Reset size to/ }).boundingBox())!.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath(`appearance-${width}.png`) });
  await tools(page).click();
  const menu = page.getByRole('menu', { name: 'Project tools' });
  await expect(menu.getByRole('menuitem')).toHaveCount(9);
  // Presentation scales during entry; hit-target geometry is measured at rest.
  await expect.poll(() => menu.evaluate((node) => node.getAnimations().length)).toBe(0);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await menu.evaluate((node) => node.scrollHeight)).toBeLessThan(600);
  const rows = await menu.getByRole('menuitem').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(rows.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: info.outputPath(`tools-${width}.png`) });
});

test('fractional opacity remains exact until explicitly edited or reset', async ({ page }) => {
  Object.assign(state.projects[0].captionAppearance!, { backgroundEnabled: true, backgroundOpacity: .584, glowEnabled: true, glowOpacity: .554 });
  await appearance(page);
  await page.getByText('More appearance', { exact: true }).click();
  await expect(exact(page, 'background opacity')).toHaveValue('58.4');
  await expect(exact(page, 'glow opacity')).toHaveValue('55.4');
  await exact(page, 'background opacity').focus(); await exact(page, 'background opacity').blur();
  expect(state.projects[0].captionAppearance!.backgroundOpacity).toBe(.584);
  await expect(page.getByRole('button', { name: /^Reset background opacity to/ })).toBeVisible();
  await setExact(page, 'background opacity', '58');
  await page.getByRole('button', { name: /^Reset glow opacity to/ }).click();
  await expect.poll(() => state.projects[0].captionAppearance!.backgroundOpacity).toBe(.58);
  await expect.poll(() => state.projects[0].captionAppearance!.glowOpacity).toBe(.55);
});

for (const kind of ['tools', 'row']) for (const reduced of [false, true]) test(`${kind} trigger close retains focus with reduced motion ${reduced}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await openProject(page);
  const trigger = kind === 'tools' ? tools(page) : page.getByLabel('More actions for caption 1', { exact: true });
  await trigger.click();
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await trigger.click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('typed drafts are atomic, cancelable, bounded and retain existing fractions on focus', async ({ page }) => {
  state.projects[0].captionAppearance!.fontSize1080 = 56.25;
  await appearance(page);
  const size = exact(page, 'size');
  await size.focus(); await size.blur();
  await expect(size).toHaveValue('56.25');
  expect(state.projects[0].captionAppearance!.fontSize1080).toBe(56.25);
  await size.fill('91');
  expect(state.projects[0].captionAppearance!.fontSize1080).toBe(56.25);
  await size.press('Escape');
  await expect(size).toHaveValue('56.25');
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  await size.fill(''); await size.press('Enter');
  await expect(size).toHaveValue('56.25');
  await setExact(page, 'size', '999'); await expect(size).toHaveValue('120');
  await setExact(page, 'size', '-4'); await expect(size).toHaveValue('22');
  await size.fill('73'); await size.press('Tab');
  await expect(slider(page, 'Size')).toHaveValue('73');
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(73);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(exact(page, 'size')).toHaveValue('73');
});

test('typed changes and single-setting resets retain sibling settings and one-step Undo/Redo', async ({ page }) => {
  const beforeCaptions = structuredClone(state.projects[0].captions);
  await appearance(page);
  await setExact(page, 'position', '25');
  await setExact(page, 'size', '78');
  const history = page.getByLabel('Appearance history');
  await history.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(exact(page, 'size')).toHaveValue('56');
  await expect(exact(page, 'position')).toHaveValue('25');
  await history.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(exact(page, 'size')).toHaveValue('78');
  await page.getByRole('button', { name: /^Reset size to/ }).click();
  await expect(exact(page, 'size')).toHaveValue(String(DEFAULT_CAPTION_APPEARANCE.fontSize1080));
  await expect(exact(page, 'size')).toBeFocused();
  await expect(page.getByRole('button', { name: /^Reset size to/ })).toHaveCount(0);
  await history.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(exact(page, 'size')).toHaveValue('78');
  await expect(exact(page, 'position')).toHaveValue('25');
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(78);
  expect(state.projects[0].captions).toEqual(beforeCaptions);
});

test('advanced numbers preserve percentages, half steps, zero and motion duration semantics', async ({ page }) => {
  await appearance(page);
  await page.getByText('More appearance', { exact: true }).click();
  await setExact(page, 'outline', '4.5'); await expect(slider(page, 'Outline')).toHaveValue('4.5');
  await setExact(page, 'shadow', '0'); await expect(slider(page, 'Shadow')).toHaveValue('0');
  const background = page.locator('.toggle-field').filter({ hasText: 'Background box' });
  await background.getByRole('button').click();
  await setExact(page, 'background opacity', '37');
  await page.getByRole('button', { name: /^Reset background opacity to/ }).click();
  await expect(exact(page, 'background opacity')).toHaveValue('58');
  await expect(background.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  const glow = page.locator('.toggle-field').filter({ hasText: /^Glow/ });
  await glow.getByRole('button').click();
  await setExact(page, 'glow opacity', '0');
  await setExact(page, 'glow width', '7.3'); await expect(exact(page, 'glow width')).toHaveValue('7.5');
  await page.locator('.appearance-motion-disclosure>summary').click();
  await page.getByRole('button', { name: 'Fade', exact: true }).click();
  await setExact(page, 'fade duration', '173'); await expect(exact(page, 'fade duration')).toHaveValue('170');
  await expect.poll(() => state.projects[0].captionAppearance!.motionDurationMs).toBe(170);
  expect(state.projects[0].captionAppearance).toMatchObject({ outlineWidth1080: 4.5, shadowWidth1080: 0, backgroundOpacity: .58, glowOpacity: 0, glowWidth1080: 7.5 });
});

for (const kind of ['tools', 'row']) test(`${kind} keyboard navigation owns focus, wraps, types and leaves cleanly`, async ({ page }) => {
  await openProject(page);
  const trigger = kind === 'tools' ? tools(page) : page.getByLabel('More actions for caption 1', { exact: true });
  await trigger.focus(); await trigger.press('ArrowDown');
  const menu = page.getByRole('menu', { name: kind === 'tools' ? 'Project tools' : 'Caption 1 actions', exact: true });
  const actions = menu.getByRole('menuitem').filter({ visible: true });
  await expect(actions.first()).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(actions.last()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(actions.first()).toBeFocused();
  await page.keyboard.press('End'); await expect(actions.last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(actions.first()).toBeFocused();
  await page.keyboard.press(kind === 'tools' ? 'h' : 'l');
  await expect(menu.getByRole('menuitem', { name: kind === 'tools' ? /^History/ : 'Lock text', exact: kind === 'row' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await trigger.press('ArrowUp'); await expect(actions.last()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('[role=menu]').evaluateAll((menus) => menus.some((node) => node.contains(document.activeElement)))).toBe(false);
  await trigger.focus(); await trigger.press('Space'); await expect(actions.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('locked row menu skips disabled actions and structural actions restore connected focus', async ({ page }) => {
  state.projects[0].captions[0].textLocked = true;
  state.projects[0].captions[0].timingLocked = true;
  await openProject(page);
  const trigger = page.getByLabel('More actions for caption 1', { exact: true });
  await trigger.focus(); await trigger.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Unlock timing', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name: 'Edit word timing', exact: true })).toBeFocused();
  await page.keyboard.press('l'); // no enabled Lock action: do not activate anything
  await page.keyboard.press('Escape');
  await page.getByLabel('More actions for caption 2', { exact: true }).focus();
  await page.keyboard.press('ArrowUp'); await expect(page.getByRole('menuitem', { name: 'Delete caption', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.caption-row')).toHaveCount(2);
  await expect(page.getByLabel('More actions for caption 2', { exact: true })).toBeFocused();
});

test('menu typing in Fine timing never auditions, nudges or invokes timing Undo', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const before = structuredClone(state.projects[0].captions);
  const playhead = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime);
  await tools(page).click();
  await page.keyboard.press('r');
  await expect(page.getByRole('menuitem', { name: /^Replace media/ })).toBeFocused();
  await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Control+z');
  expect(state.projects[0].captions).toEqual(before);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime }))).toEqual({ paused: true, time: playhead });
  await page.keyboard.press('Escape');
  await expect(page.locator('.timing-waveform-surface')).toBeVisible();
});

for (const key of ['Alt+ArrowRight', 'Control+z', 'Meta+z', 'r']) test(`History restore confirmation blocks timing shortcut ${key}`, async ({ page }) => {
  await page.route('**/api/projects/landscape/history', (route) => route.fulfill({ json: [{
    id: 'saved-1', projectId: 'landscape', label: 'Before correction', source: 'manual-save',
    createdAt: '2026-01-01T00:00:00.000Z', captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0,
  }] }));
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const original = structuredClone(state.projects[0].captions);
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.press('Alt+ArrowRight');
  await expect.poll(() => state.projects[0].captions[0].startMs).not.toBe(original[0].startMs);
  const edited = structuredClone(state.projects[0].captions);
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    (window as any).__timingPlays = 0;
    video.addEventListener('play', () => { (window as any).__timingPlays++; });
  });
  await tools(page).click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  await page.getByRole('dialog', { name: 'Project history', exact: true }).getByRole('button', { name: /^Restore Before correction/ }).click();
  const confirmation = page.getByRole('alertdialog');
  const cancel = confirmation.locator('.studio-confirm-cancel');
  await expect(cancel).toBeFocused();
  await cancel.press(key);
  await cancel.click();
  await page.keyboard.press('Escape');
  // Flush any unexpected draft through the normal save path, rather than only inspecting old server state.
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(state.projects[0].captions).toEqual(edited);
  expect(await page.evaluate(() => (window as any).__timingPlays)).toBe(0);
  await canvas.press('Control+z');
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(original[0].startMs);
});
