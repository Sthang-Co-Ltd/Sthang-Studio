import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { buildCaptionWordTiming, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const current = () => state.projects[0];
const panel = (page: Page) => page.getByRole('group', { name: 'Word timing controls', exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function rememberEvidence(page: Page) {
  await page.evaluate(() => {
    document.querySelector('video')?.pause();
    (window as any).__editingEntryNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
    (window as any).__editingEntryReveals = [];
    const list = document.querySelector<HTMLElement>('.caption-list')!;
    const scroll = list.scrollTo.bind(list);
    Object.defineProperty(list, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => {
      (window as any).__editingEntryReveals.push(options);
      scroll(options);
    } });
  });
}
async function sameEvidence(page: Page) {
  expect(await page.evaluate(() => (window as any).__editingEntryNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function selectedIds(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-caption-id')));
}
async function uncovered(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const insetX = Math.min(6, rect.width / 4);
    const insetY = Math.min(6, rect.height / 4);
    const points = [[rect.left + insetX, rect.top + insetY], [rect.right - insetX, rect.top + insetY],
      [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + insetX, rect.bottom - insetY], [rect.right - insetX, rect.bottom - insetY]];
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth
      && rect.top >= 0 && rect.bottom <= innerHeight && points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === node || (hit !== null && node.contains(hit));
      });
  })).toBe(true);
}
function useWordFixture() {
  const make = (id: string, text: string, startMs: number, endMs: number, starts: number[], ends: number[]) => {
    const tokens: TimedToken[] = text.split(' ').map((word, index) => ({
      id: `${id}-w${index}`, text: word, startMs: starts[index], endMs: ends[index], spaceBefore: index > 0,
      timingSource: 'stt', confidence: .99, alignmentScore: .99,
    }));
    const caption: CaptionSegment = { id, text, startMs, endMs, timingSource: 'stt', timingQuality: 'high', approved: true };
    caption.wordTiming = buildCaptionWordTiming(caption, tokens);
    return { caption, tokens };
  };
  const first = make('c1', 'I love you very much', 200, 2500, [200, 600, 1000, 1550, 2000], [450, 850, 1250, 1750, 2500]);
  const second = make('c2', 'Next caption', 2800, 3600, [2800, 3200], [3100, 3500]);
  current().captions = [first.caption, second.caption];
  current().transcript!.tokens = [...first.tokens, ...second.tokens];
  current().transcript!.segments = structuredClone(current().captions);
  current().transcript!.fullText = `${first.caption.text} ${second.caption.text}`;
}
async function openWords(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await rememberEvidence(page);
}
async function startSync(page: Page) {
  const sync = page.getByRole('button', { name: 'Sync words', exact: true });
  await sync.focus();
  await page.keyboard.press('Enter');
}

for (const width of [1440, 390]) test(`ordinary Add focuses the new selected field after commit and retains the reduced-motion reveal policy at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openProject(page);
  await rememberEvidence(page);
  const before = structuredClone(current().captions);
  const add = page.getByRole('button', { name: 'Add caption', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const text = page.getByLabel('Caption 4 text', { exact: true });
  await expect(text).toBeFocused();
  await uncovered(text);
  if (width === 390) await page.screenshot({ path: info.outputPath('add-entry-focus-390.png'), animations: 'disabled' });
  await expect(page.getByLabel('Caption 4 start time', { exact: true })).toHaveValue('00:03.300');
  await expect(page.getByLabel('Caption 4 end time', { exact: true })).toHaveValue('00:04.000');
  const addedId = await page.locator('.caption-row').last().getAttribute('data-caption-id');
  expect(await selectedIds(page)).toEqual([addedId]);
  const reveals = await page.evaluate(() => (window as any).__editingEntryReveals as ScrollToOptions[]);
  expect(reveals.length).toBeGreaterThan(0);
  expect(reveals.every((options) => options.behavior === 'instant')).toBe(true);
  expect(current().captions).toEqual(before);
  await sameEvidence(page);
});

for (const destination of ['caption', 'player'] as const) test(`Add yields to a newer same-turn ${destination} focus choice without a later selection jump`, async ({ page }) => {
  await page.setViewportSize({ width: destination === 'player' ? 390 : 1440, height: 900 });
  await openProject(page);
  await rememberEvidence(page);
  await page.clock.install();
  const before = structuredClone(current().captions);
  const clock = await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }));
  await page.evaluate((destination) => {
    const add = document.querySelector<HTMLButtonElement>('[aria-label="Add caption"]')!;
    add.focus();
    add.click();
    const target = destination === 'caption'
      ? document.querySelector<HTMLTextAreaElement>('[data-caption-id="c2"] textarea')!
      : document.querySelector<HTMLVideoElement>('video')!;
    target.focus();
  }, destination);
  await page.clock.runFor(240);
  const target = destination === 'caption' ? page.getByLabel('Caption 2 text', { exact: true }) : page.locator('video');
  await expect(target).toBeFocused();
  await expect(page.locator('.caption-row')).toHaveCount(4);
  const addedId = await page.locator('.caption-row').last().getAttribute('data-caption-id');
  expect(await selectedIds(page)).toEqual([destination === 'caption' ? 'c2' : addedId]);
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }))).toEqual(clock);
  expect(current().captions).toEqual(before);
  await sameEvidence(page);
});

for (const width of [1440, 390]) test(`Sync start keeps a visible keyboard path to Cancel and ignores its late response at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  useWordFixture();
  const gate = deferred(); const replied = deferred();
  let requests = 0;
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    requests++;
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    await gate.promise;
    try { await route.fulfill({ json: { basis: caption, wordTiming: caption.wordTiming } }); }
    finally { replied.release(); }
  });
  try {
    await openWords(page);
    const before = structuredClone(current().captions);
    await startSync(page);
    await expect.poll(() => requests).toBe(1);
    await expect(panel(page)).toBeFocused();
    await uncovered(panel(page).locator('.word-timing-head strong'));
    await page.keyboard.press('Enter');
    expect(requests).toBe(1);
    await page.keyboard.press('Tab');
    const cancel = page.getByRole('button', { name: 'Cancel sync', exact: true });
    await expect(cancel).toBeFocused();
    await uncovered(cancel);
    await page.screenshot({ path: info.outputPath(`sync-entry-cancel-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Enter');
    await expect(cancel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sync words', exact: true })).toBeEnabled();
    await expect(panel(page)).toBeFocused();
    const newer = page.getByLabel('Caption 1 text', { exact: true });
    await newer.focus();
    gate.release();
    await replied.promise;
    await expect(newer).toBeFocused();
    expect(requests).toBe(1);
    expect(current().captions).toEqual(before);
    await sameEvidence(page);
  } finally { gate.release(); }
});

test('a completed Sync does not move focus from newer caption interaction or change a ready track', async ({ page }) => {
  useWordFixture();
  const gate = deferred();
  let requests = 0;
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    requests++;
    const { caption } = route.request().postDataJSON() as { caption: CaptionSegment };
    await gate.promise;
    await route.fulfill({ json: { basis: caption, wordTiming: caption.wordTiming } });
  });
  try {
    await openWords(page);
    const before = structuredClone(current().captions);
    await startSync(page);
    await expect.poll(() => requests).toBe(1);
    await expect(panel(page)).toBeFocused();
    const newer = page.getByLabel('Caption 1 text', { exact: true });
    await newer.focus();
    gate.release();
    await expect(page.getByText('Word timing is ready.', { exact: true })).toBeVisible();
    await expect(newer).toBeFocused();
    expect(requests).toBe(1);
    expect(current().captions).toEqual(before);
    await sameEvidence(page);
  } finally { gate.release(); }
});
