import { test, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming, planCaptionRenderStates, type CaptionProject, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('current spoken-word native pixels precede lookahead and video frames advance paint without changing saved words', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    (window as any).__phase3FrameCallbacks = 0;
    if (original) HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        (window as any).__phase3FrameCallbacks += 1;
        callback(now, metadata);
      });
    };
  });

  const state = await installFixture(page);
  const source: CaptionSegment = { id: 'spoken', text: 'one two three four five', startMs: 200, endMs: 2_700 };
  const boundaries: Array<[number, number]> = [[200, 450], [650, 850], [1_050, 1_250], [1_450, 1_700], [1_900, 2_350]];
  const words: TimedToken[] = source.text.split(' ').map((text, index) => ({
    id: `w${index}`, text, startMs: boundaries[index][0], endMs: boundaries[index][1],
    spaceBefore: index > 0, timingSource: 'stt', alignmentScore: 1,
  }));
  source.wordTiming = buildCaptionWordTiming(source, words);
  expect(source.wordTiming).toBeDefined();

  const project = state.projects[0] as CaptionProject;
  project.captions = [source];
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  project.transcript!.tokens = words;
  project.transcript!.segments = [structuredClone(source)];
  project.transcript!.fullText = source.text;
  const originalWords = structuredClone(source.wordTiming);

  await openProject(page);
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.pause();
    video.currentTime = 0.7;
    video.dispatchEvent(new Event('timeupdate'));
  });
  // Establish an entirely NEW visual signature while a spoken word is current;
  // a request made before the first cue is visible may legitimately prefetch.
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Word highlight color').fill('#FF0000');
  const previewRequests = () => state.requests.filter((request) => request.path === '/api/video-export/landscape/preview');
  await expect.poll(() => previewRequests().filter((request) => request.body.appearance.highlightColor === '#FF0000').length).toBeGreaterThan(0);
  assertPreviewCurrentFirst(previewRequests().find((request) => request.body.appearance.highlightColor === '#FF0000')!);

  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const initialPaint = await page.locator('.native-caption-surface').getAttribute('data-paint-key');
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__phase3FrameCallbacks)).toBeGreaterThan(2);
  await expect.poll(async () => page.locator('.native-caption-surface').getAttribute('data-paint-key')).not.toBe(initialPaint);
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  // Streaming can advance again before its next native bitmap arrives; the
  // pending state is safe as long as it never claims stale word color is exact.
  const mode = await page.locator('.native-caption-surface').getAttribute('data-preview-mode');
  expect(['exact', 'pending']).toContain(mode);
  expect(project.captions[0].wordTiming).toEqual(originalWords);
});

function assertPreviewCurrentFirst(request: { body: any }) {
  expect(Array.isArray(request.body.timesMs)).toBe(true);
  expect(request.body.timesMs).toHaveLength(1);
  expect(request.body.captions).toHaveLength(1);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setSpokenFixture(state: FixtureState, tokens: string[], boundaries: Array<[number, number]>) {
  const source: CaptionSegment = {
    id: 'spoken',
    text: tokens.join(' '),
    startMs: boundaries[0][0],
    endMs: boundaries[boundaries.length - 1][1],
  };
  const words: TimedToken[] = tokens.map((text, index) => ({
    id: `word-${index}`, text, startMs: boundaries[index][0], endMs: boundaries[index][1],
    spaceBefore: index > 0, timingSource: 'stt', alignmentScore: 1,
  }));
  source.wordTiming = buildCaptionWordTiming(source, words);
  expect(source.wordTiming).toBeDefined();
  const project = state.projects[0] as CaptionProject;
  project.captions = [source];
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  project.transcript!.tokens = words;
  project.transcript!.segments = [structuredClone(source)];
  project.transcript!.fullText = source.text;
  return { source, words };
}

function previewCalls(state: FixtureState) {
  return state.requests.filter((request) => request.path === '/api/video-export/landscape/preview');
}

async function chooseNewWordPreviewLook(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Word highlight color').fill('#FF0000');
}

test('seeking into an in-flight four-paint lookahead promotes that word to one exact current render', async ({ page }) => {
  test.setTimeout(60_000);
  const state = await installFixture(page);
  // Keep setup and the held lookahead deterministic; switch to the real native
  // renderer for the promoted word whose PNG is checked against the MP4 recipe.
  const { source } = setSpokenFixture(
    state,
    ['one', 'two', 'three', 'four', 'five'],
    [[200, 450], [650, 850], [1_050, 1_250], [1_450, 1_700], [1_900, 2_350]],
  );
  const savedTiming = structuredClone(source.wordTiming);
  const targetMs = 650;
  const targetPaint = planCaptionRenderStates([source], true).find((item) => item.atMs === targetMs)?.paintKey;
  expect(targetPaint).toBeTruthy();
  await openProject(page);
  await seek(page, 250);

  const lookaheadEntered = deferred<number[]>();
  const targetEntered = deferred<any>();
  const releaseLookahead = deferred();
  const releaseTarget = deferred();
  const observed: number[][] = [];
  let heldLookahead = false;
  await page.route('**/api/video-export/landscape/preview', async (route) => {
    const body = route.request().postDataJSON();
    if (body.appearance.highlightColor !== '#FF0000') return route.fallback().catch(() => {});
    const samples = body.timesMs as number[];
    observed.push(samples);
    if (!heldLookahead && samples.length === 4 && samples.includes(targetMs)) {
      heldLookahead = true;
      lookaheadEntered.resolve(samples);
      await releaseLookahead.promise;
    } else if (samples.length === 1 && samples[0] === targetMs) {
      targetEntered.resolve(body);
      await releaseTarget.promise;
    }
    await route.fallback().catch(() => {});
  });
  try {
    await chooseNewWordPreviewLook(page);
    await expect.poll(() => observed.some((samples) => samples.length === 1 && samples[0] === 200)).toBe(true);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect.poll(() => heldLookahead).toBe(true);
    expect(await lookaheadEntered.promise).toContain(targetMs);

    // Both lookahead and the promoted word remain withheld. The browser must
    // dispatch a new single-current request BEFORE the four-frame batch returns.
    await seek(page, targetMs + 25);
    await expect.poll(() => observed.some((samples) => samples.length === 1 && samples[0] === targetMs)).toBe(true);
    const targetBody = await targetEntered.promise;
    expect(targetBody.timesMs).toEqual([targetMs]);
    expect(observed.filter((samples) => samples.length === 1 && samples[0] === targetMs)).toHaveLength(1);
    await expect(page.locator('.native-caption-surface[data-preview-mode="exact"]')).toHaveCount(0);

    const promotedResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/video-export/landscape/preview')) return false;
      return JSON.stringify(response.request().postDataJSON().timesMs) === JSON.stringify([targetMs]);
    });
    state.native = true;
    releaseTarget.resolve();
    const nativeResult = await (await promotedResponse).json();
    const nativeFrame = nativeResult.frames.find((item: { atMs: number }) => item.atMs === targetMs);
    expect(nativeFrame?.bounds).toBeTruthy();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', targetPaint!);
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${nativeFrame.png}`);

    // Independently render the same requested paint through the established
    // one-shot native path: browser pixels cannot borrow a future/stale frame.
    const renderer = await import('../../apps/server/src/services/caption-preview.js');
    const reference = await renderer.renderCaptionPreview(renderer.parseCaptionPreviewInput(targetBody), capabilities);
    expect(nativeFrame.png).toEqual(reference.frames[0].png);
    expect(nativeFrame.bounds).toEqual(reference.frames[0].bounds);

    releaseLookahead.resolve();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${nativeFrame.png}`);
    expect(observed.filter((samples) => samples.length === 1 && samples[0] === targetMs)).toHaveLength(1);
    expect(state.projects[0].captions[0].wordTiming).toEqual(savedTiming);
  } finally {
    releaseTarget.resolve();
    releaseLookahead.resolve();
  }
});

test('24 prefetched word paints are reused, later lookahead continues, and old native frames are evicted', async ({ page }) => {
  test.setTimeout(60_000);
  const state = await installFixture(page);
  // Tiny valid PNG responses make the cache-capacity race independent of FFmpeg
  // startup times. Word 2900 and the evicted first word use real native pixels.
  const tokens = Array.from({ length: 38 }, (_, index) => index % 8 === 0
    ? 'ខ្មែរ'
    : String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26));
  const { source } = setSpokenFixture(state, tokens, tokens.map((_, index) => [200 + index * 100, 300 + index * 100]));
  const savedTiming = structuredClone(source.wordTiming);
  const states = planCaptionRenderStates([source], true);
  expect(new Set(states.filter((item) => item.key).map((item) => item.paintKey)).size).toBeGreaterThan(24);

  await openProject(page);
  await seek(page, 225);

  const firstFrames = new Map<number, string>();
  const prefetchedFrames = new Set<number>();
  const reusedFrames = new Set<number>();
  const dispatchOrigin = new WeakMap<object, number>();
  const requests: Array<{ timesMs: number[]; atPlayheadMs: number; body: any }> = [];
  let playheadMs = 225;
  let nativePrefetch2900: { body: any; png: string; bounds: unknown } | undefined;
  let native2900Promise: Promise<{ atMs: number; png: string; bounds: unknown }> | undefined;
  const renderer = await import('../../apps/server/src/services/caption-preview.js');
  const singletonCount = (atMs: number) => requests.filter((request) =>
    request.timesMs.length === 1 && request.timesMs[0] === atMs).length;
  const paintTurn = () => page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  page.on('response', async (response) => {
    if (!response.url().endsWith('/api/video-export/landscape/preview') || !response.ok()) return;
    if (response.request().postDataJSON().appearance.highlightColor !== '#FF0000') return;
    try {
      const result = await response.json();
      const origin = dispatchOrigin.get(response.request()) ?? Infinity;
      for (const frame of result.frames as Array<{ atMs: number; png: string }>) {
        firstFrames.set(frame.atMs, frame.png);
        if (frame.atMs > origin) prefetchedFrames.add(frame.atMs);
      }
    } catch { /* An aborted request has no reusable response. */ }
  });
  await page.route('**/api/video-export/landscape/preview', async (route) => {
    const body = route.request().postDataJSON();
    if (body.appearance.highlightColor !== '#FF0000') return route.fallback().catch(() => {});
    const atPlayheadMs = playheadMs;
    dispatchOrigin.set(route.request(), atPlayheadMs);
    requests.push({ timesMs: body.timesMs, atPlayheadMs, body });
    // Only the late target needs expensive real FFmpeg pixels. Several moving
    // lookahead windows may request it concurrently; share one native render
    // so fixture concurrency cannot exhaust the server's two-render limit.
    if (body.timesMs.includes(2900)) {
      const nativeBody = { ...body, timesMs: [2900] };
      native2900Promise ??= renderer.renderCaptionPreview(
        renderer.parseCaptionPreviewInput(nativeBody), capabilities,
      ).then((result) => result.frames[0]);
      const image = await native2900Promise;
      if (atPlayheadMs < 2900) nativePrefetch2900 = { body: nativeBody, png: image.png, bounds: image.bounds };
      const frames = body.timesMs.map((atMs: number) => atMs === 2900
        ? image
        : { atMs, png: firstFrames.get(200), bounds: { x: 160, y: 270, width: 320, height: 40 } });
      expect(frames.every((frame: { png?: string }) => typeof frame.png === 'string')).toBe(true);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ width: 640, height: 360, frames }) }).catch(() => {});
    }
    await route.fallback().catch(() => {});
  });

  await chooseNewWordPreviewLook(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  // Prove cache admission through observable reuse, not just HTTP receipt.
  // A single-paint prefetch can be superseded by a seek during decoding; those
  // races do NOT count as successful reuse. Require at least 24 distinct paints
  // that reach exact with no new [target] request, and strictly require reuse
  // at every requested window start (1000, 1800, 2600 and native 2900).
  const requiredReuses = new Set([1000, 1800, 2600, 2900]);
  for (let atMs = 300; atMs <= 3300; atMs += 100) {
    await expect.poll(() => prefetchedFrames.has(atMs), { timeout: 15_000 }).toBe(true);
    await paintTurn(); // response event can precede Image.decode()/atomic cache commit
    const singleBefore = singletonCount(atMs);
    playheadMs = atMs + 25;
    await seek(page, playheadMs);
    const paint = states.find((item) => item.atMs === atMs)?.paintKey;
    expect(paint).toBeTruthy();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', paint!);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${firstFrames.get(atMs)}`);
    await paintTurn(); // observe the effect that could otherwise send a late duplicate
    const after = singletonCount(atMs);
    if (requiredReuses.has(atMs)) {
      expect(after, `Window-start paint ${atMs} must not fetch a new [${atMs}] current frame`).toBe(singleBefore);
    }
    if (after === singleBefore) reusedFrames.add(atMs);
    if (atMs === 2900) {
      expect(nativePrefetch2900, '2900 must have been served natively as lookahead before seeking').toBeDefined();
      await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${nativePrefetch2900!.png}`);
    }
  }
  expect(reusedFrames.size, 'At least 24 distinct prefetched paints must be demonstrably reused without current-frame refetch').toBeGreaterThanOrEqual(24);
  for (const atMs of requiredReuses) expect(reusedFrames.has(atMs)).toBe(true);

  // The cache has admitted more unique paints than its 24-frame allowance.
  // Advancing must continue warming future pixels rather than permanently stop.
  await expect.poll(() => requests.some((request) => request.atPlayheadMs >= 2600
    && request.timesMs.some((time) => time >= 3500)), { timeout: 15_000 }).toBe(true);
  expect(requests.every((request) => request.timesMs.length <= 4)).toBe(true);

  // The successfully reused 2900 preview is byte-identical to an independent
  // one-shot native reference for the same exact word paint and geometry.
  const nativeReference = await renderer.renderCaptionPreview(renderer.parseCaptionPreviewInput({
    ...nativePrefetch2900!.body, timesMs: [2900],
  }), capabilities);
  expect(nativePrefetch2900!.png).toEqual(nativeReference.frames[0].png);
  expect(nativePrefetch2900!.bounds).toEqual(nativeReference.frames[0].bounds);

  // The bounded cache must evict old entries. Revisit the first word and
  // require a fresh exact render with correct native bytes.
  const oldSingleBefore = singletonCount(200);
  state.native = true;
  playheadMs = 225;
  await seek(page, playheadMs);
  await expect.poll(() => singletonCount(200)).toBe(oldSingleBefore + 1);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const freshFirst = requests.filter((request) => request.timesMs.length === 1 && request.timesMs[0] === 200).at(-1)!.body;
  const reference = await renderer.renderCaptionPreview(renderer.parseCaptionPreviewInput(freshFirst), capabilities);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('src', `data:image/png;base64,${reference.frames[0].png}`);
  expect(state.projects[0].captions[0].wordTiming).toEqual(savedTiming);
});
