import { test as base, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis, type CaptionProject, type ProcessingJob } from '../../packages/shared/src/index.js';
import { cleanFixtures, fixtureExportUrl, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
const receipt = (project: CaptionProject, format: 'srt' | 'video') => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z',
  fingerprint: createHash('sha256').update(exportContentBasis(project, format)).digest('hex') });
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/caption-handoff/*/export-history', (route) => {
    const project = state.projects.find((item) => route.request().url().includes(`/${item.id}/`))!;
    return route.fulfill({ json: ['srt', 'video'].map((format) => receipt(project, format as 'srt' | 'video')) });
  });
  await page.addInitScript(() => {
    const native = crypto.subtle.digest.bind(crypto.subtle);
    const control = { fail: false, hold: false, calls: [] as string[], completed: 0, releases: [] as Array<() => void> };
    (window as any).__comparisonDigest = control;
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const content = JSON.parse(new TextDecoder().decode(data));
      control.calls.push(content.format);
      if (content.format === 'video' && control.fail) throw new Error('Synthetic comparison failure');
      if (content.format === 'video' && control.hold) await new Promise<void>((resolve) => control.releases.push(resolve));
      const result = await native(algorithm, data);
      control.completed++;
      return result;
    } });
  });
});

async function openHistory(page: Page) {
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  const history = page.locator('.export-history');
  await history.locator('summary').click();
  return history;
}
async function rememberNodes(page: Page) {
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__comparisonNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
}
async function expectNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__comparisonNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function releaseDigests(page: Page) {
  const before = await page.evaluate(() => {
    const control = (window as any).__comparisonDigest;
    const expected = control.completed + control.releases.length;
    control.hold = false;
    control.releases.splice(0).forEach((release: () => void) => release());
    return expected;
  });
  await expect.poll(() => page.evaluate(() => (window as any).__comparisonDigest.completed)).toBeGreaterThanOrEqual(before);
  // Let the released promise's React update commit before checking ownership.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('one failed format keeps successful comparisons and retries unchanged content once', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openProject(page);
  await rememberNodes(page);
  await page.evaluate(() => { (window as any).__comparisonDigest.fail = true; });
  const history = await openHistory(page);
  const srt = history.locator('li').filter({ has: page.getByText('SRT', { exact: true }) });
  const video = history.locator('li').filter({ has: page.getByText('Captioned video', { exact: true }) });
  await expect(srt).toContainText('Matches open project content.');
  await expect(video).toContainText('Freshness unknown');
  const retry = history.getByRole('button', { name: 'Retry comparison', exact: true });
  await expect(retry).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await retry.scrollIntoViewIfNeeded();
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 36);
    await page.screenshot({ path: info.outputPath('export-comparison-retry-' + width + '.png') });
  }
  const before = await page.evaluate(() => ({ srt: (window as any).__comparisonDigest.calls.filter((format: string) => format === 'srt').length,
    video: (window as any).__comparisonDigest.calls.filter((format: string) => format === 'video').length }));
  await page.evaluate(() => { const control = (window as any).__comparisonDigest; control.fail = false; control.hold = true; });
  try {
    await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(history.locator('summary')).toBeFocused();
    await expect(srt).toContainText('Matches open project content.');
    await expect(video).toContainText('Checking export content…');
    await expect.poll(() => page.evaluate(() => (window as any).__comparisonDigest.calls.filter((format: string) => format === 'video').length)).toBe(before.video + 1);
    expect(await page.evaluate(() => (window as any).__comparisonDigest.calls.filter((format: string) => format === 'srt').length)).toBe(before.srt);
    await releaseDigests(page);
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
    await expect(retry).toHaveCount(0);
    await expect(history.locator('summary')).toBeFocused();
    expect(await history.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('export-comparison-recovered-390.png') });
    await expectNodes(page);
  } finally { await releaseDigests(page); }
});

test('Activity reports a failed comparison honestly and retries without changing download or caption drafts', async ({ page }, info) => {
  const stamp = '2026-01-01T00:00:02Z';
  const job: ProcessingJob = { id: 'comparison-job', type: 'export-video', projectId: 'landscape', projectTitle: 'Receipt render', status: 'completed',
    stage: 'complete', progress: 100, message: 'Ready', canResume: false, createdAt: stamp, updatedAt: stamp,
    exportContentFingerprint: receipt(state.projects[0], 'video').fingerprint,
    resultExport: { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000, width: 640, height: 360,
      frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt: stamp } };
  state.jobs = [job];
  await openProject(page);
  await rememberNodes(page);
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic save remains unavailable' } }));
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unsaved wording កម្ពុជា');
  await page.evaluate(() => { (window as any).__comparisonDigest.fail = true; });
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  const label = activity.locator('.export-job-freshness');
  await expect(label).toContainText('Freshness unknown');
  const retry = activity.getByRole('button', { name: 'Retry comparison', exact: true });
  await expect(retry).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await retry.scrollIntoViewIfNeeded();
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 36);
    await page.screenshot({ path: info.outputPath('activity-comparison-retry-' + width + '.png') });
  }
  const before = await page.evaluate(() => (window as any).__comparisonDigest.calls.length);
  await page.evaluate(() => { const control = (window as any).__comparisonDigest; control.fail = false; control.hold = true; });
  try {
    await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(label).toBeFocused();
    await expect(label).toHaveText('Checking export content…');
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).__comparisonDigest.calls.length)).toBe(before + 1);
    await expect(activity.getByRole('button', { name: 'Download video', exact: true })).toBeEnabled();
    await releaseDigests(page);
    await expect(label).toContainText('Changed since export');
    await expect(retry).toHaveCount(0);
    await expect(label).toBeFocused();
    await activity.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Unsaved wording កម្ពុជា');
    expect(state.projects[0].captions[0].text).not.toBe('Unsaved wording កម្ពុជា');
    await expectNodes(page);
  } finally { await releaseDigests(page); }
});

test('a delayed hash cannot replace comparison of a newer unsaved caption draft', async ({ page }) => {
  await openProject(page);
  await rememberNodes(page);
  await page.evaluate(() => { (window as any).__comparisonDigest.hold = true; });
  const history = await openHistory(page);
  await expect.poll(() => page.evaluate(() => (window as any).__comparisonDigest.releases.length)).toBeGreaterThan(0);
  try {
    await page.evaluate(() => { (window as any).__comparisonDigest.hold = false; });
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer unsaved caption កម្ពុជា');
    await expect(history.getByText(/Changed since export/)).toHaveCount(2);
    await releaseDigests(page);
    await expect(history.getByText(/Changed since export/)).toHaveCount(2);
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Newer unsaved caption កម្ពុជា');
    await expectNodes(page);
  } finally { await releaseDigests(page); }
});

test('a delayed comparison from another project cannot publish into the current export history', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => { (window as any).__comparisonDigest.hold = true; });
  await openHistory(page);
  await expect.poll(() => page.evaluate(() => (window as any).__comparisonDigest.releases.length)).toBeGreaterThan(0);
  try {
    await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
    await page.evaluate(() => { (window as any).__comparisonDigest.hold = false; });
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.locator('.media-stage video')).toBeVisible();
    const history = await openHistory(page);
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
    await releaseDigests(page);
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
    await expect(history.getByText(/Changed since export/)).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  } finally { await releaseDigests(page); }
});
