import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis, type CaptionProject, type ExportEvidence, type ProcessingJob, type ProjectStorageStatus } from '../../packages/shared/src/index.js';
import { cleanFixtures, fixtureExportUrl, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectContained(page: Page, dialog: Locator) {
  for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < 16; index++) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
}

async function openReplacement(page: Page, find: string, replacement: string) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  await dialog.getByLabel('Find', { exact: true }).fill(find);
  await dialog.getByLabel('Replace with', { exact: true }).fill(replacement);
  return dialog;
}

async function showHistory(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const history = page.locator('.export-history');
  await history.locator('summary').click();
  return history;
}

function receipts(project: CaptionProject): ExportEvidence[] {
  return (['srt', 'video'] as const).map((format) => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z',
    fingerprint: createHash('sha256').update(exportContentBasis(project, format)).digest('hex') }));
}

async function installReceipts(page: Page, entries: ExportEvidence[]) {
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: entries }));
}

test('replacement pagination and changing disabled controls retain keyboard containment and the caption opener', async ({ page }) => {
  state.projects[0].captions = Array.from({ length: 65 }, (_, index) => ({ id: `integration-${index}`,
    text: `Token ${index}`, startMs: index * 50, endMs: index * 50 + 40 }));
  await openProject(page);
  const opener = page.getByLabel('Caption 1 text', { exact: true });
  await opener.focus();
  await opener.press('Control+f');
  const dialog = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  const find = dialog.getByLabel('Find', { exact: true });
  await expect(find).toBeFocused();
  await find.fill('Token');
  await dialog.getByLabel('Replace with', { exact: true }).fill('Changed');
  const pages = dialog.getByRole('navigation', { name: 'Replacement preview pages' });
  const previous = pages.getByRole('button', { name: 'Previous matches', exact: true });
  const next = pages.getByRole('button', { name: 'Next matches', exact: true });
  await expect(dialog.locator('.find-after')).toHaveCount(30);
  await expect(previous).toBeDisabled();
  await expectContained(page, dialog);
  await next.click();
  await expect(pages).toContainText('Page 2 of 3');
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(dialog.locator('.find-after')).toHaveCount(5);
  await expect(dialog.locator('.find-after').last()).toHaveText('Changed 64');
  await expect(next).toBeDisabled();
  await expectContained(page, dialog);
  await dialog.getByLabel('Replace with', { exact: true }).fill('Token');
  await expect(pages).toContainText('Page 1 of 3');
  await expect(dialog.getByRole('button', { name: 'Replace editable matches', exact: true })).toBeDisabled();
  await dialog.getByLabel('Match', { exact: true }).selectOption('regex');
  await expect(dialog.locator('.replace-memory select')).toBeDisabled();
  await expectContained(page, dialog);
  // Synthetic ASCII composition Escape exercises isolation, not a native Khmer IME.
  await find.focus();
  await find.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
  await expect(dialog).toBeVisible();
  await expect(find).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(state.projects[0].captions.every((caption, index) => caption.text === `Token ${index}`)).toBe(true);
  expect(state.requests.filter((request) => request.method !== 'GET' && request.path.endsWith('/captions'))).toEqual([]);
});

test('replacement preview and cancel preserve receipts; apply and reverse survive save and reopening', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const original = state.projects[0].captions[0].text;
  const replacement = 'Integration replacement wording';
  await installReceipts(page, receipts(state.projects[0]));
  await openProject(page);
  let history = await showHistory(page);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  let correction = await openReplacement(page, original, replacement);
  await expect(correction.locator('.find-after')).toHaveText(replacement);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await correction.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  expect(state.projects[0].captions[0].text).toBe(original);
  correction = await openReplacement(page, original, replacement);
  await correction.getByRole('button', { name: 'Replace editable matches', exact: true }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(replacement);
  await expect(history.getByText(/Changed since export/)).toHaveCount(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].text).toBe(replacement);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  history = await showHistory(page);
  await expect(history.getByText(/Changed since export/)).toHaveCount(2);
  correction = await openReplacement(page, replacement, original);
  await correction.getByRole('button', { name: 'Replace editable matches', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].text).toBe(original);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  history = await showHistory(page);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await expect(history.getByText(/Changed since export/)).toHaveCount(0);
});

test('same-ID recovered content cannot inherit surviving export or completed-video freshness', async ({ page }) => {
  const original = structuredClone(state.projects[0]);
  const entries = receipts(original);
  await installReceipts(page, entries);
  const createdAt = '2026-01-01T00:00:02Z';
  state.jobs = [{ id: 'surviving-render', type: 'export-video', projectId: original.id, projectTitle: original.title,
    status: 'completed', stage: 'complete', progress: 100, message: 'Ready', canResume: false, createdAt, updatedAt: createdAt,
    exportContentFingerprint: entries.find((entry) => entry.format === 'video')!.fingerprint,
    resultExport: { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000, width: 640, height: 360,
      frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt } } satisfies ProcessingJob];
  await openProject(page);
  await expect((await showHistory(page)).getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  // Model a restored saved response with the same identity and retained receipts.
  // This is UI comparison evidence, not an actual filesystem recovery operation.
  state.projects[0] = { ...structuredClone(original), captions: original.captions.map((caption, index) =>
    ({ ...caption, text: `Recovered different content ${index}` })) };
  expect(state.projects[0].id).toBe(original.id);
  await page.reload();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Recovered different content 0');
  await page.evaluate(() => {
    const claims: string[] = [];
    (window as any).__trackerCurrentClaims = claims;
    const observe = () => {
      for (const element of document.querySelectorAll('.export-history, .job-list')) {
        if (element.textContent?.includes('Matches open project content.')) claims.push(element.className);
      }
    };
    new MutationObserver(observe).observe(document.body, { childList: true, characterData: true, subtree: true });
    observe();
  });
  const history = await showHistory(page);
  await expect(history.getByText(/Changed since export/)).toHaveCount(2);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(0);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(activity).toContainText('this video contains earlier content');
  await expect(activity.getByText('Matches open project content.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__trackerCurrentClaims)).toEqual([]);
  await activity.getByRole('button', { name: 'Close Activity', exact: true }).click();
});

test('library storage review contains keyboard focus through pending, failed and successful rechecks and returns to its action', async ({ page }) => {
  state.projects = [];
  const failed = deferred(); const failedEntered = deferred(); const failedFinished = deferred();
  const succeeded = deferred(); const successEntered = deferred(); const successFinished = deferred();
  let phase: 'initial' | 'failure' | 'success' = 'initial';
  let rechecks = 0;
  const healthy: ProjectStorageStatus = { schemaVersion: 1, checkedAt: '2026-01-01T00:00:00Z',
    loadedProjectCount: 0, readableProjectCount: 0, unreadableProjectCount: 0, missingProjectCount: 0,
    duplicateProjectCount: 0, directoryUnreadable: false, orderUnreadable: false, legacyUnreadable: false,
    migrationPending: false, restartRequired: false };
  await page.route('**/api/system/project-storage*', async (route) => {
    const current = phase;
    if (current === 'initial') return route.fulfill({ status: 503, json: { error: 'Synthetic initial storage failure' } });
    rechecks++;
    if (current === 'failure') {
      failedEntered.resolve();
      try { await failed.promise; await route.fulfill({ status: 503, json: { error: 'Synthetic storage recheck failure' } }); }
      finally { failedFinished.resolve(); }
    } else {
      successEntered.resolve();
      try { await succeeded.promise; await route.fulfill({ json: healthy }); }
      finally { successFinished.resolve(); }
    }
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Dismiss storage check notice', exact: true }).click();
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    const review = page.locator('.project-library-empty').getByRole('button', { name: 'Review storage', exact: true });
    await review.focus(); await review.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const panel = dialog.getByRole('region', { name: 'Saved project storage' });
    const recheck = panel.getByRole('button', { name: 'Recheck saved projects', exact: true });
    phase = 'failure';
    await recheck.focus(); await recheck.press('Enter'); await failedEntered.promise;
    await expect(recheck).toBeDisabled();
    await expect(panel).toContainText('Checking saved project files');
    await expectContained(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(review).toBeFocused();
    await review.press('Enter');
    await expect(recheck).toBeDisabled();
    failed.resolve(); await failedFinished.promise;
    await expect(panel).toContainText('storage could not be checked');
    await expect(recheck).toBeEnabled();
    await expectContained(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(review).toBeFocused();
    await page.getByRole('button', { name: 'Dismiss storage check notice', exact: true }).click();
    await review.focus(); await review.press('Enter');
    phase = 'success';
    await recheck.focus(); await recheck.press('Enter'); await successEntered.promise;
    await expect(recheck).toBeDisabled();
    await expectContained(page, dialog);
    succeeded.resolve(); await successFinished.promise;
    await expect(panel).toContainText('No project read errors were found at the last check');
    await expect(recheck).toBeEnabled();
    await expectContained(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a project', exact: true })).toBeFocused();
    expect(rechecks).toBe(2);
    expect(state.requests.some((request) => request.path === '/api/system/doctor')).toBe(false);
  } finally {
    failed.resolve(); succeeded.resolve();
    if (rechecks >= 1) await failedFinished.promise;
    if (rechecks >= 2) await successFinished.promise;
  }
});
