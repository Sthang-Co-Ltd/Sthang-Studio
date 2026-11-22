import { test, expect, type Response } from '@playwright/test';
import { planCaptionRenderStates, resolveCaptionWordTiming, type CaptionSegment } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const targetMs = 755;
const baselineMs = 1550;
const expectedKey = '0,1|1:0-7';

function readyCue(id: string, text: string, startMs: number, endMs: number, wordStart: number, wordEnd: number): CaptionSegment {
  return {
    id, text, startMs, endMs,
    wordTiming: { version: 1, text, words: [{
      id: id + '-word', startOffset: 0, endOffset: text.length,
      startMs: wordStart, endMs: wordEnd, source: 'aligned',
    }] },
  };
}

test('repeated paused seeks report exact native presentation inside two overlapping legacy-ready cues', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const state = await installFixture(page);
  state.native = true;
  const project = state.projects[0];
  project.captions = [
    readyCue('outer', 'Following', 0, 2300, 1450, 1870),
    readyCue('inner', 'Spoken!', 480, 1110, 480, 1030),
  ];
  for (const caption of project.captions) expect(resolveCaptionWordTiming(caption).state).toBe('ready');
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  const plan = planCaptionRenderStates(project.captions, true);
  const target = plan.find(({ atMs, endMs }) => atMs <= targetMs && targetMs < endMs)!;
  expect(target.paintKey).toBe(expectedKey);
  const controlKey = plan.find(({ atMs, endMs }) => atMs <= baselineMs && baselineMs < endMs)!.paintKey!;
  const video = page.locator('.media-stage video');
  const surface = page.locator('.native-caption-surface');
  const expectedSurface = page.locator(`.native-caption-surface[data-preview-mode="exact"][data-paint-key="${expectedKey}"]`);
  const naturalSeek = (ms: number) => video.evaluate((element: HTMLVideoElement, atMs) => {
    element.pause();
    element.currentTime = atMs / 1000;
  }, ms);
  const targetReplies: Response[] = [];
  page.on('response', (response) => {
    const request = response.request();
    if (!request.url().endsWith('/api/video-export/landscape/preview') || !response.ok()) return;
    const body = request.postDataJSON();
    if (body.timesMs.includes(target.atMs) && body.captions.length === 2) targetReplies.push(response);
  });
  const results = [];
  await page.goto('/');
  for (let repetition = 0; repetition < 36; repetition++) {
    // Reopen to discard the app's decoded image cache each time. Exercise
    // both a first seek and a seek away from already presented single-cue ink.
    const warm = repetition % 2 === 1;
    await page.getByRole('button', { name: 'Audit landscape', exact: false }).click();
    await page.waitForFunction(() => (document.querySelector('.media-stage video')?.readyState ?? 0) >= 1);
    if (warm) {
      await naturalSeek(baselineMs);
      await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
      await expect(surface).toHaveAttribute('data-paint-key', controlKey);
    }
    const repliesBefore = targetReplies.length;
    await naturalSeek(targetMs);
    await page.waitForFunction((ms) => {
      const media = document.querySelector<HTMLVideoElement>('.media-stage video');
      return media?.paused && !media.seeking && Math.abs(media.currentTime * 1000 - ms) < 1;
    }, targetMs);
    const presented = await expectedSurface.locator('img').waitFor({ state: 'visible', timeout: 2500 })
      .then(() => true, (error) => {
        if (error.name !== 'TimeoutError') throw error;
        return false;
      });
    const replies = targetReplies.slice(repliesBefore);
    const frames = await Promise.all(replies.map(async (response) => {
      const { frames } = await response.json();
      return frames.some((frame: { atMs: number; png: string }) => frame.atMs === target.atMs && frame.png.length > 0);
    }));
    results.push({
      warm, presented, targetReply: frames.some(Boolean),
      observed: await surface.evaluateAll((nodes) => nodes.map((node) => ({
        mode: node.getAttribute('data-preview-mode'), key: node.getAttribute('data-paint-key'),
      }))),
    });
    await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  }
  const failures = results.filter(({ presented }) => !presented);
  const summary = { repetitions: results.length, presentationFailures: failures.length,
    missingSurface: failures.filter(({ observed }) => !observed.length).length,
    failedWithTargetReply: failures.filter(({ targetReply }) => targetReply).length };
  console.log('Paused overlap', JSON.stringify(summary));
  await testInfo.attach('paused-overlap-observations', { body: JSON.stringify({ summary, results }), contentType: 'application/json' });
});
