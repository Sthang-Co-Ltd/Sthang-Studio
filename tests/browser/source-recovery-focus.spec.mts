import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { continueOwnedRoute, closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
const stage = (page: Page) => page.getByRole('region', { name: 'Media preview', exact: true });
const action = (page: Page, name: string) => page.locator('.source-media-status').getByRole('button', { name, exact: true });
const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
const status = (state: 'original' | 'processing' | 'cancelled') => ({ source: 'landscape.mp4', state, videoCodec: 'hevc', progress: state === 'processing' ? 30 : 0 });
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic draft remains unsaved' } }));
});
async function rememberEvidence(page: Page) {
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('[data-media-preview-focus]'), document.querySelector('.caption-list')];
    (window as any).__sourceRecoveryNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
}
async function unchanged(page: Page, original: string) {
  expect(JSON.stringify(state.projects)).toBe(original);
  expect(await page.evaluate(() => (window as any).__sourceRecoveryNodes.every((node: Element, index: number) =>
    node === document.querySelector(index ? '.caption-list' : '[data-media-preview-focus]')))).toBe(true);
  expect(state.jobs).toEqual([]);
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { focused: document.activeElement === node, visible: rect.width > 0 && rect.height > 0
      && rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1
      && (hit === node || (hit !== null && node.contains(hit))) };
  })).toEqual({ focused: true, visible: true });
}
async function manualPlayback(page: Page) {
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => 'probably'; });
}

for (const width of [1440, 390]) test(`manual playback Retry keeps visible preview focus and settings through held metadata at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/media-preview/landscape*', (route) => route.fulfill({ json: { source: 'landscape.mp4', state: 'original', videoCodec: 'h264', progress: 0 } }));
  const original = JSON.stringify(state.projects);
  await openProject(page); await rememberEvidence(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill('Unfinished recovery wording កម្ពុជា');
  await seek(page, 1250);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 0.75; video.volume = 0.3; video.muted = true; });
  const gate = deferred(); let reads = 0;
  await page.route('**/media/landscape.mp4', async (route) => {
    reads++; await gate.promise;
    try { await continueOwnedRoute(route); }
    catch (error) { if (!page.isClosed() && !route.request().failure()) throw error; }
  });
  try {
    await page.locator('video').evaluate((video: HTMLVideoElement) => {
      Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
      video.dispatchEvent(new Event('error'));
    });
    await action(page, 'Retry playback').focus(); await page.keyboard.press('Enter');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await visibleFocus(stage(page));
    await page.keyboard.press('r'); await expect(stage(page)).toBeFocused();
    await action(page, 'Retry again').focus(); await page.keyboard.press('Enter');
    await expect.poll(() => reads).toBeGreaterThan(1);
    await visibleFocus(stage(page));
    if (width === 390) await page.screenshot({ path: info.outputPath('source-retry-focus-390.png'), animations: 'disabled' });
    gate.release();
    await expect(page.locator('.source-media-status')).toHaveCount(0);
    await expect(stage(page)).toBeFocused();
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.25, 2);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, rate: video.playbackRate, volume: video.volume, muted: video.muted })))
      .toEqual({ paused: true, rate: 0.75, volume: 0.3, muted: true });
    await expect(caption).toHaveValue('Unfinished recovery wording កម្ពុជា');
    await unchanged(page, original);
  } finally { gate.release(); }
});

test('manual preparation and cancellation hand off now and preserve newer field or modal focus on completion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await manualPlayback(page);
  const original = JSON.stringify(state.projects);
  const prepared = deferred(); const cancelled = deferred(); let posts = 0; let deletes = 0; let processing = false;
  await page.route('**/api/media-preview/landscape*', async (route) => {
    const method = route.request().method();
    if (method === 'POST') { posts++; await prepared.promise; processing = true; return route.fulfill({ json: status('processing') }); }
    if (method === 'DELETE') { deletes++; await cancelled.promise; processing = false; return route.fulfill({ json: status('cancelled') }); }
    return route.fulfill({ json: status(processing ? 'processing' : 'original') });
  });
  try {
    await openProject(page); await rememberEvidence(page);
    await action(page, 'Prepare playback').focus(); await page.keyboard.press('Enter');
    await expect.poll(() => posts).toBe(1); await visibleFocus(stage(page));
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Newer preparation draft ខ្មែរ');
    prepared.release(); await expect(action(page, 'Cancel preparation')).toBeEnabled();
    await expect(caption).toBeFocused(); await expect(caption).toHaveValue('Newer preparation draft ខ្មែរ');
    await action(page, 'Cancel preparation').focus(); await page.keyboard.press('Enter');
    await expect.poll(() => deletes).toBe(1); await visibleFocus(stage(page));
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
    const query = find.getByLabel('Find', { exact: true });
    await query.fill('Newer modal query');
    cancelled.release(); await expect(action(page, 'Prepare playback')).toBeEnabled();
    await expect(query).toBeFocused(); await expect(query).toHaveValue('Newer modal query');
    await expect(caption).toHaveValue('Newer preparation draft ខ្មែរ');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    expect(posts).toBe(1); expect(deletes).toBe(1); await unchanged(page, original);
  } finally { prepared.release(); cancelled.release(); }
});

test('automatic compatible playback preparation never moves focus from a current caption field', async ({ page }) => {
  const opening = deferred(); let posts = 0;
  const original = JSON.stringify(state.projects);
  await page.addInitScript(() => {
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) { return /hvc1|hev1/.test(type) ? '' : canPlay.call(this, type); };
  });
  await page.route('**/api/media-preview/landscape*', async (route) => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: status('processing') }); }
    await opening.promise;
    return route.fulfill({ json: status(posts ? 'processing' : 'original') });
  });
  try {
    await openProject(page); await rememberEvidence(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Draft before automatic preparation កម្ពុជា');
    opening.release();
    await expect.poll(() => posts).toBe(1);
    await expect(action(page, 'Cancel preparation')).toBeVisible();
    await expect(caption).toBeFocused(); await expect(caption).toHaveValue('Draft before automatic preparation កម្ពុជា');
    await unchanged(page, original);
  } finally { opening.release(); }
});
