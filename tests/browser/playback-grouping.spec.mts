import { test, expect, type Page } from '@playwright/test';
import type { CaptionMode, CorrectionEvent, ProcessingJob, RegenerationProposal, TimedToken } from '@kcs/shared';
import { segmentTimedTokens } from '../../apps/server/src/services/segmenter.js';
import { preserveCaptionLocks } from '../../apps/server/src/services/caption-locks.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function grouping(page: Page) {
  await page.getByRole('button', { name: 'Caption grouping', exact: true }).click();
  return page.locator('.controls-card');
}
async function activity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}
function preview(): RegenerationProposal {
  return { id: 'proposal-old', projectId: 'landscape', projectTitle: 'Audit landscape',
    createdAt: '2026-01-01', expiresAt: '2027-01-01', startMs: 100, endMs: 1300,
    lockedCaptionsPreserved: 0, unchangedCount: 0, changes: [], passNumber: 1, strategy: 'standard',
    currentCaptions: [], proposedCaptions: [{ id: 'old', text: 'OLD PROJECT PREVIEW', startMs: 100, endMs: 1300 }] };
}
function completedJob(): ProcessingJob {
  return { id: 'old-job', type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'completed', stage: 'complete', progress: 100, message: 'Preview ready', canResume: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', proposalId: 'proposal-old' };
}
function correctionEvent(projectId = 'second'): CorrectionEvent {
  return {
    id: 'correction-second-c1', projectId, projectTitle: `Audit ${projectId}`, captionId: 'c1',
    startMs: 200, endMs: 1000, originalText: 'កម្ពុជា CapCut', correctedText: 'កម្ពុជា CapCut corrected',
    suggestionKind: 'review', suggestedVocabularyLine: 'CapCut', status: 'pending', createdAt: '2026-01-01',
  };
}
function completedResultJob(): ProcessingJob {
  return {
    id: 'result-job', type: 'transcribe', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'completed', stage: 'complete', progress: 100, message: 'Result ready', canResume: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', resultProjectId: 'second',
  };
}
function queuedRegenerationJob(id = 'queued-regeneration'): ProcessingJob {
  return {
    id, type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'queued', stage: 'queued', progress: 0, message: 'Queued', canResume: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
}

test('changing the slider applies the requested limit only on Apply grouping', async ({ page }) => {
  const current = state.projects[0];
  const tokens: TimedToken[] = ['ខ្មែរ', 'កម្ពុជា', 'ភាសា', 'សួស្តី', 'ខ្មែរ', 'កម្ពុជា'].map((text, i) => ({
    id: `t${i}`, text, spaceBefore: false, startMs: i * 180, endMs: (i + 1) * 180,
    timingSource: 'stt', alignmentScore: 1, confidence: 1,
  }));
  current.mode = 'dynamic';
  current.transcript!.tokens = tokens;
  current.captions = segmentTimedTokens(tokens, { mode: 'dynamic', maxChars: 10 });
  const before = current.captions.map((caption) => caption.text);
  const requests: Array<{ mode: CaptionMode; maxChars: number; expectedMedia: { filename: string; size: number } }> = [];
  await page.route('**/api/projects/landscape/resegment', async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    current.mode = body.mode;
    current.captions = preserveCaptionLocks(current.captions, segmentTimedTokens(tokens, body));
    await route.fulfill({ json: current });
  });
  await openProject(page); const controls = await grouping(page);
  const slider = controls.getByRole('slider');
  for (const value of ['10', '20', '30']) await slider.fill(value);
  expect(requests).toHaveLength(0);
  expect(current.captions.map((caption) => caption.text)).toEqual(before);
  await controls.getByRole('button', { name: 'Apply grouping', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({
    mode: 'dynamic',
    maxChars: 30,
    expectedMedia: { filename: current.media.filename, size: current.media.size },
  });
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(current.captions[0].text);
  expect(current.captions.map((caption) => caption.text)).not.toEqual(before);
  await controls.getByRole('button', { name: /^Word/ }).click();
  await expect(slider).toBeDisabled();
  await expect(controls).toContainText('not a word count');
});

test('failed edit-save prevents regrouping and keeps the draft', async ({ page }) => {
  let regroupCalls = 0;
  await page.route('**/api/projects/landscape/captions', route => route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } }));
  await page.route('**/api/projects/landscape/resegment', route => { regroupCalls++; return route.fulfill({ json: state.projects[0] }); });
  await openProject(page); const controls = await grouping(page);
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.fill('Correction that must not disappear');
  await controls.getByRole('button', { name: 'Apply grouping', exact: true }).click();
  await page.getByRole('button', { name: 'Save and regroup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic save failure');
  await expect(text).toHaveValue('Correction that must not disappear');
  expect(regroupCalls).toBe(0);
});

test('old proposal image and loop do not follow a switch to another video', async ({ page }) => {
  state.jobs = [completedJob()];
  await page.route('**/regeneration-proposals/proposal-old', route => route.fulfill({ json: preview() }));
  await openProject(page);
  const dialog = await activity(page);
  await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(page.locator('.preview-version-badge')).toBeVisible();
  await seek(page, 500);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('alt', 'OLD PROJECT PREVIEW');
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
  await expect(page.locator('.preview-version-badge')).toHaveCount(0);
  await seek(page, 1800);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { Object.defineProperty(video, 'paused', { configurable: true, value: false }); video.dispatchEvent(new Event('timeupdate')); });
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.8, 1);
  await expect(page.locator('.native-caption-image')).not.toHaveAttribute('alt', 'OLD PROJECT PREVIEW');
});

test('a delayed Activity proposal response cannot replace newer navigation', async ({ page }) => {
  state.jobs = [completedJob()];
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/regeneration-proposals/proposal-old', async route => { requested = true; await pending; await route.fulfill({ json: preview() }); });
  await openProject(page); const dialog = await activity(page);
  await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  const response = page.waitForResponse(r => r.url().endsWith('/regeneration-proposals/proposal-old'));
  release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Allow the response handler and React commit; assert the current project, not just absence of a toast.
  await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
  await expect(page.locator('.preview-version-badge')).toHaveCount(0);
});

test('caption save retains the same video element and position', async ({ page }) => {
  await openProject(page); await seek(page, 2400);
  await page.locator('video').evaluate(video => { (window as any).__sourceBeforeSave = video; });
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Edited without reloading video');
  const save = page.waitForResponse(r => r.url().endsWith('/captions') && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s'); await save;
  await expect.poll(() => page.locator('video').evaluate(video => video === (window as any).__sourceBeforeSave)).toBe(true);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(2.4, 1);
});

test('playback retry reloads media without resetting caption edits or auto-playing', async ({ page }) => {
  await openProject(page); await seek(page, 2200);
  const caption = await page.getByLabel('Caption 1 text', { exact: true }).inputValue();
  await page.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
  await expect(page.getByRole('button', { name: 'Retry playback', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry playback', exact: true }).click();
  await expect(page.locator('.source-media-status')).toHaveCount(0);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(2.2, 1);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(caption);
});

test('committed media replacement with cleanup warnings still publishes the replacement', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const replacement = structuredClone(state.projects[0]);
  replacement.updatedAt = '2026-01-02T00:00:00.000Z';
  replacement.media = {
    ...replacement.media,
    filename: 'landscape-replacement.mp4',
    originalName: 'replacement.mp4',
    size: 7000,
    url: '/media/landscape-replacement.mp4',
  };
  replacement.captions = [];
  replacement.transcript = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    requested = true;
    await gate;
    state.projects[0] = structuredClone(replacement);
    await route.fulfill({ json: { ...replacement, replacementCleanupWarnings: ['old-media'] } });
  });
  try {
    await openProject(page);
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'replacement.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('synthetic replacement media'),
    });
    await expect.poll(() => requested).toBe(true);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit typed while warning replacement is pending');
    release();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape-replacement.mp4');
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveCount(0);
    const warning = page.locator('.toast.notice').filter({ hasText: 'the previous source file' });
    await expect(warning).toContainText('Replacement saved.');
    await expect(warning).toContainText('keep working with the replacement');
    const recovery = page.locator('.replacement-edit-recovery');
    await expect(recovery).toContainText('were not applied to the replacement');
    await expect(recovery.getByRole('button', { name: 'Copy recovery', exact: true })).toBeVisible();
  } finally { release(); }
});

test('replacement recovery preserves old-media text, timing, order, locks, approval and source identity', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  let savedBeforeReplacement = '';
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON();
    savedBeforeReplacement = body.captions[0].text;
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    requested = true;
    const replacement = structuredClone(state.projects[0]);
    replacement.updatedAt = '2026-01-03T00:00:00.000Z';
    replacement.media = {
      ...replacement.media,
      filename: 'landscape-clean-replacement.mp4',
      originalName: 'clean-replacement.mp4',
      size: 7100,
      url: '/media/landscape-clean-replacement.mp4',
    };
    replacement.captions = [];
    replacement.transcript = null;
    await gate;
    state.projects[0] = structuredClone(replacement);
    await route.fulfill({ json: replacement });
  });
  try {
    await openProject(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Stable edit saved before replacement');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'clean-replacement.mp4', mimeType: 'video/mp4', buffer: Buffer.from('clean replacement'),
    });
    await expect.poll(() => requested).toBe(true);
    expect(savedBeforeReplacement).toBe('Stable edit saved before replacement');
    await field.fill('Later edit that belongs to the old media');
    await page.getByLabel('Caption 1 start time', { exact: true }).fill('00:00.777');
    const row = page.locator('[data-caption-id="c1"]');
    await page.getByLabel('More actions for caption 1', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Lock text', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByLabel('More actions for caption 1', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Lock timing', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await row.getByRole('button', { name: 'Approve caption', exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value: string) => { (window as any).__copiedReplacementEdits = value; } },
      });
    });
    release();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape-clean-replacement.mp4');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveCount(0);
    await expect(page.locator('.project-title')).toContainText('clean-replacement.mp4 · saved');
    const recovery = page.locator('.replacement-edit-recovery');
    await expect(recovery).toContainText('belong to that previous media');
    await recovery.getByRole('button', { name: 'Copy recovery', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const raw = (window as any).__copiedReplacementEdits;
      return raw ? JSON.parse(raw) : null;
    })).not.toBeNull();
    const payload = await page.evaluate(() => JSON.parse((window as any).__copiedReplacementEdits));
    expect(payload.projectId).toBe('landscape');
    expect(payload.media).toEqual({ filename: 'landscape.mp4', originalName: 'landscape.mp4', size: 5000 });
    expect(payload.captions.map((item: any) => item.id)).toEqual(['c1', 'c2', 'c3']);
    expect(payload.captions[0]).toMatchObject({
      text: 'Later edit that belongs to the old media',
      startMs: 777,
      textLocked: true,
      timingLocked: true,
      approved: true,
    });
  } finally { release(); }
});

test('separate replacement recoveries are retained instead of silently overwriting an earlier one', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>((resolve) => releases.push(resolve)));
  let calls = 0;
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    const call = calls++;
    const current = structuredClone(state.projects[0]);
    const replacement = structuredClone(current);
    replacement.updatedAt = `2026-01-0${call + 4}T00:00:00.000Z`;
    replacement.media = {
      ...replacement.media,
      filename: call === 0 ? 'replacement-one.mp4' : 'replacement-two.mp4',
      originalName: call === 0 ? 'replacement-one.mp4' : 'replacement-two.mp4',
      size: 7200 + call,
      url: call === 0 ? '/media/replacement-one.mp4' : '/media/replacement-two.mp4',
    };
    replacement.captions = [];
    replacement.transcript = null;
    await gates[call];
    state.projects[0] = structuredClone(replacement);
    await route.fulfill({ json: replacement });
  });
  try {
    await openProject(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value: string) => { ((window as any).__replacementCopies ||= []).push(value); } },
      });
    });
    const firstField = page.getByLabel('Caption 1 text', { exact: true });
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'replacement-one.mp4', mimeType: 'video/mp4', buffer: Buffer.from('replacement one'),
    });
    await expect.poll(() => calls).toBe(1);
    await firstField.fill('FIRST OLD-MEDIA RECOVERY');
    releases[0]();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/replacement-one.mp4');
    await expect(page.locator('.replacement-edit-recovery')).toHaveCount(1);

    state.projects[0].captions = [{
      id: 'c-new', startMs: 300, endMs: 1300, text: 'NEW MEDIA CAPTION', textLocked: false, timingLocked: false, approved: false,
    }];
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    const secondField = page.getByLabel('Caption 1 text', { exact: true });
    await expect(secondField).toHaveValue('NEW MEDIA CAPTION');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'replacement-two.mp4', mimeType: 'video/mp4', buffer: Buffer.from('replacement two'),
    });
    await expect.poll(() => calls).toBe(2);
    await secondField.fill('SECOND OLD-MEDIA RECOVERY');
    releases[1]();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/replacement-two.mp4');

    const recoveries = page.locator('.replacement-edit-recovery');
    await expect(recoveries).toHaveCount(2);
    await recoveries.nth(0).getByRole('button', { name: 'Copy recovery', exact: true }).click();
    await recoveries.nth(1).getByRole('button', { name: 'Copy recovery', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__replacementCopies?.length || 0)).toBe(2);
    const copies = await page.evaluate(() => (window as any).__replacementCopies.map((raw: string) => JSON.parse(raw)));
    expect(copies[0].media.filename).toBe('landscape.mp4');
    expect(copies[0].captions[0].text).toBe('FIRST OLD-MEDIA RECOVERY');
    expect(copies[1].media.filename).toBe('replacement-one.mp4');
    expect(copies[1].captions[0].text).toBe('SECOND OLD-MEDIA RECOVERY');
  } finally {
    for (const release of releases) release();
  }
});

test('failed replacement keeps old media and edits typed while the request is pending', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route('**/api/projects/landscape/replace-media', async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ status: 500, json: { error: 'Synthetic replacement failure' } });
  });
  try {
    await openProject(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'failed-replacement.mp4', mimeType: 'video/mp4', buffer: Buffer.from('failed replacement'),
    });
    await expect.poll(() => requested).toBe(true);
    await field.fill('Keep this edit after replacement failure');
    release();
    await expect(page.getByRole('alert')).toContainText('Synthetic replacement failure');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    await expect(field).toHaveValue('Keep this edit after replacement failure');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('.replacement-edit-recovery')).toHaveCount(0);
  } finally { release(); }
});

test('Khmer spacing applies the server result when unchanged and preserves a newer draft while a later cleanup is pending', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const bodies: any[] = [];
  await page.route('**/api/projects/landscape/normalize-khmer-spacing', async (route) => {
    calls += 1;
    bodies.push(route.request().postDataJSON());
    const response = structuredClone(state.projects[0]);
    response.captions[0] = { ...response.captions[0], text: calls === 1 ? 'SERVER CLEANED KHMER' : 'SERVER CLEANED AGAIN', approved: true };
    response.updatedAt = `2026-01-0${calls + 3}T00:00:00.000Z`;
    if (calls === 2) await gate;
    state.projects[0] = structuredClone(response);
    await route.fulfill({ json: response });
  });
  try {
    await openProject(page);
    const controls = await grouping(page);
    const clean = controls.getByRole('button', { name: /Clean Khmer spacing/ });
    await clean.click();
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('SERVER CLEANED KHMER');
    await expect(page.locator('.project-title')).toContainText('saved');
    expect(bodies[0].expectedMedia).toEqual({ filename: state.projects[0].media.filename, size: state.projects[0].media.size });

    await clean.click();
    await expect.poll(() => calls).toBe(2);
    await field.fill('NEWER TEXT WHILE KHMER CLEANUP IS PENDING');
    release();
    await expect(field).toHaveValue('NEWER TEXT WHILE KHMER CLEANUP IS PENDING');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('.toast.notice').filter({ hasText: 'Khmer spacing cleanup was saved' })).toBeVisible();
  } finally { release(); }
});

test('timing cleanup applies normally and cannot overwrite newer timing, lock, approval, or text edits', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route('**/api/projects/landscape/postprocess-timing', async (route) => {
    calls += 1;
    const body = route.request().postDataJSON();
    expect(body.expectedMedia).toEqual({ filename: state.projects[0].media.filename, size: state.projects[0].media.size });
    const response = structuredClone(state.projects[0]);
    response.captions[0] = {
      ...response.captions[0],
      startMs: calls === 1 ? 125 : 250,
      endMs: calls === 1 ? 1125 : 1250,
      text: calls === 1 ? response.captions[0].text : 'SERVER TIMING RESPONSE',
      timingSource: 'manual',
      timingLocked: false,
      textLocked: calls === 2,
      approved: calls === 2,
    };
    if (calls === 2) await gate;
    state.projects[0] = structuredClone(response);
    await route.fulfill({ json: response });
  });
  const invokeTimingCleanup = async () => {
    await page.getByRole('button', { name: 'Fix safe timing', exact: true }).click();
    await page.getByRole('button', { name: 'Apply cleanup', exact: true }).click();
  };
  try {
    await openProject(page);
    await page.locator('header').getByRole('button', { name: /^Review/ }).click();
    await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
    await invokeTimingCleanup();
    await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.125');

    await invokeTimingCleanup();
    await expect.poll(() => calls).toBe(2);
    const text = page.getByLabel('Caption 1 text', { exact: true });
    const start = page.getByLabel('Caption 1 start time', { exact: true });
    await text.fill('NEWER TEXT DURING TIMING CLEANUP');
    await start.fill('00:00.777');
    await page.getByLabel('More actions for caption 1', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Lock timing', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    release();
    await expect(text).toHaveValue('NEWER TEXT DURING TIMING CLEANUP');
    await expect(start).toHaveValue('00:00.777');
    await expect(start).toBeDisabled();
    const row = page.locator('[data-caption-id="c1"]');
    await expect(row).toContainText('Timing locked');
    await expect(row.getByRole('button', { name: 'Approve caption and move to the next review item', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('.toast.notice').filter({ hasText: 'Timing cleanup was saved' })).toBeVisible();
  } finally { release(); }
});

test('proposal apply publishes normally and preserves a newer local draft while a later apply is pending', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.jobs = [completedJob()];
  await page.route('**/regeneration-proposals/proposal-old', async (route) => route.fulfill({ json: preview() }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route('**/api/projects/landscape/regeneration-proposals/proposal-old/apply', async (route) => {
    calls += 1;
    const response = structuredClone(state.projects[0]);
    response.captions[0] = {
      ...response.captions[0],
      text: calls === 1 ? 'SERVER APPLIED PROPOSAL' : 'SERVER SECOND PROPOSAL',
      startMs: calls === 1 ? 150 : 320,
      textLocked: calls === 2,
      approved: true,
    };
    if (calls === 2) await gate;
    state.projects[0] = structuredClone(response);
    await route.fulfill({ json: response });
  });
  const openProposal = async () => {
    const dialog = await activity(page);
    await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Live regeneration review', exact: true })).toBeVisible();
  };
  try {
    await openProject(page);
    await openProposal();
    await page.getByRole('button', { name: 'Accept proposed range', exact: true }).click();
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('SERVER APPLIED PROPOSAL');
    await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.150');

    await openProposal();
    await page.getByRole('button', { name: 'Accept proposed range', exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await field.fill('NEWER EDIT DURING PROPOSAL APPLY');
    release();
    await expect(field).toHaveValue('NEWER EDIT DURING PROPOSAL APPLY');
    await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.150');
    await expect(page.locator('[data-caption-id="c1"]')).not.toContainText('Text locked');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('.toast.notice').filter({ hasText: 'regeneration was applied on disk' })).toBeVisible();
  } finally { release(); }
});

test('History restore publishes normally and preserves a newer local draft while a later restore is pending', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const historyEntry = {
    id: 'history-1', label: 'Synthetic restore point', source: 'manual-save', createdAt: '2026-01-01T00:00:00.000Z',
    captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0,
  };
  await page.route('**/api/projects/landscape/history', async (route) => route.fulfill({ json: [historyEntry] }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route('**/api/projects/landscape/history/history-1/restore', async (route) => {
    calls += 1;
    const response = structuredClone(state.projects[0]);
    response.captions[0] = {
      ...response.captions[0],
      text: calls === 1 ? 'SERVER RESTORED HISTORY' : 'SERVER SECOND RESTORE',
      startMs: calls === 1 ? 175 : 400,
      timingLocked: calls === 2,
      approved: true,
    };
    if (calls === 2) await gate;
    state.projects[0] = structuredClone(response);
    await route.fulfill({ json: response });
  });
  const restore = async () => {
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
  };
  try {
    await openProject(page);
    await restore();
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('SERVER RESTORED HISTORY');
    await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.175');

    await restore();
    await expect.poll(() => calls).toBe(2);
    await field.fill('NEWER EDIT DURING HISTORY RESTORE');
    await page.getByLabel('Caption 1 start time', { exact: true }).fill('00:00.888');
    await page.getByLabel('Caption 1 start time', { exact: true }).press('Enter');
    release();
    await expect(field).toHaveValue('NEWER EDIT DURING HISTORY RESTORE');
    await expect(page.getByLabel('Caption 1 start time', { exact: true })).toHaveValue('00:00.888');
    await expect(page.locator('[data-caption-id="c1"]')).not.toContainText('Timing locked');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('.toast.notice').filter({ hasText: 'History was restored on disk' })).toBeVisible();
  } finally { release(); }
});

test('typing during the pre-apply save keeps the newer draft and does not regroup', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saving = false; let regroupCalls = 0;
  await page.route('**/api/projects/landscape/captions', async route => {
    const snapshot = route.request().postDataJSON().captions;
    saving = true; await gate;
    state.projects[0].captions = snapshot;
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/projects/landscape/resegment', route => { regroupCalls++; return route.fulfill({ json: state.projects[0] }); });
  try {
    await openProject(page); const controls = await grouping(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('First correction');
    await controls.getByRole('button', { name: 'Apply grouping', exact: true }).click();
    await page.getByRole('button', { name: 'Save and regroup', exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await field.fill('Newer correction while saving');
    release();
    await expect(page.getByRole('button', { name: 'Apply grouping', exact: true })).toBeEnabled();
    await expect(field).toHaveValue('Newer correction while saving');
    expect(regroupCalls).toBe(0);
  } finally { release(); }
});

test('saving accuracy context cannot publish stale caption text over newer input', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  let fulfilled = false;
  await page.route('**/api/projects/landscape/context', async (route) => {
    const body = route.request().postDataJSON();
    const response = structuredClone(state.projects[0]);
    response.transcriptionContext = body;
    requested = true;
    await gate;
    state.projects[0].transcriptionContext = body;
    fulfilled = true;
    await route.fulfill({ json: response });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    await page.getByLabel('What is this clip about?', { exact: true }).fill('Context saved while captions keep changing');
    await page.getByRole('button', { name: 'Save for project', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Newer caption while context save is pending');
    release();
    await expect.poll(() => fulfilled).toBe(true);
    await expect(field).toHaveValue('Newer caption while context save is pending');
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  } finally { release(); }
});

test('failed dirty-caption save blocks correction navigation', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.correctionEvents = [correctionEvent()];
  let saveCalls = 0;
  const saveSources: string[] = [];
  let targetReads = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    saveCalls += 1;
    saveSources.push(route.request().postDataJSON().source);
    await route.fulfill({ status: 500, json: { error: 'Synthetic correction pre-save failure' } });
  });
  await page.route('**/api/projects/second', async (route) => {
    targetReads += 1;
    await route.fulfill({ json: state.projects[1] });
  });
  await openProject(page);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await field.fill('Dirty correction that must be saved before leaving');
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correction inbox/ }).click();
  await page.getByRole('button', { name: 'Play spoken audio', exact: true }).click();
  await expect.poll(() => saveCalls).toBe(2);
  expect(saveSources).toEqual(['text-edit', 'manual-save']);
  await expect(page.getByRole('alert')).toContainText('Synthetic correction pre-save failure');
  expect(targetReads).toBe(0);
  await expect(field).toHaveValue('Dirty correction that must be saved before leaving');
  await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
  await expect(page.locator('.project-title')).toContainText('autosave pending');
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
});

test('correction project read keeps edits typed after its successful pre-save', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.correctionEvents = [correctionEvent()];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let targetReadStarted = false;
  let targetReadFulfilled = false;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON();
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/projects/second', async (route) => {
    const response = structuredClone(state.projects[1]);
    targetReadStarted = true;
    await gate;
    targetReadFulfilled = true;
    await route.fulfill({ json: response });
  });
  try {
    await openProject(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Saved before correction navigation');
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Correction inbox/ }).click();
    await page.getByRole('button', { name: 'Play spoken audio', exact: true }).click();
    await expect.poll(() => targetReadStarted).toBe(true);
    expect(state.projects[0].captions[0].text).toBe('Saved before correction navigation');
    await field.fill('Newer edit while correction project is loading');
    release();
    await expect.poll(() => targetReadFulfilled).toBe(true);
    await expect(field).toHaveValue('Newer edit while correction project is loading');
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  } finally { release(); }
});

test('job result read cannot replace edits typed after the pre-save check', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.jobs = [completedResultJob()];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let targetReadStarted = false;
  let targetReadFulfilled = false;
  await page.route('**/api/projects/second', async (route) => {
    const response = structuredClone(state.projects[1]);
    targetReadStarted = true;
    await gate;
    targetReadFulfilled = true;
    await route.fulfill({ json: response });
  });
  try {
    await openProject(page);
    const dialog = await activity(page);
    await dialog.getByRole('button', { name: 'Open result', exact: true }).click();
    await expect.poll(() => targetReadStarted).toBe(true);
    await dialog.getByRole('button', { name: 'Close Activity', exact: true }).click();
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Newer edit while result project is loading');
    release();
    await expect.poll(() => targetReadFulfilled).toBe(true);
    await expect(field).toHaveValue('Newer edit while result project is loading');
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  } finally { release(); }
});

test('full regeneration does not submit after Home invalidates its pending prerequisite save, even after reopening the same project', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saving = false;
  let jobCalls = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON();
    saving = true;
    await gate;
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/jobs/regenerate-range', async (route) => {
    jobCalls += 1;
    const job = queuedRegenerationJob('obsolete-full-regeneration');
    state.jobs.push(job);
    await route.fulfill({ status: 202, json: job });
  });
  try {
    await openProject(page);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Dirty caption before full regeneration');
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    await page.getByRole('button', { name: 'Preview full regeneration', exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await page.getByLabel('Back to projects', { exact: true }).click();
    release();
    await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    await page.waitForTimeout(50);
    expect(jobCalls).toBe(0);
  } finally { release(); }
});

test('selection regeneration does not submit after navigation invalidates its pending prerequisite save', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let saving = false;
  let jobCalls = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON();
    saving = true;
    await gate;
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/jobs/regenerate-range', async (route) => {
    jobCalls += 1;
    const job = queuedRegenerationJob('obsolete-selection-regeneration');
    state.jobs.push(job);
    await route.fulfill({ status: 202, json: job });
  });
  try {
    await openProject(page);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Dirty caption before selection regeneration');
    await page.getByRole('button', { name: /^Review/ }).first().click();
    await page.getByRole('button', { name: 'Improve…', exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await page.getByLabel('Back to projects', { exact: true }).click();
    release();
    await expect(page.getByRole('button', { name: /Audit second/ })).toBeVisible();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
    await page.waitForTimeout(50);
    expect(jobCalls).toBe(0);
  } finally { release(); }
});

test('captioned-video export does not submit after navigation during its warning confirmation', async ({ page }) => {
  let exportCalls = 0;
  await page.route('**/api/video-export/landscape/jobs', async (route) => {
    exportCalls += 1;
    const job: ProcessingJob = {
      id: 'obsolete-video-export', type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape',
      status: 'queued', stage: 'queued', progress: 0, message: 'Queued', canResume: false,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    await route.fulfill({ status: 202, json: job });
  });
  await openProject(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Captioned video/ }).click();
  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Render with review warnings?');
  await page.getByLabel('Back to projects', { exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
  await page.getByRole('button', { name: 'Render anyway', exact: true }).click();
  await page.waitForTimeout(50);
  expect(exportCalls).toBe(0);
});

test('unchanged full-regeneration session still submits exactly once after saving', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  let saveCalls = 0;
  let jobCalls = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    saveCalls += 1;
    const body = route.request().postDataJSON();
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/jobs/regenerate-range', async (route) => {
    jobCalls += 1;
    const job = queuedRegenerationJob('positive-full-regeneration');
    state.jobs.push(job);
    await route.fulfill({ status: 202, json: job });
  });
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Legitimate dirty caption before regeneration');
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await page.getByRole('button', { name: 'Preview full regeneration', exact: true }).click();
  await expect.poll(() => jobCalls).toBe(1);
  expect(saveCalls).toBe(1);
  expect(jobCalls).toBe(1);
});
