import { test, expect } from '@playwright/test';
import {
  buildCaptionWordTiming,
  resolveCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

let state: FixtureState;

function makeCue(id: string, text: string, startMs: number, endMs: number, starts: number[], ends: number[]) {
  const tokens: TimedToken[] = text.split(' ').map((word, index) => ({
    id: `${id}-w${index}`,
    text: word,
    startMs: starts[index],
    endMs: ends[index],
    spaceBefore: index > 0,
    timingSource: 'stt',
    confidence: .99,
    alignmentScore: .99,
  }));
  const caption: CaptionSegment = { id, text, startMs, endMs, timingSource: 'stt', timingQuality: 'high', approved: true };
  const wordTiming = buildCaptionWordTiming(caption, tokens);
  if (!wordTiming) throw new Error(`Could not build fixture word timing for ${id}`);
  caption.wordTiming = {
    ...wordTiming,
    words: wordTiming.words.map((word, index) => index === 0 ? { ...word, source: 'estimated' as const, needsReview: true } : word),
  };
  return { caption, tokens };
}

test('prepares unresolved highlights sequentially, applies ready timings explicitly, reviews the partial caption, and undoes the batch', async ({ page }) => {
  state = await installFixture(page);
  const first = makeCue('c1', 'ខ្មែរ AI', 200, 1200, [220, 720], [620, 1100]);
  const second = makeCue('c2', 'ស្រឡាញ់ កម្ពុជា', 1400, 2400, [1420, 1920], [1820, 2320]);
  const project = state.projects[0] as CaptionProject;
  project.captions = [first.caption, second.caption];
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  project.transcript!.tokens = [...first.tokens, ...second.tokens];
  project.transcript!.segments = structuredClone(project.captions);
  project.transcript!.fullText = `${first.caption.text} ${second.caption.text}`;

  const syncOrder: string[] = [];
  let activeSyncs = 0;
  let maxActiveSyncs = 0;
  let releaseFirst!: () => void;
  const firstSyncGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    syncOrder.push(caption.id);
    activeSyncs += 1;
    maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
    try {
      if (syncOrder.length === 1) await firstSyncGate;
      const tokens = caption.id === first.caption.id ? first.tokens : second.tokens;
      const wordTiming = buildCaptionWordTiming(caption, tokens);
      if (!wordTiming) throw new Error(`Could not prepare fixture timing for ${caption.id}`);
      const prepared = caption.id === second.caption.id
        ? { ...wordTiming, words: wordTiming.words.map((word, index) => index === 0 ? { ...word, source: 'estimated' as const, needsReview: true } : word) }
        : wordTiming;
      await route.fulfill({
        json: {
          basis: caption,
          wordTiming: prepared,
          sourceRevision: `fixture-kfa-${caption.id}`,
          warnings: caption.id === second.caption.id ? ['One spoken word should be checked.'] : [],
        },
      });
    } finally {
      activeSyncs -= 1;
    }
  });

  const batchRequests: Array<{
    expectedMedia: { filename: string; size: number };
    changes: Array<{ before: CaptionSegment; after: CaptionSegment }>;
    action: 'apply' | 'undo';
  }> = [];
  await page.route('**/api/projects/landscape/caption-word-timing/batch-apply', async (route) => {
    const body = route.request().postDataJSON() as (typeof batchRequests)[number];
    batchRequests.push(structuredClone(body));
    for (const change of body.changes) {
      const index = project.captions.findIndex((caption) => caption.id === change.before.id);
      if (index < 0) throw new Error(`Unknown batch caption ${change.before.id}`);
      project.captions[index] = structuredClone(change.after);
    }
    await route.fulfill({ json: { project, appliedCount: body.changes.length } });
  });

  await openProject(page);
  await page.getByRole('button', { name: /^Appearance$/i }).click();
  await expect(page.locator('.appearance-highlight-readiness')).toContainText('0 of 2 captions have usable word timing');

  await page.getByRole('button', { name: 'Prepare word highlights', exact: true }).click();
  await expect.poll(() => syncOrder).toEqual(['c1']);
  const preparing = page.getByRole('region', { name: 'Preparing word highlights' });
  await expect(preparing).toBeVisible();
  await expect(preparing).toContainText('0 of 2 captions checked');
  await expect(preparing.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

  releaseFirst();
  const prepared = page.getByRole('region', { name: 'Prepared word timings' });
  await expect(prepared).toBeVisible();
  await expect(prepared).toContainText('1 ready');
  await expect(prepared).toContainText('1 need review');
  expect(syncOrder.slice(0, 2)).toEqual(['c1', 'c2']);
  expect(maxActiveSyncs).toBe(1);
  expect(batchRequests).toHaveLength(0);
  expect(resolveCaptionWordTiming(project.captions[0]).state).toBe('partial');

  await prepared.getByRole('button', { name: 'Use ready timings', exact: true }).click();
  await expect.poll(() => batchRequests.length).toBe(1);
  expect(batchRequests[0].action).toBe('apply');
  expect(batchRequests[0].changes).toHaveLength(1);
  expect(batchRequests[0].changes[0].before.id).toBe('c1');
  expect(resolveCaptionWordTiming(batchRequests[0].changes[0].after).state).toBe('ready');
  const applied = page.getByRole('region', { name: 'Applied word timings' });
  await expect(applied).toBeVisible();
  await expect(applied.getByRole('button', { name: 'Prepare remaining', exact: true })).toBeVisible();
  await expect(page.locator('.appearance-highlight-readiness')).toContainText('1 of 2 captions have usable word timing');
  await expect(page.locator('.appearance-highlight-readiness')).toContainText('1 will stay plain');
  expect(resolveCaptionWordTiming(project.captions[0]).state).toBe('ready');
  expect(resolveCaptionWordTiming(project.captions[1]).state).toBe('partial');

  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.pause();
    video.currentTime = 1.6;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-paint-key', /^[^|]+$/);

  await applied.getByRole('button', { name: 'Review remaining', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Word timing', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.timing-caption-text')).toContainText(second.caption.text);

  await page.getByRole('button', { name: /^Appearance$/i }).click();
  const appliedAgain = page.getByRole('region', { name: 'Applied word timings' });
  await expect(appliedAgain).toBeVisible();
  await appliedAgain.getByRole('button', { name: 'Undo batch', exact: true }).click();
  await expect.poll(() => batchRequests.length).toBe(2);
  expect(batchRequests[1].action).toBe('undo');
  expect(batchRequests[1].changes).toHaveLength(1);
  expect(batchRequests[1].changes[0].before.id).toBe('c1');
  expect(resolveCaptionWordTiming(batchRequests[1].changes[0].after).state).toBe('partial');
  expect(resolveCaptionWordTiming(project.captions[0]).state).toBe('partial');
  await expect(page.getByRole('region', { name: 'Prepared word timings' })).toBeVisible();
});

test('turning highlight off during preparation keeps progress cancellable and aborts before later captions or apply', async ({ page }) => {
  state = await installFixture(page);
  const first = makeCue('c1', 'ខ្មែរ AI', 200, 1200, [220, 720], [620, 1100]);
  const second = makeCue('c2', 'ស្រឡាញ់ កម្ពុជា', 1400, 2400, [1420, 1920], [1820, 2320]);
  const project = state.projects[0] as CaptionProject;
  project.captions = [first.caption, second.caption];
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  project.transcript!.tokens = [...first.tokens, ...second.tokens];
  project.transcript!.segments = structuredClone(project.captions);
  project.transcript!.fullText = `${first.caption.text} ${second.caption.text}`;
  const savedCaptions = structuredClone(project.captions);

  const syncOrder: string[] = [];
  let releaseFirst!: () => void;
  const firstSyncGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    syncOrder.push(caption.id);
    if (syncOrder.length === 1) {
      await firstSyncGate;
      await route.abort('aborted').catch(() => {});
      return;
    }
    const wordTiming = buildCaptionWordTiming(caption, caption.id === first.caption.id ? first.tokens : second.tokens);
    if (!wordTiming) throw new Error(`Could not prepare fixture timing for ${caption.id}`);
    await route.fulfill({ json: { basis: caption, wordTiming, sourceRevision: `fixture-kfa-${caption.id}` } });
  });

  let batchApplyRequests = 0;
  await page.route('**/api/projects/landscape/caption-word-timing/batch-apply', async (route) => {
    batchApplyRequests += 1;
    await route.fulfill({ json: { project, appliedCount: 0 } });
  });

  await openProject(page);
  await page.getByRole('button', { name: /^Appearance$/i }).click();
  await page.getByRole('button', { name: 'Prepare word highlights', exact: true }).click();
  await expect.poll(() => syncOrder).toEqual(['c1']);

  const preparing = page.getByRole('region', { name: 'Preparing word highlights' });
  await expect(preparing).toBeVisible();
  await expect(preparing).toContainText('0 of 2 captions checked');
  const cancel = preparing.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeVisible();

  const toggle = page.getByRole('button', { name: 'Highlight spoken word', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(preparing).toBeVisible();
  await expect(preparing).toContainText('0 of 2 captions checked');
  await expect(cancel).toBeVisible();

  await cancel.click();
  releaseFirst();

  const canceled = page.getByRole('region', { name: 'Prepared word timings' });
  await expect(canceled).toBeVisible();
  await expect(canceled).toContainText('Preparation stopped early');
  expect(syncOrder).toEqual(['c1']);
  expect(batchApplyRequests).toBe(0);
  expect(project.captions).toEqual(savedCaptions);
});
