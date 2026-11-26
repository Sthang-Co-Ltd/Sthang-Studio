import { test as base, expect, type Page } from '@playwright/test';
import type { CaptionProject, ProcessingJob, RegenerationProposal } from '@kcs/shared';
import { cleanFixtures, createSyntheticWav, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); } finally { await closeOwnedBrowserContext(context); }
  },
});
const evidence = '.codex-tmp/wave2c2';
const flaggedNotice = 'Captions are ready. Watch them on the video, then check 2 flagged captions in Review.';
const defaultNotice = 'Background caption generation completed.';
const overlay = (page: Page) => page.getByRole('region', { name: 'Media preview', exact: true })
  .getByRole('group', { name: 'Captions ready', exact: true });
const watch = (page: Page) => overlay(page).getByRole('button', { name: 'Watch with captions', exact: true });
const video = (page: Page) => page.locator('.media-stage video');
const review = (page: Page) => page.locator('.stage-rail').getByRole('button', { name: /^Review/ });

let state: FixtureState;
let result: CaptionProject;
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  result = structuredClone(state.projects[0]);
  state.projects[0].captions = [];
  state.projects[0].transcript = null;
  state.jobs = [{ id: 'first-watch', type: 'transcribe', projectId: result.id, projectTitle: result.title,
    status: 'running', stage: 'alignment', progress: 52, message: 'Matching captions to audio.', canResume: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' }];
});

async function openProject(page: Page, id = 'landscape', media = 'video') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`Audit ${id}`) }).click();
  const player = page.locator(`.media-stage ${media}`);
  await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((element: HTMLMediaElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => state.requests.some((request) => request.path === '/api/jobs')).toBe(true);
}

async function complete(page: Page, output: Partial<ProcessingJob> = { resultProjectId: result.id }) {
  state.projects[0] = result;
  state.jobs = [{ ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100, message: 'Captions ready.',
    updatedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:02.000Z', ...output }];
  const response = page.waitForResponse((item) => item.url().endsWith('/api/jobs') && item.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('sthang:jobs-updated')));
  await (await response).finished();
}

async function showFirstWatch(page: Page) {
  await openProject(page);
  await complete(page);
  await expect(overlay(page)).toBeVisible();
}

test('first video captions invite a watch without taking focus, blocking controls, or autoplaying', async ({ page }) => {
  await openProject(page);
  const existingFocus = page.getByLabel('Open project tools', { exact: true });
  await existingFocus.focus();
  await expect(existingFocus).toBeFocused();
  await complete(page);
  await expect(watch(page)).toBeVisible();
  await expect(overlay(page)).toContainText('2 captions need a quick check in Review afterwards.');
  await expect(review(page)).toHaveText(/Review\s*2/);
  await expect(page.getByText(flaggedNotice, { exact: true })).toBeVisible();
  await expect(existingFocus).toBeFocused();
  expect(await video(page).evaluate((element: HTMLVideoElement) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 20);
    return { paused: element.paused, time: element.currentTime, controlsReachable: target === element };
  })).toEqual({ paused: true, time: 0, controlsReachable: true });
  await page.screenshot({ path: `${evidence}/desktop.png` });
  expect(await video(page).evaluate((element: HTMLVideoElement) => new Promise<boolean>((resolve) => {
    const onPlay = () => { window.clearTimeout(timer); resolve(false); };
    const timer = window.setTimeout(() => {
      element.removeEventListener('play', onPlay);
      resolve(element.paused && element.currentTime === 0);
    }, 1000);
    element.addEventListener('play', onPlay, { once: true });
  }))).toBe(true);
});

test('Watch with captions seeks to zero and starts playback', async ({ page }) => {
  state.native = true;
  await openProject(page);
  await video(page).evaluate((element: HTMLVideoElement) => { element.currentTime = 0.5; });
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => element.currentTime === 0.5 && !element.seeking)).toBe(true);
  await complete(page);
  await expect(watch(page)).toBeVisible();
  const captionImage = page.getByAltText(result.captions[0].text, { exact: true });
  await expect.poll(() => captionImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await video(page).evaluate((element: HTMLVideoElement) => {
    element.playbackRate = 0.5;
    element.addEventListener('seeking', () => { element.dataset.watchSeek = String(element.currentTime); }, { once: true });
  });
  await watch(page).click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(video(page)).toHaveAttribute('data-watch-seek', '0');
  await expect.poll(() => video(page).evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime >= 0.25)).toBe(true);
  await expect.poll(() => captionImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await video(page).evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.screenshot({ path: `${evidence}/playing.png` });
});

for (const trigger of ['native play', 'seek', 'caption row', 'Review', 'Accuracy', 'Not now', 'Escape'] as const) {
  test(`the overlay dismisses on ${trigger}`, async ({ page }) => {
    await showFirstWatch(page);
    switch (trigger) {
      case 'native play': await video(page).evaluate((element: HTMLVideoElement) => element.play()); break;
      case 'seek': await video(page).evaluate((element: HTMLVideoElement) => { element.currentTime = 0.5; }); break;
      case 'caption row': await page.getByRole('group', { name: 'Caption 2', exact: true }).locator('.row-index').click(); break;
      case 'Review': await review(page).click(); break;
      case 'Accuracy': await page.locator('.workspace-tool-strip').getByRole('button', { name: 'Accuracy', exact: true }).click(); break;
      case 'Not now': await overlay(page).getByRole('button', { name: 'Not now', exact: true }).click(); break;
      case 'Escape': await watch(page).press('Escape'); break;
    }
    await expect(overlay(page)).toHaveCount(0);
    if (trigger === 'Review') await page.getByRole('button', { name: 'Captions', exact: true }).click();
    if (trigger === 'Accuracy') await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await expect(overlay(page)).toHaveCount(0);
  });
}

test('a dirty draft keeps its newer caption and gets no watch prompt', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Add caption', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Caption 1 text', exact: true });
  await field.fill('Newer local edit');
  await complete(page);
  await expect(page.getByText('Caption generation completed. Your newer edits are kept; the result is available in Activity.', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('Newer local edit');
  await expect(overlay(page)).toHaveCount(0);
});

test('a legacy rebuild on a video with captions retains its existing completion notice', async ({ page }) => {
  state.projects[0].captions = structuredClone(result.captions);
  result.captions[0].text = 'Rebuilt caption';
  await openProject(page);
  await complete(page);
  await expect(page.getByText(defaultNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Caption 1 text', exact: true })).toHaveValue('Rebuilt caption');
  await expect(overlay(page)).toHaveCount(0);
});

test('first audio-only captions retain their existing completion notice', async ({ page }) => {
  const media = { ...result.media, filename: 'landscape.wav', originalName: 'landscape.wav', mimeType: 'audio/wav', url: '/media/landscape.wav' };
  state.projects[0].media = media;
  result.media = media;
  await page.route('**/media/landscape.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: createSyntheticWav(4) }));
  await openProject(page, 'landscape', 'audio');
  await complete(page);
  await expect(page.getByText(defaultNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Caption 1 text', exact: true })).toHaveValue(result.captions[0].text);
  await expect(overlay(page)).toHaveCount(0);
});

test('a proposal completion opens comparison without a watch prompt', async ({ page }) => {
  state.projects[0] = structuredClone(result);
  state.jobs[0].type = 'regenerate-range';
  const current = result.captions[0];
  const proposal: RegenerationProposal = { id: 'first-watch-proposal', projectId: result.id, projectTitle: result.title,
    createdAt: '2026-01-01', expiresAt: '2099-01-01', startMs: current.startMs, endMs: current.endMs,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard', changes: [],
    currentCaptions: [current], proposedCaptions: [{ ...current, text: 'Proposed wording' }] };
  await page.route(`**/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));
  await openProject(page);
  await complete(page, { proposalId: proposal.id });
  await expect(page.getByRole('region', { name: 'Caption comparison', exact: true })).toBeVisible();
  await expect(page.getByText('Improved captions ready. Review them before applying.', { exact: true })).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
});

test('first captions finished while a different project is open get no watch prompt on Open result', async ({ page }) => {
  await openProject(page, 'second');
  await complete(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  const openResult = activity.getByRole('article', { name: /Audit landscape/ }).getByRole('button', { name: 'Open result', exact: true });
  await expect(openResult).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
  await openResult.click();
  await expect(page.getByText('Completed caption job opened.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Caption 1 text', exact: true })).toHaveValue(result.captions[0].text);
  await expect(overlay(page)).toHaveCount(0);
});

test('zero flagged captions point to export', async ({ page }) => {
  result.captions = [{ ...result.captions[2], text: 'Hello there' }];
  await showFirstWatch(page);
  await expect(overlay(page).getByText('No captions were flagged.', { exact: true })).toBeVisible();
  await expect(page.getByText("Captions are ready. Watch them on the video, then export when you're happy.", { exact: true })).toBeVisible();
});

test('compatibility transcription keeps its notice and still offers a watch', async ({ page }) => {
  result.transcript!.contextMode = 'audio-only';
  await showFirstWatch(page);
  await expect(page.getByText('Studio used compatibility transcription without Accuracy recognition hints. Review ambiguous names.', { exact: true })).toBeVisible();
  await expect(page.getByText(flaggedNotice, { exact: true })).toHaveCount(0);
});

for (const compact of [false, true]) {
  test(`the overlay fits at 390 by 844 ${compact ? 'with Accuracy already open' : 'with the full preview'}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page);
    if (compact) await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await complete(page);
    await expect(overlay(page).getByText('2 captions need a quick check in Review afterwards.', { exact: true })).toBeVisible();
    expect(await overlay(page).evaluate((group) => {
      const box = group.getBoundingClientRect();
      const preview = group.closest('.media-stage')!.getBoundingClientRect();
      return box.left >= preview.left && box.right <= preview.right && box.top >= preview.top
        && box.bottom <= preview.bottom - 56 && box.bottom <= innerHeight
        && group.scrollHeight <= group.clientHeight
        && document.documentElement.scrollWidth <= innerWidth
        && Array.from(group.querySelectorAll('button')).every((button) => {
          const rect = button.getBoundingClientRect();
          const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return rect.width >= 44 && rect.height >= 44 && target !== null && button.contains(target);
        });
    })).toBe(true);
    if (!compact) await page.screenshot({ path: `${evidence}/phone.png` });
  });
}
