import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob, RegenerationProposal } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function completed(id = 'result'): ProcessingJob {
  const timestamp = new Date(Date.now() - 1000).toISOString();
  return { id, projectId: 'second', resultProjectId: 'second', projectTitle: 'Audit second', type: 'transcribe',
    status: 'completed', stage: 'complete', progress: 100, message: 'Captions are ready.', canResume: false,
    createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp };
}
async function activity(page: Page) {
  const compared = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/projects/landscape/appearance'));
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible(); await compared;
  return dialog;
}

test('slow fallback, repeated update events and manual refresh share one Activity request', async ({ page }) => {
  state.jobs = [completed()];
  await openProject(page); const dialog = await activity(page);
  const gate = deferred(); const started = deferred();
  let reads = 0; let pending = 0; let maximum = 0;
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads++; pending++; maximum = Math.max(maximum, pending); started.release();
    await gate.promise; pending--;
    await route.fulfill({ json: state.jobs });
  });
  try {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click(); await started.promise;
    await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('sthang:jobs-updated')); });
    // Let multiple real fallback timer intervals pass while its response is held.
    await page.waitForTimeout(2300);
    expect({ reads, maximum, pending }).toEqual({ reads: 1, maximum: 1, pending: 1 });
    await expect(dialog.getByRole('status')).toContainText('Refreshing activity…');
    const received = page.waitForResponse((response) => response.url().endsWith('/api/jobs'));
    gate.release(); await received;
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(dialog.locator('.job-state')).toHaveText('Completed');
    const next = page.waitForResponse((response) => response.url().endsWith('/api/jobs'));
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click(); await next;
    expect(maximum).toBe(1);
    expect(reads).toBe(2);
  } finally { gate.release(); }
});

test('a stalled fallback reaches a bounded retryable error and a fresh read without restarting work', async ({ page }) => {
  state.jobs = [completed()];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openProject(page);
  // Pause before Activity starts its fallback timer. Only the deliberately
  // advanced deadline can settle the held GET; the fixture disables SSE.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
  const dialog = await activity(page);
  expect(await page.evaluate(() => typeof EventSource)).toBe('undefined');
  const gate = deferred(); const started = deferred(); const drained = deferred();
  let held: import('@playwright/test').Request | null = null;
  let reads = 0;
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads++;
    if (reads > 1) return route.fallback();
    const request = route.request(); held = request; started.release();
    try { await gate.promise; await route.fulfill({ json: state.jobs }); }
    catch (error) { if (!page.isClosed() && request.failure()?.errorText !== 'net::ERR_ABORTED') throw error; }
    finally { drained.release(); }
  });
  try {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await started.promise;
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('sthang:jobs-updated')); });
    await page.clock.fastForward(14_999);
    expect(reads).toBe(1);
    await expect(dialog.getByRole('status')).toContainText('Refreshing activity…');
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    const cancelled = page.waitForEvent('requestfailed', { predicate: (request) => request === held });
    await page.clock.fastForward(1);
    expect((await cancelled).failure()?.errorText).toBe('net::ERR_ABORTED');
    await expect(dialog.locator('.job-load-error')).toContainText('Could not update activity. Try again.');
    const retry = dialog.getByRole('button', { name: 'Retry activity', exact: true });
    await expect(retry).toBeEnabled();
    await expect(dialog.locator('.job-state')).toHaveText('Completed');
    expect(reads).toBe(1);
    gate.release(); await drained.promise;
    const recovered = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/jobs'));
    await retry.click(); await recovered;
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(dialog.locator('.job-load-error')).toHaveCount(0);
    await expect(dialog.locator('.job-state')).toHaveText('Completed');
    expect(reads).toBe(2);
    expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs'))).toHaveLength(0);
  } finally {
    gate.release();
    if (held) await drained.promise;
  }
});

for (const width of [1440, 390]) test('opening a completed result is one keyboard-owned read with recoverable feedback at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  state.jobs = [completed()];
  await openProject(page); const dialog = await activity(page);
  const gate = deferred(); const started = deferred(); let reads = 0;
  await page.route('**/api/projects/second', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads++;
    if (reads === 1) {
      started.release(); await gate.promise;
      return route.fulfill({ status: 503, json: { error: 'Saved result is temporarily unavailable. Try opening it again.' } });
    }
    return route.fallback();
  });
  try {
    const open = dialog.getByRole('button', { name: 'Open result', exact: true });
    await open.focus(); await page.keyboard.press('Enter'); await started.promise;
    const pending = dialog.getByRole('button', { name: 'Opening result…', exact: true });
    await expect(pending).toBeFocused();
    await expect(pending).toHaveAttribute('aria-disabled', 'true');
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    expect(reads).toBe(1);
    await expect(dialog.getByRole('status')).toContainText('Opening saved result…');
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (width === 390) expect((await pending.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('opening-result-' + width + '.png') });
    gate.release();
    await expect(page.locator('.toast.error')).toContainText('Saved result is temporarily unavailable.');
    await expect(open).toBeFocused(); await expect(open).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit second/);
    expect(reads).toBe(2);
    expect(state.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/jobs'))).toHaveLength(0);
  } finally { gate.release(); }
});

test('leaving Activity for a newer destination retires a delayed result read', async ({ page }) => {
  state.jobs = [completed()];
  await openProject(page); const dialog = await activity(page);
  const gate = deferred(); const started = deferred();
  await page.route('**/api/projects/second', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    started.release(); await gate.promise; await route.fallback();
  });
  try {
    await dialog.getByRole('button', { name: 'Open result', exact: true }).click(); await started.promise;
    await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    const recent = page.getByRole('region', { name: 'Recent projects', exact: true }).getByRole('button', { name: /Audit landscape/ });
    await expect(recent).toBeVisible();
    gate.release();
    await recent.click();
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit landscape/);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
    await expect(page.locator('.toast.error')).toHaveCount(0);
  } finally { gate.release(); }
});

test('closing Activity alone cancels its delayed Open and leaves playback and focus in the current project', async ({ page }) => {
  state.jobs = [completed()];
  await openProject(page); const dialog = await activity(page);
  const gate = deferred(); const started = deferred(); const settled = deferred();
  await page.route('**/api/projects/second', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    started.release(); await gate.promise;
    try { await route.fallback(); } finally { settled.release(); }
  });
  try {
    await dialog.getByRole('button', { name: 'Open result', exact: true }).click(); await started.promise;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const tools = page.getByLabel('Open project tools', { exact: true });
    await expect(tools).toBeFocused();
    await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 1.6; video.dispatchEvent(new Event('timeupdate')); });
    gate.release(); await settled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Project details', exact: true })).toHaveAccessibleDescription(/Audit landscape/);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.6, 1);
    await expect(tools).toBeFocused();
    await expect(page.locator('.toast.error')).toHaveCount(0);
  } finally { gate.release(); }
});

test('closing Activity retires a delayed proposal before it can open a comparison or start playback', async ({ page }) => {
  state.jobs = [{ ...completed('proposal-job'), projectId: 'landscape', projectTitle: 'Audit landscape',
    type: 'regenerate-range', resultProjectId: undefined, proposalId: 'held-proposal' }];
  const current = structuredClone(state.projects[0].captions[0]);
  const proposed = { ...current, id: 'proposed-caption', text: 'A proposed wording កម្ពុជា' };
  const proposal: RegenerationProposal = {
    id: 'held-proposal', projectId: 'landscape', projectTitle: 'Audit landscape', createdAt: '2026-01-01', expiresAt: '2099-01-01',
    startMs: 200, endMs: 1000, lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard',
    currentCaptions: [current], proposedCaptions: [proposed], changes: [{
      id: 'held-change', startMs: 200, endMs: 1000, beforeText: current.text, afterText: proposed.text,
      beforeStartMs: 200, beforeEndMs: 1000, afterStartMs: 200, afterEndMs: 1000, textChanged: true,
      timingChanged: false, timingDeltaMs: 0, confidence: 'high', protectedByLock: false,
    }],
  };
  const gate = deferred(); const started = deferred(); const settled = deferred();
  await page.route('**/regeneration-proposals/held-proposal', async (route) => {
    started.release(); await gate.promise;
    try { await route.fulfill({ json: proposal }); } finally { settled.release(); }
  });
  try {
    await openProject(page); const dialog = await activity(page);
    await dialog.getByRole('button', { name: 'Open result', exact: true }).click(); await started.promise;
    await expect(dialog.getByRole('button', { name: 'Opening result…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await page.locator('video').evaluate((video: HTMLVideoElement) => { video.pause(); video.currentTime = 1.6; });
    gate.release(); await settled.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('region', { name: 'Live regeneration review', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(current.text);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
      .toEqual({ paused: true, time: 1.6 });
    await expect(page.locator('.toast.error')).toHaveCount(0);
  } finally { gate.release(); }
});
