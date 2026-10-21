import { test, expect, type Page, type Route } from '@playwright/test';
import type { AppProfile, VideoExportSettings } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

const lastUsedWrites = () => state.requests.filter((request) =>
  request.method === 'PUT' && request.path === '/api/profile/video-export-settings');
const presetSaves = () => state.requests.filter((request) =>
  request.method === 'POST' && request.path === '/api/profile/video-export-presets');

async function openExport(page: Page, project = 'landscape') {
  await openProject(page, project);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByLabel('Resolution', { exact: true })).toBeVisible();
}

async function setExportChoices(page: Page) {
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await page.getByLabel('Frame rate', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: 'High quality', exact: true }).click();
  const advanced = page.locator('.export-advanced');
  if (!(await advanced.evaluate((element: HTMLDetailsElement) => element.open))) await advanced.locator('summary').click();
  await page.getByLabel('Encoder', { exact: true }).selectOption('software');
  await page.getByLabel('Custom bitrate (Mbps)', { exact: true }).fill('11');
}

async function expectExportChoices(page: Page, settings: VideoExportSettings) {
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue(settings.resolution);
  await expect(page.getByLabel('Frame rate', { exact: true })).toHaveValue(String(settings.frameRate));
  await expect(page.getByRole('button', { name: 'High quality', exact: true })).toHaveAttribute('aria-pressed', settings.quality === 'high' ? 'true' : 'false');
  const advanced = page.locator('.export-advanced');
  if (!(await advanced.evaluate((element: HTMLDetailsElement) => element.open))) await advanced.locator('summary').click();
  await expect(page.getByLabel('Codec', { exact: true })).toHaveValue(settings.codec);
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue(settings.encoder);
  await expect(page.getByLabel('Custom bitrate (Mbps)', { exact: true })).toHaveValue(String(settings.customBitrateMbps ?? ''));
}

const chosen: VideoExportSettings = {
  resolution: '720p', frameRate: 30, quality: 'high', codec: 'h264', encoder: 'software', customBitrateMbps: 11,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function holdNextProfileRead(page: Page, snapshot: AppProfile) {
  const release = deferred();
  const settled = deferred();
  let intercepted = false;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET' || intercepted) return route.fallback();
    intercepted = true;
    await release.promise;
    try { await route.fulfill({ json: snapshot }); }
    catch (error) { if (!page.isClosed() && !route.request().failure()) throw error; }
    finally { settled.resolve(); }
  };
  await page.route('**/api/profile', handler);
  return {
    received: () => intercepted,
    release: release.resolve,
    settled: settled.promise,
    dispose: async () => {
      release.resolve();
      if (intercepted) await settled.promise;
      await page.unroute('**/api/profile', handler);
    },
  };
}

async function holdAllProfileReads(page: Page, snapshot: AppProfile) {
  const release = deferred();
  const inFlight = new Set<Promise<void>>();
  let intercepted = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    intercepted += 1;
    // StrictMode may issue more than one profile GET while Export mounts. Hold
    // every one so no younger response can accidentally satisfy hydration.
    const completion = (async () => {
      await release.promise;
      try { await route.fulfill({ json: snapshot }); }
      catch (error) { if (!page.isClosed() && !route.request().failure()) throw error; }
    })();
    inFlight.add(completion);
    try { await completion; }
    finally { inFlight.delete(completion); }
  };
  await page.route('**/api/profile', handler);
  return {
    received: () => intercepted > 0,
    release: release.resolve,
    settled: async () => { await Promise.all([...inFlight]); },
    dispose: async () => {
      release.resolve();
      await Promise.all([...inFlight]);
      await page.unroute('**/api/profile', handler);
    },
  };
}

test('last-used settings persist only after an accepted render and survive another project and reload', async ({ page }) => {
  await openExport(page);
  await setExportChoices(page);
  expect(lastUsedWrites()).toHaveLength(0);
  expect(state.profile.lastVideoExportSettings).toBeUndefined();

  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.locator('.studio-confirm-cancel').click();
  expect(state.jobs).toHaveLength(0);
  expect(lastUsedWrites()).toHaveLength(0);
  expect(state.profile.lastVideoExportSettings).toBeUndefined();

  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Render anyway' }).click();
  await expect.poll(() => state.jobs.length).toBe(1);
  expect(state.requests.find((request) => request.method === 'POST' && request.path === '/api/video-export/landscape/jobs')?.body.settings).toEqual(chosen);
  await expect.poll(() => state.profile.lastVideoExportSettings).toEqual(chosen);
  expect(lastUsedWrites()).toHaveLength(0);

  await page.getByRole('button', { name: /Back to projects/ }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expectExportChoices(page, chosen);

  await openExport(page);
  await expectExportChoices(page, chosen);
  expect(lastUsedWrites()).toHaveLength(0);
});

test('a named video preset can be saved, reused across projects, and deleted without changing last-used settings', async ({ page }) => {
  await openExport(page);
  await setExportChoices(page);
  await page.getByText('Manage presets', { exact: true }).click();
  const name = page.getByLabel('Save video export preset as', { exact: true });
  await name.fill('My 720p upload');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect.poll(() => state.profile.videoExportPresets?.length).toBe(1);
  const preset = state.profile.videoExportPresets![0];
  expect(preset.name).toBe('My 720p upload');
  expect(preset.settings).toEqual(chosen);
  expect(presetSaves()).toHaveLength(1);
  expect(lastUsedWrites()).toHaveLength(0);

  const picker = page.getByLabel('Video export preset', { exact: true });
  await expect(picker).toHaveValue(preset.id);
  // Recreate the app and its profile hydration, keeping only the mocked server's persisted profile.
  await page.reload();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(picker.locator(`option[value="${preset.id}"]`)).toHaveCount(1);
  await openExport(page, 'second');
  await expect(picker).toBeVisible();

  // Saved presets must be transferable choices, not implicit changes to this project's source or appearance.
  const originalSecond = structuredClone(state.projects[1]);
  await picker.selectOption(preset.id);
  await expectExportChoices(page, chosen);
  expect(state.projects[1]).toEqual(originalSecond);
  expect(lastUsedWrites()).toHaveLength(0);

  await page.getByRole('button', { name: 'Smaller file', exact: true }).click();
  await expect(picker).toHaveValue('');
  expect(state.profile.videoExportPresets![0].settings).toEqual(chosen);
  await picker.selectOption(preset.id);
  await expectExportChoices(page, chosen);

  await page.getByText('Manage presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await confirmation.locator('.studio-confirm-cancel').click();
  expect(state.profile.videoExportPresets?.map((item) => item.id)).toContain(preset.id);
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect.poll(() => state.profile.videoExportPresets?.length).toBe(0);
  await expect(picker).toHaveValue('');
  await expectExportChoices(page, chosen);
  expect(state.projects[1]).toEqual(originalSecond);
  expect(lastUsedWrites()).toHaveLength(0);
});

test('a late last-used profile read does not overwrite choices edited during hydration', async ({ page }) => {
  state.profile.lastVideoExportSettings = structuredClone(chosen);
  await openProject(page);
  const hold = await holdNextProfileRead(page, structuredClone(state.profile));
  try {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    const resolution = page.getByLabel('Resolution', { exact: true });
    await expect(resolution).toBeVisible();
    await resolution.selectOption('2160p');
    await page.getByLabel('Frame rate', { exact: true }).selectOption('60');
    hold.release();
    await hold.settled;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(resolution).toHaveValue('2160p');
    await expect(page.getByLabel('Frame rate', { exact: true })).toHaveValue('60');
    expect(lastUsedWrites()).toHaveLength(0);
  } finally {
    await hold.dispose();
  }
});

test('a late profile response from a previous project cannot reset the next project export', async ({ page }) => {
  state.profile.lastVideoExportSettings = structuredClone(chosen);
  await openProject(page);
  const hold = await holdNextProfileRead(page, structuredClone(state.profile));
  try {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    await page.getByRole('button', { name: /Back to projects/ }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expectExportChoices(page, chosen);
    await page.getByLabel('Resolution', { exact: true }).selectOption('2160p');
    hold.release();
    await hold.settled;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
    expect(lastUsedWrites()).toHaveLength(0);
  } finally {
    await hold.dispose();
  }
});

test('held profile read allows render admission and cannot replace a newer saved last-used setting', async ({ page }) => {
  const older: VideoExportSettings = {
    resolution: '2160p', frameRate: 60, quality: 'smaller', codec: 'h264', encoder: 'auto',
  };
  state.profile.lastVideoExportSettings = structuredClone(older);
  await openProject(page);
  const hold = await holdAllProfileReads(page, structuredClone(state.profile));
  try {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    await expect(page.getByText('Loading saved video settings…', { exact: true })).toBeVisible();
    await setExportChoices(page);

    const render = page.getByRole('button', { name: 'Render captioned video', exact: true });
    await expect(render).toBeEnabled();
    await render.click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();

    await expect.poll(() => state.jobs.length).toBe(1);
    expect(state.requests.find((request) => request.method === 'POST' && request.path === '/api/video-export/landscape/jobs')?.body.settings).toEqual(chosen);
    await expect.poll(() => state.profile.lastVideoExportSettings).toEqual(chosen);
    expect(lastUsedWrites()).toHaveLength(0);

    const picker = page.getByLabel('Video export preset', { exact: true });
    await expect(picker.locator('option[value=":last-used"]')).toHaveCount(1);
    await expect(page.getByText('Loading saved video settings…', { exact: true })).toBeVisible();
    hold.release();
    await hold.settled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(':last-used');
    await expectExportChoices(page, chosen);
    expect(state.profile.lastVideoExportSettings).toEqual(chosen);
  } finally {
    await hold.dispose();
  }
});

test('incompatible imported hardware preset remains available for confirmed deletion', async ({ page }) => {
  const stored: VideoExportSettings = { resolution: '720p', frameRate: 30, quality: 'high', codec: 'h264', encoder: 'nvidia' };
  state.profile.videoExportPresets = [{
    id: 'imported-hardware', name: 'Imported GPU preset', settings: structuredClone(stored),
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
  }];
  state.profile.lastVideoExportSettings = structuredClone(chosen);
  await openExport(page);
  const picker = page.getByLabel('Video export preset', { exact: true });
  await expect(picker.locator('option[value="imported-hardware"]')).toHaveCount(1);
  await picker.selectOption('imported-hardware');
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue('auto');
  await expect(page.getByText(/NVIDIA encoding is unavailable/)).toBeVisible();
  await expect(picker).toHaveValue('');
  await page.getByText('Manage presets', { exact: true }).click();
  const managed = page.getByLabel('Manage video export preset', { exact: true });
  await expect(managed).toHaveValue('imported-hardware');
  await expect(page.getByRole('button', { name: 'Delete preset', exact: true })).toBeVisible();
  expect(state.profile.videoExportPresets?.[0].settings).toEqual(stored);
  expect(state.profile.lastVideoExportSettings).toEqual(chosen);
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Imported GPU preset');
  await page.getByRole('alertdialog').locator('.studio-confirm-cancel').click();
  await expect(managed).toHaveValue('imported-hardware');
  expect(state.profile.videoExportPresets?.[0].settings).toEqual(stored);
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect.poll(() => state.profile.videoExportPresets?.length).toBe(0);
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('720p');
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue('auto');
  await expect(picker).toHaveValue('');
  expect(state.profile.lastVideoExportSettings).toEqual(chosen);
});

test('unavailable HEVC preset can be deleted at capacity and replaced without changing output or last-used choices', async ({ page }) => {
  const hevcSettings: VideoExportSettings = { resolution: '2160p', frameRate: 60, quality: 'high', codec: 'hevc', encoder: 'auto' };
  const ordinary: VideoExportSettings = { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' };
  const stamp = '2026-10-21T00:00:00.000Z';
  state.profile.videoExportPresets = [
    { id: 'legacy-hevc', name: 'Legacy HEVC', settings: structuredClone(hevcSettings), createdAt: stamp, updatedAt: stamp },
    ...Array.from({ length: 19 }, (_, index) => ({ id: `saved-${index}`, name: `Other preset ${index}`,
      settings: structuredClone(ordinary), createdAt: stamp, updatedAt: stamp })),
  ];
  state.profile.lastVideoExportSettings = structuredClone(chosen);
  await openExport(page);
  const picker = page.getByLabel('Video export preset', { exact: true });
  await picker.selectOption('legacy-hevc');
  await expect(page.getByLabel('Codec', { exact: true })).toHaveValue('h264');
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue('auto');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
  await expect(page.getByText(/HEVC is unavailable on this PC/)).toBeVisible();
  await expect(picker).toHaveValue('');
  expect(state.profile.videoExportPresets?.[0].settings).toEqual(hevcSettings);
  await page.getByText('Manage presets', { exact: true }).click();
  const managed = page.getByLabel('Manage video export preset', { exact: true });
  await expect(managed).toHaveValue('legacy-hevc');
  await managed.selectOption('saved-1');
  await expect(page.getByText('Delete saved preset:')).toContainText('Other preset 1');
  await managed.selectOption('legacy-hevc');
  await expect(page.getByText('Delete saved preset:')).toContainText('Legacy HEVC');

  const replacementName = page.getByLabel('Save video export preset as', { exact: true });
  await replacementName.fill('Replacement after deleting HEVC');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('You can save up to 20 video export presets');
  expect(state.profile.videoExportPresets?.length).toBe(20);
  expect(state.profile.videoExportPresets?.[0].settings).toEqual(hevcSettings);
  await page.setViewportSize({ width: 390, height: 844 });
  await managed.focus();
  await expect(managed).toBeFocused();
  expect((await managed.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('button', { name: 'Delete preset', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Legacy HEVC');
  await page.getByRole('alertdialog').locator('.studio-confirm-cancel').click();
  expect(state.profile.videoExportPresets?.length).toBe(20);
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect.poll(() => state.profile.videoExportPresets?.length).toBe(19);
  expect(state.profile.videoExportPresets?.some((preset) => preset.id === 'legacy-hevc')).toBe(false);
  await expect(picker).toHaveValue('');
  await expect(page.getByLabel('Codec', { exact: true })).toHaveValue('h264');
  await expect(page.getByLabel('Resolution', { exact: true })).toHaveValue('2160p');
  expect(state.profile.lastVideoExportSettings).toEqual(chosen);

  await replacementName.fill('Replacement after deleting HEVC');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect.poll(() => state.profile.videoExportPresets?.length).toBe(20);
  const replacement = state.profile.videoExportPresets?.find((preset) => preset.name === 'Replacement after deleting HEVC');
  expect(replacement).toBeDefined();
  expect(replacement?.settings).toEqual({ ...hevcSettings, codec: 'h264', encoder: 'auto' });
  expect(state.profile.videoExportPresets?.some((preset) => preset.id === 'legacy-hevc')).toBe(false);
  expect(state.profile.lastVideoExportSettings).toEqual(chosen);
});
