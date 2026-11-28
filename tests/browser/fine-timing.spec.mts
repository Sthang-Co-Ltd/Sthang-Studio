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

test.describe('whole-clip waveform overview', () => {
  test.use({ hasTouch: true, reducedMotion: 'reduce' });
  for (const width of [1440, 390]) test(`panning a three-minute recording changes only its viewport at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const sampleRate = 8000;
    const wav = createSyntheticWav(180, 200, sampleRate);
    // Give the recording distinct sections, including a quiet patch.
    for (let second = 0; second < 180; second++) {
      const gain = (1 + Math.sin(second / 7)) / 2;
      for (let i = second * sampleRate; i < (second + 1) * sampleRate; i++) {
        const offset = 44 + 2 * i;
        wav.writeInt16LE(Math.round(wav.readInt16LE(offset) * gain), offset);
      }
    }
    const item = state.projects[0];
    item.media = { filename: 'overview.wav', originalName: 'overview.wav', mimeType: 'audio/wav', size: wav.length, url: '/media/overview.wav' };
    item.captions[2] = { ...item.captions[2], startMs: 125_000, endMs: 126_000 };
    await page.route('**/media/overview.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.route('**/normalized-audio.wav*', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.goto('/');
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    const audio = page.locator('.media-stage audio');
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBe(180);
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    const overview = page.locator('.timing-overview');
    const pan = overview.getByRole('slider');
    await expect(pan).toBeEnabled();
    await expect.poll(() => overview.locator('canvas').evaluate((el: HTMLCanvasElement) =>
      el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data.some((value) => value !== 0))).toBe(true);
    const playhead = () => audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    const timeBefore = await playhead();
    const selected = page.locator('.timing-caption-nav strong');
    const before = await selected.textContent();
    const undo = page.locator('.fine-timing').getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeDisabled();
    await pan.scrollIntoViewIfNeeded();
    const box = (await pan.boundingBox())!;
    const y = box.y + box.height / 2;
    if (width === 390) {
      await page.touchscreen.tap(box.x + box.width * .7, y);
    } else {
      await page.mouse.move(box.x + 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .7, y, { steps: 8 });
      await page.mouse.up();
    }
    const jumped = Number(await pan.inputValue());
    expect(jumped).toBeGreaterThan(110_000);
    expect(jumped).toBeLessThan(140_000);
    await overview.screenshot({ path: info.outputPath('timing-overview.png') });
    await pan.press('ArrowRight');
    expect(Number(await pan.inputValue())).toBeGreaterThan(jumped);
    await pan.press('End');
    await expect(pan).toHaveAttribute('aria-valuetext', /03:00\.000$/);
    await pan.press('Home');
    await expect(pan).toHaveValue('0');
    expect(await playhead()).toBe(timeBefore);
    expect(await selected.textContent()).toBe(before);
    await expect(undo).toBeDisabled();
    expect(state.requests.filter(({ path, method }) => path.endsWith('/captions') && method === 'PUT')).toHaveLength(0);
    await page.getByRole('button', { name: 'Full clip', exact: true }).click();
    await expect(pan).toBeDisabled();
    await page.getByRole('button', { name: 'Focus caption', exact: true }).click();
    await expect(pan).toBeEnabled();
  });
});

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
  await expect(page.locator('.timing-trim-readout')).toContainText('+150');
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.timing-trim-readout')).toHaveCount(0);
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

test.describe('caption trim on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });

  test('the readout stays above the finger and clears on touch cancellation', async ({ page }, info) => {
    await openTiming(page);
    const canvas = page.locator('.waveform-data-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    const y = box.y + 158;
    const touch = await page.context().newCDPSession(page);
    const at = (ms: number) => [{ id: 1, x: box.x + ms / 2500 * box.width, y }];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(200) });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(620) });
    const readout = page.locator('.timing-trim-readout');
    await expect(readout).toContainText('(+');
    const field = page.getByLabel('Fine timing start', { exact: true });
    await expect(readout).toContainText(await field.inputValue());
    const label = (await readout.boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(label.x + label.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(label.y + label.height).toBeLessThan(y - 24);
    await page.locator('.waveform-canvas-wrap').screenshot({ path: info.outputPath('touch-trim-readout.png') });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(readout).toHaveCount(0);
    await expect(field).toHaveValue('00:00.200');
    expect(state.requests.filter(({ path, method }) => path.endsWith('/captions') && method === 'PUT')).toHaveLength(0);
  });
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
  state.projects[0].captions[2].endMs = 4000;
  await openTiming(page);
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(150);
  expect(state.projects[0].captions[0].endMs).toBe(950);
  await page.getByLabel('Timing nudge step').selectOption('100');
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(0);
  expect(state.projects[0].captions[0].endMs).toBe(800);
  const timing = page.locator('.fine-timing');
  const replay = timing.getByRole('button', { name: 'Replay caption', exact: true });
  await expect(timing.getByRole('button', { name: 'Move earlier', exact: true })).toBeDisabled();
  await expect(timing.getByRole('button', { name: 'Move start earlier by 100 milliseconds', exact: true })).toBeDisabled();
  await replay.press('Alt+ArrowLeft');
  await expect(page.locator('.toast.notice')).toHaveText('Reached the start of the media.');
  const next = timing.getByRole('button', { name: 'Next caption', exact: true });
  await next.click();
  await next.click();
  await expect(timing.getByLabel('Fine timing end', { exact: true })).toHaveValue('00:04.000');
  await expect(timing.getByRole('button', { name: 'Move later', exact: true })).toBeDisabled();
  await expect(timing.getByRole('button', { name: 'Move end later by 100 milliseconds', exact: true })).toBeDisabled();
  await replay.press('Alt+ArrowRight');
  await expect(page.locator('.toast.notice')).toHaveText('Reached the end of the media.');
});

test('zoom keeps a visible playhead in place and preserves a deliberately browsed window', async ({ page }) => {
  await openTiming(page);
  const waveform = page.getByRole('slider', { name: 'Waveform playhead', exact: true });
  const pan = page.getByRole('slider', { name: 'Scroll timing waveform', exact: true });
  const zoom = page.getByRole('button', { name: 'Zoom in', exact: true });
  await page.getByRole('button', { name: 'Full clip', exact: true }).click();
  await expect(pan).toBeDisabled();
  const bounds = (await waveform.boundingBox())!;
  await waveform.click({ position: { x: bounds.width * .8, y: 70 } });
  await expect.poll(() => page.locator('video').evaluate((media) => media.currentTime)).toBeCloseTo(3.2, 1);
  await zoom.click();
  await zoom.click();
  await expect(page.locator('.timing-view-span')).toHaveText('1.8 s visible');
  const start = Number(await pan.inputValue());
  expect((3200 - start) / (4000 / 2.25)).toBeCloseTo(.8, 1);
  await pan.press('Home');
  await expect(pan).toHaveValue('0');
  await zoom.click();
  const center = Number(await pan.inputValue()) + 4000 / 3.375 / 2;
  expect(Math.abs(center - 4000 / 2.25 / 2)).toBeLessThan(30);
  await expect.poll(() => page.locator('video').evaluate((media) => media.currentTime)).toBeCloseTo(3.2, 1);
});

test('keyboard waveform seeking and panning leave caption timing and playback independent', async ({ page }) => {
  await openTiming(page);
  const before = structuredClone(state.projects[0].captions);
  const waveform = page.getByRole('slider', { name: 'Waveform playhead', exact: true });
  const pan = page.getByRole('slider', { name: 'Scroll timing waveform', exact: true });
  const time = () => page.locator('video').evaluate((media) => Math.round(media.currentTime * 1000));
  await waveform.press('Home');
  await expect.poll(time).toBe(0);
  await waveform.press('ArrowRight');
  await expect.poll(time).toBe(50);
  await expect(waveform).toHaveAttribute('aria-valuetext', '00:00.050');
  await pan.press('ArrowRight');
  await expect(pan).toHaveValue('250');
  await expect(pan).toHaveAttribute('aria-valuetext', '00:00.250 to 00:02.750');
  expect(await time()).toBe(50);
  await waveform.press('End');
  await expect.poll(time).toBe(4000);
  await waveform.press('ArrowUp');
  await expect.poll(time).toBe(4000);
  await waveform.press('ArrowLeft');
  await expect.poll(time).toBe(3950);
  expect(state.projects[0].captions).toEqual(before);
  await expect(page.locator('.fine-timing').getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
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

test('switching between captions with equal times clears the previous invalid timestamp draft', async ({ page }) => {
  state.projects[0].captions[1].startMs = 200;
  await openTiming(page);
  const start = page.getByLabel('Fine timing start', { exact: true });
  await start.fill('00:');
  await page.getByRole('button', { name: 'Next caption', exact: true }).click();
  await expect(page.locator('.timing-caption-nav strong')).toHaveText('Caption 2 / 3');
  await expect(start).toHaveValue('00:00.200');
  await expect(start).not.toHaveAttribute('aria-invalid', 'true');
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
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
  // Native media controls own their keys. The editor shortcut applies after
  // focus returns to the surrounding editing workspace.
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.blur());
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
  await page.getByLabel('Back to Home').click();
  state.projects[0].media = { ...state.projects[0].media, filename: 'replacement.mp4', size: 6000, url: '/media/replacement.mp4' };
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  expect(audioRequests()).toBeGreaterThan(originalRequests);
  const replacementRequests = audioRequests();
  await page.getByLabel('Back to Home').click();
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

test('desktop caption edges fit without scrolling while retaining the full waveform and controls', async ({ page }) => {
  state.projects[0].mediaAlignment = { state: 'unverified-audio-change', acceptedAt: '2026-10-23T00:00:00.000Z', sourceRevision: 'fixture' };
  for (const viewport of [{ width: 2559, height: 1301 }, { width: 2048, height: 1041 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    if (!await page.locator('.fine-timing').count()) await openTiming(page);
    const panel = page.locator('.workspace-inspector');
    await expect.poll(() => panel.locator('.inspector-content').evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await expect(panel.getByRole('button', { name: 'Hear end', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole('button', { name: 'Move later', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(panel.locator('.timing-options > summary')).toBeInViewport({ ratio: 1 });
    expect((await page.locator('.waveform-canvas-wrap').boundingBox())!.height).toBe(184);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 2048, height: 1041 });
  await page.screenshot({ path: 'test-results/fine-timing-compact-desktop.png', fullPage: true });
});

test('expanded timing options and long Khmer text remain reachable in a smaller desktop', async ({ page }) => {
  state.projects[0].captions[0].text = 'កម្ពុជាខ្មែររបស់យើង '.repeat(30);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTiming(page);
  const panel = page.locator('.fine-timing');
  await panel.locator('.timing-options > summary').click();
  await panel.getByLabel('Timing playback speed', { exact: true }).selectOption('0.75');
  await panel.getByLabel('Move adjoining edge too', { exact: true }).check();
  await panel.getByRole('button', { name: 'Spectrum overview', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Spectrum overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: /Follow(?:ing)? playhead/ })).toBeInViewport({ ratio: 1 });
  expect(await page.locator('.inspector-content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator('.media-stage')).toBeInViewport({ ratio: 1 });
  await panel.getByRole('button', { name: 'Replay caption', exact: true }).focus();
  await expect(panel.getByRole('button', { name: 'Replay caption', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole('button', { name: 'Replay caption', exact: true })).toBeFocused();
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

test('word snapping distinguishes token starts from token ends', async ({ page }, info) => {
  state.projects[0].transcript!.tokens = [
    { id: 'word-a', text: 'First', startMs: 250, endMs: 960, spaceBefore: false, timingSource: 'stt' },
    { id: 'word-b', text: 'Second', startMs: 975, endMs: 1100, spaceBefore: true, timingSource: 'stt' },
  ];
  await openTiming(page);
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const readout = page.locator('.timing-trim-readout');
  const dragEdge = async (fromMs: number, toMs: number, time: string, delta: string) => {
    await page.mouse.move(box.x + fromMs / 2500 * box.width, box.y + 158);
    await page.mouse.down();
    await page.mouse.move(box.x + toMs / 2500 * box.width, box.y + 158, { steps: 5 });
    await expect(readout).toContainText(time);
    await expect(readout).toContainText(delta);
    if (fromMs === 200) {
      await page.locator('.waveform-canvas-wrap').screenshot({ path: info.outputPath('trim-readout.png') });
      await page.keyboard.down('Shift');
      await expect(readout).not.toContainText(time);
      await expect(readout).toContainText(await page.getByLabel('Fine timing start', { exact: true }).inputValue());
      await page.keyboard.up('Shift');
      await expect(readout).toContainText(time);
    }
    await page.mouse.up();
    await expect(readout).toHaveCount(0);
  };
  await dragEdge(200, 240, '00:00.250', '+50');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.250');
  await page.mouse.move(box.x + 250 / 2500 * box.width, box.y + 158);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 325 / 2500 * box.width, box.y + 158, { steps: 4 });
  await expect(readout).toContainText('(+');
  await page.keyboard.press('Escape');
  await expect(readout).toHaveCount(0);
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.250');
  await dragEdge(1000, 970, '00:00.960', '−40');
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

test('a smaller desktop keeps source playback large beside the timing controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTiming(page);
  await page.getByLabel('Fine timing end', { exact: true }).fill('1.050');
  await page.getByLabel('Fine timing end', { exact: true }).press('Enter');
  await expect(page.locator('.media-stage')).toBeInViewport();
  const player = (await page.locator('.media-stage').boundingBox())!;
  const input = (await page.getByLabel('Fine timing end', { exact: true }).boundingBox())!;
  expect(player.height).toBeGreaterThanOrEqual(450);
  expect(input.x).toBeGreaterThan(player.x + player.width);
  expect(input.y + input.height).toBeLessThanOrEqual(720);
});
