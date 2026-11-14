import { test as base, expect, type Page } from '@playwright/test';
import { hydrateCaptionWordTimings } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
});
const current = () => state.projects[0];
const row = (page: Page, id: string) => page.locator(`[data-caption-id="${id}"]`);
const notice = (page: Page) => page.locator('[data-toast-timer="notice"]');
const undo = (page: Page) => page.locator('.review-undo-toast').getByRole('button', { name: 'Undo', exact: true });
const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const completion = (page: Page) => page.getByRole('region', { name: 'All flagged captions reviewed', exact: true });
async function rememberEvidence(page: Page) {
  await page.evaluate(() => {
    document.querySelector('video')?.pause();
    (window as any).__captionEditOwnershipNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
  });
}
async function sameEvidence(page: Page) {
  expect(await page.evaluate(() => (window as any).__captionEditOwnershipNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function selectedIds(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((node) => node.getAttribute('data-caption-id')));
}
async function saveCurrent(page: Page) {
  const save = page.locator('.save-action');
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  if (await save.isEnabled()) {
    await save.click();
    await expect(save).not.toHaveAttribute('aria-busy', 'true');
  }
  await expect(save.locator('.save-action-label')).toHaveText('Saved');
  await expect(save).toBeDisabled();
}
async function approveMixedRange(page: Page) {
  current().captions.forEach((caption, index) => {
    caption.timingQuality = 'low';
    caption.approved = index === 1;
  });
  await openProject(page);
  await rememberEvidence(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(review(page)).toBeVisible();
  await expect(row(page, 'c2')).toHaveCount(0);
  await row(page, 'c1').locator('.row-index').click();
  await row(page, 'c3').locator('.row-index').click({ modifiers: ['Shift'] });
  await expect(page.locator('.review-selection')).toContainText('3 selected · 1 approved');
  await review(page).getByRole('button', { name: 'Approve & next', exact: true }).click();
  await expect(completion(page)).toBeVisible();
  await completion(page).getByRole('button', { name: 'Show all captions', exact: true }).click();
  await expect(row(page, 'c2')).toBeVisible();
}

test('Add caption uses only the valid time remaining at the end and preserves existing caption evidence', async ({ page }) => {
  current().captions.at(-1)!.endMs = 3900;
  await openProject(page);
  await rememberEvidence(page);
  const before = hydrateCaptionWordTimings(current()).captions;
  await page.getByRole('button', { name: 'Add caption', exact: true }).click();
  await expect(page.locator('.caption-row')).toHaveCount(4);
  await expect(page.getByLabel('Caption 4 start time', { exact: true })).toHaveValue('00:03.900');
  await expect(page.getByLabel('Caption 4 end time', { exact: true })).toHaveValue('00:04.000');
  const text = page.getByLabel('Caption 4 text', { exact: true });
  await expect(text).toBeFocused();
  await text.fill('New tail កម្ពុជា');
  await text.blur();
  await saveCurrent(page);
  await expect.poll(() => current().captions.length).toBe(4);
  expect(current().captions.slice(0, 3)).toEqual(before);
  expect(current().captions[3]).toMatchObject({ startMs: 3900, endMs: 4000, text: 'New tail កម្ពុជា', approved: false });
  await sameEvidence(page);
});

for (const endMs of [4000, 3980]) test(`Add caption preserves the saved draft when only ${4000 - endMs}ms remains`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  current().captions.at(-1)!.endMs = endMs;
  await openProject(page);
  await rememberEvidence(page);
  const before = structuredClone(current().captions);
  const selected = await selectedIds(page);
  const clock = await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }));
  const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  await page.getByRole('button', { name: 'Add caption', exact: true }).click();
  await expect(notice(page)).toContainText('There is no room for another caption at the end.');
  await expect(page.locator('.caption-row')).toHaveCount(3);
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(await selectedIds(page)).toEqual(selected);
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }))).toEqual(clock);
  expect(current().captions).toEqual(before);
  expect(state.requests.filter((request) => request.path.endsWith('/captions')).length).toBe(writes);
  await sameEvidence(page);
});

test('Review Undo never reapproves newer wording in an already-approved caption inside a mixed Shift range', async ({ page }) => {
  await approveMixedRange(page);
  const text = page.getByLabel('Caption 2 text', { exact: true });
  await text.fill('Newer reviewed wording កម្ពុជា');
  await expect(row(page, 'c2').locator('.row-approve')).toHaveAttribute('aria-pressed', 'false');
  await undo(page).click();
  await expect(notice(page)).toHaveText('Approval undone.');
  await saveCurrent(page);
  await expect.poll(() => current().captions.map((caption) => Boolean(caption.approved))).toEqual([false, false, false]);
  await expect(text).toHaveValue('Newer reviewed wording កម្ពុជា');
  expect(current().captions[1].text).toBe('Newer reviewed wording កម្ពុជា');
  await sameEvidence(page);
});

test('Review Undo restores only unchanged approvals and explains a partial result without overwriting newer edits', async ({ page }) => {
  await approveMixedRange(page);
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.fill('Keep this later correction ខ្មែរ');
  await undo(page).click();
  await expect(notice(page)).toHaveText('Undid approval for 1 caption. Newer changes to 1 caption were kept.');
  await saveCurrent(page);
  await expect.poll(() => current().captions.map((caption) => Boolean(caption.approved))).toEqual([false, true, false]);
  await expect(text).toHaveValue('Keep this later correction ខ្មែរ');
  expect(current().captions[0].text).toBe('Keep this later correction ខ្មែរ');
  await expect(row(page, 'c3')).toHaveClass(/selected-range/);
  await sameEvidence(page);
});

test('fully stale Review Undo keeps the current selection, playback and saved draft unchanged', async ({ page }) => {
  current().captions.forEach((caption, index) => { caption.timingQuality = 'low'; caption.approved = index !== 0; });
  await openProject(page);
  await rememberEvidence(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await review(page).getByRole('button', { name: 'Approve & next', exact: true }).click();
  await expect(completion(page)).toBeVisible();
  await completion(page).getByRole('button', { name: 'Show all captions', exact: true }).click();
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer wording stays unapproved កម្ពុជា');
  await row(page, 'c3').locator('.row-index').click();
  await saveCurrent(page);
  const before = structuredClone(current().captions);
  const clock = await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }));
  const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  expect(await selectedIds(page)).toEqual(['c3']);
  await undo(page).focus();
  await page.keyboard.press('Enter');
  await expect(notice(page)).toContainText('No approval was changed.');
  await expect(page.locator('.review-undo-toast')).toHaveCount(0);
  await expect(page.locator('.header-actions').getByRole('button', { name: /^Review/ })).toBeFocused();
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(await selectedIds(page)).toEqual(['c3']);
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }))).toEqual(clock);
  expect(current().captions).toEqual(before);
  expect(state.requests.filter((request) => request.path.endsWith('/captions')).length).toBe(writes);
  await sameEvidence(page);
});

test('fully stale Review Undo keeps the mobile Review control visible without changing saved work', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  current().captions.forEach((caption, index) => { caption.timingQuality = 'low'; caption.approved = index !== 0; });
  await openProject(page);
  await rememberEvidence(page);
  const reviewButton = page.locator('.header-actions').getByRole('button', { name: /^Review/ });
  await reviewButton.click();
  await review(page).getByRole('button', { name: 'Approve & next', exact: true }).click();
  await expect(completion(page)).toBeVisible();
  await completion(page).getByRole('button', { name: 'Show all captions', exact: true }).click();
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer wording stays unapproved កម្ពុជា');
  await row(page, 'c3').locator('.row-index').click();
  await saveCurrent(page);
  await reviewButton.click();
  const primary = review(page).getByRole('button', { name: 'Approve & next', exact: true });
  await expect(primary).toBeEnabled();
  await expect.poll(() => selectedIds(page)).toEqual(['c1']);
  const before = structuredClone(current().captions);
  const selected = await selectedIds(page);
  const clock = await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }));
  const writes = state.requests.filter((request) => request.path.endsWith('/captions')).length;
  await undo(page).focus();
  await page.locator('.editor-workbench').evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => primary.evaluate((node) => {
    const viewport = document.querySelector('.editor-workbench')!.getBoundingClientRect();
    return node.getBoundingClientRect().top >= Math.min(innerHeight, viewport.bottom);
  })).toBe(true);
  await page.keyboard.press('Enter');
  await expect(notice(page)).toContainText('No approval was changed.');
  // Keep the notice present so its timeout cannot conceal an overlap.
  await notice(page).hover();
  await expect(page.locator('.review-undo-toast')).toHaveCount(0);
  await expect(reviewButton).toBeFocused();
  await expect.poll(() => reviewButton.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const preview = document.querySelector('.stage-column')!.getBoundingClientRect();
    const notifications = document.querySelector('.toast-stack')!.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1
      && rect.top >= 0 && rect.bottom <= preview.top && rect.bottom <= notifications.top - 8
      && (hit === node || Boolean(hit && node.contains(hit)));
  })).toBe(true);
  await expect(notice(page)).toBeVisible();
  expect(await page.locator('.editor-workbench').evaluate((node) => node.scrollTop)).toBe(0);
  await page.screenshot({ path: info.outputPath('stale-review-undo-focus-390.png') });
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(await selectedIds(page)).toEqual(selected);
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }))).toEqual(clock);
  expect(current().captions).toEqual(before);
  expect(state.requests.filter((request) => request.path.endsWith('/captions')).length).toBe(writes);
  await sameEvidence(page);
});
