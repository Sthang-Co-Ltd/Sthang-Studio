import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { cleanFixtures, fixtureExportUrl, fixtureMedia, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import type { ProcessingJob } from '@kcs/shared';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

function job(id: string, status: ProcessingJob['status']): ProcessingJob {
  return { id, type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape', status,
    stage: 'rendering', progress: status === 'completed' ? 100 : 55, message: `${id} render`,
    canResume: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:02Z',
    startedAt: '2026-01-01T00:00:00Z', ...(status === 'completed' ? { completedAt: '2026-01-01T00:00:02Z', resultExport: {
      filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000,
      width: 640, height: 360, frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null,
      durationMs: 4000, createdAt: '2026-01-01T00:00:02Z',
    } } : {}) };
}
async function activity(page: import('@playwright/test').Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}

test('Activity downloads the backend bytes and exposes location, progress, readable metadata and touch controls', async ({ page }) => {
  state.jobs = [job('complete', 'completed'), job('running', 'running')];
  await openProject(page);
  const dialog = await activity(page);
  await expect(dialog.getByRole('button', { name: 'Close Activity' })).toBeFocused();
  await expect(dialog.getByText('C:\\Synthetic\\exports', { exact: true })).toBeVisible();
  await expect(dialog.locator('.job-completed')).toContainText('Took 2s');
  await expect(dialog.getByRole('progressbar').nth(1)).toHaveAttribute('aria-valuenow', '55');
  const heading = await dialog.locator('.job-modal-heading-copy strong').boundingBox();
  const description = await dialog.locator('.job-modal-heading-copy span').boundingBox();
  expect(description!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
  const result = dialog.locator('.job-completed');
  const meta = await result.locator('.job-meta').boundingBox();
  const actions = await result.locator('.job-actions').boundingBox();
  expect(actions!.y).toBeGreaterThanOrEqual(meta!.y + meta!.height);
  const download = page.waitForEvent('download');
  await result.getByRole('button', { name: 'Download video' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('synthetic-captioned.mp4');
  expect(await fs.readFile((await file.path())!)).toEqual(fixtureMedia());
  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await dialog.getByRole('button').all()) {
    if (await button.isVisible()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const sizes = await dialog.locator('.job-copy, .job-modal-heading-copy').evaluateAll((roots) => roots.flatMap((root) => [...root.querySelectorAll('small,button,strong,span')].filter((item) => item.getClientRects().length).map((item) => parseFloat(getComputedStyle(item).fontSize))));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
});

test('Activity cancel/resume/refresh act on the chosen job and keyboard focus stays out of the editor', async ({ page }) => {
  state.jobs = [job('running', 'running')];
  await openProject(page);
  const dialog = await activity(page);
  const close = dialog.getByRole('button', { name: 'Close Activity' });
  await close.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus(); await refresh.press('Enter');
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(dialog).toContainText('Queued to resume');
  expect(state.requests.filter((item) => item.method === 'POST' && item.path.startsWith('/api/jobs/')).map((item) => item.path)).toEqual(['/api/jobs/running/cancel', '/api/jobs/running/resume']);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test('an interrupted caption job is surfaced after restart instead of sitting silently idle', async ({ page }) => {
  const interrupted = job('interrupted-caption', 'interrupted');
  interrupted.type = 'transcribe';
  interrupted.stage = 'interrupted';
  interrupted.progress = 22;
  interrupted.message = 'The app stopped during this job. Resume uses saved processing checkpoints where possible.';
  interrupted.canResume = true;
  state.jobs = [interrupted];

  await openProject(page);
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.toast.notice')).toContainText('Studio restarted while this job was running');
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(dialog).toContainText('Queued to resume');
});

test('a recovered interrupted job discovered after a lost enqueue response is surfaced exactly once', async ({ page }) => {
  state.jobs = [];
  await openProject(page);

  const interrupted = job('lost-ack-caption', 'interrupted');
  interrupted.type = 'transcribe';
  interrupted.stage = 'interrupted';
  interrupted.progress = 1;
  interrupted.message = 'The app stopped during this job. Resume uses saved processing checkpoints where possible.';
  interrupted.canResume = true;
  state.jobs = [interrupted];

  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.toast.notice')).toHaveCount(1);
  await expect(page.locator('.toast.notice')).toContainText('Studio restarted while this job was running');
  expect(state.requests.filter((item) => item.method === 'POST' && item.path.includes('/api/jobs/'))).toHaveLength(0);

  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await expect(page.locator('.toast.notice')).toHaveCount(1);
  expect(state.requests.filter((item) => item.method === 'POST' && item.path.includes('/api/jobs/'))).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(dialog).toContainText('Queued to resume');
  expect(state.requests.filter((item) => item.method === 'POST' && item.path.includes('/api/jobs/')).map((item) => item.path))
    .toEqual(['/api/jobs/lost-ack-caption/resume']);
});

test('review keeps context on entry, tight replay, separate focus artwork and native select keyboard behavior', async ({ page }) => {
  state.profile.preferences.reviewPreRollMs = 450;
  state.profile.preferences.reviewPostRollMs = 300;
  state.projects[0].captions[0].startMs = 600;
  state.projects[0].captions[0].endMs = 1100;
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.15, 2);
  await seek(page, 800);
  const image = page.locator('.native-caption-image');
  await expect(image).toBeVisible();
  const pixels = await image.getAttribute('src');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
  const reviewFocusControl = page.locator('label.review-focus-mode-control[for="review-focus-mode-select"]');
  await expect(reviewFocusControl).toBeVisible();
  await expect(reviewFocusControl.locator('#review-focus-mode-select')).toBeVisible();
  const controlBox = (await reviewFocusControl.boundingBox())!;
  const selectBox = (await page.locator('#review-focus-mode-select').boundingBox())!;
  expect(selectBox.x).toBeGreaterThanOrEqual(controlBox.x - 2);
  expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(controlBox.x + controlBox.width + 2);
  const focus = page.getByLabel('Review focus', { exact: true });
  await focus.selectOption('off');
  await expect(page.locator('.native-caption-focus')).toHaveCount(0);
  expect(await image.getAttribute('src')).toBe(pixels);
  await focus.selectOption('brackets');
  await expect(page.locator('.native-caption-focus')).toBeVisible();
  await expect(page.locator('.review-focus-label')).toHaveCount(0);
  await focus.focus(); await focus.press('ArrowDown');
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
  // Inspect the actual requested replay seek without racing media-clock advancement.
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.play = async () => {}; });
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.46, 2);
  await page.getByRole('button', { name: 'Play with context', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0.15, 2);
});

test('rapid short-caption seeks coalesce obsolete preview work and finish on the latest caption', async ({ page }, testInfo) => {
  type Preview = { id: number; times: number[]; captions: Array<{ text: string; startMs: number; endMs: number }>;
    wall: number; ms: number; abortWall?: number; responseWall?: number; status?: number; error?: string };
  type MediaEvent = { type: string; wall: number; ms: number; trusted: boolean; phase: 'capture' | 'target'; turnWall?: number };
  type Transition = { target: number; actionWall: number; eventStart: number; pendingBefore: number[];
    observedWall?: number; seekingWall?: number; eventTurnWall?: number; activeId?: string | null; ms?: number; alt?: string | null };
  type Probe = { requests: Preview[]; events: MediaEvent[]; transitions: Transition[] };
  await page.addInitScript(() => {
    const probe: Probe = { requests: [], events: [], transitions: [] };
    (window as unknown as { __rapidCaptionSeeks: Probe }).__rapidCaptionSeeks = probe;
    const notify = () => window.dispatchEvent(new Event('sthang:rapid-preview-observed'));
    for (const type of ['seeking', 'seeked', 'timeupdate']) document.addEventListener(type, (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      probe.events.push({ type, wall: performance.now(), ms: event.target.currentTime * 1000, trusted: event.isTrusted, phase: 'capture' });
      notify();
    }, true);
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      if (!String(input).endsWith('/api/video-export/landscape/preview') || typeof init?.body !== 'string') {
        return originalFetch.call(this, input, init);
      }
      const body = JSON.parse(init.body) as { timesMs: number[]; captions: Preview['captions'] };
      const request: Preview = { id: probe.requests.length + 1, times: body.timesMs, captions: body.captions,
        wall: performance.now(), ms: (document.querySelector('video')?.currentTime ?? 0) * 1000 };
      probe.requests.push(request);
      const aborted = () => { request.abortWall = performance.now(); notify(); };
      init.signal?.addEventListener('abort', aborted, { once: true });
      notify();
      try {
        const response = await originalFetch.call(this, input, init);
        request.responseWall = performance.now(); request.status = response.status; notify();
        return response;
      } catch (error) {
        request.error = error instanceof Error ? error.name : String(error); notify();
        throw error;
      } finally { init.signal?.removeEventListener('abort', aborted); }
    };
  });
  state.projects[0].mode = 'word';
  state.projects[0].captions = Array.from({ length: 12 }, (_, index) => ({ id: `word-${index}`, text: `Caption ${index}`, startMs: index * 100, endMs: index * 100 + 100 }));
  state.previewDelay = () => 600;
  let primaryFailed = false;
  try {
    await openProject(page);
    await expect.poll(() => state.requests.filter((item) => item.path.endsWith('/preview')).length).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const video = document.querySelector('video');
      const list = document.querySelector('.caption-list');
      if (!video || !list) throw new Error('The rapid seek exercise requires the actual video and caption list.');
      const probe = (window as unknown as { __rapidCaptionSeeks: Probe }).__rapidCaptionSeeks;
      const eventTurns = new MessageChannel();
      eventTurns.port1.onmessage = (message: MessageEvent<number>) => {
        probe.events[message.data].turnWall = performance.now();
        window.dispatchEvent(new Event('sthang:rapid-preview-observed'));
      };
      // Register after the component's target listeners, then post a browser
      // task so the next seek cannot run inside this event's dispatch.
      const onSeeking = (event: Event) => {
        const index = probe.events.push({ type: event.type, wall: performance.now(), ms: video.currentTime * 1000,
          trusted: event.isTrusted, phase: 'target' }) - 1;
        eventTurns.port2.postMessage(index);
      };
      video.addEventListener('seeking', onSeeking);
      const waitForCommit = (read: () => boolean) => new Promise<void>((resolve, reject) => {
        let timer = 0;
        const cleanup = () => {
          clearTimeout(timer); observer.disconnect();
          window.removeEventListener('sthang:rapid-preview-observed', check);
        };
        const check = () => { if (read()) { cleanup(); resolve(); } };
        const observer = new MutationObserver(check);
        observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] });
        window.addEventListener('sthang:rapid-preview-observed', check);
        // Use the existing browser assertion budget, not a playback-speed limit.
        timer = window.setTimeout(() => { cleanup(); reject(new Error('A real seek event and caption-row commit did not arrive.')); }, 8000);
        check();
      });
      try {
        video.pause();
        for (const target of [550, 650, 750, 850]) {
          const transition: Transition = { target, actionWall: performance.now(), eventStart: probe.events.length,
            pendingBefore: probe.requests.filter((request) => request.abortWall === undefined && request.responseWall === undefined).map((request) => request.id) };
          probe.transitions.push(transition);
          // Preserve seek()'s editor update while requiring the browser's real
          // seeking event. Do not wait for seeked/decoding before the next scrub.
          video.currentTime = target / 1000;
          video.dispatchEvent(new Event('timeupdate'));
          await waitForCommit(() => probe.events.slice(transition.eventStart).some((event) => event.type === 'seeking'
            && event.trusted && event.phase === 'target' && event.turnWall !== undefined && Math.abs(event.ms - target) < 1)
            && list.querySelector('.caption-row.active')?.getAttribute('data-caption-id') === `word-${Math.floor(target / 100)}`);
          transition.observedWall = performance.now();
          const seeking = probe.events.slice(transition.eventStart).find((event) => event.type === 'seeking'
            && event.trusted && event.phase === 'target' && event.turnWall !== undefined && Math.abs(event.ms - target) < 1)!;
          transition.seekingWall = seeking.wall;
          transition.eventTurnWall = seeking.turnWall;
          transition.activeId = list.querySelector('.caption-row.active')?.getAttribute('data-caption-id');
          transition.ms = video.currentTime * 1000;
          transition.alt = document.querySelector('.native-caption-image')?.getAttribute('alt') ?? null;
        }
      } finally {
        video.removeEventListener('seeking', onSeeking);
        eventTurns.port1.close(); eventTurns.port2.close();
      }
    });
    await expect(page.locator('.native-caption-image')).toHaveAttribute('alt', 'Caption 8');
    expect(state.requests.filter((item) => item.path.endsWith('/preview')).length).toBeLessThanOrEqual(3);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    const probe = await page.evaluate(() => (window as unknown as { __rapidCaptionSeeks: Probe }).__rapidCaptionSeeks);
    expect(probe.transitions.map((transition) => transition.target)).toEqual([550, 650, 750, 850]);
    for (const transition of probe.transitions) {
      expect(transition.seekingWall).toBeGreaterThanOrEqual(transition.actionWall);
      expect(transition.eventTurnWall).toBeGreaterThanOrEqual(transition.seekingWall!);
      expect(transition.observedWall).toBeGreaterThanOrEqual(transition.eventTurnWall!);
      expect(transition.activeId).toBe(`word-${Math.floor(transition.target / 100)}`);
      expect(transition.ms).toBeCloseTo(transition.target, 4);
      if (transition.alt !== null) expect(transition.alt).toBe(`Caption ${Math.floor(transition.target / 100)}`);
    }
    const final = probe.requests.findLast((request) => request.status === 200 && request.times.includes(800));
    expect(final, 'The final caption must come from a completed request for its actual paint').toBeDefined();
    expect(final!.captions.find((caption) => caption.startMs === 800)).toEqual({ text: 'Caption 8', startMs: 800, endMs: 900 });
    expect(final!.abortWall).toBeUndefined();
    // A same-caption seek must not cancel its already-started current render.
    const first = probe.transitions[0];
    for (const id of first.pendingBefore) {
      const request = probe.requests.find((item) => item.id === id)!;
      if (request.times.length === 1 && request.times[0] === 500 && request.abortWall !== undefined) {
        expect(request.abortWall).toBeGreaterThanOrEqual(probe.transitions[1].actionWall);
      }
    }
    // Work still pending when its replacement is dispatched must already be
    // cancelled. Work that completed first remains valid cached evidence.
    for (const request of probe.requests.filter((item) => item.wall < final!.wall
      && (item.responseWall === undefined || item.responseWall > final!.wall))) {
      expect(request.abortWall, `Obsolete request ${request.id} must not remain live behind the final target`).toBeDefined();
      expect(request.abortWall).toBeLessThanOrEqual(final!.wall);
      expect(request.responseWall).toBeUndefined();
    }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      const probe = await page.evaluate(() => (window as unknown as { __rapidCaptionSeeks: Probe }).__rapidCaptionSeeks);
      await testInfo.attach('rapid-caption-seek-diagnostics', {
        body: JSON.stringify({ ...probe, routed: state.requests.filter((item) => item.path.endsWith('/preview')) }, null, 2), contentType: 'application/json',
      });
    } catch (error) {
      if (!primaryFailed) throw error;
      // Keep the original assertion/bootstrap error as the test failure, and
      // retain a diagnostic failure separately in both the report and stderr.
      const description = error instanceof Error ? error.stack ?? error.message : String(error);
      testInfo.annotations.push({ type: 'rapid-seek-diagnostic-failure', description });
      console.error('Rapid seek diagnostic collection failed after the primary test failure:', description);
    }
  }
});

test('Find & Correct modal opens from tools menu, searches matches, and closes cleanly', async ({ page }) => {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correct everywhere/ }).click();
  const modal = page.locator('.find-replace-modal');
  await expect(modal).toBeVisible();
  const findInput = modal.getByLabel('Find', { exact: true });
  await findInput.fill('caption');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});
