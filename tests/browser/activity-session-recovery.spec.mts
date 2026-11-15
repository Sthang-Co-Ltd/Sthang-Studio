import { test as base, expect } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import fs from 'node:fs/promises';
import { cleanFixtures, fixtureExportUrl, fixtureMedia, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const stamp = '2026-01-01T00:00:00.000Z';
function recoveredJobs(): ProcessingJob[] {
  return [
    { id: 'saved-video', type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape',
      status: 'completed', stage: 'complete', progress: 100, message: 'Saved captioned video is ready.', canResume: false,
      createdAt: stamp, updatedAt: stamp, completedAt: stamp, resultExport: { filename: 'synthetic-captioned.mp4',
        url: fixtureExportUrl(), sizeBytes: fixtureMedia().length, width: 640, height: 360, frameRate: 25,
        videoCodec: 'h264', encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt: stamp } },
    { id: 'interrupted-caption', type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape',
      status: 'interrupted', stage: 'interrupted', progress: 52,
      message: 'Studio stopped during this job. Resume uses saved processing checkpoints where possible.',
      canResume: true, createdAt: stamp, updatedAt: stamp },
  ];
}

for (const width of [1440, 390]) test('unavailable startup Activity recovers saved download and explicit Resume across reload at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  state.jobs = recoveredJobs();
  const originalProjects = structuredClone(state.projects);
  let unavailable = true;
  await page.route('**/api/jobs', async (route) => route.fulfill(unavailable
    ? { status: 503, json: { code: 'JOB_HISTORY_UNAVAILABLE', error: 'Saved Activity could not be read safely. Existing history was kept.' } }
    : { json: state.jobs }));
  await page.goto('/');
  const startup = page.getByRole('status').filter({ hasText: 'Could not load: Activity' });
  await expect(startup).toBeVisible();
  await expect(page.locator('.home-tools').getByRole('button', { name: /^Activity/ })).toHaveCount(0);
  expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs/'))).toEqual([]);
  unavailable = false;
  const retry = page.getByRole('button', { name: 'Retry startup', exact: true });
  await retry.focus(); await retry.press('Enter');
  await expect(startup).toHaveCount(0);
  const entry = page.locator('.home-tools').getByRole('button', { name: /^Activity(?: \d+)?$/ });
  await expect(entry).toBeVisible(); await expect(entry).toHaveAccessibleName('Activity');
  await expect(entry.locator('b')).toHaveCount(0);
  if (width === 390) expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await entry.focus(); await entry.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close Activity', exact: true })).toBeFocused();
  await expect(dialog.locator('.job-toolbar')).toContainText('0 active · 2 recent');
  await expect(dialog.getByText('No jobs yet.', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs/'))).toEqual([]);
  await page.screenshot({ path: info.outputPath('activity-restored-session-' + width + '.png'), animations: 'disabled' });
  const downloadEvent = page.waitForEvent('download');
  const downloadAction = dialog.getByRole('button', { name: 'Download video', exact: true });
  await downloadAction.focus(); await downloadAction.press('Enter');
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('synthetic-captioned.mp4');
  const downloaded = await download.path();
  if (!downloaded) throw new Error('The owned recovered video download was unavailable');
  expect(await fs.readFile(downloaded)).toEqual(fixtureMedia());
  await dialog.getByRole('button', { name: 'Resume', exact: true }).focus();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).press('Enter');
  await expect(dialog.locator('.job-queued .job-state')).toHaveText('Waiting');
  expect(state.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/resume'))).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await expect(entry).toHaveAccessibleName('Activity 1');
  await expect(entry.locator('b')).toHaveText('1');
  await expect(entry).toBeFocused();
  // The browser closes after a resumed server job is interrupted again. Its
  // saved record returns on reload; opening Activity never resumes it itself.
  state.jobs = recoveredJobs();
  await page.reload();
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAccessibleName('Activity');
  await expect(entry.locator('b')).toHaveCount(0);
  await entry.focus(); await entry.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Download video', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(entry).toBeFocused();
  expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs/'))).toHaveLength(1);
  expect(state.projects).toEqual(originalProjects);
});
