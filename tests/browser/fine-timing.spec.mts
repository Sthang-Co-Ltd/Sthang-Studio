import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openTiming(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
}

test('timing nudges preserve wording and neighbours, with undo and redo after autosave', async ({ page }) => {
  state.projects[0].captions[0].approved = true;
  await openTiming(page);
  await page.getByRole('button', { name: 'Move start later by 50 milliseconds', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
  expect(state.projects[0].captions[0].endMs).toBe(1000);
  expect(state.projects[0].captions[0].approved).toBe(false);
  expect(state.projects[0].captions[1].startMs).toBe(1200);
  await page.locator('.fine-timing').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(200);
  expect(state.projects[0].captions[0].approved).toBe(true);
  expect(state.projects[0].captions[0].timingSource).toBe('stt');
  await page.locator('.fine-timing').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
  expect(state.projects[0].captions[0].text).toBe('កម្ពុជា CapCut');
});

test('a drag is one edit; Escape cancels a preview without closing the workspace', async ({ page }) => {
  await openTiming(page);
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const at = (ms: number) => box.x + ms / 2500 * box.width;
  await page.mouse.move(at(200), box.y + 158);
  await page.mouse.down();
  await page.mouse.move(at(350), box.y + 158, { steps: 8 });
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.350');
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  await page.mouse.move(at(200), box.y + 158);
  await page.mouse.down();
  await page.mouse.move(at(350), box.y + 158, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(350);
  await page.locator('.fine-timing').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
});

test('clicking the audio above an edge seeks without changing timing', async ({ page }) => {
  await openTiming(page);
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 200 / 2500 * box.width, box.y + 65);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBeCloseTo(200, -1);
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
});

test('whole-caption movement preserves duration and stops at the media edge', async ({ page }) => {
  await openTiming(page);
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(150);
  expect(state.projects[0].captions[0].endMs).toBe(950);
  await page.getByLabel('Timing nudge step').selectOption('100');
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(0);
  expect(state.projects[0].captions[0].endMs).toBe(800);
});

test('locked captions remain playable but their timing cannot be changed', async ({ page }) => {
  state.projects[0].captions[0].timingLocked = true;
  await openTiming(page);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move later', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Replay caption', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Next caption', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:01.200');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeEnabled();
});

test('caption audition stops at the range and changing workspace cancels a loop', async ({ page }) => {
  await openTiming(page);
  await page.getByRole('button', { name: 'Replay caption', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  const stoppedAt = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime * 1000);
  expect(stoppedAt).toBeGreaterThanOrEqual(1100);
  expect(stoppedAt).toBeLessThanOrEqual(1150);
  await page.locator('.fine-timing').getByLabel('Loop', { exact: true }).check();
  await page.getByRole('button', { name: 'Replay caption', exact: true }).click();
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 2; void video.play(); });
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.3);
});

test('manual captions have timing controls even without generated word anchors', async ({ page }) => {
  delete state.projects[0].transcript;
  await openTiming(page);
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
});

test('timing controls and source audition still work when waveform loading fails', async ({ page }) => {
  await page.route('**/api/projects/landscape/normalized-audio.wav?*', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic waveform failure' } }));
  await openProject(page);
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.waveform-recovery')).toBeVisible();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
  await page.getByRole('button', { name: 'Replay caption', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
});

test('manual time entry does not save partial values and Escape preserves the workspace', async ({ page }) => {
  await openTiming(page);
  const input = page.getByLabel('Fine timing start', { exact: true });
  await input.fill('00:');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
  await input.press('Escape');
  await expect(input).toHaveValue('00:00.200');
  await expect(page.locator('.fine-timing')).toBeVisible();
  await input.fill('0.375');
  await input.press('Enter');
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(375);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('00:00.200');
});

test('stale undo cannot overwrite a subsequent caption text edit', async ({ page }) => {
  await openTiming(page);
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer wording');
  await page.getByRole('button', { name: 'Focus caption', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect.poll(() => state.projects[0].captions[0].text).toBe('Newer wording');
  expect(state.projects[0].captions[0].startMs).toBe(250);
});

test('global timing shortcuts use bounded movement and the timing undo history', async ({ page }) => {
  await openTiming(page);
  await page.locator('video').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.250');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 3; video.dispatchEvent(new Event('timeupdate')); });
  await expect(page.getByRole('button', { name: 'Set start to playhead', exact: true })).toBeDisabled();
  // A later cue now protects this boundary by default. Explicit overlaps retain
  // the original media-bounds behavior when the user deliberately enables them.
  await expect(page.getByRole('button', { name: 'Set end to playhead', exact: true })).toBeDisabled();
  await page.locator('.timing-options > summary').click();
  await page.getByLabel('Allow overlaps', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Set end to playhead', exact: true })).toBeEnabled();
});

test('moving a caption past another keeps the list and saved export order chronological', async ({ page }) => {
  await openTiming(page);
  await page.locator('.timing-options > summary').click();
  await page.getByLabel('Allow overlaps', { exact: true }).check();
  await page.getByLabel('Timing nudge step').selectOption('100');
  for (let step = 0; step < 13; step++) await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => state.projects[0].captions.map((caption) => caption.id)).toEqual(['c2', 'c1', 'c3']);
  expect(state.projects[0].captions[1].startMs).toBe(1500);
  expect(state.projects[0].captions[1].endMs).toBe(2300);
  await expect(page.locator('.timing-caption-nav strong')).toHaveText('Caption 2 / 3');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:01.500');
});

test('same-project media changes discard obsolete waveform caches', async ({ page }) => {
  await openTiming(page);
  const originalMedia = structuredClone(state.projects[0].media);
  const audioRequests = () => state.requests.filter((request) => request.path.endsWith('/normalized-audio.wav')).length;
  const originalRequests = audioRequests();
  await page.getByLabel('Back to projects').click();
  state.projects[0].media = { ...state.projects[0].media, filename: 'replacement.mp4', size: 6000, url: '/media/replacement.mp4' };
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  expect(audioRequests()).toBeGreaterThan(originalRequests);
  const replacementRequests = audioRequests();
  await page.getByLabel('Back to projects').click();
  state.projects[0].media = originalMedia;
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  // StrictMode may start/cancel more than one request. Returning to the original
  // media must fetch again, proving its obsolete cache was actually discarded.
  expect(audioRequests()).toBeGreaterThan(replacementRequests);
  expect(await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__.audioCacheHitCount)).toBe(0);
});

test('a long recording opens at a useful caption scale rather than a whole-video zoom limit', async ({ page }) => {
  const wav = createSyntheticWav(1200, 440, 8000);
  state.projects[0].transcript!.timing!.audioDurationMs = 1_200_000;
  await page.route('**/api/projects/landscape/normalized-audio.wav?*', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
  await openTiming(page);
  await expect(page.locator('.timing-view-span')).toHaveText('2.5 s visible');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.timing-view-span')).toHaveText('1.7 s visible');
  await page.getByRole('button', { name: 'Full clip', exact: true }).click();
  await expect(page.locator('.timing-view-span')).toHaveText('1200.0 s visible');
  await page.getByRole('button', { name: 'Focus caption', exact: true }).click();
  await expect(page.locator('.timing-view-span')).toHaveText('2.5 s visible');
});

test('timing controls remain labeled and fit a narrow viewport', async ({ page }) => {
  state.native = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await openTiming(page);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking)).toBe(true);
  await expect(page.getByRole('button', { name: 'Set start to playhead', exact: true })).toBeVisible();
  const sizes = await page.locator('.fine-timing button:visible').evaluateAll((buttons) => buttons.map((button) => ({ height: button.getBoundingClientRect().height, label: button.getAttribute('aria-label') || button.textContent?.trim() })));
  expect(sizes.every((button) => button.height >= 44 && Boolean(button.label))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/fine-timing-mobile.png', fullPage: true });
});

test('desktop timing view has no horizontal overflow and no runtime errors', async ({ page }) => {
  state.native = true;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openTiming(page);
  await page.locator('.waveform-data-canvas').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking)).toBe(true);
  await expect(page.locator('.media-stage')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/fine-timing-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('a rejected numeric edit never becomes the displayed or Escape-restored timestamp', async ({ page }) => {
  state.projects[0].captions[0].endMs = 5000; // A legacy cue extending beyond the 4s source.
  await openTiming(page);
  const start = page.getByLabel('Fine timing start', { exact: true });
  await start.fill('0.5');
  await start.press('Enter');
  await expect(start).toHaveValue('00:00.200');
  await start.fill('0.7');
  await start.press('Escape');
  await expect(start).toHaveValue('00:00.200');
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
});

test('word snapping distinguishes token starts from token ends', async ({ page }) => {
  state.projects[0].transcript!.tokens = [
    { id: 'word-a', text: 'First', startMs: 250, endMs: 960, spaceBefore: false, timingSource: 'stt' },
    { id: 'word-b', text: 'Second', startMs: 975, endMs: 1100, spaceBefore: true, timingSource: 'stt' },
  ];
  await openTiming(page);
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const dragEdge = async (fromMs: number, toMs: number) => {
    await page.mouse.move(box.x + fromMs / 2500 * box.width, box.y + 158);
    await page.mouse.down();
    await page.mouse.move(box.x + toMs / 2500 * box.width, box.y + 158, { steps: 5 });
    await page.mouse.up();
  };
  await dragEdge(200, 240);
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.250');
  await dragEdge(1000, 970);
  await expect(page.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:00.960');
});

test('quiet-gap snapping does not invent a silence boundary in a flat tone', async ({ page }) => {
  await openTiming(page);
  await page.locator('.timing-options > summary').click();
  await page.getByLabel('Boundary snapping', { exact: true }).selectOption('silence');
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200 / 2500 * box.width, box.y + 158);
  await page.mouse.down();
  await page.mouse.move(box.x + 350 / 2500 * box.width, box.y + 158, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.350');
});

test('a smaller desktop keeps source playback visible while editing lower timing controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTiming(page);
  await page.getByLabel('Fine timing end', { exact: true }).fill('1.050');
  await page.getByLabel('Fine timing end', { exact: true }).press('Enter');
  await expect(page.locator('.media-stage')).toBeInViewport();
  const player = (await page.locator('.media-stage').boundingBox())!;
  const input = (await page.getByLabel('Fine timing end', { exact: true }).boundingBox())!;
  expect(player.height).toBeGreaterThanOrEqual(170);
  expect(input.y).toBeGreaterThan(player.y + player.height);
  expect(input.y + input.height).toBeLessThanOrEqual(720);
});
