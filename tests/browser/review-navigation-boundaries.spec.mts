import { test as base, expect, type Page } from '@playwright/test';
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
  state.profile.preferences.autoPlayNextReview = true;
  state.profile.preferences.autoLoopReview = false;
  state.projects[0].captions = state.projects[0].captions.map((caption) => ({
    ...caption, approved: false, timingQuality: 'low' as const,
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function shortcut(page: Page, key: string) {
  return page.evaluate((value) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, key);
}

async function selection(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-caption-id')));
}

async function evidence(page: Page) {
  return page.evaluate(() => {
    const observed = (window as any).__reviewBoundaryEvidence;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-id="c1"] textarea')!;
    return {
      selected: [...document.querySelectorAll('.caption-row.selected-range')].map((row) => row.getAttribute('data-caption-id')),
      seekWrites: observed.seekWrites, playCalls: observed.playCalls,
      time: video.currentTime, paused: video.paused,
      sameVideo: video === observed.video, sameField: field === observed.field,
      caret: [field.selectionStart, field.selectionEnd],
      listScroll: document.querySelector<HTMLElement>('.caption-list')!.scrollTop,
    };
  });
}

for (const width of [1440, 390]) test(`Review first/last keyboard boundaries match disabled buttons without a seek or autoplay at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(page.getByRole('complementary', { name: 'Review workspace', exact: true })).toBeVisible();
  await expect.poll(() => selection(page)).toEqual(['c1']);
  // Review opening has its own 40ms handoff. Settle it before measuring shortcuts.
  await page.waitForTimeout(100);
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-id="c1"] textarea')!;
    video.pause();
    field.setSelectionRange(2, 2);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    if (!descriptor?.get || !descriptor.set) throw new Error('Cannot observe native video seeks');
    const observed = { video, field, seekWrites: 0, playCalls: 0 };
    (window as any).__reviewBoundaryEvidence = observed;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get() { return descriptor.get!.call(video); },
      set(value: number) { observed.seekWrites++; descriptor.set!.call(video, value); },
    });
    video.play = () => { observed.playCalls++; return Promise.resolve(); };
  });
  const review = page.getByRole('complementary', { name: 'Review workspace', exact: true });
  await expect(review.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  const first = await evidence(page);
  expect(first).toMatchObject({ selected: ['c1'], sameVideo: true, sameField: true, caret: [2, 2], paused: true });

  // The visible Previous action is disabled: ArrowUp must not re-arm the first cue.
  expect(await shortcut(page, 'ArrowUp')).toBe(true);
  await page.clock.runFor(65);
  expect(await evidence(page)).toEqual(first);

  // Skip is deliberate autoplay, while ArrowDown is navigation without autoplay.
  expect(await shortcut(page, 's')).toBe(true);
  await expect.poll(() => selection(page)).toEqual(['c2']);
  await page.clock.runFor(65);
  const afterSkip = await evidence(page);
  expect(afterSkip.seekWrites).toBeGreaterThan(first.seekWrites);
  expect(afterSkip.playCalls).toBe(first.playCalls + 1);
  expect(afterSkip).toMatchObject({ sameVideo: true, sameField: true, caret: [2, 2] });

  expect(await shortcut(page, 'ArrowDown')).toBe(true);
  await expect.poll(() => selection(page)).toEqual(['c3']);
  await page.clock.runFor(65);
  const last = await evidence(page);
  expect(last.seekWrites).toBeGreaterThan(afterSkip.seekWrites);
  expect(last.playCalls).toBe(afterSkip.playCalls);
  await expect(review.getByRole('button', { name: 'Skip', exact: true })).toBeDisabled();

  // Both last-item shortcuts must honor the disabled Skip boundary.
  for (const key of ['ArrowDown', 's']) {
    expect(await shortcut(page, key)).toBe(true);
    await page.clock.runFor(65);
    expect(await evidence(page), `Last Review item must ignore ${key}`).toEqual(last);
  }
  expect(state.projects[0].captions.every((caption) => !caption.approved)).toBe(true);
});
