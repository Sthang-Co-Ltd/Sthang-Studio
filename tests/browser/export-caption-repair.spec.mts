import { test, expect, type Page, type Route } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const checks = (page: Page) => page.getByRole('region', { name: 'Check before export' });
const renderButton = (page: Page) => page.getByRole('button', { name: 'Render captioned video', exact: true });
async function openExport(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(checks(page)).toBeVisible();
}
async function showIssues(page: Page) {
  const details = page.locator('.export-check-details');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator('summary').click();
}
async function captionsMode(page: Page) {
  await page.getByRole('group', { name: 'Export type' }).getByRole('button', { name: /Captions file/ }).click();
}
async function videoMode(page: Page) {
  await page.getByRole('group', { name: 'Export type' }).getByRole('button', { name: /Captioned video/ }).click();
}
async function advancedFormats(page: Page) {
  const details = page.locator('.handoff-advanced');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator('summary').click();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const passed = { status: 'passed', width: 640, height: 360, issues: [] };
const blocked = { status: 'blocked', width: 640, height: 360, issues: [
  { code: 'caption-overflow', captionIds: ['c1', 'c2'], message: 'These captions overlap and their combined layout extends outside the frame.' },
] };

test('caption repair selects and seeks the exact issue and returns with output choices', async ({ page }) => {
  await openExport(page);
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await page.getByLabel('Frame rate', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: 'High quality', exact: true }).click();
  await page.getByText('Advanced video settings', { exact: true }).click();
  await page.getByLabel('Custom bitrate (Mbps)', { exact: true }).fill('11');
  await captionsMode(page);
  await page.getByLabel('Caption destination', { exact: true }).selectOption('premiere');
  await advancedFormats(page);
  await page.getByRole('button', { name: /^WebVTT/ }).click();
  await showIssues(page);
  await checks(page).getByRole('button', { name: 'Go to caption 2', exact: true }).click();
  await expect(page.locator('[data-caption-id="c2"]')).toHaveClass(/selected/);
  await expect(page.getByLabel('Caption 2 text', { exact: true })).toBeFocused();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(1200);
  await expect(page.getByRole('region', { name: 'Export review', exact: true })).toContainText('Caption 2');
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check before export' })).toBeFocused();
  await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('premiere');
  await expect(page.getByRole('button', { name: 'Download VTT', exact: true })).toBeVisible();
  await videoMode(page);
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
  await expect(page.getByLabel('Frame rate', { exact: true })).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'High quality', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Custom bitrate (Mbps)', { exact: true })).toHaveValue('11');
});

test('word-file blockers open the selected caption in Word timing while SRT stays available', async ({ page }) => {
  state.projects[0].transcript!.tokens = [];
  for (const caption of state.projects[0].captions) delete caption.wordTiming;
  await openExport(page); await captionsMode(page); await advancedFormats(page);
  await page.getByRole('button', { name: /^One word per caption \(SRT\)/ }).click();
  await expect(page.getByRole('button', { name: 'Download WORD SRT', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  const second = checks(page).locator('.export-check-item').filter({ hasText: 'Word timing needs review' })
    .filter({ has: page.getByRole('button', { name: 'Go to caption 2', exact: true }) });
  await second.getByRole('button', { name: 'Go to caption 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Word timing', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-caption-id="c2"]')).toHaveClass(/selected/);
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download WORD SRT', exact: true })).toBeDisabled();
});

test('native overlap results identify both captions, preserve plain SRT, and clear after appearance repair', async ({ page }) => {
  let body: any;
  await page.route('**/api/video-export/*/check-layout', async (route) => { body = route.request().postDataJSON(); await route.fulfill({ json: blocked }); });
  await openExport(page);
  expect(body).toBeUndefined();
  await page.getByRole('button', { name: 'Check layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout needs attention');
  expect(body.captions.map((cue: any) => cue.id)).toEqual(['c1', 'c2', 'c3']);
  expect(body.expectedMedia).toEqual({ filename: 'landscape.mp4', size: 5000 });
  await expect(renderButton(page)).toBeDisabled();
  await captionsMode(page);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  await expect(checks(page)).not.toContainText('combined layout');
  await videoMode(page);
  const overlap = checks(page).locator('.export-check-item').filter({ hasText: 'combined layout' });
  await expect(overlap.getByRole('button', { name: 'Go to caption 1', exact: true })).toBeVisible();
  await overlap.getByRole('button', { name: 'Go to caption 2', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeVisible();
  await expect(page.locator('[data-caption-id="c2"]')).toHaveClass(/selected/);
  await page.getByLabel(/^Size /).fill('58');
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(checks(page)).toContainText('Full layout has not been checked');
  expect(state.jobs).toHaveLength(0);
});

test('successful checks become stale after caption and resolution edits', async ({ page }) => {
  await page.route('**/api/video-export/*/check-layout', (route) => route.fulfill({ json: passed }));
  await openExport(page);
  await page.getByRole('button', { name: 'Check layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout fits the checked frame');
  await page.getByLabel('Caption 1 text', { exact: true }).fill('New ខ្មែរ wording');
  await expect(checks(page)).toContainText('Layout changed — check again');
  await page.getByRole('button', { name: 'Recheck layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout fits the checked frame');
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await expect(checks(page)).toContainText('Layout changed — check again');
});

test('late native replies after edit or explicit cancellation cannot claim a clean result', async ({ page }) => {
  for (const cancel of [false, true]) {
    const entered = deferred(); const finish = deferred(); const settled = deferred();
    let requested = false;
    const handler = async (route: Route) => {
      requested = true;
      entered.resolve(); await finish.promise;
      try { await route.fulfill({ json: passed }); } catch { /* Aborted fetch may retire its route. */ }
      finally { settled.resolve(); }
    };
    await page.route('**/api/video-export/*/check-layout', handler);
    try {
      if (!cancel) await openExport(page);
      await checks(page).getByRole('button', { name: /^(Recheck|Check) layout$/ }).click();
      await entered.promise;
      await expect(checks(page)).toContainText('Checking all caption layouts');
      if (cancel) await page.getByRole('button', { name: 'Cancel check', exact: true }).click();
      else await page.getByLabel('Caption 1 text', { exact: true }).fill('Changed while checking');
      finish.resolve(); await settled.promise;
      await expect(checks(page)).not.toContainText('Layout fits the checked frame');
      await expect(checks(page).getByRole('button', { name: /^(Recheck|Check) layout$/ })).toBeEnabled();
      if (cancel) await expect(checks(page)).toContainText('Layout check cancelled');
    } finally { finish.resolve(); if (requested) await settled.promise; await page.unroute('**/api/video-export/*/check-layout', handler); }
  }
});

test('leaving Export cancels pending native work and new editor visits reset choices', async ({ page }) => {
  const entered = deferred(); const finish = deferred(); const settled = deferred();
  let requested = false;
  await page.route('**/api/video-export/*/check-layout', async (route) => {
    requested = true;
    entered.resolve(); await finish.promise;
    try { await route.fulfill({ json: blocked }); } catch { /* Request was cancelled on navigation. */ }
    finally { settled.resolve(); }
  });
  try {
    await openExport(page);
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    await page.getByRole('button', { name: 'Check layout', exact: true }).click();
    await entered.promise;
    await page.getByRole('button', { name: 'Edit appearance', exact: true }).click();
    finish.resolve(); await settled.promise;
    await page.getByRole('button', { name: 'Back to export', exact: true }).click();
    await expect(checks(page)).toContainText('Full layout has not been checked');
    await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('source');
    await expect(page.getByRole('region', { name: 'Export review', exact: true })).toHaveCount(0);
    await expect(checks(page)).not.toContainText('combined layout');
  } finally { finish.resolve(); if (requested) await settled.promise; }
});

test('a changed resolution during the prerequisite save cancels the old render request', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 120000;
  state.projects[0].captions = state.projects[0].captions.map((caption) => ({ ...caption, timingQuality: 'high', approved: true }));
  const entered = deferred(); const finish = deferred(); const settled = deferred();
  let calls = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    calls += 1; entered.resolve(); await finish.promise;
    state.projects[0].captions = route.request().postDataJSON().captions;
    try { await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } }); }
    finally { settled.resolve(); }
  });
  try {
    await openExport(page);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Edited');
    await renderButton(page).click();
    const confirm = page.getByRole('button', { name: 'Render anyway', exact: true });
    if (await confirm.isVisible()) await confirm.click();
    await entered.promise;
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    finish.resolve(); await settled.promise;
    await expect(renderButton(page)).toBeEnabled();
    expect(calls).toBeGreaterThan(0);
    expect(state.jobs).toHaveLength(0);
  } finally { finish.resolve(); }
});

test('format-specific blockers keep TTML available when SRT cannot preserve a blank line', async ({ page }) => {
  state.projects[0].captions[0].text = 'First\n\nsecond';
  await openExport(page); await captionsMode(page);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeDisabled();
  await expect(checks(page)).toContainText('blank line');
  await advancedFormats(page);
  await page.getByRole('button', { name: /^TTML/ }).click();
  await expect(page.getByRole('button', { name: 'Download TTML', exact: true })).toBeEnabled();
  await expect(checks(page)).not.toContainText('cannot safely preserve a blank line');
});

test('long issue lists have keyboard pagination and readable mobile touch controls', async ({ page }) => {
  state.native = true;
  state.projects[0].captions = Array.from({ length: 12 }, (_, index) => ({
    id: `many-${index}`, text: `ខ្មែរកម្ពុជា ${index + 1}`, startMs: index * 300, endMs: index * 300 + 250, timingQuality: 'low',
  }));
  state.projects[0].transcript!.tokens = [];
  await openExport(page); await captionsMode(page); await showIssues(page);
  await expect(checks(page).locator('.export-check-item')).toHaveCount(8);
  await page.getByRole('button', { name: 'Next issues', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Check before export' })).toBeFocused();
  await expect(checks(page).locator('.export-check-item')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Check before export' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/export-caption-repair-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const target = checks(page).getByRole('button', { name: 'Go to caption 10', exact: true });
  await target.scrollIntoViewIfNeeded();
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/export-caption-repair-mobile.png' });
  await target.click();
  await expect(page.getByLabel('Caption 10 text', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Back to export', exact: true })).toBeVisible();
});

test('caption-file duration blockers use the same recorded duration as the handoff serializer', async ({ page }) => {
  state.projects[0].transcript!.timing!.audioDurationMs = 2500;
  await openExport(page); await captionsMode(page);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeDisabled();
  const blocker = checks(page).locator('.export-check-item[data-severity="blocker"]');
  await expect(blocker).toContainText('ends after the supplied media duration');
  await expect(blocker.getByRole('button', { name: 'Go to caption 3', exact: true })).toBeVisible();
});
