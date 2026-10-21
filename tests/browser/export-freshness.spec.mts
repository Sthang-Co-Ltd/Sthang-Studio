import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis, type ExportEvidence, type ProcessingJob } from '../../packages/shared/src/index.js';
import { cleanFixtures, fixtureExportUrl, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let entries: ExportEvidence[];
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  entries = ['srt', 'video'].map((format) => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z', fingerprint: createHash('sha256').update(exportContentBasis(state.projects[0], format as any)).digest('hex') })) as ExportEvidence[];
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: entries }));
});

test('receipts match, become stale on edits, survive reload, and differ by format', async ({ page }, info) => {
  await openProject(page);
  await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('New Khmer wording ខ្មែរ');
  await expect(history.getByText(/Changed since export/)).toHaveCount(2);
  await expect(history.locator('summary')).toContainText('2 need updating');
  await page.screenshot({ path: info.outputPath('freshness-desktop.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].text).toBe('New Khmer wording ខ្មែរ');
  await page.reload(); await page.getByRole('button', { name: /Audit landscape/ }).click();
  await page.getByRole('button', { name: /^Export$/ }).click();
  await page.locator('.export-history summary').click();
  await expect(page.locator('.export-history').getByText(/Changed since export/)).toHaveCount(2);
});

test('unavailable history is unknown, retryable and does not block rendering', async ({ page }) => {
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic history unavailable' } }));
  await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history).toContainText('Freshness is unknown');
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: [] }));
  await history.getByRole('button', { name: 'Retry export history' }).click();
  await expect(history).toContainText('Earlier exports have unknown freshness');
});

test('caption-only freshness ignores an appearance edit while video freshness changes', async ({ page }, info) => {
  state.projects[0].captionAppearance!.textColor = '#FF0000';
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await expect(history.getByText(/Changed since export/)).toHaveCount(1);
  expect(await history.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('freshness-mobile.png') });
});

test('a delayed history response cannot publish into a different project', async ({ page }) => {
  let enter!: () => void; let release!: () => void; let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/caption-handoff/*/export-history', async (route) => {
    if (route.request().url().includes('/landscape/')) {
      enter(); await gate;
      await route.fulfill({ json: entries }).catch(() => {});
      finish();
    } else await route.fulfill({ json: [] });
  });
  try {
    await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click(); await entered;
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await page.getByRole('button', { name: /^Export$/ }).click();
    const history = page.locator('.export-history'); await history.locator('summary').click();
    await expect(history).toContainText('No recorded exports');
    release(); await finished;
    await expect(history.locator('li')).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  } finally { release(); }
});

test('Activity identifies exact old render content and keeps legacy video downloads available', async ({ page }) => {
  const resultExport = { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000, width: 640, height: 360,
    frameRate: 25, videoCodec: 'h264' as const, encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt: '2026-01-01T00:00:02Z' };
  const base: ProcessingJob = { id: 'receipt', type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape', status: 'completed',
    stage: 'complete', progress: 100, message: 'Ready', canResume: false, createdAt: resultExport.createdAt, updatedAt: resultExport.createdAt, resultExport };
  state.jobs = [{ ...base, exportContentFingerprint: entries.find((entry) => entry.format === 'video')!.fingerprint }, { ...base, id: 'legacy' }];
  state.projects[0].captions[0].text = 'New content after render';
  await openProject(page); await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(activity).toContainText('this video contains earlier content');
  await expect(activity).toContainText('this earlier export has no receipt');
  await expect(activity.getByRole('button', { name: 'Download video', exact: true })).toHaveCount(2);
});
