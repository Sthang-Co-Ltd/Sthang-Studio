import { test, expect, type Page, type Route } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const previewUrl = '**/api/video-export/landscape/preview';
const overflowMessage = 'Caption extends outside the video. Reduce Size, increase Max width, or adjust its position.';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rejectOverflow(route: Route) {
  return route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: overflowMessage, code: 'CAPTION_OVERFLOW' }),
  });
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
}

test('typed overflow hides retained native pixels, shows actionable guidance, and recovers after a valid size change', async ({ page }) => {
  const fixture = await installFixture(page);
  const savedCaptions = structuredClone(fixture.projects[0].captions);
  const entered = deferred();
  const release = deferred();
  let rejectedRequests = 0;
  await page.route(previewUrl, async (route) => {
    if (route.request().postDataJSON().appearance.fontSize1080 !== 120) return route.fallback();
    rejectedRequests += 1;
    entered.resolve();
    await release.promise;
    return rejectOverflow(route);
  });

  try {
    await openProject(page);
    const surface = page.locator('.native-caption-surface');
    const image = page.locator('.native-caption-image');
    const warning = page.locator('.native-preview-status.error');
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    const previousPixels = await image.getAttribute('src');
    await openAppearance(page);

    await page.getByLabel(/^Size /).fill('120');
    await entered.promise;
    // Retaining the old bitmap while a request is pending is intentional. Once
    // the server rejects that layout, it must no longer look like a valid result.
    await expect(image).toHaveAttribute('src', previousPixels!);
    await expect(surface).not.toHaveAttribute('data-preview-mode', 'exact');
    release.resolve();
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(warning).toContainText(overflowMessage);
    await expect(warning.getByRole('button', { name: 'Retry preview' })).toBeEnabled();
    await expect(surface).toHaveCount(0);
    await expect(image).toHaveCount(0);
    await expect(page.locator('.native-preview-refining')).toHaveCount(0);
    await expect(page.getByLabel(/^Size /)).toHaveValue('120');
    await expect.poll(() => fixture.projects[0].captionAppearance?.fontSize1080).toBe(120);
    expect(fixture.projects[0].captions).toEqual(savedCaptions);
    expect(rejectedRequests).toBe(1);

    await page.getByLabel(/^Size /).fill('72');
    await expect.poll(() => fixture.requests.some((request) => request.path.endsWith('/preview')
      && request.body.appearance.fontSize1080 === 72)).toBe(true);
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', savedCaptions[0].text);
    await expect(warning).toHaveCount(0);
    await expect.poll(() => fixture.projects[0].captionAppearance?.fontSize1080).toBe(72);
    expect(fixture.projects[0].captions).toEqual(savedCaptions);
  } finally {
    release.resolve();
  }
});

test('overflow is scoped to its cue and seeking to a valid cue restores exact native preview', async ({ page }) => {
  const fixture = await installFixture(page);
  const savedCaptions = structuredClone(fixture.projects[0].captions);
  let rejectSecondCue = true;
  let rejectedRequests = 0;
  await page.route(previewUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (rejectSecondCue && body.timesMs.includes(savedCaptions[1].startMs)) {
      // An initial gap may prefetch before openProject's first seek. Reject that
      // batch too so the problematic cue can never arrive in the valid cache.
      if (body.timesMs.length === 1) rejectedRequests += 1;
      return rejectOverflow(route);
    }
    return route.fallback();
  });

  await openProject(page);
  const surface = page.locator('.native-caption-surface');
  const image = page.locator('.native-caption-image');
  const warning = page.locator('.native-preview-status.error');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');

  await seek(page, 1500);
  await expect(warning).toContainText(overflowMessage);
  await expect(image).toHaveCount(0);
  expect(rejectedRequests).toBe(1);

  // Moving to another cue must clear a cue-local layout error without requiring
  // an unrelated appearance edit, a manual retry, or a project reload.
  await seek(page, 2600);
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  await expect(image).toHaveAttribute('alt', savedCaptions[2].text);
  await expect(warning).toHaveCount(0);

  rejectSecondCue = false;
  await seek(page, 1500);
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  await expect(image).toHaveAttribute('alt', savedCaptions[1].text);
  await expect(warning).toHaveCount(0);
  expect(fixture.projects[0].captions).toEqual(savedCaptions);
});

test('a future prefetch overflow preserves valid current pixels and does not retry that lookahead while paused', async ({ page }) => {
  const fixture = await installFixture(page);
  // Ordinary static previews only prefetch when at least four future paints are
  // missing. Keep every cue inside the shared four-second synthetic video.
  fixture.projects[0].captions = [
    { id: 'current', text: 'Current valid caption', startMs: 200, endMs: 1000 },
    { id: 'future-1', text: 'Future oversized caption', startMs: 1200, endMs: 1700 },
    { id: 'future-2', text: 'Future caption two', startMs: 1800, endMs: 2200 },
    { id: 'future-3', text: 'Future caption three', startMs: 2400, endMs: 2800 },
    { id: 'future-4', text: 'Future caption four', startMs: 3000, endMs: 3500 },
  ];
  const savedCaptions = structuredClone(fixture.projects[0].captions);
  const entered = deferred();
  const release = deferred();
  const rejectedTimes: number[][] = [];
  await page.route(previewUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.appearance.fontSize1080 !== 88 || body.timesMs.length <= 1) return route.fallback();
    rejectedTimes.push(body.timesMs);
    entered.resolve();
    await release.promise;
    return rejectOverflow(route);
  });

  try {
    await openProject(page);
    const surface = page.locator('.native-caption-surface');
    const image = page.locator('.native-caption-image');
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    await openAppearance(page);
    // A fresh signature at the visible cue makes the current-first/prefetch
    // distinction independent of the initial request made before the first seek.
    await page.getByLabel(/^Size /).fill('88');
    await entered.promise;
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    await expect(image).toHaveAttribute('alt', savedCaptions[0].text);
    const currentPixels = await image.getAttribute('src');
    const currentPaint = await surface.getAttribute('data-paint-key');
    expect(rejectedTimes).toEqual([[1200, 1800, 2400, 3000]]);

    const response = page.waitForResponse((result) => result.url().endsWith('/api/video-export/landscape/preview')
      && result.request().postDataJSON().appearance.fontSize1080 === 88
      && result.request().postDataJSON().timesMs.length > 1);
    release.resolve();
    expect((await response).status()).toBe(400);
    // Allow the failure render and another scheduler delay. This also detects a
    // paused retry loop that would otherwise hide behind a still-valid bitmap.
    await page.waitForTimeout(400);
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    await expect(surface).toHaveAttribute('data-paint-key', currentPaint!);
    await expect(image).toHaveAttribute('src', currentPixels!);
    await expect(page.locator('.native-preview-status')).toHaveCount(0);
    expect(rejectedTimes).toHaveLength(1);

    // A failed warmup cannot poison a later current-priority request.
    await seek(page, 1500);
    await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
    await expect(image).toHaveAttribute('alt', savedCaptions[1].text);
    await expect(page.locator('.native-preview-status')).toHaveCount(0);
    expect(fixture.projects[0].captions).toEqual(savedCaptions);
  } finally {
    release.resolve();
  }
});
