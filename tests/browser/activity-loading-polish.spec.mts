import { test, expect, type Page } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
function job(id: string, status: ProcessingJob['status'], extra: Partial<ProcessingJob> = {}): ProcessingJob {
  const start = new Date(Date.now() - 9000).toISOString();
  return { id, type: 'transcribe', projectId: 'landscape', projectTitle: 'Caption project', status, stage: 'local-alignment', progress: 55,
    message: 'Matching captions to the audio.', canResume: false, createdAt: start, startedAt: start, updatedAt: new Date(Date.now() - 2000).toISOString(), ...extra };
}
async function activity(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  if (!await dialog.isVisible()) {
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

for (const width of [1440, 390]) test(`Activity keeps true states and recovery visible, with calm metadata at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  state.jobs = [
    job('running', 'running', { progress: 100, projectTitle: 'ការងារចំណងជើង · A longer project title that should stay inside the sheet' }),
    job('waiting', 'queued', { progress: 0, startedAt: undefined, message: 'Waiting for the current caption job.' }),
    job('stopping', 'running', { message: 'Cancellation requested. Finishing the current step.' }),
    job('failed', 'failed', { canResume: true, error: 'The connection was interrupted. Resume to try again.' }),
    job('cancelled', 'cancelled', { message: 'Job cancelled.' }),
    job('interrupted', 'interrupted', { message: 'Studio stopped during this job.' }),
    job('complete', 'completed', { progress: 100, completedAt: new Date().toISOString(), message: 'Captions are ready.', resultProjectId: 'landscape' }),
  ];
  await openProject(page);
  const dialog = await activity(page);
  const rows = dialog.getByRole('article');
  await expect(rows).toHaveCount(7);
  await expect(rows.locator('.job-state')).toHaveText(['Working', 'Waiting', 'Stopping', 'Needs attention', 'Cancelled', 'Interrupted', 'Completed']);
  await expect(rows.first().getByRole('progressbar')).toHaveAttribute('aria-valuetext', '100% · Working');
  await expect(dialog.locator('.job-failed').getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(dialog.locator('.job-cancelled').getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.job-failed').getByText('The connection was interrupted. Resume to try again.', { exact: true })).toBeVisible();
  await expect(dialog.locator('.job-queued .job-duration')).toHaveText('');
  await expect(dialog.locator('.job-completed .job-duration')).toHaveText(/^Took /);
  await expect(rows.first().locator('.job-details')).not.toHaveAttribute('open');
  await expect(rows.first().getByText('local alignment', { exact: true })).toBeHidden();
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const target of await dialog.locator('button,summary').all()) {
    if (width === 390 && await target.isVisible()) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await dialog.locator('.spin').first().evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  await page.screenshot({ path: info.outputPath(`activity-${width}.png`) });
  await rows.first().locator('.job-details summary').click();
  await expect(rows.first().getByText('local alignment', { exact: true })).toBeVisible();
  await expect(rows.first().getByText('Updated', { exact: true })).toBeVisible();
});

test('Activity updates numbers without replacing rows, open Details, or focused actions', async ({ page }) => {
  state.jobs = [job('running', 'running'), job('finished', 'completed', { completedAt: new Date().toISOString(), message: 'Done.' })];
  await openProject(page); const dialog = await activity(page);
  const running = dialog.locator('.job-running');
  const details = running.locator('.job-details');
  await details.locator('summary').click();
  const cancel = running.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await running.evaluate((node) => { (window as any).__activityRow = node; });
  const duration = running.locator('.job-duration');
  const beforeDuration = await duration.textContent();
  const beforeRight = (await duration.boundingBox())!;
  const terminal = await dialog.locator('.job-completed .job-duration').textContent();
  await expect(duration).not.toHaveText(beforeDuration!);
  expect((await duration.boundingBox())!.x + (await duration.boundingBox())!.width).toBeCloseTo(beforeRight.x + beforeRight.width, 1);
  state.jobs[0] = { ...state.jobs[0], progress: 67, updatedAt: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await expect(running.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67');
  expect(await running.evaluate((node) => node === (window as any).__activityRow)).toBe(true);
  await expect(details).toHaveAttribute('open'); await expect(cancel).toBeFocused();
  await expect(dialog.locator('.job-completed .job-duration')).toHaveText(terminal!);
});

for (const [label, module, loaded] of [
  ['Appearance', 'CaptionAppearanceWorkspace', '.caption-appearance-workspace'],
  ['Fine timing', 'WaveformEditor', '.timing-waveform-surface'],
  ['Export', 'ExportWorkspace', '.export-workspace'],
] as const) test(`${label} first-open placeholder leaves evidence usable and cached reopen direct`, async ({ page }, info) => {
  const gate = deferred(); let requests = 0;
  await page.route(`**/components/${module}.tsx*`, async (route) => { requests++; await gate.promise; await route.fallback(); });
  try {
    await openProject(page);
    expect(requests).toBe(0);
    const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
    expect(identity.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
    await page.evaluate(() => { (window as any).__loadingEvidence = [document.querySelector('video'), document.querySelector('.caption-panel')]; });
    const before = await page.locator('.media-stage').boundingBox();
    await page.getByRole('button', { name: label, exact: true }).click();
    const loading = page.locator('.workspace-loading');
    await expect(loading.getByText(`Opening ${label}…`, { exact: true })).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading.locator('button,input,[tabindex]')).toHaveCount(0);
    await expect(loading.locator('.workspace-loading-shape')).toHaveAttribute('aria-hidden', 'true');
    expect(await loading.evaluate((node) => Boolean(node.closest('.inspector-content')))).toBe(true);
    expect(await page.locator('.media-stage').boundingBox()).toEqual(before);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('Still editable while the tool opens'); await expect(caption).toHaveValue('Still editable while the tool opens');
    await page.locator('video').evaluate((video: HTMLVideoElement) => video.play());
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
    await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
    await page.screenshot({ path: info.outputPath(`loading-${module}.png`) });
    gate.resolve();
    await expect(page.locator(loaded)).toBeVisible(); await expect(loading).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__loadingEvidence.every((node: Element, i: number) => node === document.querySelector(i ? '.caption-panel' : 'video')))).toBe(true);
    await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(loaded)).toBeVisible(); await expect(loading).toHaveCount(0);
    expect(requests).toBe(1);
  } finally { gate.resolve(); }
});

test('a late first-open chunk never replaces a newer tool on mobile', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const gate = deferred(); const fetched = deferred();
  await page.route('**/components/CaptionAppearanceWorkspace.tsx*', async (route) => { fetched.resolve(); await gate.promise; await route.fallback(); });
  try {
    await openProject(page);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click(); await fetched.promise;
    const loading = page.locator('.workspace-loading');
    await expect(loading).toContainText('Opening Appearance…');
    await loading.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await loading.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
    await page.screenshot({ path: info.outputPath('loading-mobile.png') });
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    await expect(page.getByRole('complementary', { name: 'Accuracy workspace' })).toBeVisible();
    gate.resolve();
    await expect(loading).toHaveCount(0);
    await expect(page.locator('.caption-appearance-workspace')).toHaveCount(0);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  } finally { gate.resolve(); }
});

test('a failed first-open chunk preserves edits through repeated retries', async ({ page }) => {
  let failures = 2;
  const downloads: string[] = [];
  await page.route('**/components/WaveformEditor.tsx*', (route) => {
    downloads.push(route.request().url());
    return failures-- > 0 ? route.abort() : route.fallback();
  });
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  const error = page.getByRole('alert', { name: 'Fine timing could not load', exact: true });
  await expect(error).toContainText('Your captions remain available.');
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill('Retained during recovery');
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(error).toBeVisible();
  await expect.poll(() => downloads.length).toBe(2);
  await expect(caption).toHaveValue('Retained during recovery');
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.locator('.timing-waveform-surface')).toBeVisible();
  expect(new Set(downloads).size).toBe(3);
  await caption.fill('Editing still works after retry');
  await expect(caption).toHaveValue('Editing still works after retry');
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await expect(page.locator('.workspace-inspector')).toBeHidden();
});
