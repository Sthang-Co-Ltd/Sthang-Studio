import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob, RegenerationProposal } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoLoopReview = true;
  state.profile.preferences.autoPlayNextReview = true;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const media = (page: Page) => page.locator('video');
const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const comparison = (page: Page) => page.getByRole('region', { name: 'Live regeneration review', exact: true });
const selected = (page: Page) => page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-caption-id')));
type Scope = 'Review' | 'Comparison';

function proposal(): RegenerationProposal {
  const current = structuredClone(state.projects[0].captions[0]);
  const proposed = { ...current, id: 'proposal-cue', text: 'Proposed Khmer wording កម្ពុជា' };
  return { id: 'ownership-proposal', projectId: 'landscape', projectTitle: 'Audit landscape', createdAt: '2026-01-01', expiresAt: '2099-01-01',
    startMs: 200, endMs: 1000, lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard',
    currentCaptions: [current], proposedCaptions: [proposed], changes: [{ id: 'ownership-change', startMs: 200, endMs: 1000,
      beforeText: current.text, afterText: proposed.text, beforeStartMs: 200, beforeEndMs: 1000, afterStartMs: 200, afterEndMs: 1000,
      textChanged: true, timingChanged: false, timingDeltaMs: 0, confidence: 'high', protectedByLock: false }] };
}
async function openScope(page: Page, scope: Scope) {
  if (scope === 'Comparison') {
    const job: ProcessingJob = { id: 'ownership-job', type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
      status: 'completed', stage: 'complete', progress: 100, message: 'Comparison ready', canResume: false,
      createdAt: '2026-01-01', updatedAt: '2026-01-01', proposalId: 'ownership-proposal' };
    state.jobs = [job];
    await page.route('**/regeneration-proposals/ownership-proposal', (route) => route.fulfill({ json: proposal() }));
  }
  await openProject(page);
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking)).toBe(true);
  if (scope === 'Review') {
    await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
    await expect(review(page)).toBeVisible();
    await review(page).getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
    await expect(review(page).getByLabel('Tight loop', { exact: true })).toBeChecked();
  } else {
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
    await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
    await expect(comparison(page)).toBeVisible();
    await expect(comparison(page).getByRole('button', { name: 'Looping', exact: true })).toBeVisible();
  }
  await media(page).evaluate((video: HTMLVideoElement) => {
    video.pause(); video.playbackRate = .5;
    (window as any).__reviewOwnershipNodes = [video, document.querySelector('.caption-list')];
    (window as any).__reviewOwnershipSeeks = [];
    video.addEventListener('seeking', () => (window as any).__reviewOwnershipSeeks.push(video.currentTime));
  });
  return scope === 'Review' ? review(page).getByRole('button', { name: 'Replay', exact: true })
    : comparison(page).getByRole('button', { name: 'Replay range', exact: true });
}
async function sameEvidence(page: Page, before: FixtureState['projects'][number], selection: Array<string | null>) {
  expect(state.projects[0]).toEqual(before);
  expect(await selected(page)).toEqual(selection);
  expect(state.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/api/projects/'))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__reviewOwnershipNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  expect(await media(page).evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(.5);
}

for (const width of [1440, 390]) for (const scope of ['Review', 'Comparison'] as const) test(`native seeking retires ${scope} loop playback while explicit Replay can rearm it at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const replay = await openScope(page, scope);
  const before = structuredClone(state.projects[0]); const selection = await selected(page);
  await replay.click();
  await expect.poll(() => page.evaluate(() => (window as any).__reviewOwnershipSeeks.filter((time: number) => Math.abs(time - .1) < .05).length)).toBeGreaterThanOrEqual(2);
  await media(page).focus();
  await media(page).evaluate((video: HTMLVideoElement) => { video.currentTime = 2.6; });
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.9);
  expect(await media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect(media(page)).toBeFocused();
  if (scope === 'Review') await expect(review(page).getByLabel('Tight loop', { exact: true })).toBeChecked();
  else await expect(comparison(page).getByRole('button', { name: 'Looping', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`native-${scope.toLowerCase()}-seek-${width}.png`), animations: 'disabled' });
  const loopsBefore = await page.evaluate(() => (window as any).__reviewOwnershipSeeks.filter((time: number) => Math.abs(time - .1) < .05).length);
  await replay.click();
  await expect.poll(() => page.evaluate(() => (window as any).__reviewOwnershipSeeks.filter((time: number) => Math.abs(time - .1) < .05).length)).toBeGreaterThanOrEqual(loopsBefore + 2);
  await sameEvidence(page, before, selection);
});

for (const width of [1440, 390]) for (const scope of ['Review', 'Comparison'] as const) test(`native pause and later source playback stay independent of the checked ${scope} loop at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const replay = await openScope(page, scope);
  const before = structuredClone(state.projects[0]); const selection = await selected(page);
  await replay.click(); await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await media(page).focus(); await media(page).evaluate((video: HTMLVideoElement) => video.pause());
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await media(page).evaluate(async (video: HTMLVideoElement) => { video.currentTime = 2.6; await video.play(); });
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.9);
  await expect(media(page)).toBeFocused(); await sameEvidence(page, before, selection);
});

test('the selected Review caption keeps replaying while typing and after committing the edit', async ({ page }) => {
  const replay = await openScope(page, 'Review');
  const field = page.getByLabel('Caption 1 text', { exact: true });
  const wording = 'កែសម្រួល CapCut';
  const focusSeeks = () => page.evaluate(() =>
    (window as any).__reviewOwnershipSeeks.filter((time: number) => Math.abs(time - .1) < .05).length as number);
  await media(page).evaluate((video: HTMLVideoElement) => { video.playbackRate = 1; });
  await replay.click();
  await expect.poll(focusSeeks).toBeGreaterThanOrEqual(1);

  await field.click();
  await field.fill(wording);
  const duringEdit = await focusSeeks();
  await expect.poll(focusSeeks, { timeout: 8000 }).toBeGreaterThanOrEqual(duringEdit + 2);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(wording);
  expect(await selected(page)).toEqual(['c1']);

  await field.press('Tab');
  await expect.poll(() => state.projects[0].captions[0].text).toBe(wording);
  const afterSave = await focusSeeks();
  await expect.poll(focusSeeks, { timeout: 8000 }).toBeGreaterThanOrEqual(afterSave + 2);
  expect(await selected(page)).toEqual(['c1']);
});

test('the active Review row and its menu keep the loop, while editing another row pauses at that caption', async ({ page }) => {
  const replay = await openScope(page, 'Review');
  await media(page).evaluate((video: HTMLVideoElement) => { video.playbackRate = 1; });
  const seeksAt = (seconds: number) => page.evaluate((target) =>
    (window as any).__reviewOwnershipSeeks.filter((time: number) => Math.abs(time - target) < .05).length as number, seconds);
  await replay.click();
  await expect.poll(() => seeksAt(.1)).toBeGreaterThan(0);
  await page.locator('[data-caption-id="c1"] .row-index').click();
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Caption 1 actions', exact: true });
  await expect(menu).toBeVisible();
  const loops = await seeksAt(.1);
  await expect.poll(() => seeksAt(.1), { timeout: 8000 }).toBeGreaterThanOrEqual(loops + 2);
  await menu.getByRole('menuitem').first().press('Escape');
  const next = page.getByLabel('Caption 2 text', { exact: true });
  await next.click();
  await expect(next).toBeFocused();
  expect(await selected(page)).toEqual(['c2']);
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.paused && !video.seeking && video.currentTime)).toBeCloseTo(1.2, 2);
  await replay.click();
  await expect.poll(() => seeksAt(1.1), { timeout: 8000 }).toBeGreaterThanOrEqual(2);
});

test('one-pass Review uses the edited timestamp and stops at the selected range after a row click', async ({ page }) => {
  const replay = await openScope(page, 'Review');
  await review(page).getByLabel('Tight loop', { exact: true }).uncheck();
  await expect.poll(() => state.profile.preferences.autoLoopReview).toBe(false);
  const start = page.getByLabel('Caption 1 start time', { exact: true });
  await start.fill('00:00.500');
  await media(page).evaluate(() => { (window as any).__reviewOwnershipSeeks = []; });
  await start.press('Enter');
  // Inspect the first native seek, before a later tick can correct an obsolete start.
  await expect.poll(() => page.evaluate(() => (window as any).__reviewOwnershipSeeks[0])).toBeCloseTo(.4, 1);
  const pausedAt = () => media(page).evaluate((video: HTMLVideoElement) => video.paused && !video.seeking ? video.currentTime : -1);
  await expect.poll(pausedAt, { timeout: 8000 }).toBeCloseTo(1.1, 2);
  await replay.click();
  await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  await page.locator('[data-caption-id="c1"] .row-index').click();
  await expect.poll(pausedAt, { timeout: 8000 }).toBeCloseTo(1.1, 2);
  expect(await selected(page)).toEqual(['c1']);
});

async function holdReviewNavigation(page: Page) {
  await page.evaluate(() => {
    const schedule = window.setTimeout.bind(window); const clear = window.clearTimeout.bind(window);
    const pending = new Map<number, () => void>(); let sequence = -1;
    (window as any).__reviewHeldCount = () => pending.size;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) => {
      if (delay === 40 && typeof handler === 'function') {
        const id = sequence--; pending.set(id, () => handler(...args)); return id;
      }
      return schedule(handler, delay, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { if (id !== undefined) pending.delete(id); clear(id); };
    (window as any).__releaseReviewNavigation = () => {
      window.setTimeout = schedule; window.clearTimeout = clear;
      const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback());
    };
  });
}

for (const width of [1440, 390]) for (const owner of ['pause', 'seek'] as const) test(`a held Review handoff cannot autoplay after a newer native ${owner} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await openScope(page, 'Review');
  const before = structuredClone(state.projects[0]);
  await holdReviewNavigation(page);
  try {
    await review(page).getByRole('button', { name: 'Skip', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__reviewHeldCount())).toBe(1);
    await expect(page.locator('.caption-row[data-caption-id="c2"]')).toHaveClass(/selected-range/);
    await media(page).focus();
    if (owner === 'seek') {
      await media(page).evaluate((video: HTMLVideoElement) => { video.currentTime = 3; });
      await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.seeking && video.currentTime >= 2.99)).toBe(true);
    } else {
      await media(page).evaluate(async (video: HTMLVideoElement) => { await video.play(); });
      await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
      await media(page).evaluate((video: HTMLVideoElement) => video.pause());
      await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    }
    const time = await media(page).evaluate((video: HTMLVideoElement) => video.currentTime);
    const selection = await selected(page);
    await page.evaluate(() => (window as any).__releaseReviewNavigation());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    expect(await media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(time, 2);
    await expect(media(page)).toBeFocused(); await sameEvidence(page, before, selection);
  } finally { await page.evaluate(() => (window as any).__releaseReviewNavigation?.()); }
});

for (const [exit, width] of [['Escape', 1440], ['Show all captions', 390]] as const) test(`closing Review through ${exit} cancels its queued autoplay at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); await openScope(page, 'Review');
  const before = structuredClone(state.projects[0]); await holdReviewNavigation(page);
  try {
    await review(page).getByRole('button', { name: 'Skip', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__reviewHeldCount())).toBe(1);
    const selection = await selected(page); const time = await media(page).evaluate((video: HTMLVideoElement) => video.currentTime);
    if (exit === 'Escape') {
      const entry = page.locator('.stage-rail').getByRole('button', { name: /^Review/ });
      await entry.focus(); await entry.press('Escape');
    } else await review(page).getByRole('button', { name: 'Show all captions', exact: true }).click();
    await expect(review(page)).toHaveCount(0);
    await page.evaluate(() => (window as any).__releaseReviewNavigation());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await media(page).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    expect(await media(page).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(time, 2);
    await sameEvidence(page, before, selection);
  } finally { await page.evaluate(() => (window as any).__releaseReviewNavigation?.()); }
});

test('an ordinary caption save acknowledgement preserves the newer queued Review playback handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openScope(page, 'Review');
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); let writes = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON(); writes++; await pending;
    state.projects[0] = { ...state.projects[0], captions: body.captions };
    return route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  try {
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Saved before moving to the next decision កម្ពុជា');
    await page.locator('.save-action').click(); await expect.poll(() => writes).toBe(1);
    await holdReviewNavigation(page); await review(page).getByRole('button', { name: 'Skip', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__reviewHeldCount())).toBe(1);
    const selection = await selected(page); release();
    await expect(page.locator('.save-action-label')).toHaveText('Saved');
    await expect.poll(() => page.evaluate(() => (window as any).__reviewHeldCount())).toBe(1);
    expect(await selected(page)).toEqual(selection);
    await page.evaluate(() => (window as any).__releaseReviewNavigation());
    await expect.poll(() => media(page).evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
    expect(await selected(page)).toEqual(selection); expect(writes).toBe(1);
    expect(await page.evaluate(() => (window as any).__reviewOwnershipNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
    expect(state.projects[0].captions[0].text).toBe('Saved before moving to the next decision កម្ពុជា');
  } finally { release(); await page.evaluate(() => (window as any).__releaseReviewNavigation?.()); }
});
