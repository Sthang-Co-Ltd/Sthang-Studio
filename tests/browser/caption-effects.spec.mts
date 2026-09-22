import { test, expect, type Page } from '@playwright/test';
import { normalizeCaptionAppearance } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const current = () => state.projects[0];
const panel = (page: Page) => page.locator('.caption-appearance-workspace');
const look = (page: Page, label: string) => page.getByRole('group', { name: 'Caption looks' }).getByRole('button', { name: new RegExp(`^${label}`) });
async function openEffects(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByLabel('Khmer font', { exact: true })).toBeEnabled();
}

test('original looks preserve creator typography, placement, timing and independent emphasis', async ({ page }) => {
  current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, bold: false, fontSize1080: 76, positionBottomPct: 27, alignment: 'left', maxWidthPct: 77, highlightMode: 'word', highlightColor: '#FF8000' });
  const before = structuredClone(current());
  await openEffects(page);
  await look(page, 'Bold Outline').click();
  await expect.poll(() => current().captionAppearance?.outlineWidth1080).toBe(6);
  const after = current().captionAppearance!;
  for (const key of ['fontFamily', 'bold', 'fontSize1080', 'positionBottomPct', 'alignment', 'maxWidthPct', 'highlightMode', 'highlightColor'] as const) {
    expect(after[key]).toEqual(before.captionAppearance![key]);
  }
  expect(current().captions).toEqual(before.captions);
  await expect(look(page, 'Bold Outline')).toHaveAttribute('aria-pressed', 'true');
  expect(state.requests.some((request) => request.path.endsWith('/captions'))).toBe(false);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test('a look choice and Reset look each undo as one action without resetting motion or font', async ({ page }) => {
  current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, positionBottomPct: 24, motionPreset: 'fade', highlightMode: 'word' });
  const before = structuredClone(current().captionAppearance);
  await openEffects(page);
  await look(page, 'Soft Glow').click();
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(true);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => current().captionAppearance).toEqual(before);
  await panel(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(true);
  await panel(page).getByRole('button', { name: 'Reset look', exact: true }).click();
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(false);
  expect(current().captionAppearance?.motionPreset).toBe('fade');
  expect(current().captionAppearance?.highlightMode).toBe('word');
  expect(current().captionAppearance?.positionBottomPct).toBe(24);
  expect(current().captionAppearance?.fontFamily).toBe(before!.fontFamily);
});

test('native glow produces different pixels and survives leaving and reopening Appearance', async ({ page }) => {
  state.native = true;
  await openEffects(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const original = await page.locator('.native-caption-image').getAttribute('src');
  await look(page, 'Soft Glow').click();
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(true);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect.poll(() => page.locator('.native-caption-image').getAttribute('src')).not.toBe(original);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(look(page, 'Soft Glow')).toHaveAttribute('aria-pressed', 'true');
});

test('paused native fade seeks change paint within a caption and keep the gap empty', async ({ page }) => {
  state.native = true;
  await openEffects(page);
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'Fade', exact: true }).click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('fade');
  await seek(page, 230);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const early = await page.locator('.native-caption-image').getAttribute('src');
  const firstKey = await page.locator('.native-caption-surface').getAttribute('data-paint-key');
  await seek(page, 300);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect(page.locator('.native-caption-surface')).not.toHaveAttribute('data-paint-key', firstKey!);
  await expect.poll(() => page.locator('.native-caption-image').getAttribute('src')).not.toBe(early);
  await seek(page, 1100);
  await expect(page.locator('.native-caption-image')).toHaveCount(0);
});

test('Replay effect prepares bounded native batches then plays the selected caption once', async ({ page }) => {
  state.native = true;
  await openEffects(page);
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'Fade', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Replay effect', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  const end = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
  expect(end).toBeGreaterThanOrEqual(1100);
  expect(end).toBeLessThanOrEqual(1140);
  const batches = state.requests.filter((request) => request.path.endsWith('/preview') && request.body.appearance.motionPreset === 'fade');
  expect(batches.length).toBeGreaterThan(0);
  expect(batches.every((request) => request.body.timesMs.length <= 8)).toBe(true);
});

test('changing motion while Replay is preparing cancels delayed autoplay', async ({ page }) => {
  await openEffects(page);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let completed = 0;
  await page.route('**/api/video-export/*/preview', async (route) => {
    if (route.request().postDataJSON().appearance.motionPreset === 'fade') { entered(); await gate; }
    await route.fallback();
    completed += 1;
  });
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'Fade', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Replay effect', exact: true }).click();
  await started;
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'None', exact: true }).click();
  release();
  await expect.poll(() => completed).toBeGreaterThan(0);
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('none');
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test('local presets retain glow, fade and word emphasis together', async ({ page }) => {
  await openEffects(page);
  await look(page, 'Soft Glow').click();
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'Fade', exact: true }).click();
  await page.getByRole('button', { name: 'Highlight spoken word', exact: true }).click();
  await panel(page).getByText('Manage presets', { exact: true }).click();
  await panel(page).getByPlaceholder('Example: Clean Khmer').fill('Studio glow and fade');
  await panel(page).getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect.poll(() => state.profile.captionAppearances?.length).toBe(1);
  const preset = state.profile.captionAppearances![0];
  expect(preset.appearance.glowEnabled).toBe(true);
  expect(preset.appearance.motionPreset).toBe('fade');
  expect(preset.appearance.highlightMode).toBe('word');
  await look(page, 'Clean').click();
  await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'None', exact: true }).click();
  await panel(page).getByLabel('Preset', { exact: true }).selectOption(preset.id);
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(true);
  expect(current().captionAppearance?.motionPreset).toBe('fade');
});

test('the gallery fits desktop and mobile with visible labels, focus and no automatic animations', async ({ page }) => {
  state.native = true;
  await openEffects(page);
  await look(page, 'Soft Glow').click();
  await expect.poll(() => current().captionAppearance?.glowEnabled).toBe(true);
  await page.getByRole('group', { name: 'Caption looks' }).scrollIntoViewIfNeeded();
  await expect(page.locator('.media-stage')).toBeInViewport();
  await page.screenshot({ path: 'test-results/caption-effects-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Caption motion' }).scrollIntoViewIfNeeded();
  await expect(page.locator('.media-stage')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const cards = await page.getByRole('group', { name: 'Caption looks' }).getByRole('button').evaluateAll((buttons) => buttons.map((button) => ({ h: button.getBoundingClientRect().height, label: button.textContent?.trim(), animation: getComputedStyle(button).animationName })));
  expect(cards).toHaveLength(6);
  expect(cards.every((card) => card.h >= 44 && card.label && card.animation === 'none')).toBe(true);
  await page.screenshot({ path: 'test-results/caption-effects-mobile.png', fullPage: true });
});

test('Review focus remains visible at a selected fade boundary without changing caption paint', async ({ page }) => {
  state.native = true;
  current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, motionPreset: 'fade' });
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await seek(page, 150);
  await expect(page.locator('.native-caption-focus')).toHaveCount(0);
  await seek(page, 200);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  expect(state.requests.some((request) => request.path.endsWith('/preview') && request.body.focusIndices?.length === 1)).toBe(true);
  const captionPaint = await page.locator('.native-caption-image').getAttribute('src');
  await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
  await page.getByLabel('Review focus', { exact: true }).selectOption('off');
  await expect(page.locator('.native-caption-focus')).toHaveCount(0);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.locator('.native-caption-image').getAttribute('src')).toBe(captionPaint);
});

test('a slider gesture has one appearance undo step and an unavailable font is never replaced by a Look', async ({ page }) => {
  current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, fontFamily: 'Missing creator font' });
  await openEffects(page);
  await look(page, 'Bold Outline').click();
  await expect.poll(() => current().captionAppearance?.outlineWidth1080).toBe(6);
  expect(current().captionAppearance?.fontFamily).toBe('Missing creator font');
  await expect(panel(page)).toContainText('is not available');
  const size = panel(page).getByRole('slider').first();
  const before = await size.inputValue();
  await size.focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await expect(size).not.toHaveValue(before);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(size).toHaveValue(before);
  expect(current().captionAppearance?.fontFamily).toBe('Missing creator font');
});
