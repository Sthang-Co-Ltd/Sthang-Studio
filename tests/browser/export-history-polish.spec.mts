import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let entries: { version: number; format: string; preparedAt: string; fingerprint: string }[];
test.beforeEach(async ({ page }) => {
  const state = await installFixture(page);
  entries = ['srt', 'video'].map((format) => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z', fingerprint: createHash('sha256').update(exportContentBasis(state.projects[0], format as 'srt' | 'video')).digest('hex') }));
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: entries }));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function openHistory(page: Page) { await openProject(page); await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.locator('.export-history summary').click(); return page.locator('.export-history'); }

test('initial loading and failure never masquerade as an empty export history', async ({ page }) => {
  const gate = deferred(); let fail = true;
  await page.route('**/api/caption-handoff/*/export-history', async (route) => { if (fail) { await gate.promise; return route.fulfill({ status: 503, json: {} }); } return route.fulfill({ json: [] }); });
  try {
    const history = await openHistory(page); await expect(history.getByRole('status')).toHaveText('Loading export history…');
    await expect(history.getByText(/No recorded exports/)).toHaveCount(0);
    gate.resolve(); await expect(history.getByRole('alert')).toContainText('Freshness is unknown'); await expect(history.getByText(/No recorded exports/)).toHaveCount(0);
    fail = false; await history.getByRole('button', { name: 'Retry export history', exact: true }).click();
    await expect(history.getByText(/No recorded exports/)).toBeVisible();
  } finally { gate.resolve(); }
});

test('refresh and retry retain labeled records, editor drafts, and keyboard focus', async ({ page }, info) => {
  const history = await openHistory(page); await expect(history.locator('li')).toHaveCount(2);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unsaved evidence កម្ពុជា');
  const gate = deferred(); let fail = true;
  await page.route('**/api/caption-handoff/*/export-history', async (route) => { if (fail) { await gate.promise; return route.fulfill({ status: 503, json: {} }); } return route.fulfill({ json: entries.slice(0, 1) }); });
  try {
    const refresh = history.getByRole('button', { name: 'Refresh export history', exact: true });
    await refresh.click(); await expect(history.getByRole('status')).toHaveText('Refreshing export history…');
    await expect(history.locator('li')).toHaveCount(2); await expect(history.locator('li span').first()).toContainText('Last loaded record:'); await expect(refresh).toBeFocused();
    gate.resolve(); await expect(history.getByRole('alert')).toContainText('Last loaded records are shown'); await expect(history.locator('li')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 }); await history.scrollIntoViewIfNeeded();
    expect(await history.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('retained-exports-390.png') });
    fail = false; await history.getByRole('button', { name: 'Retry export history', exact: true }).click();
    await expect(history.locator('li')).toHaveCount(1); await expect(history.getByRole('alert')).toHaveCount(0); await expect(history.locator('summary')).not.toContainText('last loaded');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Unsaved evidence កម្ពុជា');
  } finally { gate.resolve(); }
});

test('a superseded refresh cannot replace newer export records', async ({ page }) => {
  const history = await openHistory(page); await expect(history.locator('li')).toHaveCount(2);
  const gate = deferred(); let reads = 0; let settled = false;
  await page.route('**/api/caption-handoff/*/export-history', async (route) => {
    reads++; if (reads === 1) { await gate.promise; await route.fulfill({ json: entries }).catch(() => {}); settled = true; }
    else await route.fulfill({ json: entries.slice(0, 1) });
  });
  try {
    await history.getByRole('button', { name: 'Refresh export history', exact: true }).click(); await expect.poll(() => reads).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('sthang:export-history-updated')));
    await expect(history.locator('li')).toHaveCount(1); gate.resolve(); await expect.poll(() => settled).toBe(true);
    await expect(history.locator('li')).toHaveCount(1); await expect(history.getByRole('status')).toHaveText('1 recorded export');
  } finally { gate.resolve(); }
});
