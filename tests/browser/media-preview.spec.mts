import { test, expect, type Page } from '@playwright/test';
import { continueOwnedRoute } from './owned-browser-routes.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const playbackUrl = '/media/landscape.mp4?compatible=1';
const preview = (state: 'original' | 'processing' | 'ready' | 'cancelled', source = 'landscape.mp4') => ({
  source, state, videoCodec: 'hevc', progress: state === 'ready' ? 100 : state === 'processing' ? 30 : 0,
  ...(state === 'ready' ? { url: playbackUrl } : {}),
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
// Control presentation independently of metadata/currentTime, including a
// callback already queued when a source/decoder is retired.
async function controlPresentedFrames(page: Page) {
  await page.addInitScript(() => {
    type Entry = { element: HTMLVideoElement; callback: VideoFrameRequestCallback };
    const pending = new Map<number, Entry>();
    const retired: Entry[] = [];
    let id = 0;
    (window as any).__pendingPreviewFrames = (element: HTMLVideoElement) => [...pending.values()].filter((entry) => entry.element === element).length;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) { pending.set(++id, { element: this, callback }); return id; };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function(value) { const entry = pending.get(value); if (entry) retired.push(entry); pending.delete(value); };
    (window as any).__presentPreviewFrame = (element: HTMLVideoElement, stale = false) => {
      const entries = stale ? retired.filter((entry) => entry.element === element) : [...pending.entries()].filter(([, entry]) => entry.element === element).map(([key, entry]) => { pending.delete(key); return entry; });
      const now = performance.now();
      for (const entry of entries) entry.callback(now, { presentationTime: now, expectedDisplayTime: now, width: element.videoWidth, height: element.videoHeight,
        mediaTime: element.currentTime, presentedFrames: 1, processingDuration: 0 } as VideoFrameCallbackMetadata);
      return entries.length;
    };
  });
}
async function presentFrame(page: Page) {
  const delivered = await page.locator('video').evaluate((element) => (window as any).__presentPreviewFrame(element));
  expect(delivered).toBeGreaterThan(0);
}
async function manualPreparation(page: Page) {
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => 'probably'; });
}
async function negativeHevcHints(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) { return /hvc1|hev1/.test(type) ? '' : original.call(this, type); };
  });
}
async function openDirectTrial(page: Page, delayedStatus = false) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
  const startupRequest = page.waitForRequest((request) => request.method() === 'GET' && request.url().includes('/api/media-preview/landscape'), { timeout: 8000 });
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await startupRequest; // The startup effect registers its fallback before fetching.
  if (delayedStatus) await page.clock.runFor(1600);
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
  await seek(page, 500);
}
async function expectReady(page: Page, seconds: number) {
  await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(seconds, 2);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.locator('.source-media-status')).toHaveCount(0);
}
async function switchProject(page: Page) {
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
}

test('HEVC fallback prepares once, keeps a seek made during preparation and leaves captions unchanged', async ({ page }) => {
  const state = await installFixture(page); let posts = 0; let polls = 0; let allowReady = false;
  const originalCaptions = structuredClone(state.projects[0].captions);
  await negativeHevcHints(page);
  await page.clock.install(); await controlPresentedFrames(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 202, json: preview('processing') }); }
    polls++;
    return route.fulfill({ json: preview(allowReady ? 'ready' : posts ? 'processing' : 'original') });
  });
  await openDirectTrial(page);
  await page.clock.runFor(4000); expect(posts).toBe(0);
  await page.clock.runFor(1000);
  await expect.poll(() => posts).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel preparation', exact: true })).toBeVisible();
  await seek(page, 1250);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 1.5; });
  allowReady = true;
  await page.clock.runFor(1000);
  await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(1);
  await presentFrame(page);
  await expectReady(page, 1.25);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5);
  expect(state.projects[0].media.url).toBe('/media/landscape.mp4');
  expect(state.projects[0].captions).toEqual(originalCaptions);
  expect(polls).toBeGreaterThan(1);
});

for (const statusOrder of ['before frame', 'after frame'] as const) test(`an original frame wins negative HEVC hints with status ${statusOrder}`, async ({ page }) => {
  await installFixture(page);
  await negativeHevcHints(page);
  await page.clock.install(); await controlPresentedFrames(page);
  let posts = 0;
  const releaseStatus = deferred();
  if (statusOrder === 'before frame') releaseStatus.resolve();
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') posts++;
    await releaseStatus.promise;
    return route.fulfill({ json: preview(posts ? 'processing' : 'original') }).catch(() => {});
  });
  try {
    await openDirectTrial(page, statusOrder === 'after frame');
    const original = await page.locator('video').elementHandle();
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Keep the direct-playback draft');
    await seek(page, 1250);
    await page.locator('video').evaluate((element: HTMLVideoElement) => { element.playbackRate = 1.5; element.volume = .37; element.muted = true; });
    if (statusOrder === 'before frame') await page.clock.runFor(2000);
    expect(posts).toBe(0);
    await presentFrame(page);
    releaseStatus.resolve();
    await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
    await page.clock.runFor(7000);
    expect(posts).toBe(0);
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    expect(await page.locator('video').evaluate((element: HTMLVideoElement) => ({ time: element.currentTime, paused: element.paused,
      rate: element.playbackRate, volume: element.volume, muted: element.muted }))).toEqual({ time: 1.25, paused: true, rate: 1.5, volume: .37, muted: true });
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Keep the direct-playback draft');
    await expect(page.getByRole('button', { name: 'Cancel preparation', exact: true })).toHaveCount(0);
  } finally { releaseStatus.resolve(); }
});

test('an advancing audio clock still starts one HEVC preparation after five visible seconds without a picture', async ({ page }) => {
  await installFixture(page); await negativeHevcHints(page);
  await page.clock.install(); await controlPresentedFrames(page);
  let posts = 0;
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: preview(posts ? 'processing' : 'original') });
  });
  await openDirectTrial(page);
  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperties(element, { readyState: { configurable: true, value: 4 }, paused: { configurable: true, value: false },
      videoWidth: { configurable: true, value: 0 }, videoHeight: { configurable: true, value: 0 }, currentTime: { configurable: true, writable: true, value: .5 } });
    element.dispatchEvent(new Event('play'));
  });
  for (let second = 1; second <= 4; second++) {
    await page.locator('video').evaluate((element: HTMLVideoElement, value) => {
      element.currentTime = value; element.dispatchEvent(new Event('timeupdate'));
    }, .5 + second / 5);
    await page.clock.runFor(1000); expect(posts).toBe(0);
  }
  await page.clock.runFor(1000);
  await expect.poll(() => posts).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel preparation', exact: true })).toBeVisible();
  await page.clock.runFor(6000); expect(posts).toBe(1);
});

for (const supersedingAction of ['cancel', 'retry', 'navigate'] as const) test(`an armed original trial cannot prepare after ${supersedingAction}`, async ({ page }) => {
  await installFixture(page); await negativeHevcHints(page);
  await page.clock.install(); await controlPresentedFrames(page);
  let posts = 0, cancelled = false;
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    if (route.request().method() === 'DELETE') cancelled = true;
    return route.fulfill({ json: preview(cancelled ? 'cancelled' : posts ? 'processing' : 'original') });
  });
  await openDirectTrial(page);
  await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
  const original = await page.locator('video').elementHandle();
  if (supersedingAction === 'cancel') {
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
  } else if (supersedingAction === 'retry') {
    await original!.evaluate((element) => { Object.defineProperty(element, 'error', { configurable: true, value: { code: 2 } }); element.dispatchEvent(new Event('error')); });
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await expect.poll(() => original!.evaluate((element) => element.isConnected)).toBe(false);
  } else await switchProject(page);
  await page.clock.runFor(7000);
  expect(posts).toBe(supersedingAction === 'cancel' ? 1 : 0);
  await expect(page.locator('video')).toHaveAttribute('src', supersedingAction === 'navigate' ? '/media/second.mp4' : '/media/landscape.mp4');
  await expect(page.getByRole('button', { name: 'Cancel preparation', exact: true })).toHaveCount(0);
});

test('a browser without video-frame callbacks retains immediate HEVC hint fallback', async ({ page }) => {
  await installFixture(page); await negativeHevcHints(page);
  await page.addInitScript(() => { Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: undefined }); });
  let posts = 0;
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: preview(posts ? 'ready' : 'original') });
  });
  await page.clock.install();
  await page.goto('/');
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect.poll(() => posts).toBe(1);
  await expectReady(page, 0);
});

test('failed cancellation keeps polling, clears the old error and recovers to ready', async ({ page }) => {
  await installFixture(page); let started = false; let failedCancel = false; let pollsAfterCancel = 0;
  const resumePolling = deferred();
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'DELETE') { failedCancel = true; return route.fulfill({ status: 503, json: { error: 'Synthetic cancel failure' } }); }
    if (method === 'POST') started = true;
    if (method === 'GET' && failedCancel) {
      pollsAfterCancel++; await resumePolling.promise;
      return route.fulfill({ json: preview('ready') });
    }
    return route.fulfill({ json: preview(started ? 'processing' : 'original') });
  });
  try {
    await openProject(page);
    await seek(page, 750);
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(page.locator('.source-media-status')).toContainText('Could not cancel preparation');
    await expect.poll(() => pollsAfterCancel).toBeGreaterThan(0);
    resumePolling.resolve();
    await expectReady(page, 0.75);
  } finally { resumePolling.resolve(); }
});

for (const outcome of ['failure', 'ready'] as const) test(`a late cancellation ${outcome} preserves an already recovered player`, async ({ page }) => {
  await installFixture(page);
  await manualPreparation(page);
  await controlPresentedFrames(page);
  let started = false;
  let deleting = false;
  const releaseDelete = deferred();
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'DELETE') {
      deleting = true;
      await releaseDelete.promise;
      return outcome === 'failure'
        ? route.fulfill({ status: 503, json: { error: 'Synthetic late cancellation failure' } })
        : route.fulfill({ json: preview('ready') });
    }
    if (method === 'POST') started = true;
    return route.fulfill({ json: preview(deleting ? 'ready' : started ? 'processing' : 'original') });
  });
  try {
    await openProject(page);
    await seek(page, 750);
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect.poll(() => deleting).toBe(true);
    await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(1);
    await presentFrame(page);
    await expectReady(page, 0.75);
    await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
      (video as any).__recoveredCancelTarget = true;
      video.currentTime = 0.5; video.playbackRate = 0.5; video.volume = 0.35; video.muted = true;
      await video.play();
    });
    const response = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().includes('/api/media-preview/landscape'));
    releaseDelete.resolve();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.source-media-status')).toHaveCount(0);
    const player = await page.locator('video').evaluate((video: HTMLVideoElement) => ({
      sameElement: Boolean((video as any).__recoveredCancelTarget), paused: video.paused,
      time: video.currentTime, rate: video.playbackRate, volume: video.volume, muted: video.muted,
    }));
    expect(player.sameElement).toBe(true);
    expect(player.paused).toBe(false);
    expect(player.time).toBeGreaterThanOrEqual(0.5);
    expect(player.rate).toBe(0.5);
    expect(player.volume).toBeCloseTo(0.35, 2);
    expect(player.muted).toBe(true);
  } finally { releaseDelete.resolve(); }
});

test('successful cancel and repeated clicks preserve a newer seek on the next preparation', async ({ page }) => {
  await installFixture(page); let posts = 0; let cancelled = false; let allowReady = false;
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'POST') { posts++; cancelled = false; }
    if (method === 'DELETE') cancelled = true;
    await route.fulfill({ json: preview(cancelled ? 'cancelled' : allowReady ? 'ready' : posts ? 'processing' : 'original') });
  });
  await openProject(page);
  await seek(page, 750);
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => posts).toBe(1);
  await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  await seek(page, 1500);
  allowReady = true;
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect.poll(() => posts).toBe(2);
  await expectReady(page, 1.5);
});

test('transient polling failure clears after playback becomes ready', async ({ page }) => {
  await installFixture(page); let started = false; let allowReady = false;
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'POST') { started = true; return route.fulfill({ json: preview('processing') }); }
    if (started && !allowReady) return route.fulfill({ status: 503, json: { error: 'Synthetic progress failure' } });
    return route.fulfill({ json: preview(allowReady ? 'ready' : 'original') });
  });
  await openProject(page);
  await seek(page, 750);
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect(page.locator('.source-media-status')).toContainText('Playback progress is unavailable');
  allowReady = true;
  await expectReady(page, 0.75);
});

test('failed playback copy forces a rebuild and reloads even when its URL stays the same', async ({ page }) => {
  await installFixture(page); let force: unknown; let posts = 0;
  await manualPreparation(page);
  // Use the real range-aware fixture server for the compatible URL, too.
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; force = route.request().postDataJSON().force; }
    return route.fulfill({ json: preview('ready') });
  });
  await openProject(page);
  await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
  await seek(page, 1250);
  // Establish a completed, seekable starting point before testing reload recovery.
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.25, 2);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  const originalPlayer = await page.locator('video').elementHandle();
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.dispatchEvent(new Event('error'));
  });
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  expect(force).toBe(true);
  await expect.poll(() => originalPlayer!.evaluate((video) => video.isConnected)).toBe(false);
  await expectReady(page, 1.25);
});

test('Retry replaces a poisoned decoder without losing caption edits, position or sound settings', async ({ page }) => {
  const state = await installFixture(page); let posts = 0;
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: preview('ready') });
  });
  await openProject(page);
  // openProject deliberately leaves the shared fixture paused at 500 ms.
  await expectReady(page, 0.5);
  const caption = page.locator('.caption-row textarea').first();
  await caption.fill('Unfinished caption correction');
  await seek(page, 1250);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  const old = await page.locator('video').elementHandle();
  await old!.evaluate((element) => {
    const video = element as HTMLVideoElement;
    video.playbackRate = 1.5; video.volume = 0.35; video.muted = true;
    video.dispatchEvent(new Event('timeupdate'));
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    // Model a decoder that cannot be recovered by reloading the same element.
    video.load = () => { queueMicrotask(() => video.dispatchEvent(new Event('error'))); };
    video.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('.source-media-status')).toContainText('could not decode');
  await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
  await expectReady(page, 1.25);
  expect(await old!.evaluate((video) => video.isConnected)).toBe(false);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ rate: video.playbackRate, volume: video.volume, muted: video.muted }))).toEqual({ rate: 1.5, volume: 0.35, muted: true });
  await expect(caption).toHaveValue('Unfinished caption correction');
  expect(posts).toBe(0);
  expect(state.projects[0].media.url).toBe('/media/landscape.mp4');
  // Retired media must not poison the replacement through queued events.
  await old!.evaluate((video) => { video.dispatchEvent(new Event('error')); video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('timeupdate')); });
  await expectReady(page, 1.25);
});

test('retrying a failed player keeps the native caption overlay attached after resizing', async ({ page }) => {
  await installFixture(page);
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: preview('ready') }));
  await openProject(page); await expectReady(page, 0.5);
  await seek(page, 500);
  await page.locator('video').dispatchEvent('error');
  await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
  await expectReady(page, 0.5);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator('.native-caption-image')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector('video')!;
    const surface = document.querySelector('.native-caption-surface')!;
    const expected = Math.min(video.clientWidth, video.clientHeight * video.videoWidth / video.videoHeight);
    return Math.abs(surface.getBoundingClientRect().width - expected);
  })).toBeLessThan(1);
});

test('repeated Retry before metadata keeps the original recovery position', async ({ page }) => {
  await installFixture(page);
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: preview('ready') }));
  await openProject(page); await expectReady(page, 0.5);
  await seek(page, 1250);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  const release = deferred(); let requests = 0;
  await page.route('**/media/landscape.mp4?compatible=1', async (route) => {
    requests++; await release.promise; await continueOwnedRoute(route).catch(() => {});
  });
  try {
    await page.locator('video').dispatchEvent('error');
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Retry again', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(1);
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      video.playbackRate = 0.75; video.volume = 0.2; video.muted = true;
    });
    release.resolve();
    await expectReady(page, 1.25);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ rate: video.playbackRate, volume: video.volume, muted: video.muted }))).toEqual({ rate: 0.75, volume: 0.2, muted: true });
  } finally { release.resolve(); }
});

for (const code of [3, 4]) for (const presentedBeforeError of [false, true]) test(`decoder error ${code} immediately prepares after original presentation=${presentedBeforeError}`, async ({ page }) => {
  await installFixture(page); let posts = 0;
  await manualPreparation(page);
  await controlPresentedFrames(page);
  await page.clock.install();
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: preview('ready') }); }
    return route.fulfill({ json: preview('original') });
  });
  await openDirectTrial(page); await seek(page, 1250);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  if (presentedBeforeError) await presentFrame(page);
  const old = await page.locator('video').elementHandle();
  await old!.evaluate((video, errorCode) => {
    video.dispatchEvent(new Event('timeupdate'));
    Object.defineProperty(video, 'error', { configurable: true, value: { code: errorCode } });
    video.dispatchEvent(new Event('error'));
  }, code);
  await expect.poll(() => posts).toBe(1);
  await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(1);
  await presentFrame(page);
  await expectReady(page, 1.25);
  expect(await old!.evaluate((video) => video.isConnected)).toBe(false);
});

test('opening a cached copy before original metadata retains the selected editing speed', async ({ page }) => {
  await installFixture(page);
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: preview('ready') }));
  await page.route('**/api/media-preview/second*', (route) => route.fulfill({ json: { ...preview('ready', 'second.mp4'), url: '/media/second.mp4?compatible=1' } }));
  await openProject(page); await expectReady(page, 0.5);
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await page.getByText('Snapping, playback speed and display', { exact: true }).click();
  await page.getByLabel('Timing playback speed', { exact: true }).selectOption('1.5');
  const release = deferred();
  await page.route('**/media/second.mp4', async (route) => { await release.promise; await continueOwnedRoute(route).catch(() => {}); });
  try {
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4?compatible=1');
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5);
  } finally { release.resolve(); }
});

test('a cancel that finds completed playback keeps it ready despite an older in-flight poll', async ({ page }) => {
  await installFixture(page); let started = false; let cancelled = false;
  const pollStarted = deferred(); const releasePoll = deferred();
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'POST') { started = true; return route.fulfill({ json: preview('processing') }); }
    if (method === 'DELETE') { cancelled = true; return route.fulfill({ json: preview('ready') }); }
    if (started && !cancelled) {
      pollStarted.resolve(); await releasePoll.promise;
      // The client may have aborted this obsolete GET after accepting cancellation.
      return route.fulfill({ json: preview('processing') }).catch(() => {});
    }
    return route.fulfill({ json: preview(cancelled ? 'ready' : 'original') });
  });
  try {
    await openProject(page);
    await seek(page, 1250);
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await pollStarted.promise;
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expectReady(page, 1.25);
    releasePoll.resolve();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expectReady(page, 1.25);
  } finally { releasePoll.resolve(); }
});

test('a delayed preparation reply cannot replace playback after in-app project navigation', async ({ page }) => {
  await installFixture(page); const postStarted = deferred(); const releasePost = deferred(); const postSettled = deferred();
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { postStarted.resolve(); await releasePost.promise; return route.fulfill({ json: preview('ready') }).catch(() => {}).finally(postSettled.resolve); }
    return route.fulfill({ json: preview('original') });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await postStarted.promise;
    await switchProject(page);
    await seek(page, 1500);
    releasePost.resolve();
    await postSettled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.5, 2);
    await expect(page.locator('.source-media-status')).toHaveCount(0);
  } finally { releasePost.resolve(); }
});

test('stale-source response cannot swap playback and a valid retry clears its error', async ({ page }) => {
  await installFixture(page); let posts = 0;
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: preview('ready', posts === 1 ? 'replaced.mp4' : 'landscape.mp4') }); }
    return route.fulfill({ json: preview('original') });
  });
  await openProject(page);
  await seek(page, 750);
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect(page.locator('.source-media-status')).toContainText('The source media changed');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  await seek(page, 1500);
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expectReady(page, 1.5);
});

test('warm compatible startup makes no original media request, including StrictMode cleanup', async ({ page }) => {
  await installFixture(page); let originals = 0;
  await page.clock.install();
  await page.route('**/media/landscape.mp4', async (route) => { originals++; await continueOwnedRoute(route); });
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: preview('ready') }));
  await openProject(page); await expectReady(page, 0.5);
  await page.clock.runFor(1600);
  await expectReady(page, 0.5);
  expect(originals).toBe(0);
});

for (const delayedState of ['original', 'ready'] as const) test(`slow initial ${delayedState} status completes after direct playback becomes available`, async ({ page }) => {
  await installFixture(page);
  let posts = 0;
  const releaseStatus = deferred();
  await negativeHevcHints(page);
  await page.clock.install();
  if (delayedState === 'original') await controlPresentedFrames(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ json: preview('ready') });
    }
    await releaseStatus.promise;
    return route.fulfill({ json: preview(delayedState) }).catch(() => {});
  });
  try {
    // The held inspection must not prevent the 1.5-second direct-playback fallback.
    await openDirectTrial(page, true);
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    expect(posts).toBe(0);
    await seek(page, 1750);
    await page.locator('video').evaluate((element: HTMLVideoElement) => {
      element.playbackRate = 1.5; element.volume = 0.37; element.muted = true;
    });
    releaseStatus.resolve();
    if (delayedState === 'original') {
      await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
      await page.clock.runFor(6000);
      await expect(page.locator('video')).toHaveAttribute('src', playbackUrl);
      await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(1);
      await presentFrame(page);
    }
    await expectReady(page, 1.75);
    expect(posts).toBe(delayedState === 'original' ? 1 : 0);
    expect(await page.locator('video').evaluate((element: HTMLVideoElement) => ({
      rate: element.playbackRate, volume: element.volume, muted: element.muted,
    }))).toEqual({ rate: 1.5, volume: 0.37, muted: true });
  } finally { releaseStatus.resolve(); }
});

test('a slow initial status cannot change playback after project navigation', async ({ page }) => {
  await installFixture(page);
  let requests = 0, settled = 0, posts = 0;
  const releaseStatus = deferred();
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') posts++;
    requests++;
    await releaseStatus.promise;
    return route.fulfill({ json: preview('ready') }).catch(() => {}).finally(() => { settled++; });
  });
  try {
    await openProject(page);
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    expect(requests).toBeGreaterThan(0);
    await switchProject(page);
    await seek(page, 1500);
    releaseStatus.resolve();
    await expect.poll(() => settled).toBe(requests);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
    await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1.5, 2);
    await expect(page.locator('.source-media-status')).toHaveCount(0);
    expect(posts).toBe(0);
  } finally { releaseStatus.resolve(); }
});

test('Retry checks and rebuilds an evicted compatible copy without losing the draft or position', async ({ page }) => {
  const state = await installFixture(page); let evicted = false, rebuilding = false, posts = 0, heads = 0;
  const beforeCaptions = structuredClone(state.projects[0].captions);
  const draftText = 'Draft survives evicted playback';
  let saveHeld = false;
  const releaseSave = deferred(), saveSettled = deferred();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (['PUT', 'PATCH', 'POST'].includes(request.method()) && request.postData()?.includes(draftText)) {
      saveHeld = true; await releaseSave.promise;
      return route.fallback().catch(() => {}).finally(saveSettled.resolve);
    }
    return route.fallback();
  });
  await page.route('**/media/landscape.mp4?compatible=1', async (route) => {
    if (route.request().method() === 'HEAD') { heads++; return route.fulfill({ status: evicted ? 404 : 200 }); }
    if (evicted) return route.fulfill({ status: 404 });
    return continueOwnedRoute(route);
  });
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; rebuilding = true; return route.fulfill({ json: preview('processing') }); }
    if (rebuilding) evicted = false;
    return route.fulfill({ json: preview(evicted ? 'original' : 'ready') });
  });
  try {
    await openProject(page); await expectReady(page, 0.5);
    await seek(page, 1_250);
    await page.locator('.caption-row textarea').first().fill(draftText);
    // Blur commits the edit; the held request keeps its newer draft unsaved.
    await page.getByRole('textbox', { name: 'Caption 2 text', exact: true }).focus();
    await expect.poll(() => saveHeld).toBe(true);
    evicted = true;
    await page.locator('video').dispatchEvent('error');
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await expectReady(page, 1.25); expect(posts).toBe(1); expect(heads).toBe(1);
    await expect(page.locator('.caption-row textarea').first()).toHaveValue(draftText);
    expect(state.projects[0].captions).toEqual(beforeCaptions);
    releaseSave.resolve(); await saveSettled.promise;
  } finally { releaseSave.resolve(); }
});

test('repeated poll failure stops and explicit Check progress resumes without another encoder request', async ({ page }) => {
  await installFixture(page); await manualPreparation(page); let posts = 0, failures = 0, healthy = false;
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: preview('processing') }); }
    if (posts && !healthy) { failures++; return route.fulfill({ status: 503, json: { error: 'Synthetic outage' } }); }
    return route.fulfill({ json: preview(healthy ? 'ready' : 'original') });
  });
  await openProject(page); await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check progress', exact: true })).toBeVisible();
  expect(failures).toBe(3); healthy = true;
  await page.getByRole('button', { name: 'Check progress', exact: true }).click();
  await expectReady(page, 0.5); expect(posts).toBe(1);
});

test('a silent stall offers recovery and clears when the native clock resumes', async ({ page }) => {
  await installFixture(page); await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: { ...preview('original'), videoCodec: 'h264' } }));
  await page.clock.install();
  await controlPresentedFrames(page);
  await openProject(page); await seek(page, 1250);
  await presentFrame(page);
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1.25 });
    video.dispatchEvent(new Event('play'));
  });
  await page.clock.runFor(21_000);
  await expect(page.locator('.source-media-status')).toContainText('stopped making progress');
  await expect(page.getByRole('button', { name: 'Retry playback', exact: true })).toBeVisible();
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1.5 });
  });
  await page.clock.runFor(1000);
  await expect(page.locator('.source-media-status')).toHaveCount(0);
});

test('failed forced rebuild reports the failure and keeps another preparation available', async ({ page }) => {
  await installFixture(page); let posts = 0;
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: { ...preview('ready'), ...(posts ? { message: 'The new playback copy could not be prepared. The previous copy was kept. Try Prepare playback again.' } : {}) } });
  });
  await openProject(page); await expectReady(page, .5);
  await page.locator('video').dispatchEvent('error');
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect(page.locator('.source-media-status')).toContainText('new playback copy could not be prepared');
  await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect.poll(() => posts).toBe(2);
});

test('paused video recovery stays pending after metadata until an owned presented frame arrives', async ({ page }) => {
  await installFixture(page);
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: preview('ready') }));
  await page.clock.install(); await controlPresentedFrames(page);
  await openProject(page); await presentFrame(page); await expectReady(page, .5);
  await seek(page, 1250); await presentFrame(page);
  const old = await page.locator('video').elementHandle();
  await page.locator('video').dispatchEvent('error');
  await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
  await expect.poll(() => old!.evaluate((element) => element.isConnected)).toBe(false);
  await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1.25, 2);
  await expect(page.locator('.source-media-status')).toContainText('Restarting playback');
  expect(await page.locator('video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  // A keyed StrictMode ref replay must leave the paused replacement subscribed
  // for its first frame; the media clock does not request frames while paused.
  expect(await page.locator('video').evaluate((element) => (window as any).__pendingPreviewFrames(element))).toBeGreaterThan(0);
  await page.clock.runFor(21_000);
  await expect(page.locator('.source-media-status')).toContainText('stopped making progress');
  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperty(element, 'currentTime', { configurable: true, value: 1.5 });
    element.dispatchEvent(new Event('timeupdate')); element.dispatchEvent(new Event('loadedmetadata'));
  });
  await page.clock.runFor(1000);
  await expect(page.locator('.source-media-status')).toContainText('stopped making progress');
  await old!.evaluate((element) => { (window as any).__presentPreviewFrame(element, true); element.dispatchEvent(new Event('loadeddata')); });
  await expect(page.locator('.source-media-status')).toContainText('stopped making progress');
  await presentFrame(page); await expectReady(page, 1.5);
});

test('an advancing original-video audio clock cannot hide the absence of a first picture', async ({ page }) => {
  await installFixture(page); await manualPreparation(page);
  let posts = 0;
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: preview('original') });
  });
  await page.clock.install(); await controlPresentedFrames(page);
  await openProject(page);
  await page.locator('video').evaluate((element: HTMLVideoElement) => {
    Object.defineProperties(element, {
      readyState: { configurable: true, value: 4 }, paused: { configurable: true, value: false },
      videoWidth: { configurable: true, value: 0 }, videoHeight: { configurable: true, value: 0 },
      currentTime: { configurable: true, writable: true, value: .5 }, duration: { configurable: true, value: 180 },
    });
    element.dispatchEvent(new Event('play'));
  });
  for (let second = 1; second <= 21; second++) {
    await page.locator('video').evaluate((element: HTMLVideoElement, value) => { element.currentTime = value; }, .5 + second);
    await page.clock.runFor(1000);
  }
  expect(await page.locator('video').evaluate((element: HTMLVideoElement) => ({ ready: element.readyState, width: element.videoWidth, height: element.videoHeight, time: element.currentTime, error: element.error?.code ?? null })))
    .toEqual({ ready: 4, width: 0, height: 0, time: 21.5, error: null });
  await expect(page.locator('.source-media-status')).toContainText('stopped making progress');
  await expect(page.getByRole('button', { name: 'Retry playback', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare playback', exact: true })).toBeEnabled();
  expect(posts).toBe(0);
});

test('a paused compatible player renews only its exact URL even when a newer copy exists', async ({ page }) => {
  await installFixture(page);
  let statusReads = 0, latest = playbackUrl;
  const heads: string[] = [];
  await page.route('**/api/media-preview/landscape*', (route) => { statusReads++; return route.fulfill({ json: { ...preview('ready'), url: latest } }); });
  await page.route('**/media/landscape.mp4?compatible=1', (route) => {
    if (route.request().method() === 'HEAD') { heads.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search); return route.fulfill({ status: 200 }); }
    return continueOwnedRoute(route);
  });
  await page.clock.install(); await controlPresentedFrames(page);
  await openProject(page); await presentFrame(page); await expectReady(page, .5);
  const before = statusReads; latest = '/media/landscape.mp4?compatible=2';
  await page.clock.runFor(31_000);
  await expect.poll(() => heads.length).toBe(1);
  expect(heads).toEqual([playbackUrl]); expect(statusReads).toBe(before);
  await expectReady(page, .5);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.clock.runFor(31_000);
  expect(heads).toEqual([playbackUrl]);
});

test('Retry promptly replaces a poisoned decoder while optional cache checks are unavailable', async ({ page }) => {
  await installFixture(page);
  let unavailable = false, statusReads = 0, posts = 0;
  const headStarted = deferred(), releaseHead = deferred(), headSettled = deferred();
  await page.route('**/api/media-preview/landscape*', (route) => {
    if (route.request().method() === 'POST') posts++;
    statusReads++;
    return unavailable ? route.fulfill({ status: 503, json: { error: 'Synthetic status outage' } }) : route.fulfill({ json: preview('ready') });
  });
  await page.route('**/media/landscape.mp4?compatible=1', async (route) => {
    if (route.request().method() !== 'HEAD') return continueOwnedRoute(route);
    headStarted.resolve(); await releaseHead.promise;
    return route.fulfill({ status: 503 }).catch(() => {}).finally(headSettled.resolve);
  });
  try {
    await openProject(page); await expectReady(page, .5); await seek(page, 1250);
    const before = statusReads; unavailable = true;
    const old = await page.locator('video').elementHandle();
    await old!.evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.dispatchEvent(new Event('timeupdate'));
      Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
      video.load = () => { queueMicrotask(() => video.dispatchEvent(new Event('error'))); };
      video.dispatchEvent(new Event('error'));
    });
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await headStarted.promise;
    await expect.poll(() => old!.evaluate((element) => element.isConnected)).toBe(false);
    await expectReady(page, 1.25);
    const recovered = await page.locator('video').elementHandle();
    expect(statusReads).toBe(before); expect(posts).toBe(0);
    releaseHead.resolve(); await headSettled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await recovered!.evaluate((element) => element.isConnected)).toBe(true);
    await expectReady(page, 1.25);
  } finally { releaseHead.resolve(); }
});

test('a late same-copy status reply keeps the decoder and playback settings already recovered by Retry', async ({ page }) => {
  await installFixture(page);
  let lookup = false, posts = 0;
  const statusStarted = deferred(), releaseStatus = deferred(), statusSettled = deferred();
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') posts++;
    if (lookup) { statusStarted.resolve(); await releaseStatus.promise; }
    return route.fulfill({ json: preview('ready') }).catch(() => {}).finally(() => { if (lookup) statusSettled.resolve(); });
  });
  await page.route('**/media/landscape.mp4?compatible=1', (route) => route.request().method() === 'HEAD' ? route.fulfill({ status: 404 }) : continueOwnedRoute(route));
  try {
    await openProject(page); await expectReady(page, .5); await seek(page, 1250);
    lookup = true;
    await page.locator('video').dispatchEvent('error');
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await statusStarted.promise;
    await expectReady(page, 1.25);
    const recovered = await page.locator('video').elementHandle();
    await page.locator('video').evaluate(async (element: HTMLVideoElement) => { element.playbackRate = .75; element.volume = .2; element.muted = true; await element.play(); });
    releaseStatus.resolve(); await statusSettled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await recovered!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await page.locator('video').evaluate((element: HTMLVideoElement) => ({ rate: element.playbackRate, volume: element.volume, muted: element.muted, paused: element.paused }))).toEqual({ rate: .75, volume: .2, muted: true, paused: false });
    expect(posts).toBe(0);
  } finally { releaseStatus.resolve(); }
});

test('a late missing-copy lookup cannot change playback after project navigation', async ({ page }) => {
  await installFixture(page);
  let lookup = false;
  const statusStarted = deferred(), releaseStatus = deferred(), statusSettled = deferred();
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (lookup) { statusStarted.resolve(); await releaseStatus.promise; }
    return route.fulfill({ json: preview('ready') }).catch(() => {}).finally(() => { if (lookup) statusSettled.resolve(); });
  });
  await page.route('**/media/landscape.mp4?compatible=1', (route) => route.request().method() === 'HEAD' ? route.fulfill({ status: 404 }) : continueOwnedRoute(route));
  try {
    await openProject(page); await expectReady(page, .5);
    lookup = true;
    await page.locator('video').dispatchEvent('error');
    await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
    await statusStarted.promise;
    await switchProject(page); await seek(page, 1500);
    releaseStatus.resolve(); await statusSettled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
    await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1.5, 2);
    await expect(page.locator('.source-media-status')).toHaveCount(0);
  } finally { releaseStatus.resolve(); }
});
