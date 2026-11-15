import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, fixtureMedia, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const dropzone = (page: Page) => page.getByRole('button', { name: 'Choose a video or audio file', exact: true });

for (const width of [1440, 390]) test('Home distinguishes unavailable preferences from an actual upload at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const initial = deferred();
  const upload = deferred();
  let failPreferences = true;
  let uploads = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const fails = failPreferences;
    if (fails) await initial.promise;
    return route.fulfill(fails ? { status: 503, json: { error: 'Synthetic preference read failure' } } : { json: state.profile });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads++;
    await upload.promise;
    // This fixture proves that no project was created. A bare 503 instead leaves
    // the upload result uncertain and intentionally blocks another file selection.
    return route.fulfill({ status: 503, json: { error: 'Synthetic upload failure', code: 'PROJECT_CREATE_NOT_APPLIED' } });
  });
  try {
    await page.goto('/');
    const zone = dropzone(page);
    const feedback = page.locator('.upload-validation');
    const input = page.locator('.empty-stage input[type=file]');
    await expect(zone).toBeDisabled();
    await expect(zone.locator('strong')).toHaveText('Choose a video or audio file');
    await expect(zone).not.toHaveAttribute('aria-busy', 'true');
    await expect(feedback).toHaveText('Loading preferences before you can upload.');
    await expect(zone).toHaveAttribute('aria-describedby', await feedback.getAttribute('id') as string);
    await input.evaluate((node: HTMLInputElement) => {
      const files = new DataTransfer();
      files.items.add(new File(['Synthetic candidate'], 'blocked.mp4', { type: 'video/mp4' }));
      node.files = files.files;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(uploads).toBe(0);
    initial.release();
    await expect(feedback).toHaveText('Preferences could not load. Retry startup below to enable uploads.');
    await expect(zone).toBeDisabled();
    await expect(zone).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Retry startup', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('home-preferences-unavailable-' + width + '.png') });
    failPreferences = false;
    await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
    await expect(zone).toBeEnabled();
    await expect(feedback).toBeEmpty();
    expect(uploads).toBe(0);
    await input.setInputFiles({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
    await expect.poll(() => uploads).toBe(1);
    await expect(zone.locator('strong')).toHaveText('Uploading…');
    await expect(zone).toHaveAttribute('aria-busy', 'true');
    await expect(zone).toBeDisabled();
    upload.release();
    await expect(zone).toBeEnabled();
    await expect(zone).not.toHaveAttribute('aria-busy', 'true');
    await expect(zone.locator('strong')).toHaveText('Choose a video or audio file');
    await expect(page.getByRole('region', { name: 'Upload was not applied', exact: true }).getByRole('alert')).toContainText('Synthetic upload failure');
    expect(uploads).toBe(1);
  } finally { initial.release(); upload.release(); }
});

test('an unrelated running task does not claim that Home is uploading media', async ({ page }) => {
  const check = deferred();
  await page.route('**/api/system/doctor', async (route) => {
    await check.promise;
    return route.fulfill({ status: 503, json: { error: 'Synthetic system check failure' } });
  });
  try {
    await page.goto('/');
    await expect(dropzone(page)).toBeEnabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('button', { name: 'System check', exact: true }).click();
    await dialog.getByRole('button', { name: 'Run checks', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Running checks…', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(dropzone(page)).toBeDisabled();
    await expect(dropzone(page).locator('strong')).toHaveText('Choose a video or audio file');
    await expect(dropzone(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.upload-validation')).toHaveText('Wait for the current task to finish before uploading.');
    expect(state.requests.some((request) => request.path === '/api/projects' && request.method === 'POST')).toBe(false);
    check.release();
    await expect(dropzone(page)).toBeEnabled();
    await expect(page.locator('.upload-validation')).toBeEmpty();
  } finally { check.release(); }
});
