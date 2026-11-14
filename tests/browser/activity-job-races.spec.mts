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
  const createdAt = new Date(Date.now() - 30_000).toISOString();
  return {
    id, type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape',
    status, stage: status, progress: status === 'queued' ? 0 : 50,
    message: status === 'failed' ? 'Earlier generation failed.' : 'Waiting to process.',
    error: status === 'failed' ? 'Synthetic earlier failure' : undefined,
    canResume: status === 'failed' || status === 'interrupted',
    createdAt, updatedAt: new Date(Date.now() - 10_000).toISOString(),
  };
}

function queuedAfter(previous: ProcessingJob): ProcessingJob {
  return {
    ...previous, status: 'queued', stage: 'queued', progress: 0,
    message: 'Queued again.', error: undefined, completedAt: undefined, canResume: false,
    updatedAt: new Date(Date.parse(previous.updatedAt) + 1_000).toISOString(),
  };
}

function completedAfter(previous: ProcessingJob): ProcessingJob {
  const finishedAt = new Date(Date.parse(previous.updatedAt) + 1_000).toISOString();
  return {
    ...previous, status: 'completed', stage: 'complete', progress: 100,
    message: 'Full transcription and local timing completed.',
    resultProjectId: 'landscape', error: undefined, canResume: false,
    updatedAt: finishedAt, completedAt: finishedAt,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function projectReads(): number {
  return state.requests.filter((request) => request.method === 'GET' && request.path === '/api/projects/landscape').length;
}

async function openActivity(page: Page) {
  // Activity's saved-appearance reconciliation reads this project once.
  // Await that independent read before measuring a later job handoff.
  const appearanceRead = page.waitForResponse((response) => response.url().endsWith('/api/projects/landscape/appearance') && response.request().method() === 'GET');
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await appearanceRead;
  return dialog;
}

async function refreshActivity(page: Page) {
  const received = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
  await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await received;
}

test('a delayed pre-cancel jobs GET cannot undo an acknowledged cancellation', async ({ page }) => {
  state.jobs = [job('stale-get', 'queued')];
  await openProject(page);
  const dialog = await openActivity(page);
  const staleGate = deferred();
  const staleStarted = deferred();
  let heldRead = false;
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'GET' || heldRead) return route.fallback();
    heldRead = true;
    const oldSnapshot = structuredClone(state.jobs);
    staleStarted.release();
    await staleGate.promise;
    await route.fulfill({ json: oldSnapshot, headers: { 'x-activity-stale': '1' } });
  });
  await page.route('**/api/jobs/stale-get/cancel', async (route) => {
    const previous = state.jobs[0];
    state.jobs[0] = {
      ...previous, status: 'cancelled', stage: 'cancelled', progress: 0,
      message: 'Cancelled before starting.', canResume: false,
      updatedAt: new Date(Date.parse(previous.updatedAt) + 2_000).toISOString(),
    };
    await route.fulfill({ json: state.jobs[0] });
  });

  try {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await staleStarted.promise;
    const cancellation = page.waitForResponse('**/api/jobs/stale-get/cancel');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await cancellation;
    await expect(dialog.locator('.job-state')).toHaveText('Cancelled');

    const staleResponse = page.waitForResponse((response) => response.headers()['x-activity-stale'] === '1');
    staleGate.release();
    await staleResponse;
    await expect(dialog.locator('.job-state')).toHaveText('Cancelled');
    await refreshActivity(page);
    await expect(dialog.locator('.job-state')).toHaveText('Cancelled');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  } finally {
    staleGate.release();
  }
});

test('a resumed job completed before its POST acknowledgement hands off the result exactly once', async ({ page }) => {
  state.jobs = [job('early-completion', 'failed')];
  const responseGate = deferred();
  const postStarted = deferred();
  let resumptions = 0;
  await page.route('**/api/jobs/early-completion/resume', async (route) => {
    resumptions++;
    const acknowledgement = queuedAfter(state.jobs[0]);
    state.jobs = [acknowledgement];
    postStarted.release();
    await responseGate.promise;
    await route.fulfill({ json: acknowledgement });
  });

  try {
    await openProject(page);
    const dialog = await openActivity(page);
    await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
    await postStarted.promise;
    await expect(dialog.getByRole('button', { name: 'Resuming…', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Activity independently re-reads saved appearance when a project changes.
    // With it closed, only the background completion handler needs this GET.
    const readsBefore = projectReads();

    state.jobs = [completedAfter(state.jobs[0])];
    state.projects[0].captions[0].text = 'Completed while resume acknowledgement was pending';
    const completionRead = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
    await completionRead;
    await expect.poll(() => projectReads() - readsBefore).toBe(1);
    await expect(page.getByText('Background caption generation completed.', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Caption 1 text' })).toHaveValue('Completed while resume acknowledgement was pending');

    const acknowledgement = page.waitForResponse('**/api/jobs/early-completion/resume');
    responseGate.release();
    await acknowledgement;
    // The late acknowledgement and an additional job snapshot cannot reapply
    // the already handled completion.
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
    await refreshed;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(projectReads() - readsBefore).toBe(1);
    expect(resumptions).toBe(1);
  } finally {
    responseGate.release();
  }
});

test('a server-accepted resume with a lost POST response still hands off its new completion once', async ({ page }) => {
  state.jobs = [job('lost-resume-ack', 'failed')];
  let resumptions = 0;
  await page.route('**/api/jobs/lost-resume-ack/resume', async (route) => {
    resumptions++;
    state.jobs = [queuedAfter(state.jobs[0])];
    await route.fulfill({ status: 503, json: { error: 'Synthetic response lost after acceptance' } });
  });

  await openProject(page);
  const dialog = await openActivity(page);
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.toast.error')).toContainText('Could not confirm the resume request.');
  await expect(dialog.locator('.job-state')).toHaveText('Waiting');
  await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const readsBefore = projectReads();

  state.jobs = [completedAfter(state.jobs[0])];
  state.projects[0].captions[0].text = 'Completed after lost resume acknowledgement';
  const completionRead = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await completionRead;
  await expect.poll(() => projectReads() - readsBefore).toBe(1);
  await expect(page.getByText('Background caption generation completed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Caption 1 text' })).toHaveValue('Completed after lost resume acknowledgement');
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await refreshed;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(projectReads() - readsBefore).toBe(1);
  expect(resumptions).toBe(1);
});
