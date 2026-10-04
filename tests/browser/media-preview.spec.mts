import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const playbackUrl = '/media/landscape.mp4?compatible=1';
const preview = (state: 'original' | 'processing' | 'ready' | 'cancelled', source = 'landscape.mp4') => ({
  source, state, videoCodec: 'hevc', progress: state === 'ready' ? 100 : state === 'processing' ? 30 : 0,
  ...(state === 'ready' ? { url: playbackUrl } : {}),
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function manualPreparation(page: Page) {
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => 'probably'; });
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
  await page.addInitScript(() => { const original = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function(type) { return /hvc1|hev1/.test(type) ? '' : original.call(this, type); }; });
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 202, json: preview('processing') }); }
    polls++;
    return route.fulfill({ json: preview(allowReady ? 'ready' : posts ? 'processing' : 'original') });
  });
  await openProject(page);
  await expect.poll(() => posts).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel preparation', exact: true })).toBeVisible();
  await seek(page, 1250);
  allowReady = true;
  await expectReady(page, 1.25);
  expect(state.projects[0].media.url).toBe('/media/landscape.mp4');
  expect(state.projects[0].captions).toEqual(originalCaptions);
  expect(polls).toBeGreaterThan(1);
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
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.dataset.metadataLoads = '0';
    video.addEventListener('loadedmetadata', () => { video.dataset.metadataLoads = String(Number(video.dataset.metadataLoads) + 1); });
    video.dispatchEvent(new Event('error'));
  });
  await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  expect(force).toBe(true);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Number(video.dataset.metadataLoads))).toBeGreaterThan(0);
  await expectReady(page, 1.25);
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
  await installFixture(page); const postStarted = deferred(); const releasePost = deferred();
  await manualPreparation(page);
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { postStarted.resolve(); await releasePost.promise; return route.fulfill({ json: preview('ready') }); }
    return route.fulfill({ json: preview('original') });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: 'Prepare playback', exact: true }).click();
    await postStarted.promise;
    await switchProject(page);
    await seek(page, 1500);
    const response = page.waitForResponse((value) => value.url().includes('/api/media-preview/landscape') && value.request().method() === 'POST');
    releasePost.resolve();
    await (await response).finished();
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
