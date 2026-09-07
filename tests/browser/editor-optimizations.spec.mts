import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openFindReplace(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
  const modal = page.locator('.find-replace-modal');
  await expect(modal).toBeVisible();
  return modal;
}

function getFindReplaceScanCount(page: Page) {
  return page.evaluate(() => {
    const hooks = (window as any).__STHANG_TEST_HOOKS__;
    if (!hooks) {
      throw new Error('Observation seam __STHANG_TEST_HOOKS__ is not available on window');
    }
    return hooks.findReplaceScanCount as number;
  });
}

test('Find & Replace suppresses background scans while closed and recalculates upon reopening with changed text, count, and caption IDs', async ({ page }) => {
  await openProject(page);

  // 1. Open Find & Replace and search for 'កម្ពុជា'
  const modal = await openFindReplace(page);
  await modal.getByLabel('Find', { exact: true }).fill('កម្ពុជា');
  await expect(modal.locator('.find-summary')).toContainText(/1\s*matches in 1 captions/);

  const scanCountOpen = await getFindReplaceScanCount(page);
  expect(scanCountOpen).toBeGreaterThanOrEqual(1);

  // 2. Close modal via Escape
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  const scanCountClosed = await getFindReplaceScanCount(page);

  // 3. Edit captions while modal is closed:
  // Remove match from caption 1, add 2 matches in caption 2, and add 1 match in caption 3
  const textareas = page.locator('.caption-row textarea');
  await textareas.nth(0).fill('Clean introductory sentence');
  await textareas.nth(1).fill('កម្ពុជា is beautiful, visit កម្ពុជា!');
  await textareas.nth(2).fill('Welcome to កម្ពុជា');

  // Verify that scan count did NOT increase while modal was closed
  const scanCountAfterEdits = await getFindReplaceScanCount(page);
  expect(scanCountAfterEdits).toBe(scanCountClosed);

  // 4. Reopen modal and verify recalculation occurs with updated counts and matching caption IDs
  const reopenedModal = await openFindReplace(page);
  await expect.poll(async () => getFindReplaceScanCount(page)).toBeGreaterThan(scanCountClosed);

  await reopenedModal.getByLabel('Find', { exact: true }).fill('កម្ពុជា');

  // Summary must show 3 matches in 2 captions (captions 2 and 3)
  await expect(reopenedModal.locator('.find-summary')).toContainText(/3\s*matches in 2 captions/);

  // Preview must show captions 2 and 3, not caption 1
  const previewParagraphs = reopenedModal.locator('.find-preview p');
  await expect(previewParagraphs).toHaveCount(2);
  await expect(previewParagraphs.nth(0)).toContainText('កម្ពុជា is beautiful');
  await expect(previewParagraphs.nth(1)).toContainText('Welcome to កម្ពុជា');
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

test('Find & Replace selection scope correctly distinguishes unlocked-selected, unlocked-unselected, and locked-selected', async ({ page }) => {
  // Set up initial text across captions with target term COMMON
  state.projects[0].captions[0].text = 'COMMON unselected';
  state.projects[0].captions[0].textLocked = false;

  state.projects[0].captions[1].text = 'COMMON selected-unlocked';
  state.projects[0].captions[1].textLocked = false;

  state.projects[0].captions[2].text = 'COMMON selected-locked';
  state.projects[0].captions[2].textLocked = true;

  await openProject(page);

  // Select caption 2 and shift-select caption 3 via row-index to avoid textarea click stopPropagation
  const rows = page.locator('.caption-row');
  await rows.nth(1).locator('.row-index').click();
  await rows.nth(2).locator('.row-index').click({ modifiers: ['Shift'] });

  // Open Find & Replace
  const modal = await openFindReplace(page);
  const scopeSelect = modal.locator('label:has-text("Scope") select');
  await scopeSelect.selectOption('selection');

  await modal.getByLabel('Find', { exact: true }).fill('COMMON');
  await modal.getByLabel('Replace with', { exact: true }).fill('REPLACED');

  // Preview reflects 2 matching captions in selection scope: 1 editable and 1 locked
  await expect(modal.locator('.find-summary')).toContainText(/2\s*matches in 2 captions/);
  await expect(modal.locator('.find-summary')).toContainText(/1\s*protected by text locks/);

  // Execute replacement
  await modal.getByRole('button', { name: /Replace editable matches/ }).click();
  await expect(modal).toHaveCount(0);

  // Verify results:
  // Caption 0 (unlocked, unselected): unchanged
  await expect(rows.nth(0).locator('textarea')).toHaveValue('COMMON unselected');
  // Caption 1 (unlocked, selected): replaced
  await expect(rows.nth(1).locator('textarea')).toHaveValue('REPLACED selected-unlocked');
  // Caption 2 (locked, selected): unchanged
  await expect(rows.nth(2).locator('textarea')).toHaveValue('COMMON selected-locked');
});

test('Find & Replace regex mode replaces with backreferences and disables glossary remember', async ({ page }) => {
  await openProject(page);

  const modal = await openFindReplace(page);

  // Switch to regular expression mode
  const modeSelect = modal.locator('label:has-text("Match") select');
  await modeSelect.selectOption('regex');

  // Verify remember select is disabled in regex mode
  const rememberSelect = modal.locator('.replace-memory select');
  await expect(rememberSelect).toBeDisabled();

  // Search with regex capture groups and replace with backreferences
  await modal.getByLabel('Find', { exact: true }).fill('(Cap)(Cut)');
  await modal.getByLabel('Replace with', { exact: true }).fill('$2-$1-Pro');

  await expect(modal.locator('.find-summary')).toContainText(/1\s*matches in 1 captions/);

  // Apply replacement
  await modal.getByRole('button', { name: /Replace editable matches/ }).click();
  await expect(modal).toHaveCount(0);

  // Verify caption 1 text has backreference transformation applied
  const firstCaptionTextarea = page.locator('.caption-row textarea').first();
  await expect(firstCaptionTextarea).toHaveValue(/Cut-Cap-Pro/);
});

test('Find & Replace persists nondefault state across close and reopen', async ({ page }) => {
  await openProject(page);

  const modal = await openFindReplace(page);

  // Enter nondefault query and replacement
  await modal.getByLabel('Find', { exact: true }).fill('PersistentQuery');
  await modal.getByLabel('Replace with', { exact: true }).fill('PersistentReplacement');

  // Choose nondefault match mode
  await modal.locator('label:has-text("Match") select').selectOption('case-insensitive');

  // Choose nondefault remember option
  await modal.locator('.replace-memory select').selectOption('project');

  // Close modal via Escape
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // Reopen modal and assert replacement, mode, and remember retain nondefault values,
  // while Find is initialized with the single selected caption's text per baseline contract
  const reopened = await openFindReplace(page);
  await expect(reopened.getByLabel('Find', { exact: true })).toHaveValue('កម្ពុជា CapCut');
  await expect(reopened.getByLabel('Replace with', { exact: true })).toHaveValue('PersistentReplacement');
  await expect(reopened.locator('label:has-text("Match") select')).toHaveValue('case-insensitive');
  await expect(reopened.locator('.replace-memory select')).toHaveValue('project');
});

test('Review row approval on filtered list correctly targets the original caption index even after caption array changes', async ({ page }) => {
  // Pre-approve the first caption and give caption 3 an issue so the review queue has both c2 and c3
  state.projects[0].captions[0].approved = true;
  state.projects[0].captions[2].timingQuality = 'low';
  await openProject(page);

  // Open Review workspace
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(page.locator('.review-card')).toBeVisible();

  // In review mode, unapproved caption c2 is the first visible row in the queue (index 02)
  const visibleRow = page.locator('.caption-row').first();
  await expect(visibleRow.locator('.row-index')).toHaveText('02');

  // Click row approve on c2
  await visibleRow.locator('.row-approve').click();

  // Verify that caption c2 in backend state is approved
  await expect.poll(() => state.projects[0].captions.find((c) => c.id === 'c2')?.approved).toBe(true);

  // Now, the review list displays remaining unapproved caption c3 (original index 03)
  const nextVisibleRow = page.locator('.caption-row').first();
  await expect(nextVisibleRow.locator('.row-index')).toHaveText('03');

  // Mutate caption text on this row to trigger an array change event
  const c3Textarea = nextVisibleRow.locator('textarea');
  await c3Textarea.click();
  await c3Textarea.fill('Caption 3 mutated text');
  await c3Textarea.blur();

  // Click approve on this row after the array change
  await nextVisibleRow.locator('.row-approve').click();

  // Verify caption c3 in backend state is approved and has the mutated text
  await expect.poll(() => state.projects[0].captions.find((c) => c.id === 'c3')?.approved).toBe(true);
  const updatedC3 = state.projects[0].captions.find((c) => c.id === 'c3');
  expect(updatedC3?.text).toBe('Caption 3 mutated text');
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
