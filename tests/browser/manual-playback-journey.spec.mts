import { test as base, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
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
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const current = () => state.projects[0];
const media = (page: Page) => page.locator('video');
const fine = (page: Page) => page.locator('.fine-timing');
function wordFixture() {
  const cue = (id: string, text: string, startMs: number, endMs: number, starts: number[], ends: number[]) => {
    const tokens: TimedToken[] = text.split(' ').map((word, index) => ({ id: `${id}-w${index}`, text: word,
      startMs: starts[index], endMs: ends[index], spaceBefore: index > 0, timingSource: 'stt', confidence: .99, alignmentScore: .99 }));
    const caption: CaptionSegment = { id, text, startMs, endMs, timingSource: 'stt', timingQuality: 'high', approved: true };
    caption.wordTiming = buildCaptionWordTiming(caption, tokens);
    return { caption, tokens };
  };
  const first = cue('c1', 'I love you very much', 200, 2500, [200, 600, 1000, 1550, 2000], [450, 850, 1250, 1750, 2500]);
  const second = cue('c2', 'Next caption', 2800, 3600, [2800, 3200], [3100, 3500]);
  current().captions = [first.caption, second.caption];
  current().transcript!.tokens = [...first.tokens, ...second.tokens];
  current().transcript!.segments = structuredClone(current().captions);
  current().transcript!.fullText = `${first.caption.text} ${second.caption.text}`;
}
async function openTiming(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking)).toBe(true);
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    video.pause();
    video.playbackRate = 0.5;
    (window as any).__manualPlaybackNodes = [video, document.querySelector('.caption-list')];
    (window as any).__manualPlaybackSeeks = [];
    video.addEventListener('seeking', () => (window as any).__manualPlaybackSeeks.push(video.currentTime));
  });
}
async function selectedIds(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-caption-id')));
}
async function unchanged(page: Page, before: CaptionSegment[], selected: Array<string | null>, writes: number) {
  expect(current().captions).toEqual(before);
  expect(await selectedIds(page)).toEqual(selected);
  expect(state.requests.filter((request) => request.path.endsWith('/captions')).length).toBe(writes);
  expect(await page.evaluate(() => (window as any).__manualPlaybackNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function playing(page: Page) {
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.paused && !video.seeking)).toBe(true);
}
async function nativeSeekAndContinue(page: Page) {
  await media(page).focus();
  await media(page).evaluate((video: HTMLVideoElement) => { video.currentTime = 2.5; });
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.8);
  expect(await media(page).evaluate((video: HTMLVideoElement) => ({ paused: video.paused, rate: video.playbackRate }))).toEqual({ paused: false, rate: 0.5 });
  await expect(media(page)).toBeFocused();
}

for (const width of [1440, 390]) for (const loop of [false, true]) {
  test(`native source seek takes over caption audition without a jump or pause at ${width}px (Loop ${loop ? 'on' : 'off'})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openTiming(page);
    await fine(page).getByLabel('Loop', { exact: true }).setChecked(loop);
    const before = structuredClone(current().captions);
    const selected = await selectedIds(page);
    const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
    await page.getByRole('button', { name: 'Replay caption', exact: true }).click();
    await playing(page);
    if (loop) {
      await expect.poll(() => page.evaluate(() => (window as any).__manualPlaybackSeeks.filter((time: number) => Math.abs(time - 0.08) < 0.05).length)).toBeGreaterThanOrEqual(2);
      await playing(page);
    }
    await nativeSeekAndContinue(page);
    if (width === 390 && loop) await page.screenshot({ path: info.outputPath('manual-caption-seek-390.png'), animations: 'disabled' });
    await unchanged(page, before, selected, writes);
  });
}

for (const width of [1440, 390]) test(`Hear word yields to native playback while keeping its word/caption selection at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  wordFixture();
  await openTiming(page);
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await page.getByRole('button', { name: 'Word 3: you', exact: true }).click();
  await fine(page).getByLabel('Loop', { exact: true }).setChecked(width === 390);
  const before = structuredClone(current().captions);
  const selected = await selectedIds(page);
  const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  await page.getByRole('button', { name: 'Hear word', exact: true }).click();
  await playing(page);
  if (width === 390) {
    await expect.poll(() => page.evaluate(() => (window as any).__manualPlaybackSeeks.filter((time: number) => Math.abs(time - 0.88) < 0.05).length)).toBeGreaterThanOrEqual(2);
    await playing(page);
  }
  await nativeSeekAndContinue(page);
  await expect(page.getByRole('button', { name: 'Word 3: you', exact: true })).toHaveAttribute('aria-pressed', 'true');
  if (width === 390) await page.screenshot({ path: info.outputPath('manual-word-seek-390.png'), animations: 'disabled' });
  await unchanged(page, before, selected, writes);
});

test('native pause retires an audition and later source playback stays independent of its checked Loop option', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openTiming(page);
  await fine(page).getByLabel('Loop', { exact: true }).check();
  const before = structuredClone(current().captions);
  const selected = await selectedIds(page);
  const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  await page.getByRole('button', { name: 'Replay caption', exact: true }).click();
  await playing(page);
  await media(page).evaluate((video: HTMLVideoElement) => video.pause());
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await media(page).focus();
  await media(page).evaluate(async (video: HTMLVideoElement) => { video.currentTime = 2.5; await video.play(); });
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.8);
  expect(await media(page).evaluate((video: HTMLVideoElement) => ({ paused: video.paused, rate: video.playbackRate }))).toEqual({ paused: false, rate: 0.5 });
  await expect(fine(page).getByLabel('Loop', { exact: true })).toBeChecked();
  await unchanged(page, before, selected, writes);
});
