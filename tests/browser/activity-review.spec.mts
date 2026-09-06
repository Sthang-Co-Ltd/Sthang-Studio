import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { cleanFixtures, fixtureMedia, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import type { ProcessingJob } from '@kcs/shared';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

function job(id: string, status: ProcessingJob['status']): ProcessingJob {
  return { id, type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape', status,
    stage: 'rendering', progress: status === 'completed' ? 100 : 55, message: `${id} render`,
    canResume: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:02Z',
    startedAt: '2026-01-01T00:00:00Z', ...(status === 'completed' ? { completedAt: '2026-01-01T00:00:02Z', resultExport: {
      filename: 'synthetic-captioned.mp4', url: '/exports/synthetic-captioned.mp4', sizeBytes: 12000,
      width: 640, height: 360, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
      durationMs: 4000, createdAt: '2026-01-01T00:00:02Z',
    } } : {}) };
}
async function activity(page: import('@playwright/test').Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}

test('Activity downloads the backend bytes and exposes location, progress, readable metadata and touch controls', async ({ page }) => {
  state.jobs = [job('complete', 'completed'), job('running', 'running')];
  await openProject(page);
  const dialog = await activity(page);
  await expect(dialog.getByRole('button', { name: 'Close Activity' })).toBeFocused();
  await expect(dialog.getByText('C:\\Synthetic\\exports', { exact: true })).toBeVisible();
  await expect(dialog.locator('.job-completed')).toContainText('Took 2s');
  await expect(dialog.getByRole('progressbar').nth(1)).toHaveAttribute('aria-valuenow', '55');
  const heading = await dialog.locator('.job-modal-heading-copy strong').boundingBox();
  const description = await dialog.locator('.job-modal-heading-copy span').boundingBox();
  expect(description!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
  const result = dialog.locator('.job-completed');
  const meta = await result.locator('.job-meta').boundingBox();
  const actions = await result.locator('.job-actions').boundingBox();
  expect(actions!.y).toBeGreaterThanOrEqual(meta!.y + meta!.height);
  const download = page.waitForEvent('download');
  await result.getByRole('button', { name: 'Download video' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('synthetic-captioned.mp4');
  expect(await fs.readFile((await file.path())!)).toEqual(fixtureMedia());
  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await dialog.getByRole('button').all()) {
    if (await button.isVisible()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const sizes = await dialog.locator('.job-copy, .job-modal-heading-copy').evaluateAll((roots) => roots.flatMap((root) => [...root.querySelectorAll('small,button,strong,span')].filter((item) => item.getClientRects().length).map((item) => parseFloat(getComputedStyle(item).fontSize))));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
});

test('Activity cancel/resume/refresh act on the chosen job and keyboard focus stays out of the editor', async ({ page }) => {
  state.jobs = [job('running', 'running')];
  await openProject(page);
  const dialog = await activity(page);
  const close = dialog.getByRole('button', { name: 'Close Activity' });
  await close.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus(); await refresh.press('Enter');
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(dialog).toContainText('Queued to resume');
  expect(state.requests.filter((item) => item.method === 'POST' && item.path.startsWith('/api/jobs/')).map((item) => item.path)).toEqual(['/api/jobs/running/cancel', '/api/jobs/running/resume']);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test('review keeps context on entry, tight replay, separate focus artwork and native select keyboard behavior', async ({ page }) => {
  state.profile.preferences.reviewPreRollMs = 450;
  state.profile.preferences.reviewPostRollMs = 300;
  state.projects[0].captions[0].startMs = 600;
  state.projects[0].captions[0].endMs = 1100;
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.15, 2);
  await seek(page, 800);
  const image = page.locator('.native-caption-image');
  await expect(image).toBeVisible();
  const pixels = await image.getAttribute('src');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
  const reviewFocusControl = page.locator('label.review-focus-mode-control[for="review-focus-mode-select"]');
  await expect(reviewFocusControl).toBeVisible();
  await expect(reviewFocusControl.locator('#review-focus-mode-select')).toBeVisible();
  const controlBox = (await reviewFocusControl.boundingBox())!;
  const selectBox = (await page.locator('#review-focus-mode-select').boundingBox())!;
  expect(selectBox.x).toBeGreaterThanOrEqual(controlBox.x - 2);
  expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(controlBox.x + controlBox.width + 2);
  const focus = page.getByLabel('Review focus', { exact: true });
  await focus.selectOption('off');
  await expect(page.locator('.native-caption-focus')).toHaveCount(0);
  expect(await image.getAttribute('src')).toBe(pixels);
  await focus.selectOption('brackets');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  await expect(page.locator('.review-focus-label')).toHaveCount(0);
  await focus.focus(); await focus.press('ArrowDown');
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
  // Inspect the actual requested replay seek without racing media-clock advancement.
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.play = async () => {}; });
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.46, 2);
  await page.getByRole('button', { name: 'Play with context', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.15, 2);
});

test('rapid short-caption transitions share pending render work instead of starving every caption', async ({ page }) => {
  state.projects[0].mode = 'word';
  state.projects[0].captions = Array.from({ length: 12 }, (_, index) => ({ id: `word-${index}`, text: `Caption ${index}`, startMs: index * 100, endMs: index * 100 + 100 }));
  state.previewDelay = () => 600;
  await openProject(page);
  await expect.poll(() => state.requests.filter((item) => item.path.endsWith('/preview')).length).toBeGreaterThan(0);
  for (const ms of [550, 650, 750, 850]) await seek(page, ms);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('alt', 'Caption 8');
  expect(state.requests.filter((item) => item.path.endsWith('/preview')).length).toBeLessThanOrEqual(3);
});
