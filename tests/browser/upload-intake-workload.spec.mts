import { test as base, expect, type Page, type Route } from '@playwright/test';
import { summarizeProject } from '@kcs/shared';
import { cleanFixtures, fixtureMedia, installFixture, prepareFixtures, project, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { UPLOAD_RECOVERY_PREFIX } from '../../apps/web/src/upload-recovery.js';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.projects = [project('second')];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const zone = (page: Page) => page.getByRole('button', { name: /^(Choose a video or audio file|Upload recovery in progress)$/ });
const input = (page: Page) => page.locator('.empty-stage input[type=file]');
const recovery = (page: Page) => page.locator('.upload-recovery');
const video = () => ({ name: 'bounded-import.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
const rejection = { error: 'This file is too large to import. Choose a video or audio file up to 500 MB.',
  code: 'PROJECT_CREATE_NOT_APPLIED', outcome: 'not-created', retryable: false };
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function attempt(route: Route) {
  const bytes = route.request().postDataBuffer();
  expect(bytes).not.toBeNull();
  expect(bytes!.includes(fixtureMedia())).toBe(true);
  const body = bytes!.toString('latin1');
  const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`).exec(body)?.[1] || '';
  const result = { id: field('creationAttemptId'), title: field('title'), modified: field('lastModified') };
  expect(result.id).toMatch(/^upload_[a-f0-9]{32}$/);
  return result;
}
function savedProject(id: string, title = 'Recovered original upload') {
  return { ...project(id), title, captions: [], transcript: null };
}
async function expectRecentProject(page: Page, id: string, title: string, status: string) {
  const card = page.locator(`button[data-recent-project="${id}"]`);
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await expect(card.locator('small')).toContainText(status);
}
async function ready(page: Page) {
  await page.goto('/');
  // This card proves startup collection publication has completed before the
  // later summary-only hold is installed.
  await expectRecentProject(page, 'second', 'Audit second', '3 captions');
  await expect(zone(page)).toBeEnabled();
}
async function openSaved(page: Page) {
  await page.getByRole('button', { name: 'Open saved project', exact: true }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await expect(page.locator('.empty-stage')).toHaveCount(0);
}

for (const width of [1440, 390]) test(`a definite size rejection explains the limit without a recovery lookup or same-file retry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  let posts = 0;
  let exactReads = 0;
  await page.route(/\/api\/projects\/upload_[a-f0-9]{32}(?:\?|$)/, async (route) => {
    if (route.request().method() === 'GET') exactReads++;
    return route.fallback();
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++; attempt(route);
    return route.fulfill({ status: 413, json: rejection });
  });
  await ready(page);
  await zone(page).focus();
  await input(page).setInputFiles(video());
  await expect(recovery(page)).toContainText('Upload was not applied');
  await expect(recovery(page)).toContainText(rejection.error);
  await expect(page.locator('.toast.error')).toHaveCount(0);
  await expect(recovery(page)).not.toContainText('Upload result unconfirmed');
  const retry = page.getByRole('button', { name: 'Retry this upload', exact: true });
  await expect(retry).toBeDisabled();
  await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(zone(page)).toBeEnabled();
  await expect(input(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check saved upload', exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
  expect(exactReads).toBe(0);
  expect(state.projects.map((item) => item.id)).toEqual(['second']);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);
  await recovery(page).scrollIntoViewIfNeeded();
  const bounds = await recovery(page).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, width: innerWidth, overflow: node.scrollWidth > node.clientWidth + 1,
      buttons: Array.from(node.querySelectorAll('button')).map((button) => button.getBoundingClientRect().height) };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.overflow).toBe(false);
  for (const height of bounds.buttons) expect(height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`upload-size-rejection-${width}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Start another upload', exact: true }).click();
  await expect(zone(page)).toBeFocused();
  await expect(recovery(page)).toHaveCount(0);
  expect(posts).toBe(1);
});

for (const width of [1440, 390]) test(`exact lost-ACK recovery and deliberate Open do not wait for unrelated summaries at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  let posts = 0;
  let exactReads = 0;
  let uploadedId = '';
  const gate = deferred();
  let summaryReads = 0;
  let summaryFinished = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++;
    const captured = attempt(route);
    uploadedId = captured.id;
    state.projects.unshift(savedProject(captured.id, captured.title));
    return route.abort('failed');
  });
  await page.route(/\/api\/projects\/upload_[a-f0-9]{32}(?:\?|$)/, async (route) => {
    if (route.request().method() === 'GET') exactReads++;
    return route.fallback();
  });
  await ready(page);
  const oldSummaries = state.projects.map(summarizeProject);
  await page.route('**/api/projects?summary=1', async (route) => {
    summaryReads++;
    if (summaryReads > 1) return route.fallback();
    try { await gate.promise; await route.fulfill({ json: oldSummaries }); }
    finally { summaryFinished = true; }
  });
  try {
    await zone(page).focus();
    await input(page).setInputFiles(video());
    await expect.poll(() => summaryReads).toBe(1);
    await expect(recovery(page)).toContainText('Saved upload found');
    await expect(page.getByRole('button', { name: 'Open saved project', exact: true })).toBeEnabled();
    expect(summaryFinished).toBe(false);
    expect(posts).toBe(1);
    expect(exactReads).toBe(1);
    const check = page.getByRole('button', { name: 'Check saved upload', exact: true });
    await check.focus();
    await check.press('Enter');
    await expect.poll(() => exactReads).toBe(2);
    await expect(check).toBeEnabled();
    await expect(check).toBeFocused();
    expect(summaryReads).toBe(1); // Existing collection request is reused.
    expect(summaryFinished).toBe(false);
    await openSaved(page);
    await expect(page.locator('video')).toHaveAttribute('src', `/media/${uploadedId}.mp4`);
    const mounted = await page.locator('video').elementHandle();
    gate.release();
    await expect.poll(() => summaryFinished).toBe(true);
    expect(await mounted!.evaluate((node) => node === document.querySelector('.media-stage video'))).toBe(true);
    await expect(page.locator('video')).toHaveAttribute('src', `/media/${uploadedId}.mp4`);
    expect(posts).toBe(1);
    await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
    await expectRecentProject(page, uploadedId, 'bounded-import', 'Not generated yet');
  } finally {
    gate.release();
    if (summaryReads) await expect.poll(() => summaryFinished).toBe(true);
  }
});

test('a restored exact check settles missing or found while summary refresh stays pending and stale cards cannot remove its receipt', async ({ page }) => {
  const id = `upload_${'a'.repeat(32)}`;
  const metadata = { version: 1, id, name: video().name, size: fixtureMedia().length,
    type: 'video/mp4', lastModified: 1767225600000, capturedAt: Date.now() };
  await page.addInitScript(({ prefix, metadata }) => localStorage.setItem(prefix + metadata.id, JSON.stringify(metadata)),
    { prefix: UPLOAD_RECOVERY_PREFIX, metadata });
  let posts = 0;
  let exactReads = 0;
  let summaryReads = 0;
  let summaryFinished = false;
  const gate = deferred();
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fallback();
  });
  await page.route(`**/api/projects/${id}`, async (route) => {
    if (route.request().method() === 'GET') exactReads++;
    return route.fallback();
  });
  await page.goto('/');
  await expectRecentProject(page, 'second', 'Audit second', '3 captions');
  const check = page.getByRole('button', { name: 'Check saved upload', exact: true });
  await expect(check).toBeEnabled();
  const oldSummaries = state.projects.map(summarizeProject);
  await page.route('**/api/projects?summary=1', async (route) => {
    summaryReads++;
    try { await gate.promise; await route.fulfill({ json: oldSummaries }); }
    finally { summaryFinished = true; }
  });
  try {
    await check.focus();
    await check.press('Enter');
    await expect.poll(() => summaryReads).toBe(1);
    await expect.poll(() => exactReads).toBe(1);
    await expect(check).toBeEnabled();
    await expect(check).toBeFocused();
    await expect(recovery(page)).toContainText('Upload result unconfirmed');
    await expect(page.getByRole('button', { name: 'Open saved project', exact: true })).toHaveCount(0);
    expect(summaryFinished).toBe(false);
    expect(posts).toBe(0);
    state.projects.unshift(savedProject(id));
    await check.press('Enter');
    await expect.poll(() => exactReads).toBe(2);
    await expect(recovery(page)).toContainText('Saved upload found');
    await expect(check).toBeEnabled();
    await expect(check).toBeFocused();
    expect(summaryReads).toBe(1);
    expect(summaryFinished).toBe(false);
    gate.release();
    await expect.poll(() => summaryFinished).toBe(true);
    await expectRecentProject(page, id, 'Recovered original upload', 'Not generated yet');
    await expect(page.locator('.media-stage video')).toHaveCount(0);
    expect(posts).toBe(0);
    expect(await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), UPLOAD_RECOVERY_PREFIX)).toEqual([UPLOAD_RECOVERY_PREFIX + id]);
  } finally {
    gate.release();
    if (summaryReads) await expect.poll(() => summaryFinished).toBe(true);
  }
});

test('a rejected retry cannot settle the earlier unknown upload and keeps its exact check with the rejected File blocked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const attempts: ReturnType<typeof attempt>[] = [];
  let exactReads = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts.push(attempt(route));
    if (attempts.length === 1) return route.abort('failed');
    return route.fulfill({ status: 413, json: rejection });
  });
  await page.route(/\/api\/projects\/upload_[a-f0-9]{32}(?:\?|$)/, async (route) => {
    if (route.request().method() === 'GET') exactReads++;
    return route.fallback();
  });
  await ready(page);
  await input(page).setInputFiles(video());
  await expect(recovery(page)).toContainText('Upload result unconfirmed');
  await page.getByRole('button', { name: 'Retry this upload', exact: true }).click();
  await expect(recovery(page)).toContainText('Upload result unconfirmed');
  await expect(recovery(page)).toContainText('This retry was not applied.');
  await expect(recovery(page)).toContainText(rejection.error);
  await expect(recovery(page)).not.toContainText('Upload was not applied');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const retry = page.getByRole('button', { name: 'Retry this upload', exact: true });
  await expect(retry).toBeDisabled();
  const check = page.getByRole('button', { name: 'Check saved upload', exact: true });
  await check.focus();
  await check.press('Enter');
  await expect.poll(() => exactReads).toBe(2);
  await expect(check).toBeEnabled();
  await expect(check).toBeFocused();
  await expect(recovery(page)).toContainText('Upload result unconfirmed');
  await expect(recovery(page)).toContainText(rejection.error);
  await expect(retry).toBeDisabled();
  await expect(zone(page)).toBeDisabled();
  state.projects.unshift(savedProject(attempts[0].id));
  await check.press('Enter');
  await expect(recovery(page)).toContainText('Saved upload found');
  await openSaved(page);
  expect(attempts).toHaveLength(2);
  expect(await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), UPLOAD_RECOVERY_PREFIX)).toEqual([]);
});
