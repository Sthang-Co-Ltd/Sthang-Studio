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
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

function job(): ProcessingJob {
  const stamp = new Date(Date.now() - 10_000).toISOString();
  return { id: 'retained', type: 'transcribe', projectId: 'landscape', projectTitle: 'Retained caption work',
    status: 'completed', stage: 'complete', progress: 100, message: 'Captions are ready.',
    canResume: false, createdAt: stamp, startedAt: stamp, updatedAt: stamp, completedAt: stamp };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openActivity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function rememberEditor(page: Page) {
  await page.evaluate(() => {
    const media = document.querySelector('.media-stage video');
    const list = document.querySelector('.caption-list');
    if (!media || !list) throw new Error('The editor evidence must be present before Activity opens.');
    (window as any).__activityRecoveryNodes = { media, list };
  });
}
async function expectEditorPreserved(page: Page) {
  expect(await page.evaluate(() => {
    const previous = (window as any).__activityRecoveryNodes;
    return previous.media === document.querySelector('.media-stage video')
      && previous.list === document.querySelector('.caption-list');
  })).toBe(true);
}

for (const width of [1440, 390]) test('Activity separates loading and failed reads from an empty history at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const initial = deferred();
  let available = false;
  await page.route('**/api/jobs', async (route) => {
    const succeeds = available;
    if (!succeeds) await initial.promise;
    return route.fulfill(succeeds ? { json: [] } : { status: 503, json: { error: 'Synthetic activity read failure' } });
  });
  try {
    await openProject(page);
    await rememberEditor(page);
    const dialog = await openActivity(page);
    await expect(dialog.locator('.job-toolbar')).toContainText('Loading activity…');
    await expect(dialog.getByText('No jobs yet.', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    initial.release();
    await expect(dialog.locator('.job-toolbar')).toContainText('Activity unavailable');
    await expect(dialog.locator('.job-load-error')).toContainText('Could not update activity. Try again.');
    await expect(dialog.getByText('No jobs yet.', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('activity-unavailable-' + width + '.png') });
    available = true;
    await dialog.getByRole('button', { name: 'Retry activity', exact: true }).click();
    await expect(dialog.getByText('No jobs yet.', { exact: true })).toBeVisible();
    await expect(dialog.locator('.job-load-error')).toHaveCount(0);
    await expectEditorPreserved(page);
  } finally { initial.release(); }
});

for (const width of [1440, 390]) test('Activity retains loaded rows and Details through refresh failure and retry at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  state.jobs = [job()];
  await openProject(page);
  await rememberEditor(page);
  const dialog = await openActivity(page);
  const row = dialog.getByRole('article');
  await expect(row).toHaveCount(1);
  await row.locator('summary').click();
  await row.evaluate((node) => { (window as any).__retainedActivityRow = node; });
  const refresh = deferred();
  let requests = 0;
  let available = false;
  await page.route('**/api/jobs', async (route) => {
    requests++;
    const succeeds = available;
    if (!succeeds) await refresh.promise;
    return route.fulfill(succeeds ? { json: state.jobs } : { status: 503, json: { error: 'Synthetic refresh failure' } });
  });
  try {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).evaluate((button: HTMLButtonElement) => {
      button.click(); button.click();
    });
    await expect(dialog.locator('.job-toolbar')).toContainText('Refreshing activity…');
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
    await expect(row).toBeVisible();
    await expect(row.locator('details')).toHaveAttribute('open');
    refresh.release();
    await expect(dialog.locator('.job-load-error')).toContainText('The last loaded activity is still shown.');
    await expect(dialog.locator('.job-toolbar')).toContainText('Last loaded: 0 active · 1 recent');
    await expect(row.locator('details')).toHaveAttribute('open');
    expect(await row.evaluate((node) => node === (window as any).__retainedActivityRow)).toBe(true);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const retry = dialog.getByRole('button', { name: 'Retry activity', exact: true });
    if (width === 390) expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('activity-last-loaded-' + width + '.png') });
    available = true;
    await retry.click();
    await expect(dialog.locator('.job-load-error')).toHaveCount(0);
    await expect(dialog.locator('.job-toolbar')).toContainText('0 active · 1 recent');
    await expect(row.locator('details')).toHaveAttribute('open');
    await expectEditorPreserved(page);
  } finally { refresh.release(); }
});

for (const newerFails of [false, true]) test('a delayed Activity read cannot replace newer ' + (newerFails ? 'failure feedback' : 'successful feedback'), async ({ page }) => {
  state.jobs = [{ ...job(), status: 'queued', stage: 'queued', progress: 0, completedAt: undefined }];
  await openProject(page);
  const dialog = await openActivity(page);
  const older = deferred();
  const started = deferred();
  let reads = 0;
  let cancellations = 0;
  await page.route('**/api/jobs', async (route) => {
    reads++;
    if (reads === 1) {
      const oldSnapshot = structuredClone(state.jobs);
      started.release();
      await older.promise;
      return route.fulfill(newerFails
        ? { json: oldSnapshot, headers: { 'x-activity-old': '1' } }
        : { status: 503, json: { error: 'Older failed read' }, headers: { 'x-activity-old': '1' } });
    }
    return route.fulfill(newerFails
      ? { status: 503, json: { error: 'Current failed read' } }
      : { json: state.jobs });
  });
  await page.route('**/api/jobs/retained/cancel', async (route) => {
    expect(route.request().method()).toBe('POST');
    cancellations++;
    state.jobs[0] = { ...state.jobs[0], status: 'cancelled', stage: 'cancelled', canResume: false,
      message: 'Cancelled before starting.', updatedAt: new Date(Date.parse(state.jobs[0].updatedAt) + 1000).toISOString() };
    await route.fulfill({ json: state.jobs[0] });
  });
  try {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await started.promise;
    // Same-generation refresh events now share the held read. A real mutation
    // advances its ownership and creates the newer result whose feedback must
    // survive either outcome of the older request.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.locator('.job-state')).toHaveText('Cancelled');
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    expect(cancellations).toBe(1);
    if (newerFails) await expect(dialog.locator('.job-load-error')).toBeVisible();
    else await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    const oldResponse = page.waitForResponse((response) => response.headers()['x-activity-old'] === '1');
    older.release();
    await oldResponse;
    if (newerFails) {
      await expect(dialog.locator('.job-load-error')).toBeVisible();
      await expect(dialog.locator('.job-toolbar')).toContainText('Last loaded:');
    } else {
      await expect(dialog.locator('.job-load-error')).toHaveCount(0);
      await expect(dialog.locator('.job-toolbar')).not.toContainText('Last loaded:');
    }
    await expect(dialog.getByRole('article')).toHaveCount(1);
    await expect(dialog.locator('.job-state')).toHaveText('Cancelled');
    expect(cancellations).toBe(1);
  } finally { older.release(); }
});
