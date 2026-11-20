import { test as base, expect, type Page, type Route } from '@playwright/test';
import { cleanFixtures, fixtureMedia, installFixture, prepareFixtures, project, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); state.projects = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const zone = (page: Page) => page.getByRole('button', { name: /^(Choose a video or audio file|Upload recovery in progress)$/ });
const input = (page: Page) => page.locator('.empty-stage input[type=file]');
const recovery = (page: Page) => page.locator('.upload-recovery');
const fileName = 'synthetic-local-recording-with-a-long-readable-name-for-upload-recovery.mp4';
const video = () => ({ name: fileName, mimeType: 'video/mp4', buffer: fixtureMedia() });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
interface Attempt { id: string; title: string; modified: string; filename: string }
function submitted(route: Route): Attempt {
  const bytes = route.request().postDataBuffer()!;
  expect(bytes.includes(fixtureMedia())).toBe(true);
  const body = bytes.toString('latin1');
  const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`).exec(body)?.[1] || '';
  const attempt = { id: field('creationAttemptId'), title: field('title'), modified: field('lastModified'), filename: /filename="([^"]+)"/.exec(body)?.[1] || '' };
  expect(attempt.id).toMatch(/^upload_[a-f0-9]{32}$/);
  expect(attempt.modified).toMatch(/^\d+$/);
  return attempt;
}
function publish(attempt: Attempt) {
  const saved = { ...project(attempt.id), title: attempt.title, transcript: null, captions: [], media: {
    ...project(attempt.id).media, originalName: attempt.filename,
  } };
  state.projects = [saved, ...state.projects.filter((item) => item.id !== saved.id)];
  return saved;
}
async function ready(page: Page) { await page.goto('/'); await expect(zone(page)).toBeEnabled(); }
async function opened(page: Page) {
  await expect(page.locator('.media-stage video')).toBeVisible();
  await expect(page.locator('.empty-stage')).toHaveCount(0);
}
async function readable(page: Page) {
  await recovery(page).scrollIntoViewIfNeeded();
  const bounds = await recovery(page).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth, overflow: node.scrollWidth > node.clientWidth + 1,
      actions: Array.from(node.querySelectorAll('button')).map((button) => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height }; }) };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.overflow).toBe(false);
  for (const action of bounds.actions) {
    expect(action.left).toBeGreaterThanOrEqual(0); expect(action.right).toBeLessThanOrEqual(bounds.viewport); expect(action.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [1440, 390]) test(`a lost acknowledgement finds only its exact saved upload and waits for deliberate Open at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const attempts: Attempt[] = [];
  const check = deferred(); let exactReads = 0; let completedChecks = 0;
  await page.route(/\/api\/projects\/upload_[a-f0-9]{32}(?:\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    exactReads++;
    if (exactReads > 1) { try { await check.promise; await route.fallback(); } finally { completedChecks++; } }
    else await route.fallback();
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const attempt = submitted(route); attempts.push(attempt); publish(attempt);
    await route.abort('failed'); // The project exists; only its HTTP acknowledgement is lost.
  });
  try {
    await ready(page); await zone(page).focus(); await input(page).setInputFiles(video());
    await expect(recovery(page)).toContainText('Saved upload found');
    await expect(recovery(page)).toContainText(fileName);
    await expect(recovery(page)).not.toContainText('This earlier upload may already be saved.');
    await expect(zone(page)).toHaveAccessibleName('Upload recovery in progress');
    await expect(zone(page)).not.toContainText('Or drag a file here.');
    const savedProject = recovery(page).getByRole('button').first();
    await expect(savedProject).toHaveAccessibleName('Open saved project');
    await expect(savedProject).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.media-stage video')).toHaveCount(0);
    await expect(zone(page)).toBeDisabled(); await expect(input(page)).toBeDisabled();
    await expect(zone(page)).toBeFocused();
    expect(attempts).toHaveLength(1); expect(state.projects).toHaveLength(1); expect(exactReads).toBe(1);
    const checkButton = page.getByRole('button', { name: 'Check saved upload', exact: true });
    await checkButton.click();
    await expect.poll(() => exactReads).toBe(2);
    const pending = page.getByRole('button', { name: 'Checking saved upload…', exact: true });
    await expect(pending).toBeDisabled(); await expect(pending).toBeFocused();
    await pending.press('Enter'); await pending.press('Space');
    expect(exactReads).toBe(2); expect(attempts).toHaveLength(1);
    check.release(); await expect(checkButton).toBeEnabled(); await expect(checkButton).toBeFocused();
    await readable(page);
    await page.screenshot({ path: info.outputPath(`upload-recovered-${width}.png`) });
    await savedProject.click(); await opened(page);
    expect(attempts).toHaveLength(1); expect(state.projects.map((item) => item.id)).toEqual([attempts[0].id]);
  } finally { check.release(); if (exactReads > 1) await expect.poll(() => completedChecks).toBeGreaterThanOrEqual(1); }
});

for (const width of [1440, 390]) test(`an unconfirmed missing result retries the captured File and token only on explicit action at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const attempts: Attempt[] = [];
  const retry = deferred(); let retryCompleted = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const attempt = submitted(route); attempts.push(attempt);
    if (attempts.length === 1) return route.abort('failed');
    // The original attempt finishes after its earlier missing-record check. The
    // explicit retry receives that same project's serialized duplicate receipt.
    const saved = publish(attempt);
    try { await retry.promise; await route.fulfill({ status: 200, json: { ...saved, creation: { attemptId: attempt.id, reused: true, orderSaved: true } } }); }
    finally { retryCompleted = true; }
  });
  try {
    await ready(page); await zone(page).focus(); await input(page).setInputFiles(video());
    await expect(recovery(page)).toContainText('Upload result unconfirmed');
    await expect(recovery(page)).toContainText('This earlier upload may already be saved.');
    expect(attempts).toHaveLength(1); expect(state.projects).toHaveLength(0);
    if (width === 390) {
      await page.getByRole('button', { name: 'All projects', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
      await expect(recovery(page)).toBeHidden();
      await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
      await expect(recovery(page)).toContainText('Upload result unconfirmed');
      await expect(recovery(page)).toContainText(fileName);
      await expect(zone(page)).toBeDisabled();
      expect(attempts).toHaveLength(1);
    }
    await page.getByRole('button', { name: 'Check saved upload', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved upload', exact: true })).toBeEnabled();
    expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry this upload', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2);
    await expect(zone(page)).toBeDisabled(); await expect(zone(page)).toBeFocused();
    await zone(page).press('Enter'); await zone(page).press('Space');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    retry.release(); await opened(page);
    expect(state.projects).toHaveLength(1); expect(state.projects[0].id).toBe(attempts[0].id);
  } finally { retry.release(); if (attempts.length > 1) await expect.poll(() => retryCompleted).toBe(true); }
});

test('a proven rejection allows the same attempt to retry and a deliberate new selection gets a new identity', async ({ page }) => {
  const attempts: Attempt[] = [];
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const attempt = submitted(route); attempts.push(attempt);
    if (attempts.length <= 2) return route.fulfill({ status: 503, json: { code: 'PROJECT_CREATE_NOT_APPLIED', error: 'Synthetic storage failure; the project was not created.' } });
    const saved = publish(attempt); await route.fulfill({ status: 201, json: { ...saved, creation: { attemptId: attempt.id, reused: false, orderSaved: true } } });
  });
  await ready(page); await input(page).setInputFiles(video());
  await expect(recovery(page)).toContainText('Upload was not applied'); await expect(zone(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Retry this upload', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2); await expect(recovery(page)).toContainText('Upload was not applied');
  expect(attempts[1]).toEqual(attempts[0]); expect(state.projects).toHaveLength(0);
  await page.getByRole('button', { name: 'Start another upload', exact: true }).click();
  await expect(zone(page)).toBeFocused(); await expect(recovery(page)).toHaveCount(0);
  await input(page).setInputFiles(video()); await opened(page);
  expect(attempts[2].id).not.toBe(attempts[0].id); expect(state.projects).toHaveLength(1);
});

test('a published upload with an unsaved project order still opens and reports the recoverable warning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  let uploads = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads++; const attempt = submitted(route); const saved = publish(attempt);
    await route.fulfill({ status: 201, json: { ...saved, creation: { attemptId: attempt.id, reused: false, orderSaved: false } } });
  });
  await ready(page); await input(page).setInputFiles(video()); await opened(page);
  await expect(page.locator('.toast')).toContainText(/order/i);
  expect(uploads).toBe(1); expect(state.projects).toHaveLength(1); await expect(recovery(page)).toHaveCount(0);
});
