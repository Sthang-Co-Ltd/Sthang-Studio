import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const first = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 18 }, (_, index) => {
    const startMs = 80 + index * 190;
    return { ...first, id: `follow-${index}`, startMs, endMs: startMs + 170, text: `កម្ពុជា caption ${index + 1}`, approved: false };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const list = (page: Page) => page.locator('.caption-list');
const follow = (page: Page) => page.locator('.caption-panel').getByRole('button', { name: 'Follow playback', exact: true });
const row = (page: Page, index: number) => page.locator(`[data-caption-id="follow-${index}"]`);
const selection = (page: Page) => page.locator('.caption-row.selected-range').evaluateAll((rows) =>
  rows.map((item) => item.getAttribute('data-caption-id')));

async function playheadCueIsVisible(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const viewport = document.querySelector<HTMLElement>('.caption-list')!.getBoundingClientRect();
    const timeMs = video.currentTime * 1000;
    let nearest: HTMLElement | null = null;
    let closestDistance = Infinity;
    for (const cue of document.querySelectorAll<HTMLElement>('.caption-row[data-caption-id^="follow-"]')) {
      const index = Number(cue.dataset.captionId!.slice('follow-'.length));
      const startMs = 80 + index * 190;
      const endMs = startMs + 170;
      const distance = timeMs < startMs ? startMs - timeMs : timeMs >= endMs ? timeMs - endMs : 0;
      if (distance < closestDistance) { closestDistance = distance; nearest = cue; }
    }
    if (!nearest) return false;
    const rect = (nearest as HTMLElement).getBoundingClientRect();
    return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
  });
}

async function rememberNativeNodes(page: Page) {
  await page.evaluate(() => {
    const first = document.querySelector<HTMLTextAreaElement>('[data-caption-id="follow-0"] textarea')!;
    first.setSelectionRange(3, 3);
    (window as any).__followNodes = [document.querySelector('video'), document.querySelector('.caption-list'), first];
  });
}
async function expectNativeNodes(page: Page) {
  expect(await page.evaluate(() => {
    const nodes = (window as any).__followNodes;
    const first = document.querySelector<HTMLTextAreaElement>('[data-caption-id="follow-0"] textarea')!;
    return nodes[0] === document.querySelector('video') && nodes[1] === document.querySelector('.caption-list')
      && nodes[2] === first && first.selectionStart === 3 && first.selectionEnd === 3;
  })).toBe(true);
}
async function setPlayhead(page: Page, ms: number, play = false) {
  await page.locator('video').evaluate(async (video: HTMLVideoElement, options) => {
    video.currentTime = options.ms / 1000;
    video.dispatchEvent(new Event('timeupdate'));
    if (options.play) { video.playbackRate = 0.5; await video.play(); }
  }, { ms, play });
}

for (const width of [1440, 390]) test(`resuming Follow during native playback reveals playhead without changing caption selection or media ownership at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openProject(page);
  await rememberNativeNodes(page);
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'true');
  await follow(page).click(); // Pause automatic list following.
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'false');
  await row(page, 0).locator('.row-index').click();
  await expect.poll(() => selection(page)).toEqual(['follow-0']);
  await list(page).evaluate((node) => { node.scrollTop = 0; });
  await setPlayhead(page, 2600, true); // Playhead belongs to cue 14, not selected cue 1.
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await expect.poll(() => selection(page)).toEqual(['follow-0']);

  await follow(page).click(); // Resume Follow: scrolling is allowed, reselection is not.
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => list(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => playheadCueIsVisible(page)).toBe(true);
  await expect.poll(() => selection(page)).toEqual(['follow-0']);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await expect(follow(page)).toBeFocused();
  await expectNativeNodes(page);

  // Current is the distinct, intentional command that *does* select the playhead cue.
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  await setPlayhead(page, 2600);
  await page.getByRole('button', { name: 'Current', exact: true }).click();
  await expect(row(page, 13)).toHaveClass(/selected-range/);
  await expectNativeNodes(page);
});

test('rapid Follow on then off yields to a newer manual caption selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openProject(page);
  await rememberNativeNodes(page);
  await follow(page).click(); // Default Following → paused.
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'false');
  await setPlayhead(page, 2600);
  await page.clock.install();
  // Install alone advances with real time; freeze until we deliberately flush
  // any queued work after the newer manual selection.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);

  await follow(page).click(); // An old implementation queued a 0ms stale jump here.
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'true');
  await follow(page).click(); // The creator pauses before any queued jump is due.
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'false');
  await row(page, 2).locator('.row-index').click(); // Newer explicit selection wins.
  await expect.poll(() => selection(page)).toEqual(['follow-2']);
  const before = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime);
  const scrollBefore = await list(page).evaluate((node) => node.scrollTop);
  await page.clock.runFor(120);
  expect(await selection(page)).toEqual(['follow-2']);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(before, 3);
  expect(await list(page).evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'false');
  await expectNativeNodes(page);
  expect(state.projects[0].captions).toHaveLength(18);
});

test('resuming Follow leaves an owned Review tight loop and its selection intact', async ({ page }) => {
  state.profile.preferences.autoLoopReview = true;
  state.profile.preferences.autoPlayNextReview = false;
  await page.setViewportSize({ width: 390, height: 900 });
  await openProject(page);
  await rememberNativeNodes(page);
  await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
  const review = page.getByRole('complementary', { name: 'Review workspace', exact: true });
  await expect(review).toBeVisible();
  await expect.poll(() => selection(page)).toEqual(['follow-0']);
  await follow(page).click();
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.playbackRate = 0.5;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    if (!descriptor?.get || !descriptor.set) throw new Error('Cannot observe Review loop seeks');
    (window as any).__followReviewLoopSeeks = 0;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return descriptor.get!.call(video); },
      set(value: number) { (window as any).__followReviewLoopSeeks++; descriptor.set!.call(video, value); },
    });
  });
  const loopSeeks = () => page.evaluate(() => (window as any).__followReviewLoopSeeks as number);
  await review.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  // Ignore the initial Replay seek; first prove that two loop wraps happened.
  await expect.poll(loopSeeks, { timeout: 6500 }).toBeGreaterThanOrEqual(3);
  const beforeFollow = await loopSeeks();

  await follow(page).click();
  await expect(follow(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => selection(page)).toEqual(['follow-0']);
  // A Review-owned loop seeks back on reaching this cue's tail. The old Follow
  // action reselected the cue, released that owner and silently ended looping.
  await expect.poll(loopSeeks, { timeout: 6500 }).toBeGreaterThanOrEqual(beforeFollow + 2);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await expect.poll(() => selection(page)).toEqual(['follow-0']);
  await expect(follow(page)).toBeFocused();
  await expectNativeNodes(page);
});
