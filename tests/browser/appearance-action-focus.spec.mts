import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { buildCaptionWordTiming, resolveCaptionWordTiming, type CaptionProject, type CaptionSegment, type TimedToken } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
let tokens: TimedToken[];
let syncHold: ReturnType<typeof deferred> | null;
let undoHold: ReturnType<typeof deferred> | null;
let cancelResponse: boolean;
let syncCalls: number;
let batchCalls: Array<{ action: 'apply' | 'undo'; changes: Array<{ before: CaptionSegment; after: CaptionSegment }> }>;
const project = () => state.projects[0] as CaptionProject;
const group = (page: Page) => page.locator('.appearance-word-details');
const summary = (page: Page) => group(page).locator(':scope > summary');
const toggle = (page: Page) => page.getByRole('button', { name: 'Highlight spoken word', exact: true });
const exactSize = (page: Page) => page.getByRole('spinbutton', { name: 'Exact size', exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); syncHold = null; undoHold = null; cancelResponse = false; syncCalls = 0; batchCalls = [];
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  tokens = [{ id: 'w1', text: 'ខ្មែរ', startMs: 220, endMs: 620, spaceBefore: false, timingSource: 'stt', confidence: .99, alignmentScore: .99 },
    { id: 'w2', text: 'AI', startMs: 720, endMs: 1100, spaceBefore: true, timingSource: 'stt', confidence: .99, alignmentScore: .99 }];
  const caption: CaptionSegment = { id: 'c1', text: 'ខ្មែរ AI', startMs: 200, endMs: 1200, timingSource: 'stt', timingQuality: 'high', approved: true };
  const timing = buildCaptionWordTiming(caption, tokens)!;
  caption.wordTiming = { ...timing, words: timing.words.map((word, index) => index ? word : { ...word, source: 'estimated', needsReview: true }) };
  project().captions = [caption]; project().captionAppearance = { ...project().captionAppearance!, highlightMode: 'off' };
  project().transcript!.tokens = tokens; project().transcript!.segments = structuredClone(project().captions); project().transcript!.fullText = caption.text;
  await page.route('**/api/projects/landscape/caption-word-timing', async (route) => {
    const { caption: basis } = route.request().postDataJSON() as { caption: CaptionSegment };
    const held = syncHold; const abort = cancelResponse; syncCalls += 1;
    await held?.promise;
    if (abort) { await route.abort('aborted').catch(() => {}); return; }
    await route.fulfill({ json: { basis, wordTiming: buildCaptionWordTiming(basis, tokens), sourceRevision: 'owned-kfa-fixture' } });
  });
  await page.route('**/api/projects/landscape/caption-word-timing/batch-apply', async (route) => {
    const body = route.request().postDataJSON() as (typeof batchCalls)[number]; batchCalls.push(structuredClone(body));
    if (body.action === 'undo') await undoHold?.promise;
    for (const { before, after } of body.changes) {
      const index = project().captions.findIndex((caption) => caption.id === before.id);
      if (index < 0) throw new Error('Unknown owned batch caption');
      project().captions[index] = structuredClone(after);
    }
    await route.fulfill({ json: { project: project(), appliedCount: body.changes.length } });
  });
});
async function openAppearance(page: Page, enabled = false) {
  project().captionAppearance!.highlightMode = enabled ? 'word' : 'off';
  await openProject(page); await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.evaluate(() => { document.querySelector('video')?.pause(); (window as any).__appearanceActionNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function activate(page: Page, target: Locator) { await target.focus(); await page.keyboard.press('Enter'); }
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    const hits = [top + 2, top + height / 2, bottom - 2].map((y) => {
      const hit = document.elementFromPoint(left + width / 2, y);
      return { y, own: hit === node || (hit !== null && node.contains(hit)), tag: hit?.tagName, class: hit?.getAttribute('class') };
    });
    return { focused: document.activeElement === node, inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: hits.every((hit) => hit.own), rect: { left, top, right, bottom, width, height }, hits };
  })).toMatchObject({ focused: true, inViewport: true, uncovered: true });
}
async function keptNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__appearanceActionNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}

for (const width of [1440, 390]) test(`exact appearance input leaves composition and modified keys uncommitted at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await openAppearance(page);
  const before = structuredClone(project().captions); const initial = project().captionAppearance!.fontSize1080;
  const input = exactSize(page); await input.fill('73');
  await input.dispatchEvent('compositionstart'); await input.press('Enter');
  await expect(input).toBeFocused(); await expect(input).toHaveValue('73');
  await input.press('Escape');
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  await expect(input).toBeFocused(); await expect(input).toHaveValue('73');
  await input.dispatchEvent('compositionend');
  const variants = [{ keyCode: 229 }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { altGraph: true }];
  for (const variant of variants) for (const key of ['Enter', 'Escape']) {
    const prevented = await input.evaluate((node, { key, variant }) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...variant });
      if ('altGraph' in variant) Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' });
      node.dispatchEvent(event); return event.defaultPrevented;
    }, { key, variant });
    expect(prevented).toBe(false); await expect(input).toBeFocused(); await expect(input).toHaveValue('73');
    await expect(page.getByRole('slider', { name: 'Size slider', exact: true })).toHaveValue(String(initial));
    expect(project().captionAppearance!.fontSize1080).toBe(initial);
  }
  await input.press('Enter'); await expect(input).toHaveValue('73');
  await expect.poll(() => project().captionAppearance!.fontSize1080).toBe(73);
  await input.fill('81'); await input.press('Escape'); await expect(input).toHaveValue('73');
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  await input.fill('82'); await input.press('Tab'); await expect.poll(() => project().captionAppearance!.fontSize1080).toBe(82);
  await page.locator('.appearance-history').getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue('73');
  await page.locator('.appearance-history').getByRole('button', { name: 'Redo', exact: true }).click(); await expect(input).toHaveValue('82');
  expect(project().captions).toEqual(before); await keptNodes(page);
  await page.screenshot({ path: info.outputPath(`appearance-key-boundaries-${width}.png`), animations: 'disabled' });
});

for (const width of [1440, 390]) test(`explicit word sync and off-state Undo hand off before their controls change at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await openAppearance(page, true);
  const before = structuredClone(project().captions); syncHold = deferred(); undoHold = deferred();
  try {
    await activate(page, page.getByRole('button', { name: 'Sync remaining', exact: true }));
    await expect.poll(() => syncCalls).toBe(1); await visibleFocus(summary(page));
    await expect(page.getByRole('region', { name: 'Preparing word highlights', exact: true })).toBeVisible();
    syncHold.release();
    const undo = page.getByRole('button', { name: 'Undo timing changes', exact: true }); await expect(undo).toBeEnabled();
    await expect(summary(page)).toBeFocused(); expect(resolveCaptionWordTiming(project().captions[0]).state).toBe('ready');
    expect(project().captions[0].approved).toBe(true);
    await activate(page, toggle(page)); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await activate(page, undo); await expect.poll(() => batchCalls.length).toBe(2); await visibleFocus(summary(page));
    await page.screenshot({ path: info.outputPath(`word-batch-undo-focus-${width}.png`), animations: 'disabled' });
    if (width === 390) { await exactSize(page).focus(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('78'); }
    undoHold.release(); await expect(undo).toHaveCount(0); await expect(group(page)).not.toHaveAttribute('open');
    if (width === 390) { await expect(exactSize(page)).toBeFocused(); await expect(exactSize(page)).toHaveValue('78'); }
    else await visibleFocus(summary(page));
    expect(batchCalls.map((call) => call.action)).toEqual(['apply', 'undo']); expect(project().captions).toEqual(before); await keptNodes(page);
  } finally { syncHold.release(); undoHold.release(); }
});

for (const width of [1440, 390]) test(`Cancel keeps the word-highlighting task focused and never applies the held batch at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await openAppearance(page, true);
  const before = structuredClone(project().captions); syncHold = deferred(); cancelResponse = true;
  try {
    await activate(page, page.getByRole('button', { name: 'Sync remaining', exact: true }));
    await expect.poll(() => syncCalls).toBe(1);
    await activate(page, page.getByRole('region', { name: 'Preparing word highlights', exact: true }).getByRole('button', { name: 'Cancel', exact: true }));
    await visibleFocus(summary(page));
    await expect(page.getByRole('region', { name: 'Preparing word highlights', exact: true })).toHaveCount(0);
    await expect(page.getByText('Sync canceled.', { exact: true })).toBeVisible();
    await visibleFocus(summary(page)); expect(batchCalls).toEqual([]); expect(project().captions).toEqual(before); await keptNodes(page);
    await page.screenshot({ path: info.outputPath(`word-batch-cancel-focus-${width}.png`), animations: 'disabled' });
  } finally { syncHold.release(); }
});

test('Cancel sync retains its summary and prevents waiting preparation after caption save', async ({ page }) => {
  await openAppearance(page);
  const before = structuredClone(project().captions[0].wordTiming);
  await page.getByRole('button', { name: 'Mark caption as needing review', exact: true }).click();
  await activate(page, summary(page)); await activate(page, toggle(page));
  await expect(page.getByText('Word sync will start after current caption work is saved.', { exact: true })).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Cancel sync', exact: true }));
  await visibleFocus(summary(page));
  await expect(page.getByText('Word sync will start after current caption work is saved.', { exact: true })).toHaveCount(0);
  const saved = page.waitForResponse((response) => response.url().endsWith('/captions') && response.request().method() === 'PUT');
  await page.keyboard.press('Control+s'); await (await saved).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(syncCalls).toBe(0); expect(batchCalls).toEqual([]); expect(project().captions[0].wordTiming).toEqual(before); await keptNodes(page);
});
