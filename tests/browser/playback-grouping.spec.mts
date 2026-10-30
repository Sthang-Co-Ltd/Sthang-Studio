import { test, expect, type Page } from '@playwright/test';
import type { CaptionMode, CorrectionEvent, ProcessingJob, RegenerationProposal, TimedToken } from '@kcs/shared';
import { segmentTimedTokens } from '../../apps/server/src/services/segmenter.js';
import { preserveCaptionLocks } from '../../apps/server/src/services/caption-locks.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function confirmResetReplacement(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Replace media', exact: true });
  await dialog.getByRole('radio', { name: /Start over/ }).check();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Start over with this media?' }).getByRole('button', { name: 'Replace and clear captions', exact: true }).click();
}
async function grouping(page: Page) {
  await page.getByRole('button', { name: 'Caption grouping', exact: true }).click();
  return page.locator('.controls-card');
}
async function activity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}
async function history(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /History/ }).click();
  return page.getByRole('dialog', { name: 'Project history', exact: true });
}
async function selectedCaptionIds(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-caption-id')));
}
async function finishCaptionAcknowledgement(page: Page, release: () => void) {
  const response = page.waitForResponse((value) => value.url().endsWith('/captions') && value.request().method() === 'PUT');
  release();
  await (await response).finished();
  // Wait for the response handler and React commit, then assert UI state rather
  // than treating the network response alone as an acknowledged save.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
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
  await expect(controls).toContainText('Character limit, not word count.');
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

for (const decision of ['cancel', 'navigate'] as const) {
  test(`regrouping intent: ${decision} while confirmation is pending`, async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    const corrected = `Confirmed wording kept on ${decision}`;
    const saveBodies: any[] = [];
    const regroupBodies: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/projects/landscape/captions', async (route) => {
      const body = route.request().postDataJSON();
      saveBodies.push(body);
      await gate;
      state.projects[0].captions = structuredClone(body.captions);
      await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
    });
    await page.route('**/api/projects/landscape/resegment', async (route) => {
      regroupBodies.push(route.request().postDataJSON());
      await route.fulfill({ json: state.projects[0] });
    });
    try {
      await openProject(page);
      const controls = await grouping(page);
      const field = page.getByLabel('Caption 1 text', { exact: true });
      await field.fill(corrected);
      await controls.getByRole('button', { name: 'Apply grouping', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Regroup from timed wording?', exact: true });
      await expect(confirmation).toBeVisible();
      // Blurring edited caption text starts its normal save independently of
      // the decision. Keep that acknowledgement pending across cancellation.
      await expect.poll(() => saveBodies.length).toBe(1);
      if (decision === 'navigate') {
        // The modal traps physical focus. Exercise the real Home handler as an
        // external navigation request while its confirmation remains unresolved.
        await page.getByLabel('Back to projects', { exact: true }).evaluate((button: HTMLButtonElement) => button.click());
        await confirmation.getByRole('button', { name: 'Save and regroup', exact: true }).click();
      } else {
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).last().click();
      }
      release();
      if (decision === 'cancel') {
        await expect(controls.getByRole('button', { name: 'Apply grouping', exact: true })).toBeEnabled();
        await expect(field).toHaveValue(corrected);
        await expect(page.locator('.save-action')).toBeDisabled();
        await page.getByLabel('Back to projects', { exact: true }).click();
      }
      const home = page.getByRole('button', { name: /Audit landscape/ });
      await expect.soft(home).toBeVisible();
      expect(regroupBodies).toEqual([]);
      expect(saveBodies).toHaveLength(1);
      expect(saveBodies[0].captions[0].text).toBe(corrected);
      expect(state.projects[0].captions[0].text).toBe(corrected);
      await home.click();
      await expect(field).toHaveValue(corrected);
      expect(regroupBodies).toEqual([]);
    } finally { release(); }
  });
}

test('regrouping intent: navigation after queuing cancels before API dispatch', async ({ page }) => {
  const original = structuredClone(state.projects[0].captions);
  const regroupBodies: any[] = [];
  await page.route('**/api/projects/landscape/resegment', async (route) => {
    regroupBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: state.projects[0] });
  });
  await openProject(page);
  const controls = await grouping(page);
  await controls.getByRole('button', { name: 'Apply grouping', exact: true }).evaluate((button: HTMLButtonElement) => {
    // The clean prerequisite resolves immediately. Its first continuation
    // enqueues regrouping; this microtask invokes Home before the queued callback
    // can dispatch. Both clicks execute the actual component handlers.
    button.click();
    queueMicrotask(() => {
      const home = document.querySelector<HTMLButtonElement>('button[aria-label="Back to projects"]');
      if (!home) throw new Error('Home action is missing at queued cancellation.');
      home.click();
    });
  });
  const home = page.getByRole('button', { name: /Audit landscape/ });
  await expect(home).toBeVisible();
  expect(regroupBodies).toEqual([]);
  expect(state.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/captions'))).toEqual([]);
  expect(state.projects[0].captions).toEqual(original);
  await home.click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(original[0].text);
  expect(regroupBodies).toEqual([]);
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
    await confirmResetReplacement(page);
    await expect.poll(() => requested).toBe(true);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit typed while warning replacement is pending');
    release();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape-replacement.mp4');
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveCount(0);
    const warning = page.locator('.toast.notice').filter({ hasText: 'old derived files' });
    await expect(warning).toContainText('Media replaced.');
    await expect(warning).toContainText('replacement is usable');
    const recovery = page.locator('.replacement-edit-recovery');
    await expect(recovery).toContainText('were not applied here');
    await expect(recovery.getByRole('button', { name: 'Copy recovery', exact: true })).toBeVisible();
  } finally { release(); }
});

for (const { interaction, responseTiming } of [
  { interaction: 'pointer', responseTiming: 'immediate' },
  { interaction: 'pointer', responseTiming: 'held' },
  { interaction: 'keyboard', responseTiming: 'held' },
] as const) {
  test(`caption row menu ${interaction} interaction survives the ${responseTiming} caption-save response`, async ({ page }, testInfo) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    await page.route('**/api/projects/landscape/captions', async (route) => {
      state.projects[0].captions = structuredClone(route.request().postDataJSON().captions);
      const reply = structuredClone(state.projects[0]);
      requested = true;
      if (responseTiming === 'held') await gate;
      await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
    });
    try {
      await openProject(page);
      // Preserve the original ordinary-pointer reproduction separately from the
      // recovery fixture. Do not preselect c2 or force the pointer click. Focus
      // changes may move rows; the log distinguishes lost click from menu close.
      await page.evaluate(() => {
        const records: unknown[] = [];
        (window as any).__captionMenuEvents = records;
        const record = (phase: string, event?: Event) => {
          const target = event?.target instanceof Element ? event.target : null;
          records.push({
            phase, time: performance.now(), type: event?.type,
            target: target ? { tag: target.tagName, label: target.getAttribute('aria-label'), buttonLabel: target.closest('button')?.getAttribute('aria-label'), role: target.getAttribute('role'), row: target.closest('[data-caption-id]')?.getAttribute('data-caption-id') } : null,
            rows: ['c1', 'c2'].map((id) => {
              const row = document.querySelector(`[data-caption-id="${id}"]`);
              const button = row?.querySelector('.row-more');
              const bounds = button?.getBoundingClientRect();
              return { id, className: row?.className, expanded: button?.getAttribute('aria-expanded'), button: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null };
            }),
          });
        };
        for (const type of ['pointerdown', 'mousedown', 'blur', 'focusin', 'pointerup', 'mouseup', 'click']) {
          document.addEventListener(type, (event) => { record('capture', event); queueMicrotask(() => record('after-event', event)); }, true);
        }
        const observer = new MutationObserver(() => record('menu-attribute-change'));
        document.querySelectorAll('.row-more').forEach((button) => observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] }));
      });
      await page.getByLabel('Caption 1 text', { exact: true }).fill('Stable edit saved before replacement');
      const more = page.getByLabel('More actions for caption 2', { exact: true });
      if (interaction === 'pointer') await more.click();
      else {
        // A separately labeled keyboard path, not a workaround substituted for
        // the ordinary pointer reproduction above.
        await more.focus();
        await more.press('Enter');
      }
      if (interaction === 'pointer') {
        const gesture = await page.evaluate(() => {
          const records = (window as any).__captionMenuEvents as Array<{
            phase: string; type?: string; target?: { row?: string; buttonLabel?: string };
            rows?: Array<{ id: string; button: { x: number; y: number; width: number; height: number } | null }>;
          }>;
          const start = records.findIndex((entry) => entry.phase === 'capture' && entry.type === 'pointerdown' && entry.target?.row === 'c2');
          return records.slice(start).filter((entry) => entry.phase === 'capture' && ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(entry.type ?? ''));
        });
        expect(gesture.map((entry) => entry.type)).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
        const firstBounds = gesture[0].rows?.find((row) => row.id === 'c2')?.button;
        expect(firstBounds).toBeTruthy();
        for (const entry of gesture) {
          expect(entry.target?.buttonLabel, `${entry.type} must still hit the same row action`).toBe('More actions for caption 2');
          const bounds = entry.rows?.find((row) => row.id === 'c2')?.button;
          expect(bounds).toBeTruthy();
          for (const axis of ['x', 'y', 'width', 'height'] as const) {
            expect(Math.abs(bounds![axis] - firstBounds![axis]), `${entry.type} must not move the ${axis} of the pointer target before click`).toBeLessThanOrEqual(0.5);
          }
        }
      }
      await expect.poll(() => requested).toBe(true);
      const lock = page.getByRole('menuitem', { name: 'Lock text', exact: true });
      if (responseTiming === 'held') {
        await expect(more, 'The menu must open before the held caption response is released').toHaveAttribute('aria-expanded', 'true');
        await expect(lock).toBeVisible();
        await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
        await page.evaluate(() => (window as any).__captionMenuEvents.push({ phase: 'release-caption-response', time: performance.now() }));
        const response = page.waitForResponse((value) => value.url().endsWith('/captions') && value.request().method() === 'PUT');
        release();
        await (await response).finished();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      }
      await expect(page.locator('.save-action')).toBeDisabled();
      await expect(more, 'A completed caption save must not silently discard an open row menu').toHaveAttribute('aria-expanded', 'true');
      await expect(lock).toBeVisible();
      // Check before any menu action can reselect c2 and hide a stale save's
      // reversal. An open menu alone did not catch the V4 regression.
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
      if (interaction === 'pointer') await lock.click();
      else { await lock.focus(); await lock.press('Enter'); }
      await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveAttribute('readonly', '');
      if (interaction === 'pointer') await more.click();
      else await more.press('Enter');
      const timing = page.getByRole('menuitem', { name: 'Lock timing', exact: true });
      if (interaction === 'pointer') await timing.click();
      else { await timing.focus(); await timing.press('Enter'); }
      await expect(page.getByLabel('Caption 2 start time', { exact: true })).toBeDisabled();
      const row = page.locator('[data-caption-id="c2"]');
      await row.getByRole('button', { name: 'Approve caption', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Mark caption as needing review', exact: true })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      release();
      if (!page.isClosed()) {
        const events = await page.evaluate(() => (window as any).__captionMenuEvents ?? []);
        await testInfo.attach(`caption-menu-${interaction}-${responseTiming}-events.json`, { contentType: 'application/json', body: Buffer.from(JSON.stringify(events, null, 2)) });
      }
    }
  });
}

for (const scenario of [
  { name: 'newer single selection', anchor: 'c2', end: 'c2', replyIds: ['c1', 'c2', 'c3'], selected: ['c2'], extended: ['c1', 'c2'] },
  { name: 'newer forward range', anchor: 'c2', end: 'c3', replyIds: ['c1', 'c2', 'c3'], selected: ['c2', 'c3'], extended: ['c1', 'c2'] },
  { name: 'newer reversed range', anchor: 'c3', end: 'c2', replyIds: ['c1', 'c2', 'c3'], selected: ['c2', 'c3'], extended: ['c1', 'c2', 'c3'] },
  { name: 'removed range end', anchor: 'c2', end: 'c3', replyIds: ['c1', 'c2'], selected: ['c2'], extended: ['c1', 'c2'] },
  { name: 'removed range anchor', anchor: 'c3', end: 'c2', replyIds: ['c1', 'c2'], selected: ['c2'], extended: ['c1', 'c2'] },
  { name: 'empty caption response', anchor: 'c2', end: 'c3', replyIds: [], selected: [], extended: [] },
]) {
  test(`held caption-save acknowledgement reconciles ${scenario.name}`, async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route('**/api/projects/landscape/captions', async (route) => {
      requests += 1;
      const reply = structuredClone(state.projects[0]);
      // Removed-ID and empty cases are deliberate route-mocked response
      // boundaries, not claims that an ordinary server save deletes captions.
      reply.captions = structuredClone(route.request().postDataJSON().captions)
        .filter((caption: { id: string }) => scenario.replyIds.includes(caption.id));
      await gate;
      state.projects[0] = structuredClone(reply);
      await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
    });
    try {
      await openProject(page);
      await page.getByLabel('Caption 1 text', { exact: true }).fill('Snapshot saved before newer selection');
      // Blur while c1 remains selected so the captured save predates every
      // selection below. Ordinary nonfocusable row-index targets allow Shift
      // ranges without a button's focus handler collapsing the anchor first.
      await page.locator('[data-caption-id="c1"] .row-index').click();
      await expect.poll(() => requests).toBe(1);
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
      await page.locator(`[data-caption-id="${scenario.anchor}"] .row-index`).click();
      if (scenario.end !== scenario.anchor) {
        await page.locator(`[data-caption-id="${scenario.end}"] .row-index`).click({ modifiers: ['Shift'] });
      }
      const before = scenario.anchor === scenario.end ? ['c2'] : ['c2', 'c3'];
      await expect.poll(() => selectedCaptionIds(page)).toEqual(before);
      // The removed-ID fallback is playhead-based. Observe the actual seek's
      // rendered active row before releasing the acknowledgement.
      await expect(page.locator(`[data-caption-id="${scenario.end}"]`)).toHaveClass(/\bactive\b/);
      await expect(page.locator('.save-action')).toBeEnabled();
      await finishCaptionAcknowledgement(page, release);
      await expect(page.locator('.save-action')).toBeDisabled();
      await expect(page.locator('.caption-row')).toHaveCount(scenario.replyIds.length);
      await expect.poll(() => selectedCaptionIds(page)).toEqual(scenario.selected);
      expect(requests).toBe(1);
      if (scenario.extended.length) {
        // Forward and reversed ranges contain the same IDs. Extending again
        // proves the acknowledgement also retained the original anchor.
        await page.locator('[data-caption-id="c1"] .row-index').click({ modifiers: ['Shift'] });
        await expect.poll(() => selectedCaptionIds(page)).toEqual(scenario.extended);
        await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Snapshot saved before newer selection');
      }
    } finally { release(); }
  });
}

test('direct caption approval remains clickable after editing a different caption', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit before direct pointer approval');
  const row = page.locator('[data-caption-id="c2"]');
  await expect(row).not.toHaveClass(/selected-range/);
  // No row preselection, forced click, or substituted keyboard activation.
  await row.getByRole('button', { name: 'Approve caption', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Mark caption as needing review', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toHaveClass(/selected-range/);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Edit before direct pointer approval');
  // Approval is a fresh metadata edit after the blur save. Persist it
  // explicitly instead of waiting for the deliberately long autosave delay.
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => state.projects[0].captions.find((caption) => caption.id === 'c2')?.approved).toBe(true);
  expect(state.projects[0].captions[0].text).toBe('Edit before direct pointer approval');
});

for (const action of ['More actions', 'Approve'] as const) {
  test(`dragging away from caption ${action} cancels activation and preserves subsequent keyboard navigation`, async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    await openProject(page);
    const firstText = page.getByLabel('Caption 1 text', { exact: true });
    await firstText.fill('Edit before canceled row action');
    const row = page.locator('[data-caption-id="c2"]');
    const more = page.getByLabel('More actions for caption 2', { exact: true });
    const target = action === 'More actions' ? more : row.getByRole('button', { name: 'Approve caption', exact: true });
    await expect(row).not.toHaveClass(/selected-range/);
    const bounds = await target.boundingBox();
    expect(bounds).toBeTruthy();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    try {
      await page.mouse.down();
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(row.getByRole('button', { name: 'Approve caption', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await page.mouse.move(1, 1);
    } finally { await page.mouse.up(); }
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Approve caption', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.save-action')).toBeDisabled();
    expect(state.projects[0].captions[0].text).toBe('Edit before canceled row action');
    expect(Boolean(state.projects[0].captions.find((caption) => caption.id === 'c2')?.approved)).toBe(false);

    await firstText.focus();
    // Use real Tab navigation after the canceled pointer gesture. Stale
    // pointer-origin state must not suppress keyboard focus selection.
    for (let tabs = 0; tabs < 12 && !await more.evaluate((button) => button === document.activeElement); tabs++) {
      await page.keyboard.press('Tab');
    }
    await expect(more).toBeFocused();
    await expect(row).toHaveClass(/selected-range/);
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
  });
}

test('synthetic pointer cancellation clears deferred row-action focus without activating the action', async ({ page }) => {
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).focus();
  const row = page.locator('[data-caption-id="c2"]');
  const more = page.getByLabel('More actions for caption 2', { exact: true });
  await expect(row).not.toHaveClass(/selected-range/);
  // Synthetic events isolate the pointercancel cleanup branch. This is not
  // evidence of a native touch/scroll-cancellation sequence.
  await more.dispatchEvent('pointerdown', { pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 });
  await more.dispatchEvent('pointercancel', { pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(row).not.toHaveClass(/selected-range/);
  await more.focus();
  await expect(more).toBeFocused();
  await expect(row).toHaveClass(/selected-range/);
  await expect(row.getByRole('button', { name: 'Approve caption', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await more.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
});

for (const action of ['More actions', 'Approve'] as const) {
  test(`synthetic delayed touch-compatibility focus keeps caption ${action} stationary until click`, async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    await page.route('**/api/projects/landscape/captions', async (route) => {
      state.projects[0].captions = structuredClone(route.request().postDataJSON().captions);
      const reply = structuredClone(state.projects[0]);
      requested = true;
      await gate;
      await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
    });
    try {
      await openProject(page);
      await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit before delayed compatibility focus');
      const row = page.locator('[data-caption-id="c2"]');
      const more = page.getByLabel('More actions for caption 2', { exact: true });
      const approve = row.locator('.row-approve');
      const target = action === 'More actions' ? more : approve;
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);

      // This is a synthetic event-order regression, not native touchscreen
      // evidence. Keep the ordinary .tap() tests below as separate coverage.
      // Await a timer queued AFTER pointerup, so zero-delay pointer cleanup
      // necessarily runs before the later compatibility mousedown and focus.
      const initial = await target.evaluate(async (button) => {
        const bounds = button.getBoundingClientRect();
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const pointer = { bubbles: true, cancelable: true, pointerId: 23, pointerType: 'touch', isPrimary: true, button: 0, clientX: point.x, clientY: point.y };
        button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
        button.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        return { ...point, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
      });
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(approve).toHaveAttribute('aria-pressed', 'false');

      await target.evaluate((button, point) => {
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: point.x, clientY: point.y }));
        // dispatchEvent has no native focus default, so model that step
        // explicitly after mousedown and before mouseup/click.
        (button as HTMLButtonElement).focus();
      }, initial);
      await expect(target).toBeFocused();
      await expect.poll(() => requested).toBe(true);
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(approve).toHaveAttribute('aria-pressed', 'false');
      const focusedBounds = await target.boundingBox();
      expect(focusedBounds).toBeTruthy();
      for (const axis of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(focusedBounds![axis] - initial.bounds[axis]), `Compatibility focus must not move the ${axis} of the pending action`).toBeLessThanOrEqual(0.5);
      }
      const stillUnderPointer = await target.evaluate((button, point) => document.elementFromPoint(point.x, point.y)?.closest('button') === button, initial);
      expect(stillUnderPointer, 'The original touch point must still hit the same action after compatibility focus').toBe(true);

      // Resolve each completion target from the ORIGINAL point. Dispatching
      // directly to the locator would conceal the row-moving regression.
      const completionTargets = await page.evaluate((point) => {
        return ['mouseup', 'click'].map((type) => {
          const hit = document.elementFromPoint(point.x, point.y);
          const label = hit?.closest('button')?.getAttribute('aria-label');
          hit?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 0, detail: 1, clientX: point.x, clientY: point.y }));
          return label;
        });
      }, initial);
      const targetLabel = action === 'More actions' ? 'More actions for caption 2' : 'Approve caption';
      expect(completionTargets).toEqual([targetLabel, targetLabel]);
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
      if (action === 'More actions') {
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeVisible();
      } else {
        await expect(approve).toHaveAttribute('aria-pressed', 'true');
        await expect(more).toHaveAttribute('aria-expanded', 'false');
      }

      await finishCaptionAcknowledgement(page, release);
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
      if (action === 'More actions') {
        await expect(page.locator('.save-action')).toBeDisabled();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeVisible();
      } else {
        // Approval is newer than the blur-save snapshot. Its pending metadata
        // must survive that acknowledgement and still be explicitly saveable.
        await expect(approve).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => state.projects[0].captions.find((caption) => caption.id === 'c2')?.approved).toBe(true);
      }
      expect(state.projects[0].captions[0].text).toBe('Edit before delayed compatibility focus');
    } finally { release(); }
  });
}

test('synthetic compatibility mouse release clears unused row-action focus deferral', async ({ page }) => {
  await openProject(page);
  const firstText = page.getByLabel('Caption 1 text', { exact: true });
  await firstText.focus();
  const row = page.locator('[data-caption-id="c2"]');
  const more = page.getByLabel('More actions for caption 2', { exact: true });
  await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
  // Synthetic cleanup coverage only: release a compatibility mouse press
  // without its focus or click. Await the release cleanup before later focus.
  await more.evaluate(async (button) => {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByRole('button', { name: 'Approve caption', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
  // No intervening keydown: a keyboard event would independently clear the
  // marker and hide broken mouseup cleanup from this assertion.
  await more.focus();
  await expect(more).toBeFocused();
  await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
  await more.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test.describe('touch-capable caption row actions', () => {
  test.use({ hasTouch: true });
  test('a touchscreen tap opens the caption row menu after editing another caption', async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    await openProject(page);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit before touchscreen row action');
    const row = page.locator('[data-caption-id="c2"]');
    const more = page.getByLabel('More actions for caption 2', { exact: true });
    await expect(row).not.toHaveClass(/selected-range/);
    await more.tap();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveClass(/selected-range/);
    await expect(page.locator('.save-action')).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Lock text', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Lock text', exact: true }).tap();
    await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveAttribute('readonly', '');
    expect(state.projects[0].captions[0].text).toBe('Edit before touchscreen row action');
  });

  test('a touchscreen row menu retains its exact selection after a held caption-save acknowledgement', async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    await page.route('**/api/projects/landscape/captions', async (route) => {
      state.projects[0].captions = structuredClone(route.request().postDataJSON().captions);
      const reply = structuredClone(state.projects[0]);
      requested = true;
      await gate;
      await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
    });
    try {
      await openProject(page);
      await page.getByLabel('Caption 1 text', { exact: true }).fill('Edit before held touchscreen row action');
      const more = page.getByLabel('More actions for caption 2', { exact: true });
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c1']);
      // Preserve the original ordinary tap without preselection or forced input.
      await more.tap();
      await expect.poll(() => requested).toBe(true);
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
      await expect(page.locator('.save-action')).toBeEnabled();
      await finishCaptionAcknowledgement(page, release);
      await expect(page.locator('.save-action')).toBeDisabled();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => selectedCaptionIds(page)).toEqual(['c2']);
      const lock = page.getByRole('menuitem', { name: 'Lock text', exact: true });
      await expect(lock).toBeVisible();
      await lock.tap();
      await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveAttribute('readonly', '');
      expect(state.projects[0].captions[0].text).toBe('Edit before held touchscreen row action');
    } finally { release(); }
  });
});

test('replacement recovery retains late text/timing and pre-existing locks/approval while the pending modal blocks row actions', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  // This case tests replacement recovery. Seed reviewed metadata before mount so
  // a separate row-menu/caption-save race cannot prevent its safety assertions.
  // The separate pointer and keyboard menu regressions retain that UI coverage.
  state.projects[0].captions[1] = { ...state.projects[0].captions[1], textLocked: true, timingLocked: true, approved: true };
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
    // Keep caption 1 editable so the recovery assertions cover late input.
    const reviewedRow = page.locator('[data-caption-id="c2"]');
    await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Caption 2 start time', { exact: true })).toBeDisabled();
    const reviewedApproval = reviewedRow.getByRole('button', { name: 'Mark caption as needing review', exact: true });
    await expect(reviewedApproval).toHaveAttribute('aria-pressed', 'true');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'clean-replacement.mp4', mimeType: 'video/mp4', buffer: Buffer.from('clean replacement'),
    });
    await confirmResetReplacement(page);
    await expect.poll(() => requested).toBe(true);
    expect(savedBeforeReplacement).toBe('Stable edit saved before replacement');
    const reviewedCaption = structuredClone(state.projects[0].captions[1]);
    expect(reviewedCaption).toMatchObject({ id: 'c2', textLocked: true, timingLocked: true, approved: true });
    const dialog = page.getByRole('dialog', { name: 'Replace media', exact: true });
    const moreActions = page.getByLabel('More actions for caption 1', { exact: true });
    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    for (const control of [moreActions, reviewedApproval]) {
      await expect(control).toBeVisible();
      const target = await control.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        return { x, y, blocked: document.elementFromPoint(x, y)?.classList.contains('media-replacement-backdrop') };
      });
      expect(target.blocked).toBe(true);
      await page.mouse.click(target.x, target.y);
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
    }
    await expect(moreActions).toHaveAttribute('aria-expanded', 'false');
    await expect(reviewedApproval).toHaveAttribute('aria-pressed', 'true');

    // Inject late text/timing input to exercise the recovery race independently
    // of the modal's normal pointer interaction, which is blocked above.
    await field.fill('Later edit that belongs to the old media');
    const start = page.getByLabel('Caption 1 start time', { exact: true });
    await start.fill('00:00.777');
    await start.press('Enter');
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
    await expect(recovery).toContainText('belong to the previous media and were not applied here.');
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
      approved: false,
    });
    expect(payload.captions[1]).toEqual(reviewedCaption);
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
    await confirmResetReplacement(page);
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
    await confirmResetReplacement(page);
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
    await confirmResetReplacement(page);
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
    await page.getByRole('dialog', { name: 'Project history', exact: true })
      .getByRole('button', { name: /^Restore Synthetic restore point saved / }).click();
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
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Project history', exact: true })).toHaveCount(0);
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

test('a delayed History list from another project cannot replace the current project checkpoints', async ({ page }) => {
  const entry = {
    id: 'history-landscape', label: 'Landscape checkpoint', source: 'manual-save', createdAt: '2026-01-01T00:00:00.000Z',
    captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0,
  };
  const secondEntry = { ...entry, id: 'history-second', label: 'Second project checkpoint' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let landscapeReads = 0;
  let secondReads = 0;
  await page.route('**/api/projects/landscape/history', async (route) => {
    landscapeReads += 1;
    await gate;
    await route.fulfill({ json: [entry] });
  });
  await page.route('**/api/projects/second/history', async (route) => {
    secondReads += 1;
    await route.fulfill({ json: [secondEntry] });
  });
  try {
    await openProject(page);
    const firstHistory = await history(page);
    await expect.poll(() => landscapeReads).toBe(1);
    await firstHistory.getByRole('button', { name: 'Close history', exact: true }).click();
    await page.getByLabel('Back to projects', { exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
    const secondHistory = await history(page);
    await expect(secondHistory.locator('.history-list article strong')).toHaveText(['Second project checkpoint']);
    expect(secondReads).toBe(1);

    const staleResponse = page.waitForResponse((response) => response.url().endsWith('/landscape/history'));
    release();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await expect(secondHistory.locator('.history-list article strong')).toHaveText(['Second project checkpoint']);
    await expect(secondHistory.getByRole('button', { name: /^Restore Second project checkpoint saved / })).toBeVisible();
    await expect(secondHistory.getByRole('button', { name: /^Restore Landscape checkpoint saved / })).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/second.mp4');
    expect(state.requests.filter((request) => request.method === 'POST' && request.path.includes('/history/'))).toEqual([]);
  } finally { release(); }
});

test('a delayed History refresh cannot replace a newer refresh in the same project', async ({ page }) => {
  const entry = {
    id: 'history-initial', label: 'Initial checkpoint', source: 'manual-save', createdAt: '2026-01-01T00:00:00.000Z',
    captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route('**/api/projects/landscape/history', async (route) => {
    const request = ++reads;
    const response = request === 1 ? entry : request === 2
      ? { ...entry, id: 'history-obsolete', label: 'Obsolete refresh checkpoint' }
      : { ...entry, id: 'history-latest', label: 'Latest refresh checkpoint' };
    if (request === 2) await gate;
    await route.fulfill({ json: [response] });
  });
  try {
    await openProject(page);
    const dialog = await history(page);
    await expect(dialog.locator('.history-list article strong')).toHaveText(['Initial checkpoint']);
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(dialog.locator('.history-list article strong')).toHaveText(['Latest refresh checkpoint']);
    expect(reads).toBe(3);

    const staleResponse = page.waitForResponse((response) => response.url().endsWith('/landscape/history'));
    release();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await expect(dialog.locator('.history-list article strong')).toHaveText(['Latest refresh checkpoint']);
    await expect(dialog.getByRole('button', { name: /^Restore Latest refresh checkpoint saved / })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Restore Obsolete refresh checkpoint saved / })).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
    expect(state.requests.filter((request) => request.method === 'POST' && request.path.includes('/history/'))).toEqual([]);
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
    response.transcriptionContext = structuredClone(body.transcriptionContext);
    requested = true;
    await gate;
    state.projects[0].transcriptionContext = structuredClone(body.transcriptionContext);
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
  await page.getByRole('button', { name: 'Review audio', exact: true }).click();
  await expect.poll(() => saveCalls).toBe(2);
  expect(saveSources).toEqual(['text-edit', 'manual-save']);
  const failure = page.getByRole('alert').filter({ hasText: "Couldn't save changes" });
  await expect(failure).toContainText('Synthetic correction pre-save failure');
  await expect(failure.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  await expect(failure.getByRole('button', { name: 'Download edits', exact: true })).toBeEnabled();
  expect(targetReads).toBe(0);
  await expect(field).toHaveValue('Dirty correction that must be saved before leaving');
  await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
  await expect(page.locator('.project-title')).toContainText("Couldn't save changes");
  await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
  await page.keyboard.press('Escape');
  // Save failures must outlive the ordinary 4.2-second notice lifetime.
  await page.waitForTimeout(4600);
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  await expect(failure.getByRole('button', { name: 'Download edits', exact: true })).toBeEnabled();
  await expect(field).toHaveValue('Dirty correction that must be saved before leaving');
  expect(saveCalls).toBe(2);
  expect(targetReads).toBe(0);
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
    await page.getByRole('button', { name: 'Review audio', exact: true }).click();
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

test('completed compatibility transcription surfaces its context limitation in the normal completion flow', async ({ page }) => {
  const running = completedResultJob();
  running.status = 'running';
  running.stage = 'transcription';
  running.progress = 22;
  running.message = 'Transcribing';
  delete running.resultProjectId;
  state.jobs = [running];
  state.projects[0].transcript!.contextMode = 'vocabulary-only';
  state.projects[0].transcript!.descriptionHintsUsed = 2;

  await openProject(page);
  const dialog = await activity(page);
  await expect(dialog).toContainText('Transcribing');
  const completed = completedResultJob();
  completed.resultProjectId = 'landscape';
  state.jobs[0] = completed;
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(dialog).toContainText('Result ready');

  await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
  await expect(page.locator('.toast.notice')).toContainText('Studio used compatibility transcription');
  await expect(page.locator('.toast.notice')).toContainText('2 selected name/model hints from your Accuracy context');
  await expect(page.locator('.toast.notice')).toContainText('full topic description was not available to Transcribe');
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

for (const scope of ['full', 'selection'] as const) {
  test(`unchanged ${scope} regeneration waits for held caption saves and submits the intended request exactly once`, async ({ page }) => {
    state.profile.preferences.autosaveDelayMs = 60_000;
    state.projects[0].transcriptionContext = { description: 'Synthetic saved Accuracy context', vocabulary: ['TS11 | terminal'] };
    const current = state.projects[0];
    const text = `Legitimate ${scope} caption correction waiting to save`;
    const expectedRequest = {
      projectId: current.id,
      generationModel: 'automatic',
      startMs: scope === 'full' ? 0 : current.captions[0].startMs,
      endMs: scope === 'full' ? current.transcript!.timing!.audioDurationMs : current.captions[0].endMs,
      transcriptionContext: structuredClone(current.transcriptionContext),
      expectedMedia: { filename: current.media.filename, size: current.media.size },
    };
    const requests: unknown[] = [];
    const savedTextAtSubmission: string[] = [];
    const captionWrites: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/projects/landscape/captions', async (route) => {
      const body = route.request().postDataJSON();
      captionWrites.push(body.captions[0].text);
      await gate;
      current.captions = structuredClone(body.captions);
      await route.fulfill({ json: { project: current, correctionsCreated: 0 } });
    });
    await page.route('**/api/jobs/regenerate-range', async (route) => {
      requests.push(route.request().postDataJSON());
      savedTextAtSubmission.push(current.captions[0].text);
      const job = queuedRegenerationJob(`positive-held-${scope}-regeneration`);
      state.jobs.push(job);
      await route.fulfill({ status: 202, json: job });
    });
    try {
      await openProject(page);
      const field = page.getByLabel('Caption 1 text', { exact: true });
      await field.fill(text);
      if (scope === 'full') {
        await page.getByRole('button', { name: /^Accuracy/ }).click();
        await page.getByRole('button', { name: 'Preview full regeneration', exact: true }).click();
      } else {
        await page.getByRole('button', { name: /^Review/ }).first().click();
        await page.getByRole('button', { name: 'Improve…', exact: true }).click();
      }
      await expect.poll(() => captionWrites.length).toBeGreaterThan(0);
      expect(requests).toEqual([]);
      expect(current.captions[0].text).not.toBe(text);
      await expect(field).toHaveValue(text);
      await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');

      release();
      await expect.poll(() => requests.length).toBe(1);
      await expect(page.getByRole('dialog', { name: 'Activity', exact: true })).toBeVisible();
      expect(requests).toEqual([expectedRequest]);
      expect(savedTextAtSubmission).toEqual([text]);
      expect(captionWrites.every((value) => value === text)).toBe(true);
      expect(current.captions[0].text).toBe(text);
      await expect(field).toHaveValue(text);
      await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    } finally { release(); }
  });
}

test('Home cancels regeneration while a held caption save succeeds but Accuracy prevents navigation', async ({ page }, testInfo) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const captionText = 'Caption saved before an abandoned full regeneration';
  const contextText = 'Accuracy text that must survive a failed Home save';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let captionWrites = 0;
  let contextWrites = 0;
  let failContext = true;
  let jobCalls = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const body = route.request().postDataJSON();
    captionWrites += 1;
    await gate;
    state.projects[0].captions = structuredClone(body.captions);
    await route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.route('**/api/projects/landscape/context', async (route) => {
    contextWrites += 1;
    if (failContext) return route.fulfill({ status: 503, json: { error: 'Synthetic Accuracy navigation save failure' } });
    state.projects[0].transcriptionContext = structuredClone(route.request().postDataJSON().transcriptionContext);
    await route.fulfill({ json: state.projects[0] });
  });
  await page.route('**/api/jobs/regenerate-range', async (route) => {
    jobCalls += 1;
    const job = queuedRegenerationJob('obsolete-regeneration-after-failed-navigation');
    state.jobs.push(job);
    await route.fulfill({ status: 202, json: job });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    const context = page.getByLabel('What is this clip about?', { exact: true });
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await context.fill(contextText);
    await caption.fill(captionText);
    await page.getByRole('button', { name: 'Preview full regeneration', exact: true }).click();
    await expect.poll(() => captionWrites).toBeGreaterThan(0);
    expect(jobCalls).toBe(0);
    await page.getByLabel('Back to projects', { exact: true }).click();
    release();

    const failure = page.getByRole('alert').filter({ hasText: "Couldn't save changes" });
    await expect(failure).toContainText('Synthetic Accuracy navigation save failure');
    await expect(failure.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
    await expect(failure.getByRole('button', { name: 'Download edits', exact: true })).toBeEnabled();
    expect(contextWrites).toBe(1);
    expect(jobCalls).toBe(0);
    expect(state.projects[0].captions[0].text).toBe(captionText);
    await expect(caption).toHaveValue(captionText);
    await expect(context).toHaveValue(contextText);
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    await expect(page.locator('video')).toHaveAttribute('src', '/media/landscape.mp4');
    await expect(page.getByRole('button', { name: /Audit second/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('navigation-save-failed-accuracy.png'), fullPage: true });

    failContext = false;
    await failure.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(failure).toHaveCount(0);
    await expect(page.locator('.save-action')).toBeDisabled();
    expect(contextWrites).toBe(2);
    expect(state.projects[0].transcriptionContext?.description).toBe(contextText);
    await expect(context).toHaveValue(contextText);
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    expect(jobCalls).toBe(0);
  } finally { release(); }
});

test('the latest Home request saves reverted Accuracy input once after an older held save', async ({ page }, testInfo) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const baseline = { description: 'Canonical Accuracy baseline A', vocabulary: ['TS11 | terminal'] };
  const submitted = { ...baseline, description: 'Pending Accuracy value B' };
  state.projects[0].transcriptionContext = structuredClone(baseline);
  const contextWrites: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects/landscape/context', async (route) => {
    const context = route.request().postDataJSON().transcriptionContext;
    contextWrites.push(structuredClone(context));
    if (contextWrites.length === 1) await gate;
    state.projects[0].transcriptionContext = structuredClone(context);
    await route.fulfill({ json: state.projects[0] });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    const description = page.getByLabel('What is this clip about?', { exact: true });
    await description.fill(submitted.description);
    await page.getByRole('button', { name: 'Save for project', exact: true }).click();
    await expect.poll(() => contextWrites.length).toBe(1);
    await description.fill(baseline.description);

    // Both requests wait on B. The obsolete first request must not enqueue A
    // and make the latest request reject its otherwise-complete queue drain.
    await page.getByLabel('Back to projects', { exact: true }).click();
    await page.getByLabel('Back to projects', { exact: true }).click();
    await expect(description).toHaveValue(baseline.description);
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    expect(contextWrites).toEqual([submitted]);
    await page.screenshot({ path: testInfo.outputPath('accuracy-navigation-waiting.png'), fullPage: true });

    release();
    await expect(page.getByRole('button', { name: /Audit landscape/ })).toBeVisible();
    expect(contextWrites).toEqual([submitted, baseline]);
    expect(state.projects[0].transcriptionContext).toEqual(baseline);
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save changes" })).toHaveCount(0);
    expect(await page.locator('.toast.notice').count(), 'Accepted navigation clears the previous editor notice immediately').toBe(0);
    await page.screenshot({ path: testInfo.outputPath('navigation-home-saved.png'), fullPage: true });

    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await expect(page.locator('.project-title strong')).toHaveText('Audit landscape');
    if (!await description.isVisible()) await page.getByRole('button', { name: /^Accuracy/ }).click();
    await expect(description).toHaveValue(baseline.description);
    await expect(page.getByLabel('Exact terms to preserve', { exact: true })).toHaveValue(baseline.vocabulary.join('\n'));
    await expect(page.locator('.save-action')).toBeDisabled();
    expect(contextWrites).toEqual([submitted, baseline]);
    await page.screenshot({ path: testInfo.outputPath('accuracy-navigation-reopened.png'), fullPage: true });
  } finally { release(); }
});
