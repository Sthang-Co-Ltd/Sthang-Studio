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
  await expect(dialog.getByRole('article').getByRole('alert')).toContainText(action === 'cancel'
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

for (const width of [390, 1440]) test(`an interruption notice takes the user to its job in a populated Activity list at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 760 : 900 });
  state.jobs = Array.from({ length: 40 }, (_, index) => ({
    ...job('job-' + index, index === 31 ? 'interrupted' : 'completed'), projectTitle: index % 3 ? 'Interview B' : 'Interview A',
    canResume: index === 31, progress: index === 31 ? 64 : 100, stage: index === 31 ? 'alignment' : 'complete',
    message: index === 31 ? 'Studio closed during alignment.' : 'Captions are ready.',
  }));
  const gate = deferred();
  let calls = 0;
  await page.route('**/api/jobs/job-31/resume', async (route) => {
    calls++;
    await gate.promise;
    await route.fulfill({ status: 503, json: { error: 'Resume reply unavailable' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open Activity', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    const interrupted = dialog.getByRole('article').filter({ hasText: 'Studio closed during alignment.' });
    await expect(interrupted).toBeFocused();
    await expect(interrupted).toBeInViewport({ ratio: 0.95 });
    const resume = interrupted.getByRole('button', { name: 'Resume', exact: true });
    await resume.focus();
    await resume.press('Enter');
    await expect(interrupted).toBeFocused();
    await expect(interrupted.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    gate.resolve();
    await expect(interrupted.getByRole('alert')).toContainText('Could not confirm the resume request.');
    await expect(resume).toBeFocused();
    await expect(resume).toBeInViewport({ ratio: 1 });
    expect(calls).toBe(1);
    await page.screenshot({ path: info.outputPath('interrupted-job-retry.png'), animations: 'disabled' });
  } finally { gate.resolve(); }
});

test('a lost generation reply looks up Activity and a failed lookup can be retried without sending another job', async ({ page }) => {
  state.projects[0].captions = []; state.projects[0].transcript = null;
  await openProject(page);
  let submissions = 0;
  let available = false;
  await page.route('**/api/jobs/transcribe', async (route) => {
    submissions++;
    state.jobs = [{ ...job('accepted', 'running'), projectTitle: state.projects[0].title }];
    await route.abort('failed');
  });
  await page.route('**/api/jobs', (route) => available || !submissions ? route.fallback()
    : route.fulfill({ status: 503, json: { error: 'Disconnected' } }));
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toContainText('Studio lost the reply for Audit landscape');
  await expect(dialog.getByRole('alert')).toContainText('Could not update activity');
  await dialog.getByRole('button', { name: 'Close Activity' }).click();
  const check = page.getByRole('button', { name: 'Check Activity', exact: true });
  await expect(check).toBeEnabled();
  available = true;
  await check.click();
  await expect(dialog.getByRole('article')).toContainText('Working');
  await dialog.getByRole('button', { name: 'Close Activity' }).click();
  await expect(page.getByRole('button', { name: 'Caption job in progress' })).toBeDisabled();
  await expect(page.getByText(/Studio lost the reply/)).toHaveCount(0);
  expect(submissions).toBe(1);
});

for (const cause of ['dismissed notice', 'project switch'] as const) test(`an unconfirmed caption submission survives a ${cause} until Activity can verify it`, async ({ page }) => {
  state.projects[0].captions = []; state.projects[0].transcript = null;
  await openProject(page);
  const gate = deferred();
  let submissions = 0;
  let lookupAvailable = false;
  await page.route('**/api/jobs/transcribe', async (route) => {
    submissions++;
    state.jobs = [{ ...job('accepted', 'running'), projectTitle: state.projects[0].title }];
    if (cause === 'project switch') await gate.promise;
    await route.abort('failed');
  });
  await page.route('**/api/jobs', (route) => lookupAvailable || !submissions ? route.fallback()
    : route.fulfill({ status: 503, json: { error: 'Activity unavailable for this check' } }));
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  const close = activity.getByRole('button', { name: 'Close Activity' });
  const verify = page.getByRole('button', { name: 'Check Activity', exact: true });
  try {
    await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
    await expect.poll(() => submissions).toBe(1);
    if (cause === 'dismissed notice') {
      await expect(activity.getByRole('alert')).toContainText('Could not update activity');
      await close.click();
      await page.getByRole('button', { name: 'Dismiss job notice', exact: true }).click();
      await expect(page.getByText(/Studio lost the reply/)).toHaveCount(0);
    } else {
      await page.getByRole('button', { name: 'Back to projects' }).click();
      await page.getByRole('button', { name: /Audit second/ }).click();
      const identity = page.getByRole('button', { name: 'Project details', exact: true });
      await expect(identity).toHaveAccessibleDescription(/Audit second/);
      const caption = page.getByRole('textbox', { name: 'Caption 1 text' });
      await caption.focus();
      const lost = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/api/jobs/transcribe'));
      gate.resolve(); await lost;
      await expect(caption).toBeFocused(); await expect(identity).toHaveAccessibleDescription(/Audit second/);
      await expect(activity).toHaveCount(0); await expect(verify).toHaveCount(0);
      await expect(page.getByText(/Studio lost the reply/)).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to projects' }).click();
      await page.getByRole('button', { name: /Audit landscape/ }).click();
    }
    await expect(verify).toBeEnabled();
    await verify.click();
    await expect(activity.getByRole('alert')).toContainText('Could not update activity');
    await close.click(); await expect(verify).toBeEnabled();
    lookupAvailable = true;
    await verify.click();
    await expect(activity.getByRole('article')).toContainText('Working');
    await close.click();
    await expect(page.getByRole('button', { name: 'Caption job in progress' })).toBeDisabled();
    expect(submissions).toBe(1);
  } finally { gate.resolve(); }
});
