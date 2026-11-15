import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

function job(id: string, status: ProcessingJob['status']): ProcessingJob {
  const start = new Date(Date.now() - 9000).toISOString();
  return { id, type: 'transcribe', projectId: 'landscape', projectTitle: id, status,
    stage: 'local-alignment', progress: 55, message: 'Matching captions to the audio.',
    canResume: status === 'failed', createdAt: start, startedAt: start,
    updatedAt: new Date(Date.now() - 2000).toISOString() };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function openActivity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const width of [1440, 390]) test('Activity guards independent pending actions across reopen at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  state.jobs = [job('running', 'running'), job('failed', 'failed')];
  const cancelGate = deferred(); const resumeGate = deferred();
  let cancels = 0; let resumes = 0;
  await page.route('**/api/jobs/running/cancel', async (route) => {
    cancels++; await cancelGate.promise;
    state.jobs[0] = { ...state.jobs[0], message: 'Cancellation requested. Finishing the current step.', updatedAt: new Date().toISOString() };
    await route.fulfill({ json: state.jobs[0] });
  });
  await page.route('**/api/jobs/failed/resume', async (route) => {
    resumes++; await resumeGate.promise;
    state.jobs[1] = { ...state.jobs[1], status: 'queued', canResume: false, message: 'Queued to resume.', updatedAt: new Date().toISOString() };
    await route.fulfill({ json: state.jobs[1] });
  });
  try {
    await openProject(page);
    const dialog = await openActivity(page);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await dialog.getByRole('button', { name: 'Resume', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(dialog.getByRole('button', { name: 'Requesting stop…', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Resuming…', exact: true })).toBeDisabled();
    await expect.poll(() => [cancels, resumes]).toEqual([1, 1]);
    await expect(dialog.locator('.job-state')).toHaveText(['Working', 'Needs attention']);
    await expect(dialog.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '55');
    await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await openActivity(page);
    await expect(dialog.getByRole('button', { name: 'Requesting stop…', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Resuming…', exact: true })).toBeDisabled();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('activity-pending-' + width + '.png') });
    cancelGate.resolve();
    await expect(dialog.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
    await expect(dialog.locator('.job-running .job-state')).toHaveText('Stopping');
    resumeGate.resolve();
    await expect(dialog.locator('.job-queued .job-state')).toHaveText('Waiting');
    await expect(dialog.getByRole('button', { name: 'Resuming…', exact: true })).toHaveCount(0);
    expect([cancels, resumes]).toEqual([1, 1]);
  } finally { cancelGate.resolve(); resumeGate.resolve(); }
});

for (const action of ['cancel', 'resume'] as const) test('Activity ' + action + ' failure is visible and retryable', async ({ page }) => {
  state.jobs = [job('retry', action === 'cancel' ? 'running' : 'failed')];
  let calls = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/jobs/retry/' + action, async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable request' } });
    state.jobs[0] = { ...state.jobs[0], status: action === 'cancel' ? 'cancelled' : 'queued',
      canResume: false, message: 'Acknowledged.', updatedAt: new Date().toISOString() };
    return route.fulfill({ json: state.jobs[0] });
  });
  await openProject(page); const dialog = await openActivity(page);
  const button = dialog.getByRole('button', { name: action === 'cancel' ? 'Cancel' : 'Resume', exact: true });
  await button.click();
  await expect(page.locator('.toast.error')).toContainText(action === 'cancel'
    ? 'Could not confirm the stop request.' : 'Could not confirm the resume request.');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(dialog.locator('.job-state')).toHaveText(action === 'cancel' ? 'Cancelled' : 'Waiting');
  expect(calls).toBe(2);
  expect(pageErrors).toEqual([]);
});

test('a late cancellation response cannot replace a newer completed job', async ({ page }) => {
  state.jobs = [job('late', 'running')];
  const gate = deferred();
  const old = { ...state.jobs[0], message: 'Cancellation requested. Finishing the current step.' };
  await page.route('**/api/jobs/late/cancel', async (route) => { await gate.promise; await route.fulfill({ json: old }); });
  try {
    await openProject(page); const dialog = await openActivity(page);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Requesting stop…', exact: true })).toBeDisabled();
    state.jobs[0] = { ...state.jobs[0], status: 'completed', progress: 100, canResume: false, updatedAt: new Date().toISOString() };
    await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
    await expect(dialog.locator('.job-state')).toHaveText('Completed');
    const acknowledgement = page.waitForResponse('**/api/jobs/late/cancel');
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
    gate.resolve();
    await Promise.all([acknowledgement, refreshed]);
    await expect(dialog.locator('.job-actions button')).toHaveCount(0);
    await expect(dialog.locator('.job-state')).toHaveText('Completed');
  } finally { gate.resolve(); }
});
