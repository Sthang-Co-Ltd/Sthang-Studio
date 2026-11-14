import { test, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming, type TimedToken } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 100;
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function openTiming(page: Page, words = false) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  if (words) await page.getByRole('button', { name: 'Word timing', exact: true }).click();
}

async function waveformPoint(page: Page, timeMs: number, durationMs: number, y: number) {
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { canvas, box, x: box.x + timeMs / durationMs * box.width, y: box.y + y };
}

test('a nearby caption edge has a clear hover affordance, keeps drag delta, and Escape cancels', async ({ page }) => {
  await openTiming(page);
  const { canvas, box, x, y } = await waveformPoint(page, 200, 2500, 158);
  const start = page.getByLabel('Fine timing start', { exact: true });
  const offset = 11; // Wider than the former 10px hit radius, within the new mouse target.
  const movement = box.width * 60 / 2500;
  await page.mouse.move(x + offset, y);
  await expect(canvas).toHaveClass(/hover-edge/);
  await page.screenshot({ path: test.info().outputPath('precision-hover-desktop.png') });
  await page.keyboard.down('Shift'); // Keep snapping from changing the intended delta.
  await page.mouse.down();
  await page.mouse.move(x + offset + movement, y, { steps: 5 });
  await expect.poll(async () => Number((await start.inputValue()).split(':').at(-1))).toBeGreaterThan(.24);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(start).toHaveValue('00:00.200');
  expect(state.projects[0].captions[0].startMs).toBe(200);
  await page.mouse.move(x + offset, y);
  await page.mouse.down();
  await page.mouse.move(x + offset + movement, y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => state.projects[0].captions[0].startMs).toBeCloseTo(260, 0);
  expect(state.projects[0].captions[1].startMs).toBe(1200);
  await page.mouse.click(box.x + 500 / 2500 * box.width, box.y + 65);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBeCloseTo(500, -1);
  expect(state.projects[0].captions[0].startMs).toBeCloseTo(260, 0);
});

test('a shared caption cut picks the selected edge and leaves the adjacent caption fixed', async ({ page }) => {
  state.projects[0].captions[1].startMs = 1000;
  await openTiming(page);
  const { canvas, box, x, y } = await waveformPoint(page, 1000, 2500, 158);
  await page.mouse.move(x, y);
  await expect(canvas).toHaveClass(/hover-edge/);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(x - box.width * 80 / 2500, y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => state.projects[0].captions[0].endMs).toBeCloseTo(920, 0);
  expect(state.projects[0].captions[1].startMs).toBe(1000);
});

test('word boundaries gain the same forgiving targets without shifting neighboring word timing', async ({ page }) => {
  const cue = state.projects[0].captions[0];
  cue.text = 'First second';
  const tokens: TimedToken[] = [
    { id: 'first', text: 'First', startMs: 200, endMs: 500, spaceBefore: false, timingSource: 'stt', confidence: 1 },
    { id: 'second', text: 'second', startMs: 500, endMs: 1000, spaceBefore: true, timingSource: 'stt', confidence: 1 },
  ];
  cue.wordTiming = buildCaptionWordTiming(cue, tokens);
  await openTiming(page, true);
  await page.getByRole('button', { name: 'Full clip', exact: true }).click();
  const { canvas, box, x, y } = await waveformPoint(page, 200, 4000, 116);
  await page.mouse.move(x + 11, y);
  await expect(canvas).toHaveClass(/hover-edge/);
  await page.mouse.down();
  await page.mouse.move(x + 11 + box.width * 100 / 4000, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => state.projects[0].captions[0].wordTiming!.words[0].startMs).toBe(300);
  expect(state.projects[0].captions[0].wordTiming!.words[1].startMs).toBe(500);
  const sharedX = box.x + 500 / 4000 * box.width;
  await page.mouse.move(sharedX, y);
  await expect(canvas).toHaveClass(/hover-edge/);
  await page.mouse.down();
  await page.mouse.move(sharedX - box.width * 60 / 4000, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => state.projects[0].captions[0].wordTiming!.words[0].endMs).toBe(440);
  expect(state.projects[0].captions[0].wordTiming!.words[1].startMs).toBe(500);
});

test('separator has a wider hit area without changing pane widths or taking neighboring clicks', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const divider = page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true });
  const preview = page.locator('.stage-column');
  const before = (await preview.boundingBox())!.width;
  const box = (await divider.boundingBox())!;
  expect(box.width).toBe(8); // Unchanged grid allocation.
  expect(await divider.evaluate((node) => getComputedStyle(node, '::before').left)).toBe('-4px');
  const y = box.y + 90;
  // Outside the visual 8px track, inside the expanded pointer target.
  await page.mouse.move(box.x + box.width + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 42, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThan(before + 20);
  const resized = (await preview.boundingBox())!.width;
  const after = (await divider.boundingBox())!;
  await page.mouse.click(after.x + after.width + 12, after.y + 90);
  expect((await preview.boundingBox())!.width).toBeCloseTo(resized, 0);
  const row = page.locator('.refined-editor .caption-row').first();
  const approve = (await row.locator('.row-approve').boundingBox())!;
  const more = (await row.locator('.row-more').boundingBox())!;
  expect(approve.width).toBeGreaterThanOrEqual(36);
  expect(more.width).toBeGreaterThanOrEqual(36);
  expect(approve.x + approve.width).toBeLessThanOrEqual(more.x);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(divider).toBeHidden();
  const mobileApprove = (await row.locator('.row-approve').boundingBox())!;
  const mobileMore = (await row.locator('.row-more').boundingBox())!;
  expect(mobileApprove.width).toBeGreaterThanOrEqual(44);
  expect(mobileApprove.height).toBeGreaterThanOrEqual(44);
  expect(mobileMore.width).toBeGreaterThanOrEqual(44);
  expect(mobileMore.height).toBeGreaterThanOrEqual(44);
  expect(mobileApprove.x + mobileApprove.width).toBeLessThanOrEqual(mobileMore.x);
  await row.locator('.row-more').click();
  await expect(page.getByRole('menu', { name: 'Caption 1 actions' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('precision-mobile-row-menu.png') });
});
