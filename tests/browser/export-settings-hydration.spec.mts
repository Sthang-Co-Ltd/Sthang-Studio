import { test as base, expect, type Page, type Route } from '@playwright/test';
import type { AppProfile, VideoExportSettings } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const lastUsed: VideoExportSettings = {
  resolution: '2160p', frameRate: 60, quality: 'high', codec: 'h264', encoder: 'software',
};
const explicit: VideoExportSettings = {
  resolution: '720p', frameRate: 30, quality: 'recommended', codec: 'h264', encoder: 'auto',
};
const renderButton = (page: Page) => page.getByRole('button', { name: 'Render captioned video', exact: true });
const checkLayout = (page: Page) => page.getByRole('button', { name: 'Check layout', exact: true });
const resolution = (page: Page) => page.getByLabel('Resolution', { exact: true });
const frameRate = (page: Page) => page.getByLabel('Frame rate', { exact: true });
const pendingSettings = (page: Page) => page.getByText('Loading saved video settings…', { exact: true });
const jobRequests = () => state.requests.filter((item) => item.method === 'POST' && item.path === '/api/video-export/landscape/jobs');

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Hold every Export profile GET, including StrictMode duplicate reads, while
 * ordinary project startup and video capability/appearance reads can complete. */
async function holdExportProfile(page: Page, snapshot: AppProfile) {
  const gate = deferred();
  const pending = new Set<Promise<void>>();
  let received = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    received += 1;
    const completion = (async () => {
      await gate.promise;
      try { await route.fulfill({ json: snapshot }); }
      catch (error) { if (!page.isClosed() && !route.request().failure()) throw error; }
    })();
    pending.add(completion);
    try { await completion; }
    finally { pending.delete(completion); }
  };
  await page.route('**/api/profile', handler);
  return {
    received: () => received,
    release: gate.release,
    dispose: async () => {
      gate.release();
      await Promise.all([...pending]);
      await page.unroute('**/api/profile', handler);
    },
  };
}

async function openReadyVideoExport(page: Page) {
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  await expect(resolution(page)).toBeVisible();
  await expect(page.locator('.export-check-save').filter({ hasText: 'Loading saved caption appearance' })).toHaveCount(0);
  await expect(page.getByText('Checking video export support…', { exact: true })).toHaveCount(0);
}

async function confirmRender(page: Page) {
  await renderButton(page).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Render with review warnings?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();
  await expect.poll(() => jobRequests().length).toBe(1);
}

test('initial Render waits for the saved Last used choice before submitting video settings', async ({ page }) => {
  await openProject(page);
  state.profile.lastVideoExportSettings = structuredClone(lastUsed);
  const held = await holdExportProfile(page, structuredClone(state.profile));
  try {
    await openReadyVideoExport(page);
    await expect.poll(held.received).toBeGreaterThan(0);
    await expect(pendingSettings(page)).toBeVisible();
    // Default choices are displayed while the saved profile request is in flight.
    // Rendering them now would silently ignore the creator's remembered choice.
    await expect(resolution(page)).toHaveValue('source');
    await expect(renderButton(page)).toBeDisabled();
    await expect(checkLayout(page)).toBeDisabled();
    expect(jobRequests()).toHaveLength(0);

    held.release();
    await expect(pendingSettings(page)).toHaveCount(0);
    await expect(resolution(page)).toHaveValue(lastUsed.resolution);
    await expect(frameRate(page)).toHaveValue(String(lastUsed.frameRate));
    await expect(renderButton(page)).toBeEnabled();
    await expect(checkLayout(page)).toBeEnabled();
    await confirmRender(page);
    expect(jobRequests()[0].body.settings).toEqual(lastUsed);
  } finally { await held.dispose(); }
});

test('explicit settings chosen while Last used is loading remain immediately renderable', async ({ page }) => {
  await openProject(page);
  state.profile.lastVideoExportSettings = structuredClone(lastUsed);
  const held = await holdExportProfile(page, structuredClone(state.profile));
  try {
    await openReadyVideoExport(page);
    await expect.poll(held.received).toBeGreaterThan(0);
    await expect(pendingSettings(page)).toBeVisible();
    await resolution(page).selectOption(explicit.resolution);
    await frameRate(page).selectOption(String(explicit.frameRate));
    // A deliberate creator choice hydrates this visit, even before the old GET.
    await expect(renderButton(page)).toBeEnabled();
    await expect(checkLayout(page)).toBeEnabled();
    await confirmRender(page);
    expect(jobRequests()[0].body.settings).toEqual(explicit);

    held.release();
    await expect(pendingSettings(page)).toHaveCount(0);
    await expect(resolution(page)).toHaveValue(explicit.resolution);
    await expect(frameRate(page)).toHaveValue(String(explicit.frameRate));
    expect(jobRequests()).toHaveLength(1);
  } finally { await held.dispose(); }
});

test('failed saved-settings read explains the limitation, allows current choices and can retry', async ({ page }) => {
  await openProject(page);
  state.profile.lastVideoExportSettings = structuredClone(lastUsed);
  let fail = true;
  await page.route('**/api/profile', (route) => route.request().method() === 'GET' && fail
    ? route.fulfill({ status: 503, json: { error: 'Synthetic saved settings read failure' } })
    : route.fallback());
  await openReadyVideoExport(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load saved video presets.' })).toBeVisible();
  await expect(renderButton(page)).toBeEnabled();
  await expect(checkLayout(page)).toBeEnabled();
  await expect(resolution(page)).toHaveValue('source');
  expect(jobRequests()).toHaveLength(0);

  fail = false;
  await page.getByRole('button', { name: 'Retry saved presets', exact: true }).click();
  await expect(pendingSettings(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveValue(lastUsed.resolution);
  await expect(frameRate(page)).toHaveValue(String(lastUsed.frameRate));
  await expect(renderButton(page)).toBeEnabled();
  expect(jobRequests()).toHaveLength(0);
});

test('caption-file layout uses source resolution without waiting for saved video settings', async ({ page }) => {
  await openProject(page);
  state.profile.lastVideoExportSettings = structuredClone(lastUsed);
  const held = await holdExportProfile(page, structuredClone(state.profile));
  const checkedResolutions: string[] = [];
  await page.route('**/api/video-export/landscape/check-layout', async (route) => {
    checkedResolutions.push(route.request().postDataJSON().resolution);
    await route.fulfill({ json: { status: 'passed', width: 640, height: 360, issues: [] } });
  });
  try {
    await openReadyVideoExport(page);
    await expect.poll(held.received).toBeGreaterThan(0);
    await expect(checkLayout(page)).toBeDisabled();
    await page.getByRole('group', { name: 'Export type' }).getByRole('button', { name: /Captions file/ }).click();
    await page.locator('.handoff-advanced > summary').click();
    await page.getByRole('group', { name: 'Advanced caption format' }).getByRole('button', { name: /^ASS\b/ }).click();
    await expect(checkLayout(page)).toBeEnabled();
    await checkLayout(page).click();
    await expect(page.getByText('Layout fits the checked frame', { exact: true })).toBeVisible();
    expect(checkedResolutions).toEqual(['source']);
    expect(jobRequests()).toHaveLength(0);
  } finally { await held.dispose(); }
});
