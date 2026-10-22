import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createCaptionData, exportContentBasis, hydrateCaptionWordTimings, serializeCaptionFile } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  const entries = ['srt', 'video'].map((format) => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z',
    fingerprint: createHash('sha256').update(exportContentBasis(state.projects[0], format as 'srt' | 'video')).digest('hex') }));
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: entries }));
  await page.route('**/api/caption-handoff/*/summary', (route) => route.fulfill({ json: {
    revision: 'a'.repeat(64), captionCount: state.projects[0].captions.length,
    snapshot: createCaptionData({ captions: hydrateCaptionWordTimings(state.projects[0]).captions, appearance: state.projects[0].captionAppearance, durationMs: 4000 }),
    media: { filename: state.projects[0].media.filename, size: state.projects[0].media.size },
  } }));
  await page.route('**/api/caption-handoff/*/export', async (route) => {
    const format = route.request().postDataJSON().format as 'srt' | 'vtt';
    const result = serializeCaptionFile({ captions: state.projects[0].captions }, format);
    await route.fulfill({ contentType: result.mimeType, headers: { 'Content-Disposition': `attachment; filename="captions${result.extension}"` }, body: result.text });
  });
});

for (const format of ['srt', 'vtt'] as const) test(`plain ${format.toUpperCase()} keeps downloads and history appearance recovery after a failed read`, async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByLabel(/^Size /).fill('90');
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  let failReads = true;
  await page.route('**/api/projects/landscape', (route) => {
    if (failReads) return route.fulfill({ status: 503, json: { error: 'Synthetic comparison read failure' } });
    return route.fulfill({ json: state.projects[0] });
  });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Captions file/ }).click();
  if (format === 'vtt') {
    await page.locator('.handoff-advanced summary').click();
    await page.getByRole('button', { name: /^WebVTT/ }).click();
  }
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(1);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  failReads = false;
  const download = page.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true });
  await expect(download).toBeEnabled();
  const downloaded = page.waitForEvent('download'); await download.click();
  expect((await downloaded).suggestedFilename()).toBe(`captions.${format}`);
  const retry = history.getByRole('button', { name: 'Retry appearance comparison', exact: true });
  await expect(retry).toBeVisible();
  await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
  await expect(history.getByText(/Changed since export/)).toHaveCount(1);
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(0);
  await expect(download).toBeEnabled();
});

test('plain caption mode exposes saved-appearance repair beside history', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  state.appearanceFailure = true;
  await page.getByLabel(/^Size /).fill('90');
  await expect(page.getByText('Appearance could not be saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Captions file/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  await history.getByRole('button', { name: 'Retry save in Appearance', exact: true }).click();
  await expect(page.getByLabel(/^Size /)).toHaveValue('90');
  state.appearanceFailure = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  await page.getByRole('button', { name: 'Back to export', exact: true }).click();
  await page.locator('.export-history summary').click();
  await expect(page.locator('.export-history').getByText(/Changed since export/)).toHaveCount(1);
});
