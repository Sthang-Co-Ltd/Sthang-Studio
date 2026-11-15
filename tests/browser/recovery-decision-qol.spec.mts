import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { hydrateCaptionWordTimings, type ProcessingJob } from '@kcs/shared';
import { createUnfinishedEditRecoveryStore } from '../../apps/web/src/unfinished-edit-recovery.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const backups = [1, 2].map((index) => ({ id: `recovery-backup-${index}`, mode: 'preserve' as const,
  previousOriginalName: `Synthetic reviewed version ${index}.mp4`, createdAt: `2026-01-0${index}`, retainedBytes: 5000 }));
async function failedBackups(page: Page) {
  let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | null = null;
  let reads = 0;
  await page.route('**/api/projects/*/media-replacements', async (route) => {
    expect(route.request().method()).toBe('GET');
    reads++;
    const current = attempt;
    if (current) await current.gate.promise;
    return current?.succeeds ? route.fulfill({ json: backups })
      : route.fulfill({ status: 503, json: { error: 'Synthetic backup read failure' } });
  });
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo media replacement/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo media replacement', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic backup read failure');
  expect(await page.evaluate(() => {
    const nodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__recoveryDecisionNodes = nodes;
    return nodes.every(Boolean);
  })).toBe(true);
  return { dialog, next(succeeds: boolean) { const gate = deferred(); attempt = { succeeds, gate }; return gate; }, reads: () => reads };
}
async function expectVisibleTarget(target: Locator) {
  await expect(target).toBeFocused();
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      && rect.left >= 0 && rect.right <= innerWidth && (hit === node || (hit !== null && node.contains(hit)));
  })).toBe(true);
}
async function finishBackupRead(dialog: Locator, succeeds: boolean) {
  await expect(dialog).toHaveAttribute('aria-busy', 'false');
  if (succeeds) {
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('radio')).toHaveCount(2);
    await expect(dialog.getByRole('radio').first()).toBeChecked();
  } else await expect(dialog.getByRole('button', { name: 'Refresh backups', exact: true })).toBeEnabled();
}
function expectNoSavedStateMutations() {
  // Native preview is a render read whose input travels by POST. Every other
  // non-GET still counts as an unexpected saved-state mutation in these cases.
  expect(state.requests.filter((request) => request.method !== 'GET'
    && !(request.method === 'POST' && request.path === '/api/video-export/landscape/preview'))).toEqual([]);
}
async function expectReadOnlyEvidence(page: Page, original: string) {
  expect(JSON.stringify(state.projects)).toBe(original);
  expect(await page.evaluate(() => (window as any).__recoveryDecisionNodes.every((node: Element, index: number) =>
    node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  expectNoSavedStateMutations();
}

test('mobile backup refresh keeps a visible persistent Close target through held failure and success', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const original = JSON.stringify(state.projects);
  const attempts = await failedBackups(page);
  const close = attempts.dialog.getByRole('button', { name: 'Close', exact: true });
  for (const succeeds of [false, true]) {
    const gate = attempts.next(succeeds);
    try {
      const refresh = attempts.dialog.getByRole('button', { name: 'Refresh backups', exact: true });
      await refresh.focus();
      await page.keyboard.press('Enter');
      await expect(refresh).toHaveCount(0);
      await expect(attempts.dialog).toHaveAttribute('aria-busy', 'true');
      await expectVisibleTarget(close);
      if (!succeeds) await page.screenshot({ path: info.outputPath('backup-refresh-focus-390.png'), animations: 'disabled' });
      gate.release();
      await finishBackupRead(attempts.dialog, succeeds);
      await expect(close).toBeFocused();
    } finally { gate.release(); }
  }
  expect(attempts.reads()).toBe(3);
  await expectReadOnlyEvidence(page, original);
});

test('held backup refresh yields to a newer dialog control on both failure and success', async ({ page }) => {
  const original = JSON.stringify(state.projects);
  const attempts = await failedBackups(page);
  const later = attempts.dialog.getByRole('button', { name: 'Close replacement backups', exact: true });
  for (const succeeds of [false, true]) {
    const gate = attempts.next(succeeds);
    try {
      await attempts.dialog.getByRole('button', { name: 'Refresh backups', exact: true }).click();
      await expect(attempts.dialog).toHaveAttribute('aria-busy', 'true');
      await later.focus();
      gate.release();
      await finishBackupRead(attempts.dialog, succeeds);
      await expect(later).toBeFocused();
    } finally { gate.release(); }
  }
  await later.press('Enter');
  await expect(attempts.dialog).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  expect(attempts.reads()).toBe(3);
  await expectReadOnlyEvidence(page, original);
});

async function seedRecovery(page: Page) {
  state.projects[0] = hydrateCaptionWordTimings(state.projects[0]);
  const values = new Map<string, string>();
  const store = createUnfinishedEditRecoveryStore(() => ({
    get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); },
  }), 'recovery-decision-fixture');
  const captions = structuredClone(state.projects[0].captions);
  captions[0].text = 'Recovered ខ្មែរ wording awaiting review';
  const result = store.write({ project: state.projects[0], captions });
  expect(result.status).toBe('saved');
  if (!result.entry) throw new Error('The synthetic recovery entry was not created.');
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), result.entry);
}
const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
async function expectBlockedReason(page: Page, text: string) {
  const notice = recovery(page);
  const restore = notice.getByRole('button', { name: 'Restore draft', exact: true });
  await expect(restore).toBeDisabled();
  const id = await restore.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  await expect(notice.locator(`[id="${id}"]`)).toHaveText(text);
  await expect(notice.getByRole('button', { name: 'Download draft', exact: true })).toBeEnabled();
  await expect(notice.getByRole('button', { name: 'Discard draft', exact: true })).toBeEnabled();
}

test('a clean current draft explains its active project task instead of asking for a save', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRecovery(page);
  const original = JSON.stringify(state.projects);
  const running: ProcessingJob = { id: 'recovery-blocking-job', type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'running', stage: 'working', progress: 30, message: 'Synthetic caption task', canResume: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  state.jobs = [running];
  await openProject(page);
  await expectBlockedReason(page, 'Wait for the current project task to finish before restoring this draft.');
  await recovery(page).screenshot({ path: info.outputPath('recovery-task-reason-390.png'), animations: 'disabled' });
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
  state.jobs = [];
  await expect(recovery(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await expect(recovery(page).locator('.unfinished-recovery-hint')).toHaveCount(0);
  await expect(recovery(page).getByRole('button', { name: 'Restore draft', exact: true })).not.toHaveAttribute('aria-describedby');
  expect(JSON.stringify(state.projects)).toBe(original);
  expectNoSavedStateMutations();
});

test('new unsaved caption edits get their own restore explanation while Download and Discard stay available', async ({ page }) => {
  await seedRecovery(page);
  const original = JSON.stringify(state.projects);
  await openProject(page);
  await expect(recovery(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill('New current ខ្មែរ edits to keep');
  await expectBlockedReason(page, 'Save your current edits before restoring this draft.');
  await expect(caption).toBeFocused();
  await expect(caption).toHaveValue('New current ខ្មែរ edits to keep');
  expect(JSON.stringify(state.projects)).toBe(original);
  expectNoSavedStateMutations();
});
