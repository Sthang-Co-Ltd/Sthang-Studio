import { test, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming, createCaptionData, normalizeCaptionAppearance } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const current = () => state.projects[0];
const panel = (page: Page) => page.locator('.caption-appearance-workspace');
const motion = (page: Page, name: string) => page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name, exact: true });
async function appearance(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByLabel('Khmer font', { exact: true })).toBeEnabled();
}

function installWords() {
  const cue = current().captions[0];
  cue.text = 'ខ្មែរ កម្ពុជា';
  cue.wordTiming = buildCaptionWordTiming(cue, [
    { id: 'w1', text: 'ខ្មែរ', startMs: 220, endMs: 490, spaceBefore: false, timingSource: 'stt' },
    { id: 'w2', text: 'កម្ពុជា', startMs: 560, endMs: 900, spaceBefore: true, timingSource: 'stt' },
  ]);
}

test('Rise and Soft Pop are independent appearance choices with one undo and no caption mutations', async ({ page }) => {
  current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, positionBottomPct: 25, fontSize1080: 72, glowEnabled: true, highlightMode: 'word' });
  const before = structuredClone(current());
  await appearance(page);
  await motion(page, 'Rise').click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('rise');
  await expect(motion(page, 'Rise')).toHaveAttribute('aria-pressed', 'true');
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('none');
  await panel(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('rise');
  await motion(page, 'Soft Pop').click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('soft-pop');
  for (const field of ['positionBottomPct', 'fontSize1080', 'fontFamily', 'bold', 'glowEnabled', 'highlightMode'] as const) expect(current().captionAppearance![field]).toBe(before.captionAppearance![field]);
  expect(current().captions).toEqual(before.captions);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

for (const [preset, label] of [['rise', 'Rise'], ['soft-pop', 'Soft Pop']] as const) {
  test(`${label} native seeks update geometry, preserve exact state when seeking backward, and clear gaps`, async ({ page }) => {
    state.native = true;
    installWords();
    current().captionAppearance = normalizeCaptionAppearance({ ...current().captionAppearance, highlightMode: 'word', glowEnabled: true });
    await appearance(page);
    await motion(page, label).click();
    await expect.poll(() => current().captionAppearance?.motionPreset).toBe(preset);
    await seek(page, 240);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    const entry = await page.locator('.native-caption-image').getAttribute('src');
    const entryKey = await page.locator('.native-caption-surface').getAttribute('data-paint-key');
    await seek(page, 620);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    const middle = await page.locator('.native-caption-image').getAttribute('src');
    expect(middle).not.toBe(entry);
    await seek(page, 940);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    expect(await page.locator('.native-caption-image').getAttribute('src')).not.toBe(middle);
    await seek(page, 240);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', entryKey!);
    expect(await page.locator('.native-caption-image').getAttribute('src')).toBe(entry);
    await seek(page, 1100);
    await expect(page.locator('.native-caption-image')).toHaveCount(0);
  });
}

test('new motions survive preset save, workspace reopen and export with versioned appearance', async ({ page }) => {
  await appearance(page);
  await motion(page, 'Soft Pop').click();
  await panel(page).getByText('Manage presets', { exact: true }).click();
  await panel(page).getByPlaceholder('Example: Clean Khmer').fill('Soft Pop setting');
  await panel(page).getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect.poll(() => state.profile.captionAppearances?.length).toBe(1);
  const preset = state.profile.captionAppearances![0];
  expect(preset.appearance.motionPreset).toBe('soft-pop');
  await motion(page, 'None').click();
  await panel(page).getByLabel('Preset', { exact: true }).selectOption(preset.id);
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('soft-pop');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(motion(page, 'Soft Pop')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('.export-appearance-copy')).toContainText('Soft Pop');
  expect(createCaptionData({ captions: current().captions, appearance: current().captionAppearance }).version).toBe(3);
});

test('Rise replay renders bounded batches, stops once and lets manual seeking take over', async ({ page }) => {
  state.native = true;
  await appearance(page);
  await motion(page, 'Rise').click();
  await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop replay', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 2.5; });
  await expect(page.getByRole('button', { name: 'Stop replay', exact: true })).toHaveCount(0);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.75);
  const requests = state.requests.filter((r) => r.path.endsWith('/preview') && r.body.appearance.motionPreset === 'rise');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.body.timesMs.length <= 8)).toBe(true);
});

test('changing Soft Pop during preparation cancels the old animation before autoplay', async ({ page }) => {
  await appearance(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let began!: () => void;
  const requested = new Promise<void>((resolve) => { began = resolve; });
  await page.route('**/api/video-export/*/preview', async (route) => {
    if (route.request().postDataJSON().appearance.motionPreset === 'soft-pop') { began(); await gate; }
    await route.fallback().catch(() => {});
  });
  try {
    await motion(page, 'Soft Pop').click();
    await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
    await requested;
    await motion(page, 'Rise').click();
    release();
    await expect.poll(() => current().captionAppearance?.motionPreset).toBe('rise');
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  } finally { release(); }
});

test('overlapping captions disclose and use stable Fade geometry without modifying stored timing', async ({ page }) => {
  state.native = true;
  current().captions[1].startMs = 650;
  const captions = structuredClone(current().captions);
  await appearance(page);
  await motion(page, 'Soft Pop').click();
  await expect(panel(page)).toContainText('Overlapping captions stay still and fade');
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('soft-pop');
  await seek(page, 730);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const overlap = await page.locator('.native-caption-image').getAttribute('src');
  await motion(page, 'Fade').click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('fade');
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.locator('.native-caption-image').getAttribute('src')).toBe(overlap);
  expect(current().captions).toEqual(captions);
});

test('an ended overlap stays in compact preview context and cannot restart a remaining entrance', async ({ page }) => {
  state.native = true;
  current().captions = [
    { id: 'brief', text: 'Earlier overlap', startMs: 80, endMs: 140 },
    { id: 'continuing', text: 'ខ្មែរ continuing', startMs: 100, endMs: 900 },
  ];
  const captions = structuredClone(current().captions);
  await appearance(page);
  await motion(page, 'Rise').click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('rise');
  await seek(page, 180);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const suppressed = await page.locator('.native-caption-image').getAttribute('src');
  // Entry and exit can reuse the same neutral-geometry paint. A valid cached
  // frame need not trigger another request at exactly 180 ms; every request
  // contributing this cue must retain its entrance blocker nevertheless.
  const requests = state.requests.filter((r) => r.path.endsWith('/preview')
    && r.body.appearance.motionPreset === 'rise'
    && r.body.captions.some((cue: { text: string }) => cue.text === 'ខ្មែរ continuing'));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.body.captions.some((cue: { text: string }) => cue.text === 'Earlier overlap'))).toBe(true);
  await motion(page, 'Fade').click();
  await expect.poll(() => current().captionAppearance?.motionPreset).toBe('fade');
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.locator('.native-caption-image').getAttribute('src')).toBe(suppressed);
  expect(current().captions).toEqual(captions);
});

test('motion choices stay labeled and usable on phone and tablet without autoplay', async ({ page }) => {
  await appearance(page);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('group', { name: 'Caption motion' }).scrollIntoViewIfNeeded();
    const choices = page.getByRole('group', { name: 'Caption motion' }).getByRole('button');
    await expect(choices).toHaveText(['None', 'Fade', 'Rise', 'Soft Pop']);
    const bounds = await choices.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
    expect(bounds.every((box) => box.height >= (width <= 620 ? 44 : 36))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/caption-motion-${width}.png` });
  }
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});
