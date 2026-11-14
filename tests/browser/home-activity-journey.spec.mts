import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import fs from 'node:fs/promises';
import { cleanFixtures, fixtureExportUrl, fixtureMedia, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const homeActivity = (page: Page) => page.locator('.home-tools').getByRole('button', { name: /^Activity/ });
const activity = (page: Page) => page.getByRole('dialog', { name: 'Activity', exact: true });
const stamp = '2026-01-01T00:00:00.000Z';
function running(id: string, type: ProcessingJob['type']): ProcessingJob {
  return { id, type, projectId: 'landscape', projectTitle: 'Audit landscape', status: 'running',
    stage: type === 'export-video' ? 'rendering' : 'alignment', progress: 55, message: 'Synthetic processing in progress.',
    canResume: false, createdAt: stamp, startedAt: stamp, updatedAt: '2026-01-01T00:00:01.000Z' };
}
async function publish(page: Page) {
  const received = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/jobs' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await received;
}
async function visibleActivity(page: Page, width: number) {
  const button = homeActivity(page);
  await expect(button).toBeVisible(); await expect(button).toBeEnabled();
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  if (width === 390) expect(box.height).toBeGreaterThanOrEqual(44);
  return button;
}

for (const width of [1440, 390]) test(`Home keeps terminal Activity reachable after dismissal, with keyboard return and a real download at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  state.jobs = [running('home-export', 'export-video'), running('home-caption', 'transcribe')];
  await page.goto('/');
  await expect(homeActivity(page).locator('b')).toHaveText('2');
  await expect(page.locator('.media-stage video')).toHaveCount(0);

  const finished = '2026-01-01T00:00:03.000Z';
  state.jobs[0] = { ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100,
    message: 'Captioned video exported.', completedAt: finished, updatedAt: finished,
    resultExport: { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: fixtureMedia().length,
      width: 640, height: 360, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
      durationMs: 4000, createdAt: finished } };
  await publish(page);
  await expect(homeActivity(page).locator('b')).toHaveText('1');
  state.jobs[1] = { ...state.jobs[1], status: 'failed', stage: 'failed', canResume: true,
    message: 'Saved processing checkpoints are available.', error: 'Synthetic Home alignment failure',
    completedAt: finished, updatedAt: finished };
  await publish(page);
  const notice = page.getByRole('alert').filter({ hasText: 'Synthetic Home alignment failure' });
  await expect(notice).toBeVisible(); await expect(activity(page)).toHaveCount(0);
  await notice.getByRole('button', { name: 'Dismiss processing notice', exact: true }).click();
  await expect(notice).toHaveCount(0);
  const entry = await visibleActivity(page, width);
  await expect(entry).toHaveAccessibleName('Activity'); await expect(entry.locator('b')).toHaveCount(0);
  await entry.focus(); await expect(entry).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`home-terminal-activity-${width}.png`), animations: 'disabled' });

  await entry.press('Enter');
  await expect(activity(page)).toBeVisible();
  const close = activity(page).getByRole('button', { name: 'Close Activity', exact: true });
  await expect(close).toBeFocused();
  await expect(activity(page).locator('.job-toolbar')).toContainText('0 active · 2 recent');
  const completed = activity(page).getByRole('article', { name: 'Export captioned video · Audit landscape', exact: true });
  const failed = activity(page).getByRole('article', { name: 'Generate captions · Audit landscape', exact: true });
  await expect(failed.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(failed).toContainText('Synthetic Home alignment failure');
  await expect(activity(page).getByText('C:\\Synthetic\\exports', { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  const downloadAction = completed.getByRole('button', { name: 'Download video', exact: true });
  await downloadAction.focus(); await downloadAction.press('Enter');
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('synthetic-captioned.mp4');
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('The owned synthetic video download was unavailable.');
  expect(await fs.readFile(downloadPath)).toEqual(fixtureMedia());
  await close.focus(); await close.press('Enter');
  await expect(activity(page)).toHaveCount(0); await expect(entry).toBeFocused();
  await expect(entry).toHaveAccessibleName('Activity'); await expect(entry.locator('b')).toHaveCount(0);

  // The launcher and full library share the same history entry. Viewing the
  // collection must not require opening a project to recover terminal work.
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
  const libraryEntry = await visibleActivity(page, width);
  await libraryEntry.focus(); await libraryEntry.press('Space');
  await expect(activity(page)).toBeVisible();
  await expect(activity(page).getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(activity(page).getByRole('button', { name: 'Download video', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(activity(page)).toHaveCount(0); await expect(libraryEntry).toBeFocused();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await expect(homeActivity(page)).toHaveAccessibleName('Activity');
  await expect(page.locator('.media-stage video')).toHaveCount(0);
  expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs/'))).toEqual([]);
});
