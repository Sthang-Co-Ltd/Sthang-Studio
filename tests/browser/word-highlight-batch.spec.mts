import { test, expect, type Page } from '@playwright/test';
import {
  buildCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type TimedToken,
} from '../../packages/shared/src/index.js';
import { cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, seek } from './fixtures.mjs';

import { deferredHighlight, stubHighlightRoutes } from './word-highlight-routes.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

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


const baseCue = (id: string, text: string, startMs: number): CaptionSegment => ({
  id, text, startMs, endMs: startMs + 620, approved: true,
});

async function batchFixture(page: Page, enabled = false) {
  const state = await installFixture(page);
  const project = state.projects[0] as CaptionProject;
  project.captions = [
    baseCue('c1', 'First caption', 100),
    baseCue('c2', 'Second caption', 800),
    baseCue('c3', 'Third caption', 1500),
    { ...baseCue('c4', 'Locked caption', 2300), timingLocked: true },
  ];
  project.transcript = null;
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: enabled ? 'word' : 'off' };
  const routes = await stubHighlightRoutes(page, project);
  return { state, project, routes };
}

const controls = (page: Page) => page.getByRole('region', { name: 'Word highlight results' });
const toggle = (page: Page) => page.getByRole('button', { name: 'Highlight spoken word', exact: true });
const undo = (page: Page) => controls(page).getByRole('button', { name: 'Undo', exact: true });
async function appearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expandAppearanceSection(page, 'words');
}

test('one Apply publishes eligible candidates by reference and offers ranked review and exact Undo', async ({ page }) => {
  const { project, routes } = await batchFixture(page);
  const before = structuredClone(project.captions);
  const held = routes.holdCandidates = deferredHighlight();
  routes.terminal.add('c2');
  await openProject(page);
  await appearance(page);
  await toggle(page).click();

  await expect(controls(page)).toContainText('Checking captions… 0 of 3');
  await expect(controls(page).getByRole('progressbar')).toBeVisible();
  expect(routes.writes).toHaveLength(0);
  held.release();
  await expect(undo(page)).toBeEnabled();
  expect(routes.arms).toBe(1);
  expect(routes.prepares).toBe(1);
  expect(routes.chunks).toEqual([['c1', 'c2', 'c3']]);
  expect(routes.writes).toHaveLength(1);
  expect(routes.committed[0].map(({ id }) => id)).toEqual(['c1', 'c3']);
  expect(project.captions.every(({ approved }) => approved)).toBe(true);
  await expect(controls(page)).toContainText('Highlighting 2 captions · 2 plain');
  await seek(page, 320);
  await expect(page.locator('.native-caption-surface[data-preview-mode="exact"]')).toHaveAttribute('data-paint-key', '0|0:6-13');

  await controls(page).getByRole('button', { name: 'Review remaining (2)' }).click();
  await expect(page.getByRole('button', { name: 'Word timing', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.timing-caption-text')).toContainText('Second caption');
  await expect(page.getByRole('slider', { name: 'Waveform playhead' })).toHaveAttribute('aria-valuenow', '800');
  await page.getByRole('button', { name: 'Next timing issue', exact: true }).click();
  await expect(page.locator('.timing-caption-text')).toContainText('Locked caption');
  await expect(page.getByRole('slider', { name: 'Waveform playhead' })).toHaveAttribute('aria-valuenow', '2300');
  expect(routes.chunks).toHaveLength(1);
  await appearance(page);
  await undo(page).click();
  await expect(undo(page)).toHaveCount(0);
  expect(routes.writes.map(({ action }) => action ?? 'apply')).toEqual(['apply', 'undo']);
  expect(project.captions).toEqual(before);
  expect(project.wordHighlightFollow?.enabled).toBe(false);
  await expect(controls(page).getByRole('button', { name: 'Apply to all captions', exact: true })).toBeVisible();
});

test('Sync remaining opens the still-unresolved caption in the waveform and caption edge controls', async ({ page }) => {
  const { project, routes } = await batchFixture(page);
  project.captions[2] = baseCue('c3', 'Third caption', 2340);
  project.captions[3] = { ...baseCue('c4', 'Locked caption', 3300), timingLocked: true };
  routes.terminal.add('c2').add('c3');
  await openProject(page);
  await appearance(page);
  await toggle(page).click();
  const sync = controls(page).getByRole('button', { name: 'Sync remaining', exact: true });
  await expect(sync).toBeEnabled();

  // The first issue is fixed by the retry. Its original position in the queue is stale.
  routes.terminal.delete('c2');
  await seek(page, 150);
  await sync.click();
  const edges = page.getByRole('button', { name: 'Caption edges', exact: true });
  await expect(edges).toHaveAttribute('aria-pressed', 'true');
  await expect(edges).toBeFocused();
  await expect(page.locator('[data-caption-id="c3"]')).toHaveClass(/selected-range/);
  await expect(page.locator('.timing-caption-text')).toHaveText('Third caption');
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:02.340');
  await expect(page.getByRole('slider', { name: 'Waveform playhead' })).toHaveAttribute('aria-valuenow', '2340');
  await expect(page.getByRole('slider', { name: 'Scroll timing waveform' })).toHaveValue('1400');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused && Math.round(video.currentTime * 1000))).toBe(2340);
  expect(routes.chunks[1]).toEqual(['c2', 'c3']);
});

test('a delayed Sync remaining keeps the newer workspace choice', async ({ page }) => {
  const { routes } = await batchFixture(page);
  routes.terminal.add('c2');
  await openProject(page);
  await appearance(page);
  await toggle(page).click();
  const sync = controls(page).getByRole('button', { name: 'Sync remaining', exact: true });
  await expect(sync).toBeEnabled();
  const held = routes.holdCandidates = deferredHighlight();
  try {
    await sync.click();
    await expect.poll(() => routes.chunks.length).toBe(2);
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await appearance(page);
    held.release();
    await expect(sync).toBeEnabled();
    await expect(page.locator('.fine-timing')).toHaveCount(0);
  } finally { held.release(); }
});

for (const action of ['Cancel', 'Off'] as const) test(`${action} revokes the running pass and keeps saved timing`, async ({ page }) => {
  const { project, routes } = await batchFixture(page);
  const before = structuredClone(project.captions);
  const held = routes.holdCandidates = deferredHighlight();
  try {
    await openProject(page);
    await appearance(page);
    await toggle(page).click();
    await expect.poll(() => routes.chunks.length).toBe(1);
    if (action === 'Off') await toggle(page).click();
    else await controls(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    held.release();
    await expect.poll(() => routes.revokes).toBe(1);
    await expect(controls(page).getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(routes.writes).toHaveLength(0);
    expect(project.captions).toEqual(before);
    await expect.poll(() => project.captionAppearance?.highlightMode).toBe(action === 'Off' ? 'off' : 'word');
  } finally { held.release(); }
});

test('Apply starts after the ordinary autosave and follows saved text without prompting', async ({ page }) => {
  const { state, project, routes } = await batchFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  project.captions[0].approved = false;
  await page.clock.install();
  await openProject(page);
  await page.getByRole('button', { name: 'Approve caption', exact: true }).first().click();
  await appearance(page);
  await toggle(page).click();
  await expect(controls(page)).toContainText('Word sync will continue after your edits are saved.');
  expect(routes.arms).toBe(0);
  expect(routes.chunks).toEqual([]);
  await page.clock.fastForward(62_000);
  await expect(undo(page)).toBeEnabled();
  expect(project.captions[0].approved).toBe(true);
  const input = page.locator('[data-caption-id="c2"] textarea');
  await input.fill('Revised wording');
  await input.press('Tab');
  await page.clock.fastForward(62_000);
  await expect.poll(() => project.captions[1].text).toBe('Revised wording');
  await page.clock.fastForward(2_000);
  await expect.poll(() => routes.writes.length).toBe(2);
  expect(routes.writes[1].intent).toBe('follow');
  expect(routes.chunks[1]).toEqual(['c1', 'c2', 'c3']);
  expect(routes.committed[1].map(({ id }) => id)).toEqual(['c2']);
  expect(routes.arms).toBe(1);
});

test('composition defers publication until saved and a context conflict checks only affected IDs', async ({ page }) => {
  const { project, routes } = await batchFixture(page, true);
  const held = routes.holdCandidates = deferredHighlight();
  try {
    await openProject(page);
    await appearance(page);
    await controls(page).getByRole('button', { name: 'Apply to all captions' }).click();
    await expect.poll(() => routes.chunks.length).toBe(1);
    const editor = page.locator('[data-caption-id="c2"] textarea');
    await editor.dispatchEvent('compositionstart');
    await editor.fill('កម្ពុជា Second');
    held.release();
    await expect(controls(page)).toContainText('Word sync will continue after your edits are saved.');
    expect(routes.writes).toHaveLength(0);
    routes.rejectNext.push('c2');
    await editor.dispatchEvent('compositionend');
    await editor.press('Tab');
    await expect(undo(page)).toBeEnabled();
    expect(project.captions[1].text).toBe('កម្ពុជា Second');
    expect(routes.chunks[1]).toEqual(['c2']);
    expect(routes.writes[1].preparedKeys).toEqual(expect.arrayContaining([routes.writes[0].preparedKeys![0], routes.writes[0].preparedKeys![2]]));
  } finally { held.release(); }
});

test('a dirty unrelated edit survives a delayed publication response', async ({ page }) => {
  const { project, routes } = await batchFixture(page, true);
  const held = routes.holdPublish = deferredHighlight();
  try {
    await openProject(page);
    await appearance(page);
    await controls(page).getByRole('button', { name: 'Apply to all captions' }).click();
    await expect.poll(() => routes.committed.length).toBe(1);
    const editor = page.locator('[data-caption-id="c4"] textarea');
    await editor.fill('New local text');
    held.release();
    await expect(editor).toHaveValue('New local text');
    await editor.press('Tab');
    await expect.poll(() => project.captions[3].text).toBe('New local text');
    expect(project.captions[0].wordTiming?.evidence).toBe(2);
  } finally { held.release(); }
});

test('Cancel after commit recovers the lost response and exposes the exact Undo', async ({ page }) => {
  const { project, routes } = await batchFixture(page, true);
  const held = routes.holdPublish = deferredHighlight();
  routes.dropAcknowledgement = true;
  try {
    await openProject(page);
    await appearance(page);
    await controls(page).getByRole('button', { name: 'Apply to all captions' }).click();
    await expect.poll(() => routes.committed.length).toBe(1);
    await controls(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => routes.revokes).toBe(1);
    held.release();
    await expect(undo(page)).toBeEnabled();
    await undo(page).click();
    await expect(undo(page)).toHaveCount(0);
    expect(project.captions[0].wordTiming).toBeUndefined();
  } finally { held.release(); }
});

test('an armed project resumes quietly while an old On project waits for Apply', async ({ page }) => {
  const { project, routes } = await batchFixture(page, true);
  await page.clock.install();
  await openProject(page);
  await appearance(page);
  await page.clock.fastForward(3_000);
  await expect(controls(page).getByRole('button', { name: 'Apply to all captions' })).toBeVisible();
  expect(routes.prepares).toBe(0);
  routes.armInitial();
  await openProject(page);
  await page.clock.fastForward(3_000);
  await expect.poll(() => routes.writes.length).toBe(1);
  expect(routes.writes[0].intent).toBe('follow');
  expect(routes.arms).toBe(0);
  await expect(page.locator('.caption-appearance-workspace')).toHaveCount(0);
  const paint = project.captions.map(({ wordTiming }) => wordTiming);
  await openProject(page);
  await page.clock.fastForward(3_000);
  expect(project.captions.map(({ wordTiming }) => wordTiming)).toEqual(paint);
  expect(routes.writes).toHaveLength(1);
});

test('Undo rejects a changed target and retains intervening manual evidence', async ({ page }) => {
  const { project, routes } = await batchFixture(page, true);
  await openProject(page);
  await appearance(page);
  await controls(page).getByRole('button', { name: 'Apply to all captions' }).click();
  await expect(undo(page)).toBeEnabled();
  const word = project.captions[0].wordTiming!.words[0];
  word.source = 'manual';
  word.method = 'manual';
  await undo(page).click();
  await expect(page.getByText(/Those captions have newer edits/)).toBeVisible();
  expect(word.source).toBe('manual');
  expect(routes.writes).toHaveLength(2);
  expect(project.wordHighlightFollow?.enabled).toBe(false);
});

for (const allReady of [false, true]) {
  test(`word highlight controls fit with ${allReady ? 'ready' : 'unresolved'} timing`, async ({ page }, testInfo) => {
    const state = await installFixture(page);
    const first = makeCue('c1', 'ខ្មែរ AI', 200, 1200, [220, 720], [620, 1100]);
    const second = makeCue('c2', 'ស្រឡាញ់ កម្ពុជា', 1400, 2400, [1420, 1920], [1820, 2320]);
    if (allReady) {
      first.caption.wordTiming = buildCaptionWordTiming(first.caption, first.tokens)!;
      second.caption.wordTiming = buildCaptionWordTiming(second.caption, second.tokens)!;
    }
    const project = state.projects[0] as CaptionProject;
    project.captions = [first.caption, second.caption];
    project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
    project.transcript!.tokens = [...first.tokens, ...second.tokens];
    project.transcript!.segments = structuredClone(project.captions);

    await openProject(page);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const section = page.getByRole('region', { name: 'Spoken word highlight', exact: true });
    await expect(section.getByRole('button', { name: 'Highlight spoken word', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(section).toContainText(allReady ? 'Highlighting 2 captions' : '2 plain');
    await expect(section).toContainText('SRT carries text and timing only.');
    await expect(section.getByRole('button', { name: 'Apply to all captions', exact: true })).toBeVisible();
    const disclosure = page.locator('.appearance-word-details');
    const summary = disclosure.locator(':scope > summary');
    await summary.focus();
    await summary.press('Enter');
    await expect(section).toBeHidden();
    expect(project.captionAppearance?.highlightMode).toBe('word');
    await page.locator('.workspace-inspector').screenshot({ path: testInfo.outputPath('word-highlighting-collapsed.png'), animations: 'disabled' });
    await summary.press('Enter');
    await expect(section).toBeVisible();

    for (const [width, height] of [[1440, 1000], [390, 1000], [320, 1000], [390, 740], [320, 740]]) {
      await page.setViewportSize({ width, height });
      const layout = await section.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        return {
          fits: root.scrollWidth <= root.clientWidth + 1,
          controls: [...root.querySelectorAll('button,input')].map((node) => {
            const rect = node.getBoundingClientRect();
            return { height: rect.height, inside: rect.left >= bounds.left && rect.right <= bounds.right + 1 };
          }),
        };
      });
      expect(layout.fits).toBe(true);
      for (const control of layout.controls) {
        expect(control.inside).toBe(true);
        expect(control.height).toBeGreaterThanOrEqual(width <= 620 ? 44 : 36);
      }
      if (width <= 620) {
        for (const control of await section.locator('button,input').all()) {
          await control.evaluate((node) => node.scrollIntoView({ block: 'start' }));
          await expect(control).toBeInViewport();
          expect(await control.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          })).toBe(true);
        }
        await summary.evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: testInfo.outputPath(`word-highlighting-${width}x${height}-top.png`), animations: 'disabled' });
        await section.locator('.appearance-highlight-note').evaluate((node) => node.scrollIntoView({ block: 'end' }));
        await page.screenshot({ path: testInfo.outputPath(`word-highlighting-${width}x${height}-bottom.png`), animations: 'disabled' });
      } else {
        await disclosure.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await page.locator('.workspace-inspector').screenshot({ path: testInfo.outputPath(`word-highlighting-${width}x${height}.png`), animations: 'disabled' });
      }
    }
  });
}
