import { test as base, expect, type Page } from '@playwright/test';
import type { AppProfile, VideoExportSettings } from '@kcs/shared';
import { appearance, cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let imports = 0;
const oldSettings: VideoExportSettings = { resolution: '720p', frameRate: 30, quality: 'recommended', codec: 'h264', encoder: 'software' };
const importedSettings: VideoExportSettings = { resolution: '2160p', frameRate: 60, quality: 'high', codec: 'h264', encoder: 'software' };
const timestamp = '2026-01-01T00:00:00.000Z';
type Surface = 'export' | 'appearance';
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); imports = 0;
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.videoExportPresets = [{ id: 'old-video', name: 'Old video preset', settings: { ...oldSettings }, createdAt: timestamp, updatedAt: timestamp }];
  state.profile.captionAppearances = [{ id: 'old-look', name: 'Old appearance preset', appearance: { ...appearance, fontSize1080: 44 }, createdAt: timestamp, updatedAt: timestamp }];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/profile/import', (route) => {
    imports++;
    const received: AppProfile = route.request().postDataJSON();
    state.profile = structuredClone(received);
    return route.fulfill({ json: received });
  });
});
function importedProfile(): AppProfile {
  return { ...structuredClone(state.profile),
    videoExportPresets: [{ id: 'imported-video', name: 'Imported video preset', settings: { ...importedSettings }, createdAt: timestamp, updatedAt: timestamp }],
    captionAppearances: [{ id: 'imported-look', name: 'Imported appearance preset', appearance: { ...appearance, fontSize1080: 88 }, createdAt: timestamp, updatedAt: timestamp }],
    lastVideoExportSettings: { ...importedSettings },
  };
}
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const picker = (page: Page, surface: Surface) => page.getByLabel(surface === 'export' ? 'Video export preset' : 'Preset', { exact: true });
const name = (page: Page, surface: Surface) => page.getByLabel(surface === 'export' ? 'Save video export preset as' : 'Save current appearance as', { exact: true });
async function openSurface(page: Page, surface: Surface) {
  await page.getByRole('button', { name: surface === 'export' ? 'Export' : 'Appearance', exact: true }).click();
  if (surface === 'export') {
    await expect(page.getByLabel('Resolution', { exact: true })).toBeVisible();
    await page.locator('.export-preset-tools > summary').click();
  } else {
    await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
    await expandAppearanceSection(page, 'presets');
    await page.locator('.appearance-preset-tools > summary').click();
  }
}
async function importWhileOpen(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Profile', exact: true }).click();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'studio-profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedProfile())) });
  await page.getByRole('button', { name: 'Replace profile', exact: true }).click();
  await expect(dialog.locator('.profile-import-feedback')).toContainText('Profile imported.');
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function refreshed(page: Page, surface: Surface) {
  await expect(picker(page, surface).locator(`option[value="${surface === 'export' ? 'imported-video' : 'imported-look'}"]`)).toHaveCount(1);
  await expect(picker(page, surface).locator(`option[value="${surface === 'export' ? 'old-video' : 'old-look'}"]`)).toHaveCount(0);
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('an imported Export catalog replaces missing IDs and Last used while keeping current settings and the name draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await openProject(page); await openSurface(page, 'export');
  await picker(page, 'export').selectOption('old-video');
  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Render with review warnings?' }).getByRole('button', { name: 'Render anyway', exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(1);
  const video = await page.locator('video').elementHandle();
  const captions = await page.locator('.caption-list').elementHandle();
  await name(page, 'export').fill('  Keep this export name  ');
  await importWhileOpen(page);
  await name(page, 'export').focus();
  await refreshed(page, 'export');
  await expect(name(page, 'export')).toBeFocused();
  await expect(name(page, 'export')).toHaveValue('  Keep this export name  ');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
  await expect(page.getByLabel('Frame rate', { exact: true })).toHaveValue('30');
  await expect(picker(page, 'export')).toHaveValue('');
  await expect(page.getByLabel('Manage video export preset', { exact: true })).toHaveValue('');
  await page.getByLabel('Manage video export preset', { exact: true }).selectOption('imported-video');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
  await name(page, 'export').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('export-imported-presets-390.png') });
  await picker(page, 'export').selectOption(':last-used');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
  await expect(page.getByLabel('Frame rate', { exact: true })).toHaveValue('60');
  expect(await video!.evaluate((node) => node === document.querySelector('video'))).toBe(true);
  expect(await captions!.evaluate((node) => node === document.querySelector('.caption-list'))).toBe(true);
  expect(imports).toBe(1);
});

test('Appearance refresh preserves current appearance, raw controls, name and Undo without rereading fonts', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const gate = deferred();
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET' || !imports) return route.fallback();
    const captured = structuredClone(state.profile);
    await gate.promise;
    return route.fulfill({ json: captured });
  });
  try {
    await openProject(page); await openSurface(page, 'appearance');
    const originalSize = state.projects[0].captionAppearance!.fontSize1080;
    await picker(page, 'appearance').selectOption('old-look');
    await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
    await name(page, 'appearance').fill('  Keep this appearance name  ');
    const fontReads = state.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/api/video-export/fonts')).length;
    await importWhileOpen(page);
    const exact = page.getByRole('spinbutton', { name: 'Exact size', exact: true });
    await exact.fill('8');
    gate.release();
    await refreshed(page, 'appearance');
    await expect(exact).toHaveValue('8'); await expect(exact).toBeFocused();
    await expect(picker(page, 'appearance')).toHaveValue('');
    await expect(name(page, 'appearance')).toHaveValue('  Keep this appearance name  ');
    expect(state.projects[0].captionAppearance!.fontSize1080).toBe(44);
    expect(state.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/api/video-export/fonts'))).toHaveLength(fontReads);
    await exact.press('Escape');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(originalSize);
    await picker(page, 'appearance').selectOption('imported-look');
    await expect(page.getByLabel(/^Size /)).toHaveValue('88');
    await name(page, 'appearance').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('appearance-imported-presets-1440.png') });
    expect(imports).toBe(1);
  } finally { gate.release(); }
});

for (const surface of ['export', 'appearance'] as const) test(`an older pending ${surface} preset read cannot undo an imported catalog`, async ({ page }) => {
  await openProject(page);
  const old = deferred();
  const oldFinished: Array<Promise<void>> = [];
  const stale = structuredClone(state.profile);
  let openingReads = 0; let postImportReads = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (imports === 0) {
      openingReads++;
      const finished = deferred(); oldFinished.push(finished.promise);
      await old.promise;
      try { await route.fulfill({ json: stale }); } finally { finished.release(); }
      return;
    }
    postImportReads++;
    if (surface === 'export' && postImportReads === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic post-import read failure' } });
    return route.fallback();
  });
  try {
    await openSurface(page, surface);
    await expect.poll(() => openingReads).toBeGreaterThan(0);
    await name(page, surface).fill('Pending read name draft');
    await importWhileOpen(page);
    if (surface === 'export') {
      await expect(page.getByRole('button', { name: 'Retry saved presets', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Retry saved presets', exact: true }).click();
    }
    await refreshed(page, surface);
    await name(page, surface).focus();
    old.release(); await Promise.all(oldFinished); await frames(page);
    await refreshed(page, surface);
    await expect(name(page, surface)).toHaveValue('Pending read name draft');
    await expect(name(page, surface)).toBeFocused();
    if (surface === 'export') {
      await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('source');
      await picker(page, surface).selectOption(':last-used');
      await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
    } else expect(state.projects[0].captionAppearance!.fontSize1080).toBe(appearance.fontSize1080);
  } finally { old.release(); await Promise.all(oldFinished); }
});

for (const surface of ['export', 'appearance'] as const) test(`a pre-import ${surface} preset mutation cannot republish its old catalog or leave saving stuck`, async ({ page }) => {
  const gate = deferred(); const finished = deferred();
  let writes = 0;
  await page.route(surface === 'export' ? '**/api/profile/video-export-presets' : '**/api/profile', async (route) => {
    const method = route.request().method();
    if (surface === 'export' ? method !== 'POST' : method !== 'PATCH') return route.fallback();
    if (surface === 'appearance') {
      const body: { captionAppearances?: AppProfile['captionAppearances'] } = route.request().postDataJSON();
      if (!body.captionAppearances) return route.fallback();
      writes++;
      if (writes !== 1) return route.fallback();
      state.profile = { ...state.profile, captionAppearances: structuredClone(body.captionAppearances) };
    } else {
      writes++;
      if (writes !== 1) return route.fallback();
      const body: { name: string; settings: VideoExportSettings } = route.request().postDataJSON();
      state.profile = { ...state.profile, videoExportPresets: [{ id: 'held-preset', name: body.name, settings: body.settings, createdAt: timestamp, updatedAt: timestamp }, ...(state.profile.videoExportPresets || [])] };
    }
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    try { await route.fulfill({ json: acknowledged }); } finally { finished.release(); }
  });
  try {
    await openProject(page); await openSurface(page, surface);
    await name(page, surface).fill('Pre-import pending save');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await name(page, surface).fill('Newer preset name');
    await importWhileOpen(page);
    await refreshed(page, surface);
    await name(page, surface).focus();
    gate.release(); await finished.promise;
    await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
    await expect(name(page, surface)).toHaveValue('Newer preset name');
    await expect(name(page, surface)).toBeFocused();
    await refreshed(page, surface);
    await expect(picker(page, surface).locator('option').filter({ hasText: 'Pre-import pending save' })).toHaveCount(0);
    await expect(page.locator(surface === 'export' ? '.export-preset-status' : '.appearance-preset-notice').filter({ hasText: 'Pre-import pending save' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect.poll(() => writes).toBe(2);
    await expect(page.locator(surface === 'export' ? '.export-preset-status' : '.appearance-preset-notice')).toContainText('Newer preset name');
  } finally { gate.release(); }
});
