import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { buildCaptionWordTiming, type CaptionProject, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
const project = () => state.projects[0] as unknown as CaptionProject;
const first = () => project().captions[0];

function cue(id: string, text: string, startMs: number, endMs: number, starts: number[], ends: number[]) {
  const tokens: TimedToken[] = text.split(' ').map((word, index) => ({
    id: `${id}-w${index}`, text: word, startMs: starts[index], endMs: ends[index], spaceBefore: index > 0,
    timingSource: 'stt', confidence: .99, alignmentScore: .99,
  }));
  const caption: CaptionSegment = { id, text, startMs, endMs, timingSource: 'stt', timingQuality: 'high', approved: true };
  caption.wordTiming = buildCaptionWordTiming(caption, tokens);
  return { caption, tokens };
}
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const left = cue('c1', 'I love you very much', 200, 2500, [200, 600, 1000, 1550, 2000], [450, 850, 1250, 1750, 2500]);
  const right = cue('c2', 'Next caption', 2800, 3600, [2800, 3200], [3100, 3500]);
  project().captions = [left.caption, right.caption];
  project().transcript!.tokens = [...left.tokens, ...right.tokens];
  project().transcript!.segments = structuredClone(project().captions);
  project().transcript!.fullText = `${left.caption.text} ${right.caption.text}`;
});
async function openTiming(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Word timing controls', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__wordFocusNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function activate(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.focus();
  await button.press('Enter');
}
async function expectNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__wordFocusNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function expectUncovered(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const points = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2];
    return rect.top >= 0 && rect.bottom <= innerHeight && points.every((y) => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
      return hit === node || (hit !== null && node.contains(hit));
    });
  })).toBe(true);
}
test('Edit word timing focuses the selected caption’s visible controls on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 844 });
  await openProject(page);
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit word timing', exact: true }).press('Enter');
  const sync = page.getByRole('group', { name: 'Word timing controls', exact: true }).getByRole('button', { name: 'Sync words', exact: true });
  await expect(sync).toBeFocused();
  await expectUncovered(sync);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(first().text);
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const width of [1440, 390]) {
  test(`manual word creation and application keep the selected word focused at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    first().text = 'I love you really much';
    delete first().wordTiming;
    const before = structuredClone(first());
    await openTiming(page);
    await activate(page, 'Set words manually');
    const word = page.getByRole('button', { name: 'Word 1: I', exact: true });
    await expect(word).toBeFocused();
    await expectUncovered(word);
    await expect.poll(() => first().wordTiming?.words[0].startMs).toBe(null);
    const end = page.getByLabel('Word end time', { exact: true });
    await end.fill('0.450');
    await end.press('Enter');
    await activate(page, 'Apply word timing');
    await expect(word).toBeFocused();
    await expectUncovered(word);
    await expect.poll(() => first().wordTiming?.words[0].source).toBe('manual');
    expect(first().wordTiming!.words[0].startMs).toBe(200);
    expect(first().wordTiming!.words[0].endMs).toBe(450);
    expect(first().wordTiming!.words.slice(1).every((item) => item.startMs === null && item.endMs === null)).toBe(true);
    expect([first().text, first().startMs, first().endMs, first().approved]).toEqual([before.text, before.startMs, before.endMs, before.approved]);
    await expectNodes(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`word-action-focus-${width}.png`), animations: 'disabled' });
    await activate(page, 'Undo');
    await expect.poll(() => first().wordTiming?.words[0].startMs).toBe(null);
  });
}

test('confirming a word that needs review keeps it selected and remains undoable', async ({ page }) => {
  first().wordTiming!.words[3].needsReview = true;
  const before = structuredClone(first());
  await openTiming(page);
  const word = page.getByRole('button', { name: 'Word 4: very', exact: true });
  await expect(word).toHaveAttribute('aria-pressed', 'true');
  await activate(page, 'Confirm this word');
  await expect(word).toBeFocused();
  await expect.poll(() => first().wordTiming!.words[3].source).toBe('manual');
  expect(first().wordTiming!.words[3].needsReview).not.toBe(true);
  expect(first().wordTiming!.words.filter((_, index) => index !== 3)).toEqual(before.wordTiming!.words.filter((_, index) => index !== 3));
  expect([first().text, first().startMs, first().endMs, first().approved]).toEqual([before.text, before.startMs, before.endMs, before.approved]);
  await activate(page, 'Undo');
  await expect.poll(() => first()).toEqual(before);
  await expectNodes(page);
});

for (const action of ['Close preview', 'Use tentative timing']) {
  test(`${action} returns to Sync words without losing the selected word`, async ({ page }) => {
    let calls = 0;
    await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
      calls++;
      const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
      const wordTiming = structuredClone(caption.wordTiming!);
      wordTiming.words[3].needsReview = true;
      await route.fulfill({ json: { basis: caption, wordTiming } });
    });
    const before = structuredClone(first().wordTiming);
    await openTiming(page);
    await activate(page, 'Word 4: very');
    await activate(page, 'Sync words');
    await expect(page.getByRole('button', { name: 'Use tentative timing', exact: true })).toBeVisible();
    await activate(page, action);
    await expect(page.getByRole('button', { name: 'Sync words', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Word 4: very', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toHaveCount(0);
    if (action === 'Close preview') expect(first().wordTiming).toEqual(before);
    else await expect.poll(() => first().wordTiming!.words[3].needsReview).toBe(true);
    expect(calls).toBe(1);
    await expectNodes(page);
  });
}

for (const width of [1440, 390]) test(`Cancel sync keeps keyboard continuity and ignores late responses at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const gate = deferred();
  const replied = deferred();
  let requested = false;
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    requested = true;
    await gate.promise;
    try { await route.fulfill({ json: { basis: caption, wordTiming: caption.wordTiming } }); }
    finally { replied.release(); }
  });
  try {
    const before = structuredClone(first().wordTiming);
    await openTiming(page);
    await activate(page, 'Sync words');
    await expect.poll(() => requested).toBe(true);
    await activate(page, 'Cancel sync');
    await expect(page.getByRole('button', { name: 'Cancel sync', exact: true })).toHaveCount(0);
    const panel = page.getByRole('group', { name: 'Word timing controls', exact: true });
    const sync = page.getByRole('button', { name: 'Sync words', exact: true });
    // App clears its global busy state after the aborted request settles. The
    // explicit cancellation uses the named fallback and never moves focus twice.
    await expect(panel).toBeFocused();
    await expect(sync).toBeEnabled();
    await expect(panel).toBeFocused();
    await expectUncovered(panel.locator('.word-timing-head strong'));
    await page.screenshot({ path: info.outputPath(`word-cancel-focus-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Tab');
    await expect(sync).toBeFocused();
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill('I love you very much today');
    gate.release();
    await replied.promise;
    await expect(caption).toBeFocused();
    await expect(caption).toHaveValue('I love you very much today');
    await expect(page.getByRole('button', { name: 'Use tentative timing', exact: true })).toHaveCount(0);
    expect(first().wordTiming?.words[0].startMs).toBe(before!.words[0].startMs);
    await expectNodes(page);
  } finally { gate.release(); }
});
