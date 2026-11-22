import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { prepareFixtures, cleanFixtures, installFixture, project, setPlaybackFixtureHandler } from './fixtures.mjs';
import { closeOwnedBrowserContext, continueOwnedRoute } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.setTimeout(240_000);
let originalHash: string;
let mediaPath: string;
let cachePath: string;
let projectValue: ReturnType<typeof project>;
const hash = async (file: string) => (await import('node:crypto')).createHash('sha256').update(await fs.readFile(file)).digest('hex');
test.beforeAll(async () => {
  // This hook includes a separately bounded 180-second synthetic encode.
  // A test-body timeout does not extend Playwright's setup-hook budget.
  test.setTimeout(240_000);
  await prepareFixtures();
  const { config } = await import('../../apps/server/src/config.js');
  await fs.mkdir(config.uploadDir, { recursive: true });
  mediaPath = path.join(config.uploadDir, 'landscape.mp4');
  cachePath = path.join(config.cacheDir, 'media-previews', 'landscape');
  // Three minutes of generated moving video/audio. No user footage or cloud calls.
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=180', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=2:log-level=error', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mediaPath], { timeout: 180_000, stdio: 'ignore', windowsHide: true });
  originalHash = await hash(mediaPath);
  projectValue = project(); projectValue.media.size = (await fs.stat(mediaPath)).size;
  const { store } = await import('../../apps/server/src/services/store.js');
  const { cancelScheduledProjectPrewarm } = await import('../../apps/server/src/services/prewarm.js');
  await store.upsert(projectValue);
  cancelScheduledProjectPrewarm(projectValue.id);
  const { default: previewRouter } = await import('../../apps/server/src/routes/media-preview.js');
  const app = express(); app.use(express.json()); app.use('/api/media-preview', previewRouter); app.use('/media', express.static(config.uploadDir));
  setPlaybackFixtureHandler(app);
});
test.afterAll(async () => {
  const { invalidateMediaPreview } = await import('../../apps/server/src/services/media-preview.js');
  await invalidateMediaPreview('landscape');
  await cleanFixtures();
});

test('real long compatible copy presents frames, preserves a pending edit and plays through 35 seconds', async ({ page }, info) => {
  const state = await installFixture(page);
  state.projects[0] = structuredClone(projectValue);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const captionsBefore = structuredClone(state.projects[0].captions);
  const draft = 'Keep the pending native playback edit ខ្មែរ';
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let saves = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves++;
    await saveGate;
    return route.fallback();
  });
  await page.route('**/api/media-preview/**', (route) => continueOwnedRoute(route));
  await page.route('**/media/landscape.mp4*', (route) => continueOwnedRoute(route));
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    (window as any).__preparationRequests = 0;
    window.fetch = function(input, init) {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const url = input instanceof Request ? input.url : String(input);
      if (method === 'POST' && url.includes('/api/media-preview/')) {
        (window as any).__preparationRequestedAt = performance.now();
        (window as any).__preparationRequests++;
      }
      return originalFetch.call(this, input, init);
    };
    (window as any).__frames = [];
    const seen = new WeakSet<HTMLVideoElement>();
    let generation = 0;
    new MutationObserver(() => {
      const video = document.querySelector('video');
      if (!video || seen.has(video)) return;
      seen.add(video);
      const owner = ++generation;
      const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (!video.isConnected || document.querySelector('video') !== video || !video.currentSrc) return;
        const records = (window as any).__frames;
        records.push({ wall: performance.now(), presentation: metadata.presentationTime, mediaTime: metadata.mediaTime,
          source: video.getAttribute('src'), generation: owner, presentedFrames: metadata.presentedFrames });
        if (records.length > 5000) records.splice(0, records.length - 5000);
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    }).observe(document, { subtree: true, childList: true });
  });
  const requests: Array<{ url: string; method: string; status: number; range: string | undefined }> = [];
  page.on('response', (response) => {
    if (/media-preview|landscape.mp4/.test(response.url())) requests.push({
      url: new URL(response.url()).pathname, method: response.request().method(),
      status: response.status(), range: response.request().headers().range,
    });
  });
  const video = page.locator('video');
  const beginOpen = async () => {
    await expect(video).toHaveCount(0);
    const started = await page.evaluate(() => { (window as any).__frames = []; return performance.now(); });
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    return started;
  };
  const waitForCopyFrame = async (started: number) => {
    await expect(video).toHaveAttribute('src', /\/api\/media-preview\/.+\.mp4/, { timeout: 180_000 });
    await expect.poll(() => page.evaluate(() => {
      const current = document.querySelector('video')?.getAttribute('src');
      return (window as any).__frames.some((frame: any) => frame.source === current && frame.source?.includes('/api/media-preview/'));
    }), { timeout: 30_000 }).toBe(true);
    return page.evaluate((began) => {
      const frames = (window as any).__frames;
      const current = document.querySelector('video')?.getAttribute('src');
      const first = frames.find((frame: any) => frame.wall >= began);
      const copy = frames.find((frame: any) => frame.wall >= began && frame.source === current && frame.source?.includes('/api/media-preview/'));
      return { firstVisibleFrameMs: first.presentation - began,
        firstVisibleSource: first.source?.includes('/api/media-preview/') ? 'compatible-copy' : 'original',
        firstCompatibleFrameMs: copy.presentation - began,
        ...((window as any).__preparationRequestedAt >= began ? { preparationRequestToFrameMs: copy.presentation - (window as any).__preparationRequestedAt } : {}) };
    }, started);
  };
  const frameAfter = (after: number, lower: number, upper: number) => page.evaluate(({ after, lower, upper }) => {
    const current = document.querySelector('video')?.getAttribute('src');
    return (window as any).__frames.some((frame: any) => frame.wall >= after && frame.source === current
      && frame.mediaTime >= lower && frame.mediaTime <= upper);
  }, { after, lower, upper });

  try {
    await page.goto('/');
    const coldStarted = await beginOpen();
    // A negative codec hint is advisory: this PC may actually decode HEVC.
    // Request the real conversion explicitly unless a genuine decoder failure
    // or the bounded no-picture trial has already started that same request.
    await expect.poll(() => page.evaluate(() => (window as any).__preparationRequests > 0
      || [...document.querySelectorAll('button')].some((button) => button.textContent === 'Prepare playback' && !button.disabled)), { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => {
      if ((window as any).__preparationRequests > 0) return;
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Prepare playback' && !candidate.disabled);
      if (!button) throw new Error('The inspected original must offer explicit playback preparation.');
      button.click();
    });
    await expect(page.locator('.source-media-status')).toContainText('Preparing browser playback', { timeout: 30_000 });
    await page.getByLabel('Caption 1 text', { exact: true }).fill(draft);
    await page.getByLabel('Caption 2 text', { exact: true }).focus();
    await expect.poll(() => saves).toBe(1);
    const cold = await waitForCopyFrame(coldStarted);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(draft);
    expect(state.projects[0].captions).toEqual(captionsBefore);

    const continuousStarted = await video.evaluate((element: HTMLVideoElement) => {
      element.muted = true; element.playbackRate = 1; element.currentTime = 0;
      return performance.now();
    });
    await video.evaluate((element: HTMLVideoElement) => element.play());
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.error?.code ?? null)).toBe(null);
    await expect.poll(() => frameAfter(continuousStarted, 39.5, 45), { timeout: 55_000 }).toBe(true);
    await video.evaluate((element: HTMLVideoElement) => element.pause());
    expect(await frameAfter(continuousStarted, 34, 36)).toBe(true);
    const continuous = await video.evaluate((element: HTMLVideoElement) => ({
      currentTime: element.currentTime, errorCode: element.error?.code ?? null,
      playbackRate: element.playbackRate, readyState: element.readyState,
    }));
    expect(continuous.currentTime).toBeGreaterThanOrEqual(39.5);
    expect(continuous.errorCode).toBe(null);

    const seeks = [];
    for (const seconds of [30, 90, 165]) {
      const began = await video.evaluate((element: HTMLVideoElement, target) => {
        element.currentTime = target; return performance.now();
      }, seconds);
      await expect.poll(() => frameAfter(began, seconds - 0.1, seconds + 0.5)).toBe(true);
      await video.evaluate((element: HTMLVideoElement) => element.play());
      await expect.poll(() => frameAfter(began, seconds + 0.8, seconds + 8)).toBe(true);
      await video.evaluate((element: HTMLVideoElement) => element.pause());
      const errorCode = await video.evaluate((element: HTMLVideoElement) => element.error?.code ?? null);
      expect(errorCode).toBe(null);
      seeks.push({ seconds, presentedFrame: true, shortPlayback: true, errorCode });
    }
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(draft);
    expect(state.projects[0].captions).toEqual(captionsBefore);
    releaseSave();
    await expect.poll(() => state.projects[0].captions[0].text).toBe(draft);
    await expect(page.locator('.workspace-identity')).toContainText(/\bsaved\b/);
    const savedCaptions = structuredClone(state.projects[0].captions);

    const warm = [];
    const beforeWarm = requests.length;
    for (let sample = 0; sample < 3; sample++) {
      await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
      warm.push(await waitForCopyFrame(await beginOpen()));
      await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(draft);
    }
    const warmRequests = requests.slice(beforeWarm);
    const copySource = await video.getAttribute('src');
    const copyFilename = path.basename(new URL(copySource!, 'http://127.0.0.1').pathname);
    const { config } = await import('../../apps/server/src/config.js');
    const decodeStarted = performance.now();
    execFileSync(config.ffmpegPath, ['-v', 'error', '-xerror', '-i', path.join(cachePath, copyFilename), '-f', 'null', '-'], { timeout: 60_000, stdio: 'pipe', windowsHide: true });
    const fullFileDecodeMs = performance.now() - decodeStarted;
    expect(await hash(mediaPath)).toBe(originalHash);
    expect(state.projects[0].captions).toEqual(savedCaptions);
    expect(requests.some((request) => request.status === 206 && request.url.includes('/file/'))).toBe(true);
    expect(warmRequests.filter((request) => request.url === '/media/landscape.mp4')).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__preparationRequests)).toBe(1);
    const result = { cold, warm, continuous, seeks, fullFileDecodeMs,
      durationSeconds: 180, resolution: '1280x720', inputCodec: 'hevc', outputCodec: 'h264/aac',
      conditions: 'Synthetic App fixture with explicit Prepare playback unless a decoder error or the bounded no-picture trial already started its single request. preparationRequestToFrameMs starts at that fetch invocation and excludes earlier inspection/click delay. Media routes use Playwright route.fetch/fulfill, which buffers responses and disables HTTP caching. One empty preview-cache opening with pending draft; three prepared-cache reopenings in the same browser. OS caches not reset. First-frame means compositor submission. Direct HTTP streaming and real-footage timings require the separate local range harness.',
      warmSourceRequests: warmRequests.filter((request) => request.url === '/media/landscape.mp4').length, requests };
    console.log('MEDIA_PREVIEW_MEASUREMENTS ' + JSON.stringify(result));
    await info.attach('playback-measurements.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  } finally { releaseSave(); }
});
