import { test as base, expect, type Page, type Route } from '@playwright/test';
import { normalizeCaptionAppearance, type CaptionAppearance } from '@kcs/shared';
import type { RecoveryDraft } from '../../apps/web/src/unfinished-edit-recovery.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { expectRecoveryOfferReachable } from './recovery-layout.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let writes: Array<{ appearance: CaptionAppearance; expectedAppearance: CaptionAppearance }>;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  writes = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/video-export/landscape/appearance') writes.push(request.postDataJSON());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const project = () => state.projects[0];
const notice = (page: Page) => page.locator('.unfinished-recovery');
const size = (page: Page) => page.getByLabel('Exact size', { exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function appearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(size(page)).toBeEnabled();
  await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
}
async function changeSize(page: Page, value: number) {
  await size(page).fill(String(value));
  await size(page).press('Enter');
}
async function copies(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('sthang-studio:unfinished-edits:'))
    .map((key) => ({ key, raw: localStorage.getItem(key)! }))
    .map((entry) => ({ ...entry, draft: JSON.parse(entry.raw) as RecoveryDraft })));
}
async function offeredCopy(page: Page, beforeReload: Awaited<ReturnType<typeof copies>>[number]) {
  const surviving = (await copies(page)).filter((entry) => entry.draft.projectId === beforeReload.draft.projectId
    && entry.draft.mediaKey === beforeReload.draft.mediaKey && entry.draft.appearance?.fontSize1080 === 94);
  expect(surviving).toHaveLength(1);
  const current = surviving[0];
  expect(current.draft.appearance).toEqual(beforeReload.draft.appearance);
  expect(current.draft.basis).toEqual(beforeReload.draft.basis);
  expect(current.draft.ownerId).toBe(beforeReload.draft.ownerId);
  // Unload may replace the immutable snapshot. Subsequent actions must use
  // the exact copy actually offered after reopening, with the same edits.
  return current;
}
async function failLook(page: Page, lostAcknowledgement = false) {
  await openProject(page);
  await appearance(page);
  const basis = normalizeCaptionAppearance(project().captionAppearance);
  if (lostAcknowledgement) {
    let first = true;
    await page.route('**/api/video-export/landscape/appearance', async (route) => {
      if (!first) return route.fallback();
      first = false;
      const body = route.request().postDataJSON();
      project().captionAppearance = body.appearance;
      return route.fulfill({ status: 503, json: { error: 'Synthetic response lost after saving the look' } });
    });
  } else state.appearanceFailure = true;
  await changeSize(page, 94);
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await expect.poll(async () => (await copies(page)).filter((entry) => entry.draft.appearance?.fontSize1080 === 94).length).toBe(1);
  const entry = (await copies(page)).find((item) => item.draft.appearance?.fontSize1080 === 94)!;
  expect(entry.draft.version).toBe(2);
  expect(Object.keys(entry.draft.basis)).toEqual(['appearance']);
  expect(entry.draft.captions).toBeUndefined();
  expect(entry.draft.accuracy).toBeUndefined();
  for (const cue of project().captions) expect(entry.raw).not.toContain(cue.text);
  expect(entry.draft.basis.appearance).toBe(JSON.stringify(basis));
  return entry;
}
async function reloadAndReopen(page: Page, name = 'landscape') {
  const accept = async (dialog: import('@playwright/test').Dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.getByRole('button', { name: new RegExp(`Audit ${name}`) }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);
  await expect(notice(page)).toBeVisible();
}
async function restoreWithKeyboard(page: Page) {
  const restore = notice(page).getByRole('button', { name: 'Restore draft', exact: true });
  await restore.focus();
  await restore.press('Enter');
}
async function visibleRecoveryOffer(page: Page, width: number) {
  await expectRecoveryOfferReachable(page, notice(page), width, notice(page).getByText('Caption appearance', { exact: true }));
}
async function rememberEditor(page: Page) {
  await seek(page, 1200);
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    video.playbackRate = 0.75;
    (window as any).__appearanceRecoveryNodes = [video, document.querySelector('.caption-list')];
  });
}
async function sameEditor(page: Page) {
  expect(await page.evaluate(() => (window as any).__appearanceRecoveryNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  const playback = await page.locator('video').evaluate((video: HTMLVideoElement) => ({ time: video.currentTime, rate: video.playbackRate, paused: video.paused }));
  expect(playback.time).toBeCloseTo(1.2, 1);
  expect(playback.rate).toBe(0.75);
  expect(playback.paused).toBe(true);
}
async function heldProjectRead(page: Page, id = 'landscape', appearanceOnly = false) {
  const gate = deferred(); const started = deferred(); const finished = deferred();
  let held = false;
  const route = async (route: Route) => {
    if (held || route.request().method() !== 'GET') return route.fallback();
    held = true;
    const snapshot = structuredClone(state.projects.find((item) => item.id === id)!);
    started.release();
    await gate.promise;
    try { await route.fulfill({ json: snapshot }); }
    catch (error) {
      if (!page.isClosed() && route.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error;
    }
    finally { finished.release(); }
  };
  await page.route(`**/api/projects/${id}${appearanceOnly ? '/appearance' : ''}`, route);
  return { started: started.promise, release: gate.release, finished: finished.promise };
}
function noCaptionMutation() {
  expect(state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/captions'))).toEqual([]);
  expect(state.profile.correctionEvents).toEqual([]);
  expect(state.requests.filter((request) => request.method === 'POST' && /\/api\/jobs\/(transcribe|regenerate|refine)/.test(request.path))).toEqual([]);
}

for (const width of [1440, 390]) test(`an appearance draft survives restart and restores into an already open saved form before ordinary editing and export at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const captions = structuredClone(project().captions);
  const preferences = structuredClone(state.profile.preferences);
  const basis = normalizeCaptionAppearance(project().captionAppearance);
  await failLook(page);
  state.appearanceFailure = false;
  const before = writes.length;
  await reloadAndReopen(page);
  expect(normalizeCaptionAppearance(project().captionAppearance)).toEqual(basis);
  await appearance(page);
  await expect(size(page)).toHaveValue(String(basis.fontSize1080));
  expect(writes).toHaveLength(before, 'offering and inspecting recovery never applies it');
  await rememberEditor(page);
  await visibleRecoveryOffer(page, width);
  await page.screenshot({ path: info.outputPath(`appearance-recovery-offer-${width}.png`), animations: 'disabled' });
  await page.clock.install();
  await restoreWithKeyboard(page);
  await page.clock.runFor(800);
  await expect(size(page)).toHaveValue('94');
  await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
  await expect(page.locator('[data-project-entry-focus]')).toBeFocused();
  await page.clock.runFor(100);
  await expect.poll(() => state.requests.filter((request) => request.path.endsWith('/preview')).at(-1)?.body.appearance.fontSize1080).toBe(94);
  await expect(page.locator('.native-caption-image')).toBeVisible();
  expect(writes.slice(before)).toHaveLength(1);
  expect(writes[before].expectedAppearance).toEqual(basis);
  await expect(notice(page)).toHaveCount(0);
  expect(await copies(page)).toEqual([]);
  await sameEditor(page);
  await size(page).focus();
  await expect(size(page)).toBeFocused();
  if (width === 390) {
    const group = page.locator('.appearance-number-control').filter({ has: size(page) });
    const slider = page.getByRole('slider', { name: 'Size slider', exact: true });
    for (const control of [group, slider]) await expect.poll(() => control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const points = [[rect.left + 4, rect.top + 4], [rect.right - 4, rect.top + 4],
        [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 4, rect.bottom - 4], [rect.right - 4, rect.bottom - 4]];
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1
        && rect.left >= 0 && rect.right <= innerWidth + 1 && points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y); return hit === node || Boolean(hit && node.contains(hit));
        });
    })).toBe(true);
  }
  await page.screenshot({ path: info.outputPath(`appearance-restored-form-${width}.png`), animations: 'disabled' });

  await page.getByLabel('Text color', { exact: true }).fill('#445566');
  await page.clock.runFor(800);
  await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
  await expect(size(page)).toHaveValue('94');
  expect(project().captionAppearance?.fontSize1080).toBe(94);
  expect(project().captionAppearance?.textColor).toBe('#445566');
  expect(writes.slice(before)).toHaveLength(2);
  expect(writes[before + 1].expectedAppearance.fontSize1080).toBe(94);
  await sameEditor(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.clock.runFor(100);
  const render = page.getByRole('button', { name: /Render captioned video/ });
  await expect(render).toBeEnabled();
  await render.click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Render anyway', exact: true }).click();
  await expect.poll(() => state.requests.find((request) => request.method === 'POST' && request.path.endsWith('/jobs'))?.body.appearance.textColor).toBe('#445566');
  const exportLook = state.requests.find((request) => request.method === 'POST' && request.path.endsWith('/jobs'))!.body.appearance;
  expect(exportLook.fontSize1080).toBe(94);
  expect(project().captions).toEqual(captions);
  expect(state.profile.preferences).toEqual(preferences);
  noCaptionMutation();
});

test('a saved look with a lost acknowledgement offers Download and Discard after restart without another appearance write', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await failLook(page, true);
  const before = writes.length;
  await reloadAndReopen(page);
  await expect(notice(page)).toContainText('already matches the saved project');
  await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await notice(page).getByRole('button', { name: 'Download draft', exact: true }).click();
  const stream = await (await downloaded).createReadStream();
  if (!stream) throw new Error('The owned recovery download was unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloadedDraft = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(downloadedDraft.appearance.fontSize1080).toBe(94);
  expect(Object.keys(downloadedDraft.basis)).toEqual(['appearance']);
  await page.screenshot({ path: info.outputPath('appearance-already-saved-390.png'), animations: 'disabled' });
  await notice(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await appearance(page);
  await expect(size(page)).toHaveValue('94');
  expect(writes).toHaveLength(before);
  expect(await copies(page)).toEqual([]);
  noCaptionMutation();
});

test('a delayed initial Appearance read cannot replace the explicitly restored form or queue another save', async ({ page }) => {
  await failLook(page);
  state.appearanceFailure = false;
  await reloadAndReopen(page);
  const before = writes.length;
  const held = await heldProjectRead(page, 'landscape', true);
  try {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await held.started;
    await restoreWithKeyboard(page);
    await expect(size(page)).toHaveValue('94');
    await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
    await size(page).focus();
    held.release(); await held.finished;
    await expect(size(page)).toHaveValue('94');
    await expect(size(page)).toBeFocused();
    await page.getByLabel('Text color', { exact: true }).fill('#112233');
    await expect.poll(() => project().captionAppearance?.textColor).toBe('#112233');
    expect(project().captionAppearance?.fontSize1080).toBe(94);
    expect(writes.slice(before).map((write) => write.appearance.fontSize1080)).toEqual([94, 94]);
    noCaptionMutation();
  } finally { held.release(); }
});

test('newer Appearance editing and focus supersede a delayed Restore check', async ({ page }) => {
  await failLook(page);
  state.appearanceFailure = false;
  await reloadAndReopen(page); await appearance(page);
  await rememberEditor(page);
  const before = writes.length;
  const held = await heldProjectRead(page);
  try {
    await restoreWithKeyboard(page); await held.started;
    await changeSize(page, 97); await size(page).focus();
    held.release(); await held.finished;
    await expect(page.getByText('Newer edits are still here. Save them before restoring this draft.', { exact: true })).toBeVisible();
    await expect(size(page)).toHaveValue('97'); await expect(size(page)).toBeFocused();
    await expect.poll(() => project().captionAppearance?.fontSize1080).toBe(97);
    expect(writes.slice(before).map((write) => write.appearance.fontSize1080)).toEqual([97]);
    expect((await copies(page)).some((entry) => entry.draft.appearance?.fontSize1080 === 94)).toBe(true);
    await sameEditor(page); noCaptionMutation();
  } finally { held.release(); }
});

test('an exact recovery copy discarded in another tab cannot be restored after its held canonical read', async ({ page }) => {
  const beforeReload = await failLook(page);
  state.appearanceFailure = false;
  await reloadAndReopen(page); await rememberEditor(page);
  const original = await offeredCopy(page, beforeReload);
  const before = writes.length;
  const held = await heldProjectRead(page);
  try {
    await restoreWithKeyboard(page); await held.started;
    await page.evaluate(({ key, raw }) => {
      localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue: raw, newValue: null, storageArea: localStorage, url: location.href }));
    }, original);
    held.release(); await held.finished;
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByText('That recovery copy was removed or changed. Your current project is kept.', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(before);
    expect(project().captionAppearance?.fontSize1080).not.toBe(94);
    await sameEditor(page); noCaptionMutation();
  } finally { held.release(); }
});

test('Cancel check leaves an appearance recovery intact and permits a later deliberate Restore', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const beforeReload = await failLook(page);
  state.appearanceFailure = false;
  await reloadAndReopen(page); await rememberEditor(page);
  const original = await offeredCopy(page, beforeReload);
  const before = writes.length;
  const held = await heldProjectRead(page);
  try {
    await restoreWithKeyboard(page); await held.started;
    const cancel = notice(page).getByRole('button', { name: 'Cancel check', exact: true });
    await cancel.focus(); await cancel.press('Enter');
    const restore = notice(page).getByRole('button', { name: 'Restore draft', exact: true });
    await expect(restore).toBeEnabled(); await expect(restore).toBeFocused();
    expect(writes).toHaveLength(before);
    expect((await copies(page)).some((entry) => entry.key === original.key && entry.raw === original.raw)).toBe(true);
    await sameEditor(page);
    await restore.press('Enter');
    await expect.poll(() => project().captionAppearance?.fontSize1080).toBe(94);
    held.release(); await held.finished;
    await expect(size(page)).toHaveValue('94');
    expect(writes.slice(before)).toHaveLength(1);
    noCaptionMutation();
  } finally { held.release(); }
});

test('leaving a hung Restore releases the next project recovery and its late completion cannot settle that newer check', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await failLook(page);
  state.appearanceFailure = false;
  await reloadAndReopen(page);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await appearance(page);
  state.appearanceFailure = true;
  await changeSize(page, 91);
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await expect.poll(async () => (await copies(page)).some((entry) => entry.draft.projectId === 'second' && entry.draft.appearance?.fontSize1080 === 91)).toBe(true);
  state.appearanceFailure = false;
  await reloadAndReopen(page, 'second');
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(notice(page)).toBeVisible();

  const appearanceWrites = () => state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/appearance'));
  const before = appearanceWrites().length;
  const first = await heldProjectRead(page);
  let second: Awaited<ReturnType<typeof heldProjectRead>> | undefined;
  try {
    await restoreWithKeyboard(page); await first.started;
    await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(notice(page)).toBeVisible();
    for (const name of ['Restore draft', 'Download draft', 'Discard draft']) {
      await expect(notice(page).getByRole('button', { name, exact: true })).toBeEnabled();
    }
    await rememberEditor(page);
    second = await heldProjectRead(page, 'second');
    await restoreWithKeyboard(page); await second.started;
    await expect(notice(page).getByRole('button', { name: 'Checking draft…', exact: true })).toBeDisabled();
    await page.locator('video').focus();
    first.release(); await first.finished;
    await expect(notice(page).getByRole('button', { name: 'Checking draft…', exact: true })).toBeDisabled();
    await expect(notice(page).getByRole('button', { name: 'Cancel check', exact: true })).toBeEnabled();
    await expect(notice(page).getByRole('button', { name: 'Download draft', exact: true })).toBeDisabled();
    await expect(notice(page).getByRole('button', { name: 'Discard draft', exact: true })).toBeDisabled();
    await expect(page.locator('video')).toBeFocused();
    expect(appearanceWrites()).toHaveLength(before);
    await sameEditor(page);

    second.release(); await second.finished;
    await expect(size(page)).toHaveValue('91');
    await expect(page.locator('.appearance-save-state')).toContainText('Saved automatically');
    await expect(page.locator('video')).toBeFocused();
    expect(appearanceWrites().slice(before).map((request) => request.path)).toEqual(['/api/video-export/second/appearance']);
    expect(project().captionAppearance?.fontSize1080).not.toBe(94);
    expect(state.projects[1].captionAppearance?.fontSize1080).toBe(91);
    await sameEditor(page); noCaptionMutation();
  } finally { first.release(); second?.release(); }
});

for (const conflict of ['saved look', 'media'] as const) test(`a changed ${conflict} after restart keeps the recovery downloadable and refuses automatic application`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const beforeReload = await failLook(page);
  state.appearanceFailure = false;
  if (conflict === 'saved look') project().captionAppearance = { ...project().captionAppearance!, fontSize1080: 81 };
  else project().media = { ...project().media, filename: 'replacement.mp4', url: '/media/replacement.mp4', size: 6000 };
  const before = writes.length;
  await reloadAndReopen(page);
  const original = await offeredCopy(page, beforeReload);
  await expect(notice(page)).toContainText(conflict === 'media' ? 'different media' : 'saved project has changed');
  await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
  await expect(notice(page).getByRole('button', { name: 'Download draft', exact: true })).toBeEnabled();
  await expect(notice(page).getByRole('button', { name: 'Discard draft', exact: true })).toBeEnabled();
  await appearance(page);
  await expect(size(page)).toHaveValue(conflict === 'saved look' ? '81' : '56');
  expect(writes).toHaveLength(before);
  expect((await copies(page)).some((entry) => entry.key === original.key && entry.raw === original.raw)).toBe(true);
  noCaptionMutation();
});
