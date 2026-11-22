import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { ProcessingJob, VideoExportSettings } from '@kcs/shared';
import { EXPORT_SESSION_PREFIX } from '../../apps/web/src/export-session-storage.js';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const resolution = (page: Page) => page.getByLabel('Resolution', { exact: true });
const rate = (page: Page) => page.getByLabel('Frame rate', { exact: true });
const bitrate = (page: Page) => page.getByLabel('Custom bitrate (Mbps)', { exact: true });
const video = (page: Page) => page.getByRole('group', { name: 'Export type' }).getByRole('button', { name: /Captioned video/ });
const captions = (page: Page) => page.getByRole('group', { name: 'Export type' }).getByRole('button', { name: /Captions file/ });
const preset = (page: Page) => page.getByLabel('Video export preset', { exact: true });
const destination = (page: Page) => page.getByLabel('Caption destination', { exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function rendered(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Export type' })).toBeVisible();
}
async function openRecent(page: Page, id = 'landscape') {
  await page.getByRole('region', { name: 'Recent projects', exact: true }).getByRole('button', { name: new RegExp(`Audit ${id}`) }).click();
  await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(new RegExp(`Audit ${id}`));
}
async function home(page: Page) {
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
}
async function openAdvanced(page: Page) {
  const details = page.locator('.export-advanced');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}
async function chooseVideo(page: Page, size = '720p', fps = '30') {
  await video(page).click(); await expect(resolution(page)).toBeVisible(); await expect(preset(page)).toBeEnabled();
  await resolution(page).selectOption(size); await rate(page).selectOption(fps);
  await page.getByRole('button', { name: 'High quality', exact: true }).click();
}
async function chooseCaptions(page: Page) {
  await captions(page).click(); await destination(page).selectOption('premiere');
  const details = page.locator('.handoff-advanced');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await page.getByRole('group', { name: 'Advanced caption format', exact: true }).getByRole('button', { name: /^WebVTT/ }).click();
}
async function captionChoices(page: Page) {
  await expect(captions(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(destination(page)).toHaveValue('premiere');
  await expect(page.locator('.handoff-advanced')).toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Download VTT', exact: true })).toBeVisible();
}
async function videoChoices(page: Page) {
  await video(page).click(); await expect(resolution(page)).toHaveValue('720p'); await expect(rate(page)).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'High quality', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.export-advanced')).toHaveAttribute('open', '');
  await expect(page.getByLabel('Encoder', { exact: true })).toHaveValue('software'); await expect(bitrate(page)).toHaveValue('11');
}
async function stored(page: Page, id = 'landscape') {
  return page.evaluate(({ prefix, id }) => localStorage.getItem(prefix + encodeURIComponent(id)), { prefix: EXPORT_SESSION_PREFIX, id });
}
function noAutomaticWork(states: FixtureState[]) {
  for (const fixture of states) {
    expect(fixture.jobs).toEqual([]);
    expect(fixture.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/api/profile'))).toEqual([]);
    expect(fixture.requests.filter((request) => request.method === 'POST' && /\/jobs(?:\/|$)/.test(request.path))).toEqual([]);
  }
}
async function otherTab(context: BrowserContext, width: number) {
  const other = await context.newPage(); await other.setViewportSize({ width, height: 1000 });
  await other.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await installFixture(other);
  fixture.projects = structuredClone(state.projects); fixture.profile = structuredClone(state.profile);
  await openProject(other); await openExport(other);
  return { page: other, fixture };
}

for (const width of [1440, 390]) test(`output and caption handoff choices survive Home, another project, reload and a new tab without automatic work at ${width}px`, async ({ page, context }, info) => {
  await page.setViewportSize({ width, height: 1000 }); const states = [state];
  await openProject(page); await openExport(page); await chooseVideo(page); await openAdvanced(page);
  await page.getByLabel('Encoder', { exact: true }).selectOption('software'); await bitrate(page).fill('11');
  await chooseCaptions(page); await captionChoices(page);
  const chosen = JSON.parse((await stored(page))!);
  expect(chosen.session).toMatchObject({ outputMode: 'captions', settings: { resolution: '720p', frameRate: 30, quality: 'high', encoder: 'software', customBitrateMbps: 11 },
    handoff: { destination: 'premiere', advancedFormat: 'vtt', advancedOpen: true } });
  await home(page); await openRecent(page, 'second'); await openExport(page);
  await expect(video(page)).toHaveAttribute('aria-pressed', 'true'); await expect(resolution(page)).toHaveValue('source');
  await home(page); await openRecent(page); await openExport(page); await captionChoices(page); await videoChoices(page); await captions(page).click();
  await page.reload(); await openRecent(page); await openExport(page); await captionChoices(page); await videoChoices(page); await captions(page).click();
  const next = await context.newPage(); await next.setViewportSize({ width, height: 1000 }); await next.emulateMedia({ reducedMotion: 'reduce' });
  const nextState = await installFixture(next); nextState.projects = structuredClone(state.projects); nextState.profile = structuredClone(state.profile); states.push(nextState);
  await openProject(next); await openExport(next); await captionChoices(next); await videoChoices(next);
  await page.close();
  await rate(next).focus();
  await next.screenshot({ path: info.outputPath(`remembered-export-choices-${width}.png`), animations: 'disabled' });
  expect(await next.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  noAutomaticWork(states);
});

for (const width of [1440, 390]) test(`unavailable optional storage explains the failure and preserves live output controls at ${width}px`, async ({ page }) => {
  const job: ProcessingJob = { id: 'other-export-result', type: 'transcribe', projectId: 'second', projectTitle: 'Audit second',
    status: 'completed', stage: 'complete', progress: 100, message: 'Other result ready', canResume: false,
    resultProjectId: 'second', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  state.jobs = [job];
  await page.setViewportSize({ width, height: 1000 }); await openProject(page); await openExport(page);
  await page.evaluate((prefix) => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix)) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  }, EXPORT_SESSION_PREFIX);
  await chooseVideo(page); await openAdvanced(page); await bitrate(page).fill('11');
  await expect(page.getByRole('status').filter({ hasText: 'These export choices could not be remembered in this browser.' })).toBeVisible();
  await expect(resolution(page)).toHaveValue('720p'); await expect(rate(page)).toHaveValue('30'); await expect(bitrate(page)).toHaveValue('11');
  await chooseCaptions(page); await captionChoices(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await openExport(page); await captionChoices(page);
  await video(page).click(); await expect(resolution(page)).toHaveValue('720p'); await expect(bitrate(page)).toHaveValue('11');
  await page.route('**/api/projects/second', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic project result read failure' } }));
  await page.getByLabel('Open project tools', { exact: true }).click(); await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await activity.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic project result read failure' })).toBeVisible();
  await activity.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit landscape/);
  await expect(resolution(page)).toHaveValue('720p'); await expect(rate(page)).toHaveValue('30'); await expect(bitrate(page)).toHaveValue('11');
  await captions(page).click(); await captionChoices(page); expect(await stored(page)).toBeNull();
  expect(state.jobs).toEqual([job]);
  expect(state.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/api/profile'))).toEqual([]);
  expect(state.requests.filter((request) => request.method === 'POST' && /\/jobs(?:\/|$)/.test(request.path))).toEqual([]);
});

test('preset name stays visible through an appearance repair and output switches for this visit only', async ({ page }) => {
  await openProject(page); await openExport(page); await chooseVideo(page);
  const manager = page.locator('.export-preset-tools > summary');
  const name = page.getByLabel('Save video export preset as', { exact: true });
  await manager.press('Enter'); await name.fill('Interview broadcast draft');
  await page.getByRole('button', { name: 'Edit appearance', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Back to export', exact: true }).press('Enter');
  await expect(name).toBeVisible(); await expect(name).toHaveValue('Interview broadcast draft');
  await captions(page).click(); await video(page).click();
  await expect(name).toBeVisible(); await expect(name).toHaveValue('Interview broadcast draft');
  expect(await stored(page)).not.toContain('Interview broadcast draft');
  await page.reload(); await openRecent(page); await openExport(page);
  await expect(name).toBeHidden(); await manager.press('Enter'); await expect(name).toHaveValue('');
  noAutomaticWork([state]);
});

test('a delayed profile read cannot replace choices persisted by another tab', async ({ page, context }) => {
  await openProject(page); const gate = deferred(); const entered = deferred();
  const lastUsed: VideoExportSettings = { resolution: '720p', frameRate: 25, quality: 'smaller', codec: 'h264', encoder: 'auto' };
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    entered.release(); await gate.promise; return route.fulfill({ json: { ...state.profile, lastVideoExportSettings: lastUsed } });
  });
  try {
    await openExport(page); await entered.promise; await expect(preset(page)).toBeDisabled();
    const other = await otherTab(context, 1440); await chooseVideo(other.page, '2160p', '60');
    const newer = await stored(other.page); expect(JSON.parse(newer!).session.settings.resolution).toBe('2160p');
    gate.release(); await expect(preset(page)).toBeEnabled(); await rendered(page);
    expect(await stored(page)).toBe(newer); await expect(resolution(other.page)).toHaveValue('2160p');
    noAutomaticWork([state, other.fixture]);
  } finally { gate.release(); }
});

test('a delayed preset save acknowledgement cannot replace another tab\'s newer persisted output choices', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openProject(page); await openExport(page); await chooseVideo(page);
  const gate = deferred(); let saves = 0;
  await page.route('**/api/profile/video-export-presets', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); saves++; await gate.promise;
    const saved = { id: 'deferred-session-preset', name: body.name, settings: body.settings, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    return route.fulfill({ json: { ...state.profile, videoExportPresets: [saved] } });
  });
  try {
    await page.locator('.export-preset-tools > summary').click();
    await page.getByLabel('Save video export preset as', { exact: true }).fill('Deferred session preset');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click(); await expect.poll(() => saves).toBe(1);
    const other = await otherTab(context, 390); await chooseVideo(other.page, '2160p', '60'); const newer = await stored(other.page);
    gate.release(); await expect(page.getByText('Saved video preset “Deferred session preset”.', { exact: true })).toBeVisible(); await rendered(page);
    expect(await stored(page)).toBe(newer); await expect(resolution(other.page)).toHaveValue('2160p');
    expect(state.jobs).toEqual([]); expect(other.fixture.jobs).toEqual([]); expect(saves).toBe(1);
  } finally { gate.release(); }
});

test('a delayed capability fallback keeps another tab\'s newer persisted output choices', async ({ page, context }) => {
  state.capabilities = { ...structuredClone(capabilities), encoders: [...capabilities.encoders,
    { id: 'nvidia', label: 'Synthetic HEVC GPU', codec: 'hevc', encoder: 'hevc_nvenc', hardware: true, available: true }] };
  await openProject(page); await openExport(page); await chooseVideo(page); await openAdvanced(page);
  await page.getByLabel('Codec', { exact: true }).selectOption('hevc'); await page.getByLabel('Encoder', { exact: true }).selectOption('nvidia');
  const gate = deferred(); let checks = 0;
  await page.route('**/api/video-export/landscape/capabilities*', async (route) => { checks++; await gate.promise; return route.fulfill({ json: capabilities }); });
  try {
    await page.getByRole('button', { name: 'Recheck video export support', exact: true }).click(); await expect.poll(() => checks).toBe(1);
    const other = await otherTab(context, 1440); await chooseVideo(other.page, '2160p', '60'); const newer = await stored(other.page);
    gate.release(); await expect(page.getByLabel('Codec', { exact: true })).toHaveValue('h264'); await rendered(page);
    expect(await stored(page)).toBe(newer); await expect(resolution(other.page)).toHaveValue('2160p');
    noAutomaticWork([state, other.fixture]);
  } finally { gate.release(); }
});

test('reopening replaced media ignores choices belonging to the previous source', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openProject(page); await openExport(page); await chooseVideo(page); await chooseCaptions(page);
  const oldRecord = await stored(page); expect(oldRecord).not.toBeNull();
  await home(page);
  state.projects[0] = { ...state.projects[0], media: { ...state.projects[0].media, filename: 'replacement.mp4', size: 6789, url: '/media/replacement.mp4' } };
  await openRecent(page); await openExport(page);
  await expect(video(page)).toHaveAttribute('aria-pressed', 'true'); await expect(resolution(page)).toHaveValue('source'); await expect(rate(page)).toHaveValue('source');
  await captions(page).click(); await expect(destination(page)).toHaveValue('capcut-desktop'); await expect(page.getByRole('button', { name: 'Download VTT', exact: true })).toHaveCount(0);
  noAutomaticWork([state]);
});

for (const width of [1440, 390]) test(`a clean stale tab cannot render captions it has not reviewed at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await openProject(page); await openExport(page); await chooseVideo(page);
  const oldText = await page.getByLabel('Caption 1 text', { exact: true }).inputValue();
  const oldMedia = structuredClone(state.projects[0].media); const oldAppearance = structuredClone(state.projects[0].captionAppearance);
  state.projects[0] = { ...state.projects[0], captions: state.projects[0].captions.map((caption, index) => index ? caption : { ...caption, text: 'Newer saved caption from another tab កម្ពុជា' }), updatedAt: '2026-03-01T00:00:00Z' };
  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  const confirmation = page.getByRole('alertdialog'); await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The saved captions changed while preparing export.' })).toBeVisible();
  const submitted = state.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/jobs'));
  expect(submitted).toHaveLength(1); expect(submitted[0].body.expectedContentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(state.jobs).toEqual([]); expect(state.profile.lastVideoExportSettings).toBeUndefined();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(oldText); await expect(resolution(page)).toHaveValue('720p');
  expect(state.projects[0].media).toEqual(oldMedia); expect(state.projects[0].captionAppearance).toEqual(oldAppearance);
  expect(state.requests.filter((request) => request.method === 'PUT' && request.path.startsWith('/api/projects/'))).toEqual([]);
});
