import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openFindReplace(page: import('@playwright/test').Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
  const modal = page.locator('.find-replace-modal');
  await expect(modal).toBeVisible();
  return modal;
}

test('Find & Replace suppresses background scans while closed and recalculates upon reopening', async ({ page }) => {
  await openProject(page);

  // 1. Open Find & Replace and enter search query
  const modal = await openFindReplace(page);
  await modal.getByLabel('Find', { exact: true }).fill('កម្ពុជា');
  await expect(modal.locator('.find-summary')).toContainText(/1\s*matches in 1 captions/);

  const scanCountOpen = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.findReplaceScanCount ?? 0);
  expect(scanCountOpen).toBeGreaterThanOrEqual(1);

  // 2. Close modal via Escape
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  const scanCountClosed = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.findReplaceScanCount ?? 0);

  // 3. Edit caption text while modal is closed
  const firstCaptionTextarea = page.locator('.caption-row textarea').first();
  await firstCaptionTextarea.click();
  await firstCaptionTextarea.fill('កម្ពុជា Updated text');

  // Verify that scan count did NOT increase while modal is closed
  const scanCountAfterEdit = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.findReplaceScanCount ?? 0);
  expect(scanCountAfterEdit).toBe(scanCountClosed);

  // 4. Reopen modal and verify recalculation occurs
  await openFindReplace(page);
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.findReplaceScanCount ?? 0);
  }).toBeGreaterThan(scanCountClosed);

  await expect(page.locator('.find-replace-modal .find-summary')).toContainText(/1\s*matches in 1 captions/);
});

test('Find & Replace literal mode handles dollar signs safely without regex backreference corruption', async ({ page }) => {
  await openProject(page);

  const modal = await openFindReplace(page);
  await modal.getByLabel('Find', { exact: true }).fill('CapCut');
  await modal.getByLabel('Replace with', { exact: true }).fill('$100');

  // Preview shows 1 match
  await expect(modal.locator('.find-summary')).toContainText(/1\s*matches in 1 captions/);

  // Apply replacement
  await modal.getByRole('button', { name: /Replace editable matches/ }).click();
  await expect(modal).toHaveCount(0);

  // Verify the replaced text in the editor contains literal $100
  const firstCaptionTextarea = page.locator('.caption-row textarea').first();
  await expect(firstCaptionTextarea).toHaveValue(/កម្ពុជា \$100/);
});

test('Find & Replace respects text locks and selection scope', async ({ page }) => {
  state.projects[0].captions[0].textLocked = true;
  await openProject(page);

  // Open Find & Replace and search for word in the locked caption
  const modal = await openFindReplace(page);
  await modal.getByLabel('Find', { exact: true }).fill('CapCut');

  // Verify lock is detected in summary
  await expect(modal.locator('.find-summary')).toContainText(/1\s*protected by text locks/);

  // When all matches are locked, clicking replace shows the inline error
  await modal.getByRole('button', { name: /Replace editable matches/ }).click();
  await expect(modal.locator('.inline-form-error')).toHaveText('Every match is text-locked. Unlock it first.');

  // Close modal
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);

  // Select second caption (which is not locked)
  await page.locator('.caption-row').nth(1).click();

  // Re-open modal
  const reopenedModal = await openFindReplace(page);
  const scopeSelect = reopenedModal.locator('label:has-text("Scope") select');
  await scopeSelect.selectOption('selection');

  // Search for word in second caption 'ខ្មែរ'
  await reopenedModal.getByLabel('Find', { exact: true }).fill('ខ្មែរ');
  await expect(reopenedModal.locator('.find-summary')).toContainText(/1\s*matches in 1 captions/);
  await reopenedModal.getByLabel('Replace with', { exact: true }).fill('Khmer');
  await reopenedModal.getByRole('button', { name: /Replace editable matches/ }).click();
  await expect(reopenedModal).toHaveCount(0);

  // Verify second caption was replaced
  const secondCaptionTextarea = page.locator('.caption-row textarea').nth(1);
  await expect(secondCaptionTextarea).toHaveValue(/Khmerរបស់យើង/);
});

test('Review row approval on filtered list correctly targets the original caption index', async ({ page }) => {
  // Pre-approve the first caption so the review queue starts at caption 2 (c2, index 1 in full list)
  state.projects[0].captions[0].approved = true;
  await openProject(page);

  // Open Review workspace
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(page.locator('.review-card')).toBeVisible();

  // In review mode, the only unapproved flagged caption is c2 (visible at index 0 of review queue)
  const visibleRow = page.locator('.caption-row').first();
  await expect(visibleRow.locator('.row-index')).toHaveText('02');

  // Click row approve on this filtered row
  const rowApprove = visibleRow.locator('.row-approve');
  await rowApprove.click();

  // Verify that caption c2 in backend state has approved: true (target is c2, NOT c1)
  await expect.poll(() => state.projects[0].captions.find((c) => c.id === 'c2')?.approved).toBe(true);
  expect(state.projects[0].captions.find((c) => c.id === 'c3')?.approved).toBeFalsy();
});

test('Row action menu on the bottom caption renders with .menu-up class', async ({ page }) => {
  await openProject(page);

  const rows = page.locator('.caption-row');
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(3);

  // Open menu on the last caption
  const lastRowMore = rows.last().locator('.row-more');
  await lastRowMore.click();

  const menu = page.locator('.caption-action-menu');
  await expect(menu).toBeVisible();

  // In CaptionEditor, visibleIndex > visible.length - 4 attaches .menu-up
  await expect(menu).toHaveClass(/menu-up/);
});
