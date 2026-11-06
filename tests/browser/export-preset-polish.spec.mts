import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
const name = (page: Page) => page.getByLabel('Save video export preset as', { exact: true });
const notice = (page: Page) => page.locator('.export-preset-status').filter({ hasText: /(?:Saved|Updated) video preset/ });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function openPresets(page: Page) {
  await openProject(page); await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByLabel('Resolution', { exact: true })).toBeVisible();
  await page.getByText('Manage presets', { exact: true }).click();
}

test('video presets distinguish Save and Update and clear an old confirmation when the name changes', async ({ page }) => {
  await openPresets(page); await name(page).fill('My export');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(notice(page)).toHaveText('Saved video preset “My export”.');
  const id = state.profile.videoExportPresets![0].id;
  await name(page).fill('  MY EXPORT  ');
  await expect(notice(page)).toHaveCount(0);
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await page.getByRole('button', { name: 'Update preset', exact: true }).click();
  await expect(notice(page)).toHaveText('Updated video preset “MY EXPORT”.');
  expect(state.profile.videoExportPresets).toHaveLength(1);
  expect(state.profile.videoExportPresets![0]).toMatchObject({ id, settings: { resolution: '720p' } });
});

test('Retry saved presets preserves choices and a typed preset name through failed profile loading', async ({ page }, info) => {
  await openProject(page); let fail = true;
  await page.route('**/api/profile', (route) => route.request().method() === 'GET' && fail
    ? route.fulfill({ status: 503, json: { error: 'Synthetic preset read failure' } }) : route.fallback());
  state.profile.lastVideoExportSettings = { resolution: '2160p', frameRate: 30, quality: 'high', codec: 'h264', encoder: 'software' };
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByText('Manage presets', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved presets', exact: true })).toBeEnabled();
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await name(page).fill('My unsaved export');
  await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Retry saved presets', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('export-preset-retry-390.png') });
  fail = false; await page.getByRole('button', { name: 'Retry saved presets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
  await expect(name(page)).toHaveValue('My unsaved export');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
});

test('a pending video preset saves only the clicked settings and leaves newer form edits unconfirmed', async ({ page }) => {
  const gate = deferred(); let writes = 0;
  await page.route('**/api/profile/video-export-presets', async (route) => { writes++; await gate.promise; return route.fallback(); });
  try {
    await openPresets(page); await name(page).fill('Captured preset');
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    await page.getByRole('button', { name: 'Save preset', exact: true }).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
    await expect.poll(() => writes).toBe(1);
    await name(page).fill('Newer preset');
    await page.getByLabel('Resolution', { exact: true }).selectOption('2160p');
    gate.resolve();
    await expect.poll(() => state.profile.videoExportPresets?.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
    expect(state.profile.videoExportPresets![0]).toMatchObject({ name: 'Captured preset', settings: { resolution: '720p' } });
    await expect(name(page)).toHaveValue('Newer preset');
    await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByLabel('Video export preset', { exact: true })).toHaveValue('');
  } finally { gate.resolve(); }
});

for (const failure of ['request', 'missing acknowledgement'] as const) test(`video preset ${failure} retains its name and settings for retry`, async ({ page }) => {
  let fail = true;
  await page.route('**/api/profile/video-export-presets', (route) => fail ? route.fulfill(failure === 'request'
    ? { status: 503, json: { error: 'Synthetic preset write failure' } } : { json: state.profile }) : route.fallback());
  await openPresets(page); await name(page).fill('Keep this preset');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.locator('.export-preset-warning[role=alert]')).toBeVisible();
  await expect(name(page)).toHaveValue('Keep this preset'); await expect(notice(page)).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(notice(page)).toHaveText('Saved video preset “Keep this preset”.');
});

for (const action of ['save', 'delete'] as const) for (const render of ['accepted', 'cancelled'] as const) test(`a pending preset ${action} settles when a render is ${render} meanwhile`, async ({ page }) => {
  const gate = deferred(); let held = false;
  await openPresets(page); await name(page).fill('Concurrent preset');
  if (action === 'delete') {
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(notice(page)).toHaveText('Saved video preset “Concurrent preset”.');
  }
  await page.route('**/api/profile/video-export-presets**', async (route) => {
    if (route.request().method() !== (action === 'save' ? 'POST' : 'DELETE')) return route.fallback();
    held = true; await gate.promise; return route.fallback();
  });
  try {
    if (action === 'save') await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete preset', exact: true }).click();
    }
    await expect.poll(() => held).toBe(true);
    await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Render with review warnings?' });
    await expect(confirmation).toBeVisible();
    if (render === 'accepted') {
      await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();
      await expect.poll(() => state.jobs.length).toBe(1);
    } else {
      await confirmation.locator('.studio-confirm-cancel').click();
      await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
      expect(state.jobs).toHaveLength(0);
    }
    gate.resolve();
    await expect(page.locator('.export-preset-status').filter({ hasText: action === 'save' ? 'Saved video preset' : 'Deleted video preset' })).toContainText('Concurrent preset');
    expect(state.profile.videoExportPresets).toHaveLength(action === 'save' ? 1 : 0);
    await name(page).fill('Next preset');
    await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
  } finally { gate.resolve(); }
});
