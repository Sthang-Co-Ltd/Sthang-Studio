import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis, type ProcessingJob } from '@kcs/shared';
import { cleanFixtures, fixtureExportUrl, fixtureMedia, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
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

const createdAt = '2026-01-01T00:00:00.000Z';
const completedAt = '2026-01-01T00:00:05.000Z';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function queuedVideo(id = 'initial-export'): ProcessingJob {
  return { id, projectId: 'landscape', projectTitle: 'Audit landscape', type: 'export-video',
    status: 'queued', stage: 'queued', progress: 0, message: 'Captioned video export is queued.',
    canResume: false, createdAt, updatedAt: createdAt };
}
function completedVideo(previous = queuedVideo()): ProcessingJob {
  return { ...previous, status: 'completed', stage: 'complete', progress: 100,
    message: 'Captioned video export is ready.', canResume: false, updatedAt: completedAt, completedAt,
    exportContentFingerprint: createHash('sha256').update(exportContentBasis(state.projects[0], 'video')).digest('hex'),
    resultExport: { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: fixtureMedia().length,
      width: 640, height: 360, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
      durationMs: 4000, createdAt: completedAt } };
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function observeJobs(page: Page) {
  const received = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/jobs'
    && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await received; await rendered(page);
}
async function openActivity(page: Page, fromHome = false) {
  if (fromHome) await page.locator('.home-tools').getByRole('button', { name: /^Activity(?: \d+)?$/ }).click();
  else {
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  }
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(activity).toBeVisible();
  return activity;
}
async function requestRender(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();
}
async function exactDownload(page: Page, action: Locator) {
  const started = page.waitForEvent('download');
  await action.focus(); await action.press('Enter');
  const download = await started;
  expect(download.suggestedFilename()).toBe('synthetic-captioned.mp4');
  const stream = await download.createReadStream();
  if (!stream) throw new Error('The owned verified video download was unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(fixtureMedia());
  expect(await download.failure()).toBeNull();
}
function jobPosts() {
  return state.requests.filter((request) => request.method === 'POST' && /\/jobs(?:\/|$)/.test(request.path));
}

for (const width of [1440, 390]) test(`an initial export completion stays completed after its older queued POST acknowledgement at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const gate = deferred(); const entered = deferred(); let submissions = 0;
  await page.route('**/api/video-export/landscape/jobs', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON().expectedContentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    submissions++;
    const acknowledgement = queuedVideo(); state.jobs = [acknowledgement];
    entered.release(); await gate.promise;
    await route.fulfill({ status: 202, json: { ...acknowledgement, lastUsedSettingsSaved: true } });
  });
  try {
    await openProject(page); await requestRender(page); await entered.promise;
    await observeJobs(page); // Observe the accepted active ID while its POST is still pending.
    state.jobs = [completedVideo(state.jobs[0])];
    await observeJobs(page);
    const notice = page.locator('[data-toast-timer="notice"]');
    await expect(notice).toContainText('Captioned video ready: synthetic-captioned.mp4. Open Activity to download it.');
    await notice.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
    await expect(notice).toHaveCount(0);
    const activity = await openActivity(page);
    const row = activity.getByRole('article', { name: 'Export captioned video · Audit landscape', exact: true });
    await expect(row.locator('.job-state')).toHaveText('Completed');
    const download = row.getByRole('button', { name: 'Download video', exact: true });
    await expect(download).toBeEnabled(); await download.focus();
    const acknowledgement = page.waitForResponse('**/api/video-export/landscape/jobs');
    gate.release(); await acknowledgement; await rendered(page);
    await expect(row.locator('.job-state')).toHaveText('Completed');
    await expect(download).toBeEnabled(); await expect(download).toBeFocused();
    await expect(notice).toHaveCount(0); // Neither the completion nor a queued notice may return.
    await observeJobs(page); await expect(notice).toHaveCount(0);
    await expect(activity.getByRole('article')).toHaveCount(1);
    await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(activity.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(submissions).toBe(1);
  } finally { gate.release(); }
});

for (const width of [1440, 390]) test(`checking and uncertain export completions keep truthful Activity actions and folder guidance at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  state.jobs = [
    { ...queuedVideo('checking-publication'), status: 'interrupted', stage: 'checking-export-completion', progress: 99,
      message: 'Checking whether this video finished before Studio stopped. No render is being restarted.', canResume: false },
    { ...queuedVideo('uncertain-publication'), status: 'interrupted', stage: 'export-completion-uncertain', progress: 99,
      message: 'Studio stopped while finishing this video. Its saved completion could not be verified. Check the export folder before starting another render. No render was restarted.', canResume: false },
  ];
  await page.goto('/');
  const activity = await openActivity(page, true);
  await expect(activity).toContainText('Checking whether this video finished before Studio stopped.');
  await expect(activity).toContainText('Its saved completion could not be verified.');
  await expect(activity.locator('.job-state')).toHaveText(['Checking output', 'Completion uncertain']);
  await expect(activity.locator('.activity-export-location')).toContainText('C:\\Synthetic\\exports');
  await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await expect(activity.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(activity.getByRole('button', { name: 'Download video', exact: true })).toHaveCount(0);
  await expect(activity.locator('.job-toolbar')).toContainText('0 active · 2 recent');
  expect(await activity.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`export-completion-uncertain-${width}.png`), animations: 'disabled' });
  await activity.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await expect(page.getByText('Processing was interrupted. Open Activity and choose Resume to continue from saved progress.', { exact: true })).toHaveCount(0);
  await openActivity(page, true);
  await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  expect(jobPosts()).toEqual([]);
});

for (const width of [1440, 390]) test(`an exact completed result remains downloadable through reload without another export at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  state.jobs = [{ ...completedVideo(queuedVideo('recovered-exact-output')),
    message: 'Captioned video export is ready. The same verified file was recovered after Studio restarted.' }];
  const original = structuredClone(state.projects); const url = state.jobs[0].resultExport!.url;
  await page.goto('/');
  let activity = await openActivity(page, true);
  await expect(activity).toContainText('The same verified file was recovered after Studio restarted.');
  await exactDownload(page, activity.getByRole('button', { name: 'Download video', exact: true }));
  await page.reload();
  activity = await openActivity(page, true);
  await expect(activity.getByRole('article')).toHaveCount(1);
  await expect(activity.locator('.job-state')).toHaveText('Completed');
  await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  const download = activity.getByRole('button', { name: 'Download video', exact: true });
  if (width === 390) expect((await download.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await exactDownload(page, download);
  expect(state.jobs[0].id).toBe('recovered-exact-output'); expect(state.jobs[0].resultExport!.url).toBe(url);
  expect(state.projects).toEqual(original); expect(jobPosts()).toEqual([]);
});

for (const width of [1440, 390]) test(`a lost initial export response explains uncertainty and finds accepted work without resubmission at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); let submissions = 0;
  await page.route('**/api/video-export/landscape/jobs', async (route) => {
    submissions++; state.jobs = [queuedVideo('lost-export-ack')]; await route.abort('failed');
  });
  await openProject(page); await requestRender(page);
  const error = page.getByRole('alert').filter({ hasText: 'The request outcome could not be confirmed.' });
  await expect(error).toContainText('Check Activity for accepted work before starting another request.');
  expect(submissions).toBe(1);
  await observeJobs(page);
  const activity = await openActivity(page);
  await expect(activity.getByRole('article')).toHaveCount(1);
  await expect(activity.locator('.job-state')).toHaveText('Waiting');
  await activity.getByRole('button', { name: 'Close Activity', exact: true }).click();
  state.jobs = [completedVideo(state.jobs[0])]; await observeJobs(page);
  await openActivity(page);
  await expect(activity.getByRole('button', { name: 'Download video', exact: true })).toBeEnabled();
  await expect(activity.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  expect(state.jobs[0].id).toBe('lost-export-ack'); expect(submissions).toBe(1);
});
