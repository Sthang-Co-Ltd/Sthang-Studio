import { test, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming, type CaptionProject, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;

function makeCue(id: string, text: string, startMs: number, endMs: number, starts: number[], ends: number[]) {
  const tokens: TimedToken[] = text.split(' ').map((word, index) => ({ id: `${id}-w${index}`, text: word, startMs: starts[index], endMs: ends[index], spaceBefore: index > 0, timingSource: 'stt', confidence: .99, alignmentScore: .99 }));
  const caption: CaptionSegment = { id, text, startMs, endMs, timingSource: 'stt', timingQuality: 'high', approved: true };
  caption.wordTiming = buildCaptionWordTiming(caption, tokens);
  return { caption, tokens };
}

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  const first = makeCue('c1', 'I love you very much', 200, 2500, [200, 600, 1000, 1550, 2000], [450, 850, 1250, 1750, 2500]);
  const second = makeCue('c2', 'Next caption', 2800, 3600, [2800, 3200], [3100, 3500]);
  const project = state.projects[0] as unknown as CaptionProject;
  project.captions = [first.caption, second.caption];
  project.transcript!.tokens = [...first.tokens, ...second.tokens];
  project.transcript!.segments = structuredClone(project.captions);
  project.transcript!.fullText = `${first.caption.text} ${second.caption.text}`;
});

const project = () => state.projects[0] as unknown as CaptionProject;
const first = () => project().captions.find((caption) => caption.id === 'c1')!;

async function openTiming(page: Page, words = true) {
  await openProject(page);
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await expect(page.locator('.fine-timing')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  if (words) await page.getByRole('button', { name: 'Word timing', exact: true }).click();
}

async function selectWord(page: Page, index: number, text: string) {
  await page.getByRole('button', { name: `Word ${index}: ${text}`, exact: true }).click();
}

test('caption moves stop at the next caption and translate owned words exactly once', async ({ page }) => {
  await openTiming(page, false);
  await page.getByLabel('Timing nudge step').selectOption('100');
  for (let index = 0; index < 5; index++) await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => first().endMs).toBe(2800);
  expect(first().startMs).toBe(500);
  expect(first().wordTiming!.words[0].startMs).toBe(500);
  expect(first().wordTiming!.words[3].startMs).toBe(1850);
  expect(project().captions[1].startMs).toBe(2800);
  await page.locator('.timing-options > summary').click();
  await page.getByLabel('Allow overlaps', { exact: true }).check();
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => first().endMs).toBe(2900);
  await expect(page.locator('.fine-timing')).toContainText('This caption overlaps another caption');
});

test('shared edge edits and undo keep both neighbors in one transaction', async ({ page }) => {
  await openTiming(page, false);
  await page.locator('.timing-options > summary').click();
  await page.getByLabel('Move adjoining edge too', { exact: true }).check();
  await page.getByRole('button', { name: 'Move end later by 50 milliseconds', exact: true }).click();
  await expect.poll(() => first().endMs).toBe(2550);
  expect(project().captions[1].startMs).toBe(2550);
  expect(first().wordTiming!.words[4].endMs).toBe(2500);
  expect(project().captions[1].wordTiming!.words[0].startMs).toBe(2800);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => first().endMs).toBe(2500);
  expect(project().captions[1].startMs).toBe(2800);
});

test('individual word nudge changes only that word and is undoable after saving', async ({ page }) => {
  await openTiming(page);
  await selectWord(page, 4, 'very');
  await page.getByRole('button', { name: 'Move word earlier', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1500);
  expect(first().wordTiming!.words[3].endMs).toBe(1700);
  expect(first().wordTiming!.words[2].endMs).toBe(1250);
  expect(first().wordTiming!.words[4].startMs).toBe(2000);
  expect([first().startMs, first().endMs, first().text]).toEqual([200, 2500, 'I love you very much']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1550);
});

test('word dragging commits on release and Escape cancels the local preview', async ({ page }) => {
  await openTiming(page);
  await page.getByRole('button', { name: 'Full clip', exact: true }).click();
  const canvas = page.locator('.waveform-data-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const x = (ms: number) => box.x + ms / 4000 * box.width;
  await page.mouse.move(x(1550), box.y + 116);
  await page.mouse.down();
  await page.mouse.move(x(1450), box.y + 116, { steps: 4 });
  expect(first().wordTiming!.words[3].startMs).toBe(1550);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.fine-timing')).toBeVisible();
  expect(first().wordTiming!.words[3].startMs).toBe(1550);
  await page.mouse.move(x(1550), box.y + 116);
  await page.mouse.down();
  await page.mouse.move(x(1450), box.y + 116, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1450);
  expect(first().wordTiming!.words[3].endMs).toBe(1750);
});

test('corrected spelling keeps tentative timing until the user confirms that word', async ({ page }) => {
  project().captionAppearance = { ...project().captionAppearance!, highlightMode: 'word' };
  await openTiming(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('I love you really much');
  await selectWord(page, 4, 'really');
  await expect.poll(() => first().wordTiming!.words[3].needsReview).toBe(true);
  expect(first().wordTiming!.words[0].startMs).toBe(200);
  expect(first().wordTiming!.words[3].startMs).toBe(1550);
  await expect(page.locator('.word-timing-panel')).toContainText('Highlighting stays off');
  await page.getByRole('button', { name: 'Confirm this word', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].source).toBe('manual');
  expect(first().wordTiming!.words[3].needsReview).not.toBe(true);
  await expect(page.locator('.word-timing-panel')).toContainText('Each word has usable timing');
});

test('an inserted word starts untimed and can be assigned without stretching other words', async ({ page }) => {
  await openTiming(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('I love you so very much');
  await selectWord(page, 4, 'so');
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(null);
  await page.getByLabel('Word start time', { exact: true }).fill('1.300');
  await page.getByLabel('Word start time', { exact: true }).press('Enter');
  await page.getByLabel('Word end time', { exact: true }).fill('1.500');
  await page.getByLabel('Word end time', { exact: true }).press('Enter');
  expect(first().wordTiming!.words[3].startMs).toBe(null);
  await page.getByRole('button', { name: 'Apply word timing', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1300);
  expect(first().wordTiming!.words[4].startMs).toBe(1550);
  expect(first().wordTiming!.words[2].endMs).toBe(1250);
});

test('equal-time word selection clears an invalid draft and exposes review status accessibly', async ({ page }) => {
  // Equal ends leave each word a possible repair interval. Equal starts would
  // deliberately activate the separately tested no-room guard on the first word.
  first().wordTiming!.words[0].endMs = 850;
  first().wordTiming!.words[1].needsReview = true;
  await openTiming(page);
  const end = page.getByLabel('Word end time', { exact: true });
  await end.fill('00:');
  await selectWord(page, 2, 'love');
  await expect(end).toHaveValue('00:00.850');
  await expect(end).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Word 2: love', exact: true })).toHaveAccessibleDescription('Needs review');
  await expect(page.getByRole('button', { name: 'Word 4: very', exact: true })).toHaveAccessibleDescription('');
  expect(first().wordTiming!.words[1].endMs).toBe(850);
});

test('an untimed word with no available gap explains recovery and becomes editable after making room', async ({ page }) => {
  state.native = true;
  first().wordTiming!.words[3].startMs = 1250;
  await openTiming(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('I love you so very much');
  await selectWord(page, 4, 'so');
  await expect(page.locator('.word-timing-panel')).toContainText('No room for this word');
  await expect(page.getByLabel('Word start time', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply word timing', exact: true })).toBeDisabled();
  await page.locator('.word-timing-selected').scrollIntoViewIfNeeded();
  await expect(page.locator('.media-stage')).toBeInViewport();
  await page.screenshot({ path: 'test-results/word-timing-no-room-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const guidance = page.locator('.word-timing-selected [role="status"]');
  await guidance.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const playerBox = (await page.locator('.media-stage').boundingBox())!;
  const guidanceBox = (await guidance.boundingBox())!;
  expect(guidanceBox.y).toBeGreaterThanOrEqual(playerBox.y + playerBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/word-timing-no-room-mobile.png' });
  await selectWord(page, 5, 'very');
  await page.getByRole('button', { name: 'Move word start later', exact: true }).click();
  await selectWord(page, 4, 'so');
  await expect(page.getByLabel('Word start time', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply word timing', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply word timing', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1250);
  expect(first().wordTiming!.words[3].endMs).toBe(1300);
  expect(first().wordTiming!.words[2].endMs).toBe(1250);
  expect(first().wordTiming!.words[4].startMs).toBe(1300);
});

test('local sync is a proposal until Use timing, and applying it participates in undo', async ({ page }) => {
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    const wordTiming = structuredClone(caption.wordTiming!);
    wordTiming.words[3] = { ...wordTiming.words[3], startMs: 1450, endMs: 1700 };
    await route.fulfill({ json: { basis: caption, wordTiming } });
  });
  await openTiming(page);
  await page.getByRole('button', { name: 'Sync words', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use timing', exact: true })).toBeVisible();
  expect(first().wordTiming!.words[3].startMs).toBe(1550);
  await selectWord(page, 4, 'very');
  await expect(page.getByLabel('Word start time', { exact: true })).toHaveValue('00:01.450');
  await page.getByRole('button', { name: 'Use timing', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1450);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1550);
});

test('opening unresolved word timing automatically prepares one ready local proposal without applying it', async ({ page }) => {
  let requests = 0;
  first().wordTiming!.words[0].needsReview = true;
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    requests += 1;
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    const wordTiming = structuredClone(caption.wordTiming!);
    wordTiming.words[0] = { ...wordTiming.words[0] };
    delete wordTiming.words[0].needsReview;
    await route.fulfill({ json: { basis: caption, wordTiming } });
  });

  const before = structuredClone(first().wordTiming);
  await openTiming(page);
  await expect(page.getByRole('button', { name: 'Use timing', exact: true })).toBeVisible();
  expect(requests).toBe(1);
  expect(first().wordTiming).toEqual(before);
  await page.getByRole('button', { name: 'Keep current', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use timing', exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('an unchanged sync proposal clears the selected word invalid draft without applying it', async ({ page }) => {
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    await route.fulfill({ json: { basis: caption, wordTiming: caption.wordTiming } });
  });
  await openTiming(page);
  const original = structuredClone(first().wordTiming);
  const start = page.getByLabel('Word start time', { exact: true });
  await start.fill('00:');
  await page.getByRole('button', { name: 'Sync words', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use timing', exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(start).toHaveValue('00:00.200');
  await expect(start).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Keep current', exact: true }).click();
  await expect(start).toBeEnabled();
  await expect(start).toHaveValue('00:00.200');
  expect(first().wordTiming).toEqual(original);
});

test('a newer word edit invalidates a local-sync response without losing the edit', async ({ page }) => {
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    requested = true;
    await gate;
    await route.fulfill({ json: { basis: caption, wordTiming: caption.wordTiming } });
  });
  try {
    await openTiming(page);
    await selectWord(page, 4, 'very');
    await page.getByRole('button', { name: 'Sync words', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.getByRole('button', { name: 'Move word earlier', exact: true }).click();
    release();
    await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1500);
    await expect(page.getByRole('button', { name: 'Use timing', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sync words', exact: true })).toBeEnabled();
  } finally { release?.(); }
});

test('timing locks disable word changes and sync while leaving playback available', async ({ page }) => {
  first().timingLocked = true;
  await openTiming(page);
  await expect(page.getByLabel('Word start time', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sync words', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move word later', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Hear word', exact: true })).toBeEnabled();
});

test('an older multi-caption project hydrates only its exact owned word windows', async ({ page }) => {
  delete first().wordTiming;
  delete project().captions[1].wordTiming;
  await openTiming(page);
  await expect(page.getByRole('button', { name: 'Word 4: very', exact: true })).toBeVisible();
  await expect(page.locator('.word-timing-panel')).toContainText('Each word has usable timing');
  await page.getByRole('button', { name: 'Next caption', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Word 1: Next', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Word 4: very', exact: true })).toHaveCount(0);
});

test('temporary Khmer composition does not destroy the original word timings', async ({ page }) => {
  const khmer = makeCue('c1', 'ខ្មែរ AI', 200, 2500, [200, 1100], [900, 1700]);
  project().captions[0] = khmer.caption;
  project().transcript!.tokens = khmer.tokens;
  const original = structuredClone(khmer.caption.wordTiming);
  await openTiming(page);
  const text = page.getByLabel('Caption 1 text', { exact: true });
  await text.focus();
  await text.dispatchEvent('compositionstart');
  await text.fill('ខ្ AI');
  await text.fill('ខ្មែរ AI');
  await text.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await expect.poll(() => first().wordTiming).toEqual(original);
  await expect(page.locator('.word-timing-panel')).toContainText('Each word has usable timing');
});

test('spoken-word highlight setting saves and links directly to the word editor', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: /^Appearance$/i }).click();
  const toggle = page.getByRole('button', { name: 'Highlight spoken word', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect.poll(() => project().captionAppearance?.highlightMode).toBe('word');
  await expect(page.locator('.appearance-highlight-readiness')).toContainText('2 of 2 captions');
  await page.getByRole('button', { name: 'Edit word timing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Word timing', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.word-timing-panel')).toBeVisible();
});

test('native preview changes paint when seeking between words and restores plain text during a gap', async ({ page }) => {
  state.native = true;
  project().captionAppearance = { ...project().captionAppearance!, highlightMode: 'word', highlightColor: '#D7FF4F' };
  await openProject(page);
  const seek = async (seconds: number) => {
    await page.locator('video').evaluate((video: HTMLVideoElement, value) => { video.pause(); video.currentTime = value; video.dispatchEvent(new Event('timeupdate')); }, seconds);
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    await expect(page.locator('.native-caption-image')).toBeVisible();
  };
  await seek(.3);
  const firstPaint = await page.locator('.native-caption-image').getAttribute('src');
  await seek(1.6);
  await expect.poll(() => page.locator('.native-caption-image').getAttribute('src')).not.toBe(firstPaint);
  const fourthPaint = await page.locator('.native-caption-image').getAttribute('src');
  await seek(1.9);
  await expect.poll(() => page.locator('.native-caption-image').getAttribute('src')).not.toBe(fourthPaint);
  await seek(.3);
  await expect.poll(() => page.locator('.native-caption-image').getAttribute('src')).toBe(firstPaint);
});

test('word controls fit a narrow screen with labeled touch targets', async ({ page }) => {
  state.native = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await openTiming(page);
  await selectWord(page, 4, 'very');
  await page.getByLabel('Word start time', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator('.media-stage')).toBeInViewport();
  const mediaBox = (await page.locator('.media-stage').boundingBox())!;
  const timeBox = (await page.getByLabel('Word start time', { exact: true }).boundingBox())!;
  expect(timeBox.y).toBeGreaterThanOrEqual(mediaBox.y + mediaBox.height);
  const heights = await page.locator('.word-timing-panel button:visible').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(heights.every((height) => height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/word-timing-mobile.png', fullPage: true });
});

test('desktop word editing keeps playback visible and retains saved timing on reopen', async ({ page }) => {
  state.native = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openTiming(page);
  await selectWord(page, 4, 'very');
  await page.getByRole('button', { name: 'Move word earlier', exact: true }).click();
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1500);
  await page.getByLabel('Word start time', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator('.media-stage')).toBeInViewport();
  await page.screenshot({ path: 'test-results/word-timing-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await page.getByRole('button', { name: /^Fine timing$/i }).click();
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await selectWord(page, 4, 'very');
  await expect(page.getByLabel('Word start time', { exact: true })).toHaveValue('00:01.500');
});

test('word time entry displays the same 10 ms value that is saved', async ({ page }) => {
  await openTiming(page);
  await selectWord(page, 4, 'very');
  const start = page.getByLabel('Word start time', { exact: true });
  await start.fill('1.503');
  await start.press('Enter');
  await expect(start).toHaveValue('00:01.500');
  await expect.poll(() => first().wordTiming!.words[3].startMs).toBe(1500);
  await start.press('Escape');
  await expect(start).toHaveValue('00:01.500');
});

test('splitting and merging preserve complete owned words and their timing', async ({ page }) => {
  await openProject(page);
  const originalWords = structuredClone(first().wordTiming!.words);
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split caption', exact: true }).click();
  await expect.poll(() => project().captions.length).toBe(3);
  const split = project().captions.slice(0, 2);
  expect(`${split[0].text} ${split[1].text}`).toBe('I love you very much');
  expect(split.flatMap((caption) => caption.wordTiming!.words).map(({ id, startMs, endMs }) => ({ id, startMs, endMs })))
    .toEqual(originalWords.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Merge with next', exact: true }).click();
  await expect.poll(() => project().captions.length).toBe(2);
  expect(project().captions[0].wordTiming!.words).toEqual(originalWords);
});

test('a corrected legacy project cannot reattach old word timings on reopen', async ({ page }) => {
  delete first().wordTiming;
  first().text = 'I love you really much';
  await openTiming(page);
  await expect(page.locator('.word-timing-panel')).toContainText('No editable word timings');
  await expect(page.getByRole('button', { name: 'Word 4: very', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set words manually', exact: true })).toBeEnabled();
});

test('merging nested captions preserves the longer caption and all original word intervals', async ({ page }) => {
  const nested = makeCue('c2', 'Next caption', 1000, 1500, [1000, 1300], [1200, 1450]);
  project().captions[1] = nested.caption;
  const originalWords = project().captions.flatMap((caption) => caption.wordTiming!.words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
  await openProject(page);
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Merge with next', exact: true }).click();
  await expect.poll(() => project().captions.length).toBe(1);
  const merged = project().captions[0];
  expect([merged.startMs, merged.endMs]).toEqual([200, 2500]);
  expect(merged.wordTiming!.words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))).toEqual(originalWords);
});
