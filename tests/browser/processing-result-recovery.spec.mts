import { test as base, expect } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const width of [1440, 390]) test(`completed processing with a failed result read remains recoverable without regenerating at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const job: ProcessingJob = { id: 'completed-read', type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'running', stage: 'alignment', progress: 52, message: 'Matching captions to audio.', canResume: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
  state.jobs = [job];
  await openProject(page);
  const oldText = state.projects[0].captions[0].text;
  const oldMedia = structuredClone(state.projects[0].media);
  const oldAppearance = structuredClone(state.projects[0].captionAppearance);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await field.focus(); await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 2));
  let failRead = true; let phase: 'automatic' | 'activity' | 'open' = 'automatic';
  const reads = { automatic: 0, activity: 0, open: 0 };
  const appearanceReads = { automatic: 0, activity: 0, open: 0 };
  await page.route('**/api/projects/landscape', async (route) => {
    reads[phase]++;
    return failRead ? route.fulfill({ status: 503, json: { error: 'Synthetic completed-result read failure' } }) : route.fulfill({ json: state.projects[0] });
  });
  await page.route('**/api/projects/landscape/appearance', (route) => {
    appearanceReads[phase]++;
    return route.fallback();
  });
  state.projects[0].captions[0].text = 'Completed generated wording ខ្មែរ';
  state.projects[0].updatedAt = '2026-01-01T00:00:02.000Z';
  state.jobs = [{ ...job, status: 'completed', stage: 'complete', progress: 100, resultProjectId: 'landscape',
    message: 'Captions are ready.', completedAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z' }];
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  const recovery = page.getByRole('alert').filter({ hasText: /Processing completed.*result could not be loaded/ });
  await expect(recovery).toContainText('Audit landscape');
  await expect(field).toHaveValue(oldText); await expect(field).toBeFocused();
  expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, 2]);
  await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toHaveCount(0);
  expect(reads.automatic).toBe(1);
  await page.screenshot({ path: info.outputPath(`completed-result-recovery-${width}.png`), animations: 'disabled' });
  phase = 'activity';
  const appearanceRead = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/projects/landscape/appearance'));
  await recovery.getByRole('button', { name: 'Open Activity', exact: true }).focus();
  await recovery.getByRole('button', { name: 'Open Activity', exact: true }).press('Enter');
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(activity).toBeVisible();
  await (await appearanceRead).finished();
  expect(reads.activity).toBe(0);
  expect(appearanceReads.activity).toBe(1);
  phase = 'open';
  failRead = false;
  const resultRead = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/projects/landscape'));
  const refreshedAppearanceRead = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/projects/landscape/appearance'));
  await activity.getByRole('button', { name: 'Open result', exact: true }).click();
  await Promise.all([resultRead, refreshedAppearanceRead].map(async (response) => (await response).finished()));
  await expect(field).toHaveValue('Completed generated wording ខ្មែរ');
  await expect(activity).toHaveCount(0);
  expect(reads.automatic).toBe(1);
  // Explicit result loading reads the project once. Activity verifies only its
  // saved appearance when navigation advances the project ticket.
  expect(reads.open).toBe(1);
  expect(appearanceReads.open).toBe(1);
  expect(state.requests.filter((request) => request.method === 'POST' && /jobs|transcribe|regenerate/.test(request.path))).toEqual([]);
  expect(state.projects[0].media).toEqual(oldMedia);
  expect(state.projects[0].captionAppearance).toEqual(oldAppearance);
});
