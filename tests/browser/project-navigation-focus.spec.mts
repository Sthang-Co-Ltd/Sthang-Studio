import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const entry = (page: Page) => page.getByRole('button', { name: 'Project details', exact: true });
const recent = (page: Page, name = 'landscape') => page.getByRole('region', { name: 'Recent projects', exact: true })
  .getByRole('button', { name: new RegExp(`Audit ${name}`) });
const upload = (page: Page) => page.getByRole('button', { name: 'Choose a video or audio file', exact: true });
async function visibleFocus(target: Locator) {
  await expect(target).toBeFocused();
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1
      && rect.left >= 0 && rect.right <= innerWidth + 1 && (hit === node || Boolean(hit && node.contains(hit)));
  })).toBe(true);
}
async function openRecentWithKeyboard(page: Page, name = 'landscape') {
  await recent(page, name).focus();
  await recent(page, name).press('Enter');
  await expect(entry(page)).toBeVisible();
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const surface of ['Activity', 'Correction inbox'] as const) {
  test(`a blocked switch in ${surface} returns to a visible save action with the local draft intact`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const now = '2026-11-20T00:00:00.000Z';
    state.jobs = [{ id: 'ready', projectId: 'second', resultProjectId: 'second', projectTitle: 'Audit second',
      type: 'transcribe', status: 'completed', stage: 'complete', progress: 100, message: 'Captions ready.',
      canResume: false, createdAt: now, updatedAt: now, completedAt: now }];
    state.profile.correctionEvents = [{ id: 'correction', projectId: 'second', projectTitle: 'Audit second', captionId: 'c1',
      startMs: 500, endMs: 1000, originalText: 'ខ្មែរ', correctedText: 'ខ្មែរ corrected', suggestionKind: 'review',
      suggestedVocabularyLine: 'Khmer', status: 'ignored', createdAt: now }];
    await page.goto('/');
    await openRecentWithKeyboard(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue(state.projects[0].captions[0].text);
    if (surface === 'Activity') {
      await page.route('**/api/projects/landscape/captions', (route) => route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, json: { error: 'Could not save these captions.' } }) : route.fallback());
    } else {
      state.projects[0].captions[0].text = 'Newer externally saved text';
      state.projects[0].updatedAt = '2027-01-01T00:00:00.000Z';
    }
    const local = 'សេចក្ដីព្រាង · Local caption';
    await field.fill(local);
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: surface === 'Activity' ? /Processing jobs/ : /Correction inbox/ }).click();
    const dialog = page.getByRole('dialog', { name: surface, exact: true });
    const open = dialog.getByRole('button', { name: surface === 'Activity' ? 'Open result' : 'Review audio', exact: true });
    await open.focus();
    await open.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText(surface === 'Activity' ? 'could not be saved' : 'saved project changed');
    await expect(open).toBeFocused();
    await open.press('Tab');
    const back = dialog.getByRole('button', { name: 'Return to edits', exact: true });
    await visibleFocus(back);
    await back.press('Enter');
    const primary = page.getByRole('alert').getByRole('button', { name: surface === 'Activity' ? 'Retry save' : 'Reload saved project', exact: true });
    await visibleFocus(primary);
    await expect(field).toHaveValue(local);
    expect(state.requests.some((request) => request.method === 'GET' && request.path === '/api/projects/second')).toBe(false);
  });
}

for (const width of [1440, 390]) test(`Recent project entry and Back to Home provide visible keyboard destinations at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const before = JSON.stringify(state.projects);
  await page.goto('/'); await openRecentWithKeyboard(page);
  await visibleFocus(entry(page));
  await expect(entry(page)).toHaveAccessibleDescription(/Audit landscape/);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
  await page.screenshot({ path: info.outputPath(`project-entry-focus-${width}.png`) });
  await entry(page).press('Tab');
  await expect(page.locator('.stage-rail').getByRole('button', { name: /^Review/ })).toBeFocused();
  const back = page.getByRole('button', { name: 'Back to Home', exact: true });
  await back.focus(); await back.press('Enter');
  await expect(page.locator('main.workspace')).toHaveCount(0);
  await visibleFocus(upload(page));
  await expect(upload(page)).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`project-home-focus-${width}.png`) });
  expect(JSON.stringify(state.projects)).toBe(before);
  expect(state.requests.filter((request) => request.method !== 'GET'
    && !(request.method === 'POST' && request.path === '/api/video-export/landscape/preview'))).toEqual([]);
});

for (const width of [1440, 390]) test(`a failed library Open returns to its reenabled action and a successful retry enters the project at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const gate = deferred(); let reads = 0; let fail = true;
  await page.route('**/api/projects/landscape', async (route) => {
    reads++;
    if (fail) { await gate.promise; return route.fulfill({ status: 503, json: { error: 'Synthetic navigation read failure' } }); }
    return route.fulfill({ json: state.projects[0] });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    const open = page.getByRole('button', { name: 'Open Audit landscape', exact: true });
    await open.focus(); await open.press('Enter');
    await expect.poll(() => reads).toBe(1);
    await expect(open).toBeDisabled();
    gate.release();
    await expect(page.getByRole('alert')).toContainText('Synthetic navigation read failure');
    await expect(open).toBeEnabled(); await visibleFocus(open);
    fail = false;
    await open.press('Enter'); await visibleFocus(entry(page));
    await expect(entry(page)).toHaveAccessibleDescription(/Audit landscape/);
    const back = page.getByRole('button', { name: 'Back to Home', exact: true });
    await back.focus(); await back.press('Enter');
    await visibleFocus(open);
    await expect(page.getByRole('list', { name: 'Project results', exact: true }).getByRole('button')).toHaveCount(2);
    expect(reads).toBe(2);
  } finally { gate.release(); }
});

for (const foreground of ['Settings', 'Guide'] as const) test(`a delayed Open yields focus to a newer ${foreground} surface`, async ({ page }) => {
  const gate = deferred(); let entered = false;
  await page.route('**/api/projects/landscape', async (route) => {
    entered = true; await gate.promise; return route.fulfill({ json: state.projects[0] });
  });
  try {
    await page.goto('/');
    await recent(page).focus(); await recent(page).press('Enter');
    await expect.poll(() => entered).toBe(true);
    await page.getByRole('button', { name: foreground, exact: true }).click();
    const close = foreground === 'Settings'
      ? page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings', exact: true })
      : page.getByRole('complementary', { name: 'Sthang Studio guide', exact: true }).getByRole('button', { name: 'Close guide', exact: true });
    await expect(close).toBeFocused();
    gate.release();
    await expect(entry(page)).toBeVisible(); await rendered(page);
    await expect(close).toBeFocused();
    await expect(entry(page)).not.toBeFocused();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
  } finally { gate.release(); }
});

test('the first project focuses its named control and opens the guide on request', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('sthang:project-guide-seen:v1'));
  await openRecentWithKeyboard(page);
  const close = page.getByRole('complementary', { name: 'Sthang Studio guide', exact: true }).getByRole('button', { name: 'Close guide', exact: true });
  await visibleFocus(entry(page));
  await expect(entry(page)).toHaveAccessibleDescription(/Audit landscape/);
  await expect(close).toHaveCount(0);
  const tools = page.getByLabel('Open project tools', { exact: true });
  await tools.press('Enter');
  await page.getByRole('menuitem', { name: 'Guide', exact: true }).press('Enter');
  await expect(close).toBeFocused();
  await close.press('Escape');
  await expect(close).toHaveCount(0);
  await visibleFocus(tools);
});

test('a superseded Open cannot take focus or replace a newer project draft', async ({ page }) => {
  const gate = deferred(); let entered = false; let finished = false;
  await page.route('**/api/projects/landscape', async (route) => {
    entered = true;
    await gate.promise;
    try { await route.fulfill({ json: state.projects[0] }); }
    catch { /* The older navigation is deliberately aborted by the newer one. */ }
    finally { finished = true; }
  });
  try {
    await page.goto('/');
    await recent(page).focus(); await recent(page).press('Enter');
    await expect.poll(() => entered).toBe(true);
    await openRecentWithKeyboard(page, 'second');
    await expect(entry(page)).toBeFocused();
    await expect(entry(page)).toHaveAccessibleDescription(/Audit second/);
    const text = page.getByLabel('Caption 1 text', { exact: true });
    await text.fill('Newer project wording កម្ពុជា');
    await page.evaluate(() => { (window as any).__projectNavigationNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
    gate.release(); await expect.poll(() => finished).toBe(true); await rendered(page);
    await expect(text).toBeFocused(); await expect(text).toHaveValue('Newer project wording កម្ពុជា');
    await expect(entry(page)).toHaveAccessibleDescription(/Audit second/);
    expect(await page.evaluate(() => (window as any).__projectNavigationNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
    expect(state.projects[1].captions[0].text).not.toBe('Newer project wording កម្ពុជា');
  } finally { gate.release(); }
});

test('ordinary caption save acknowledgements never reuse a completed project-entry focus handoff', async ({ page }) => {
  await page.goto('/'); await openRecentWithKeyboard(page); await expect(entry(page)).toBeFocused();
  const gate = deferred(); let writes = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    writes++;
    const body = route.request().postDataJSON();
    await gate.promise;
    state.projects[0] = { ...state.projects[0], captions: body.captions };
    return route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  try {
    const first = page.getByLabel('Caption 1 text', { exact: true });
    const second = page.getByLabel('Caption 2 text', { exact: true });
    await first.fill('Saved wording after navigation កម្ពុជា'); await second.focus();
    await expect.poll(() => writes).toBe(1);
    const response = page.waitForResponse('**/api/projects/landscape/captions');
    gate.release(); await (await response).finished(); await rendered(page);
    await expect(second).toBeFocused();
    await expect(first).toHaveValue('Saved wording after navigation កម្ពុជា');
    await expect(entry(page)).not.toBeFocused();
    expect(writes).toBe(1);
  } finally { gate.release(); }
});
