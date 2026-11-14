import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
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
async function appearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Exact size', { exact: true })).toBeEnabled();
}
async function changeSize(page: Page, value: number) {
  const size = page.getByLabel('Exact size', { exact: true });
  await size.fill(String(value));
  await size.press('Enter');
}
async function rememberEditor(page: Page) {
  await seek(page, 1200);
  await page.evaluate(() => { (window as any).__saveJourneyNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function unchangedEditor(page: Page, captions: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(captions);
  expect(await page.evaluate(() => (window as any).__saveJourneyNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.2, 1);
}

for (const width of [1440, 390]) test(`failed appearance remains protected across tool closure, navigation and retry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openProject(page); await appearance(page); await rememberEditor(page);
  const captions = structuredClone(state.projects[0].captions);
  state.appearanceFailure = true;
  await changeSize(page, 90);
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back to projects', exact: true });
  await back.focus(); await back.press('Enter');
  await expect(page.locator('main.workspace')).toBeVisible();
  await expect(page.locator('.save-action')).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: "Couldn't save changes" })).toBeVisible();
  await unchangedEditor(page, captions);
  await page.screenshot({ path: info.outputPath(`appearance-save-recovery-${width}.png`), animations: 'disabled' });
  state.appearanceFailure = false;
  await page.keyboard.press('Control+s');
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(90);
  await expect(page.locator('.save-action')).toBeDisabled();
  await unchangedEditor(page, captions);
  await back.click();
  await expect(page.locator('main.workspace')).toHaveCount(0);
  await page.getByRole('region', { name: 'Recent projects', exact: true }).getByRole('button', { name: /Audit landscape/ }).click();
  await appearance(page);
  await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('90');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: /Render captioned video/ })).toBeEnabled();
  expect(state.projects[0].captions).toEqual(captions);
});

test('a pending appearance save holds navigation and preserves a newer edit made while it settles', async ({ page }) => {
  await openProject(page); await appearance(page); await rememberEditor(page);
  const captions = structuredClone(state.projects[0].captions);
  const gate = deferred(); const finished = deferred();
  let writes = 0;
  await page.route('**/api/video-export/landscape/appearance', async (route) => {
    writes += 1;
    const body = route.request().postDataJSON();
    if (writes === 1) await gate.promise;
    try {
      state.projects[0].captionAppearance = body.appearance;
      await route.fulfill({ json: state.projects[0] });
    } finally { if (writes === 1) finished.release(); }
  });
  try {
    await changeSize(page, 81);
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.getByLabel('Exact size', { exact: true })).toBeVisible();
    await changeSize(page, 93);
    // Enter commits and intentionally blurs this number field. Resume editing
    // before the delayed response, so it must preserve the newer focus choice.
    await page.getByLabel('Exact size', { exact: true }).focus();
    gate.release(); await finished.promise;
    await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(93);
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('93');
    await expect(page.getByLabel('Exact size', { exact: true })).toBeFocused();
    await unchangedEditor(page, captions);
    await page.keyboard.press('Control+s');
    await expect(page.locator('.save-action')).toBeDisabled();
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.locator('main.workspace')).toHaveCount(0);
  } finally { gate.release(); }
});

test('reopening Appearance while an older save fails preserves the look edited during recovery', async ({ page }) => {
  await openProject(page); await appearance(page); await rememberEditor(page);
  const captions = structuredClone(state.projects[0].captions);
  const gate = deferred(); const finished = deferred();
  let writes = 0;
  await page.route('**/api/video-export/landscape/appearance', async (route) => {
    const request = ++writes;
    if (request === 1) {
      await gate.promise;
      try { await route.fulfill({ status: 503, json: { error: 'Synthetic old save failure' } }); }
      finally { finished.release(); }
    } else {
      state.projects[0].captionAppearance = route.request().postDataJSON().appearance;
      await route.fulfill({ json: state.projects[0] });
    }
  });
  try {
    await changeSize(page, 81); await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await appearance(page);
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('81');
    await changeSize(page, 96);
    await page.getByLabel('Exact size', { exact: true }).focus();
    gate.release(); await finished.promise;
    await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(96);
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('96');
    await expect(page.getByLabel('Exact size', { exact: true })).toBeFocused();
    await unchangedEditor(page, captions);
  } finally { gate.release(); }
});

test('a failed appearance is included in Download edits and protects the tab after its tool closes', async ({ page }) => {
  await openProject(page); await appearance(page);
  state.appearanceFailure = true;
  await changeSize(page, 94);
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download edits', exact: true }).click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  if (!stream) throw new Error('The owned draft download was unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const draft = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(draft.appearance.fontSize1080).toBe(94);
  expect(draft.projectId).toBe('landscape');
  expect(draft.captions.map((caption: { text: string }) => caption.text)).toEqual(state.projects[0].captions.map((caption) => caption.text));
  state.appearanceFailure = false;
  await page.keyboard.press('Control+s');
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(94);
  await expect(page.locator('.save-action-label')).toHaveText('Saved');
  await expect(page.locator('.save-action')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
});

test('editing back to an earlier look after reopening an external change still saves when the tool closes immediately', async ({ page }) => {
  await openProject(page); await appearance(page);
  await changeSize(page, 72);
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(72);
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  state.projects[0].captionAppearance = { ...state.projects[0].captionAppearance!, fontSize1080: 84 };
  await appearance(page);
  await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('84');
  await changeSize(page, 72);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(72);
  await appearance(page);
  await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('72');
});

test('a newer appearance edit cancels Home while an earlier caption save is draining', async ({ page }) => {
  await openProject(page);
  const gate = deferred(); const finished = deferred();
  let writes = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    writes++;
    await gate.promise;
    try {
      state.projects[0].captions = route.request().postDataJSON().captions;
      await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
    } finally { finished.release(); }
  });
  try {
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Caption saved before the newer appearance');
    await appearance(page);
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await changeSize(page, 92);
    await page.getByLabel('Exact size', { exact: true }).focus();
    gate.release(); await finished.promise;
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('92');
    await expect(page.getByLabel('Exact size', { exact: true })).toBeFocused();
    await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(92);
    await expect(page.locator('main.workspace')).toBeVisible();
    expect(state.projects[0].captions[0].text).toBe('Caption saved before the newer appearance');
  } finally { gate.release(); }
});

for (const width of [1440, 390]) test(`reopening a saved look after a read failure retries reading without writing at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openProject(page); await appearance(page);
  let writes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/video-export/landscape/appearance') && request.method() === 'PUT') writes++; });
  await changeSize(page, 79);
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(79);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  let failRead = true;
  await page.route('**/api/projects/landscape/appearance', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill(failRead ? { status: 503, json: { error: 'Synthetic saved look read failure' } } : { json: state.projects[0] });
  });
  await appearance(page);
  const recovery = page.getByRole('alert').filter({ hasText: 'Could not reload the saved appearance' });
  await expect(recovery).toBeVisible();
  await expect(page.locator('.appearance-save-state')).toContainText('Current look kept');
  await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('79');
  await expect(page.locator('.save-action')).toBeDisabled();
  await page.screenshot({ path: info.outputPath(`appearance-read-recovery-${width}.png`), animations: 'disabled' });
  failRead = false;
  const retry = recovery.getByRole('button', { name: 'Retry saved appearance', exact: true });
  await retry.focus(); await retry.press('Enter');
  await expect(recovery).toHaveCount(0);
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('79');
  await expect(page.locator('.appearance-save-state')).toBeFocused();
  expect(writes).toBe(1);
  expect(state.projects[0].captionAppearance?.fontSize1080).toBe(79);
});

test('a delayed saved-look retry preserves the newer appearance and focus chosen while reading', async ({ page }) => {
  await openProject(page); await appearance(page);
  await changeSize(page, 79);
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  const gate = deferred(); const finished = deferred();
  let hold = false; let reads = 0;
  await page.route('**/api/projects/landscape/appearance', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (!hold) return route.fulfill({ status: 503, json: { error: 'Synthetic saved look read failure' } });
    reads++;
    const previous = structuredClone(state.projects[0]);
    await gate.promise;
    try { await route.fulfill({ json: previous }); } finally { finished.release(); }
  });
  try {
    await appearance(page);
    await expect(page.getByRole('button', { name: 'Retry saved appearance', exact: true })).toBeVisible();
    hold = true;
    await page.getByRole('button', { name: 'Retry saved appearance', exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    await changeSize(page, 97);
    await page.getByLabel('Exact size', { exact: true }).focus();
    gate.release(); await finished.promise;
    await expect(page.getByLabel('Exact size', { exact: true })).toHaveValue('97');
    await expect(page.getByLabel('Exact size', { exact: true })).toBeFocused();
    await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(97);
    await expect(page.getByRole('button', { name: 'Retry saved appearance', exact: true })).toHaveCount(0);
  } finally { gate.release(); }
});
