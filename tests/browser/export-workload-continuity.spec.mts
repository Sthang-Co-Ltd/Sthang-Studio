import { test as base, expect, type Page } from '@playwright/test';
import { capabilities, cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); await page.emulateMedia({ reducedMotion: 'reduce' }); });
const checks = (page: Page) => page.getByRole('region', { name: 'Check before export' });
const passed = { status: 'passed', width: 640, height: 360, issues: [] };
async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByLabel('Resolution', { exact: true })).toBeEnabled();
}

test('ordinary Appearance and Export returns reuse prerequisites after a font mutation while explicit support recheck stays fresh', async ({ page }) => {
  const fontReads: string[] = []; const supportReads: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const url = new URL(request.url());
    if (url.pathname === '/api/video-export/fonts') fontReads.push(url.search);
    if (url.pathname.endsWith('/capabilities')) supportReads.push(url.search);
  });
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.locator('.appearance-font-file-input').setInputFiles({ name: 'Synthetic.ttf', mimeType: 'font/ttf', buffer: Buffer.from('owned synthetic font') });
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Creator Khmer');
  state.capabilities = { ...structuredClone(capabilities), fonts: structuredClone(state.fonts) };
  await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe('Creator Khmer');
  await openExport(page);
  for (let trip = 0; trip < 2; trip++) {
    await page.getByRole('button', { name: 'Edit appearance', exact: true }).click();
    await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Creator Khmer');
    await page.getByRole('button', { name: 'Back to export', exact: true }).click();
    await expect(page.getByLabel('Resolution', { exact: true })).toBeEnabled();
  }
  // The source-browser harness runs Vite DEV. App's StrictMode replays each
  // mount effect, so three visits make three exact pairs of ordinary reads.
  // Server prerequisite coalescing is covered independently; no visit may force
  // a new machine scan merely because a font mutation happened earlier.
  const ordinaryReads = ['', '', '', '', '', ''];
  expect(fontReads).toEqual(ordinaryReads);
  expect(supportReads).toEqual(ordinaryReads);
  await page.getByRole('button', { name: 'Recheck video export support', exact: true }).click();
  await expect.poll(() => supportReads).toEqual([...ordinaryReads, '?refresh=1']);
  await expect(page.getByLabel('Resolution', { exact: true })).toBeEnabled();
});

for (const width of [1440, 390]) test(`500-caption layout findings survive repair returns and remain explicitly stale after edits at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  state.projects[0].captions.push(...Array.from({ length: 497 }, (_, index) => ({
    id: `bulk-${index}`, text: `ខ្មែរកម្ពុជា ${index + 4}`, startMs: 4000 + index * 1000, endMs: 4900 + index * 1000,
    approved: true, timingQuality: 'high' as const,
  })));
  let requests = 0;
  await page.route('**/api/video-export/*/check-layout', (route) => {
    requests++;
    return route.fulfill({ json: requests > 1 ? passed : { status: 'blocked', width: 640, height: 360, issues: [
      { code: 'caption-overflow', captionIds: ['c1', 'c2'], message: 'These captions overlap and their combined layout extends outside the frame.' },
      { code: 'caption-overflow', captionIds: ['bulk-496'], message: 'This caption extends outside the frame.' },
    ] } });
  });
  await openProject(page); await openExport(page);
  await checks(page).getByRole('button', { name: 'Check layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout needs attention');
  const native = checks(page).locator('.export-check-item').filter({ hasText: 'combined layout' });
  await native.getByRole('button', { name: 'Go to caption 2', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(checks(page)).toContainText('Layout needs attention');
  await expect(checks(page).getByRole('button', { name: 'Go to caption 500', exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await native.getByRole('button', { name: 'Go to caption 1', exact: true }).click();
  const size = page.getByLabel('Exact size', { exact: true });
  await size.fill('58'); await size.press('Enter');
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(checks(page)).toContainText('Layout changed — check again');
  await expect(checks(page)).toContainText('previous snapshot');
  const previous = checks(page).locator('.export-check-item').filter({ hasText: 'Previous layout finding' });
  await expect(previous).toHaveCount(2);
  for (const item of await previous.all()) await expect(item).toHaveAttribute('data-severity', 'advisory');
  const details = page.locator('.export-check-details');
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) await details.locator('summary').click();
  const last = previous.getByRole('button', { name: 'Go to caption 500', exact: true });
  await last.scrollIntoViewIfNeeded(); await expect(last).toBeVisible();
  if (width === 390) expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`retained-layout-findings-${width}.png`), animations: 'disabled' });
  expect(requests).toBe(1);
  await last.click();
  await expect(page.locator('[data-caption-id="bulk-496"]')).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await checks(page).getByRole('button', { name: 'Recheck layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout fits the checked frame');
  await expect(previous).toHaveCount(0); expect(requests).toBe(2);
});

test('support recheck invalidation survives an unchanged repair return and another media visit drops diagnostics', async ({ page }) => {
  await page.route('**/api/video-export/*/check-layout', (route) => route.fulfill({ json: passed }));
  await openProject(page); await openExport(page);
  await checks(page).getByRole('button', { name: 'Check layout', exact: true }).click();
  await expect(checks(page)).toContainText('Layout fits the checked frame');
  await page.getByRole('button', { name: 'Recheck video export support', exact: true }).click();
  await expect(checks(page)).toContainText('Layout changed — check again');
  await page.getByRole('button', { name: 'Edit appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await expect(checks(page)).toContainText('Layout changed — check again');
  await expect(checks(page)).not.toContainText('Layout fits the checked frame');
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click(); await openExport(page);
  await expect(checks(page)).toContainText('Full layout has not been checked');
});
