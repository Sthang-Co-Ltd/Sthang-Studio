import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function running(): ProcessingJob {
  return { id: 'background-a', type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'running', stage: 'alignment', progress: 52, message: 'Matching captions to audio.',
    canResume: false, createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z' };
}
async function publish(page: Page) {
  const received = page.waitForResponse((response) => response.url().endsWith('/api/jobs') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await received;
}
async function openActivity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function visibleControl(page: Page, name: string) {
  const control = page.getByRole('button', { name, exact: true });
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && (innerWidth > 900 || rect.height >= 44) && rect.top >= 0 && rect.bottom <= innerHeight + 1
      && rect.left >= 0 && rect.right <= innerWidth + 1 && (hit === node || Boolean(hit && node.contains(hit)));
  })).toBe(true);
  return control;
}

for (const width of [1440, 390]) for (const composing of [false, true]) {
  test('a different project failure preserves ' + (composing ? 'Khmer composition' : 'caption editing') + ' through deliberate recovery at ' + width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    state.jobs = [running()];
    const beforeA = structuredClone(state.projects[0]);
    const text = 'Newer project B wording ខ្មែរ';
    const resumedStamp = '2026-01-01T00:00:04.000Z';
    let resumes = 0;
    await page.route('**/api/jobs/background-a/resume', async (route) => {
      resumes++;
      state.jobs[0] = { ...state.jobs[0], status: 'queued', stage: 'queued', progress: 0,
        message: 'Queued to resume.', error: undefined, canResume: false, completedAt: undefined, updatedAt: resumedStamp };
      return route.fulfill({ json: state.jobs[0] });
    });
    await openProject(page, 'second');
    await expect.poll(() => state.requests.filter((request) => request.path === '/api/jobs').length).toBeGreaterThan(0);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill(text); await field.focus();
    await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 13));
    if (composing) await field.dispatchEvent('compositionstart', { data: 'ខ្មែរ' });
    await page.evaluate(() => {
      (window as any).__backgroundJourneyNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    });
    state.jobs[0] = { ...state.jobs[0], status: 'failed', stage: 'failed', canResume: true,
      message: 'Processing failed. Saved checkpoints remain available for retry.',
      error: 'Synthetic alignment failure', completedAt: '2026-01-01T00:00:03.000Z', updatedAt: '2026-01-01T00:00:03.000Z' };
    await publish(page);
    const failure = page.getByRole('alert').filter({ hasText: 'Synthetic alignment failure' });
    await expect(failure).toContainText('Audit landscape');
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toHaveCount(0);
    await expect(field).toBeFocused(); await expect(field).toHaveValue(text);
    expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([6, 13]);
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit second/);
    expect(state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/captions'))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__backgroundJourneyNodes.every((node: Element, index: number) =>
      node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
    if (composing) await field.dispatchEvent('compositionend', { data: 'ខ្មែរ' });

    const activityAction = await visibleControl(page, 'Open Activity');
    await page.screenshot({ path: info.outputPath('background-failure-' + width + (composing ? '-composition' : '-editing') + '.png') });
    await activityAction.focus(); await activityAction.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
    await expect(dialog).toBeVisible();
    const failed = dialog.getByRole('article', { name: /Audit landscape/ });
    await expect(failed).toContainText('Synthetic alignment failure');
    await failed.getByRole('button', { name: 'Resume', exact: true }).focus();
    await failed.getByRole('button', { name: 'Resume', exact: true }).press('Enter');
    await expect(failed.locator('.job-state')).toHaveText(/Waiting|Working/);
    expect(resumes).toBe(1);
    await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
    // Opening Activity intentionally blurs and saves the first edit. Start a
    // genuinely newer unsaved draft before the recovered job completes.
    const newerText = text + ' after resuming';
    await field.fill(newerText); await field.focus();

    state.projects[0].captions[0].text = 'Recovered generation result A';
    state.projects[0].updatedAt = '2026-01-01T00:00:05.000Z';
    state.jobs[0] = { ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100,
      message: 'Full transcription and local timing completed.', resultProjectId: 'landscape',
      canResume: false, updatedAt: '2026-01-01T00:00:05.000Z', completedAt: '2026-01-01T00:00:05.000Z' };
    await publish(page);
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toHaveCount(0);
    await expect(field).toBeFocused(); await expect(field).toHaveValue(newerText);
    expect(state.projects[1].captions[0].text).not.toBe(newerText);
    const completed = (await openActivity(page)).getByRole('article', { name: /Audit landscape/ });
    await completed.getByRole('button', { name: 'Open result', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit landscape/);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Recovered generation result A');
    await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toHaveCount(0);
    expect(state.projects[1].captions[0].text).toBe(newerText, 'explicit result navigation must save project B first');
    expect(state.projects[0].captions.slice(1)).toEqual(beforeA.captions.slice(1));
    expect(state.projects[0].media).toEqual(beforeA.media);
    expect(state.projects[0].captionAppearance).toEqual(beforeA.captionAppearance);
    expect(state.projects[0].transcriptionContext).toEqual(beforeA.transcriptionContext);
  });
}
