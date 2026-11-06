import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
  const first = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 12 }, (_, index) => ({
    ...first, id: `notification-${index + 1}`, text: `កម្ពុជា ${index + 1}`,
    startMs: 100 + index * 300, endMs: 350 + index * 300, approved: false,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
});

const undoToast = (page: Page) => page.locator('[data-toast-timer="review-undo"]');
const approve = (page: Page) => page.getByRole('button', { name: 'Approve & next', exact: true });
const firstRow = (page: Page) => page.locator('.caption-row[data-caption-id="notification-1"]');

async function openReview(page: Page) {
  await openProject(page);
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  await expect(approve(page)).toBeEnabled();
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  await page.evaluate(() => {
    (window as any).__notificationNodes = [
      document.querySelector('video'), document.querySelector('.caption-panel'),
      document.querySelector('.caption-list'), document.querySelector('[data-caption-id="notification-2"]'),
    ];
  });
}

async function rememberScrolledViewport(page: Page) {
  const list = page.locator('.caption-list');
  await expect.poll(() => list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.evaluate(() => {
    (window as any).__notificationViewport = {
      list: document.querySelector('.caption-list')!.scrollTop, x: scrollX, y: scrollY,
    };
  });
}

async function expectEvidenceStable(page: Page, checkScroll = true) {
  expect(await page.evaluate(() => {
    const selectors = ['video', '.caption-panel', '.caption-list', '[data-caption-id="notification-2"]'];
    return (window as any).__notificationNodes.every((node: Element | null, index: number) =>
      node !== null && node === document.querySelector(selectors[index]));
  })).toBe(true);
  if (checkScroll) {
    const scroll = await page.evaluate(() => ({
      current: { list: document.querySelector('.caption-list')!.scrollTop, x: scrollX, y: scrollY },
      expected: (window as any).__notificationViewport,
    }));
    expect(scroll.current.list).toBeCloseTo(scroll.expected.list, 0);
    expect(scroll.current.x).toBe(scroll.expected.x);
    expect(scroll.current.y).toBe(scroll.expected.y);
  }
}

for (const reading of ['hover', 'keyboard focus'] as const) test(`Review Undo pauses during ${reading} and resumes only its remaining lifetime`, async ({ page }, info) => {
  await openReview(page);
  await approve(page).click();
  await page.mouse.move(5, 5);
  await expect(firstRow(page)).toHaveCount(0);
  const toast = undoToast(page);
  await expect(toast).toContainText('Approved. Moved to the next review item.');
  // Let deliberate Review navigation settle before testing notification stability.
  await page.waitForTimeout(1250);
  await rememberScrolledViewport(page);
  await page.waitForTimeout(1400);
  if (reading === 'hover') await toast.hover();
  else await toast.getByRole('button', { name: 'Undo', exact: true }).focus();
  // Real time avoids altering media playback or the owned fixture's timers.
  await page.waitForTimeout(6800);
  await expect(toast).toBeVisible();
  if (reading === 'keyboard focus') await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeFocused();
  if (reading === 'hover') await page.screenshot({ path: info.outputPath('review-undo.png') });
  await expectEvidenceStable(page);
  if (reading === 'hover') await page.mouse.move(5, 5);
  else await approve(page).focus();
  await page.waitForTimeout(300);
  await expect(toast).toBeVisible();
  // About 2.6 seconds were consumed before pausing: restarting a fresh 6.5-second
  // lifetime on leave/blur would fail this bound, even including the short exit.
  await expect(toast).toHaveCount(0, { timeout: 4800 });
  await expect(firstRow(page)).toHaveCount(0);
  await expectEvidenceStable(page);
});

test('Activity pauses Review Undo while unavailable and Undo still restores the approved decision', async ({ page }) => {
  await openReview(page);
  await approve(page).click();
  await page.mouse.move(5, 5);
  await expect(firstRow(page)).toHaveCount(0);
  await expect(undoToast(page)).toBeVisible();
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(6800);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(undoToast(page)).toBeVisible();
  await expectEvidenceStable(page, false);
  await undoToast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(firstRow(page)).toBeVisible();
  await expect(firstRow(page)).toHaveClass(/selected-range/);
  await expect(firstRow(page).getByRole('button', { name: 'Approve caption and move to the next review item', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-toast-timer="notice"]')).toHaveText('Approval undone.');
  await expect(undoToast(page)).toHaveCount(0);
  await expectEvidenceStable(page, false);
});

for (const reduced of [false, true]) test(`explicit notice dismissal restores its opener without moving evidence, reduced motion ${reduced}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await openReview(page);
  await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
  const opener = page.getByRole('button', { name: 'Lock text', exact: true });
  await opener.click();
  const notice = page.locator('[data-toast-timer="notice"]');
  await expect(notice).toHaveText('Selected text locked.');
  await page.mouse.move(5, 5);
  await rememberScrolledViewport(page);
  if (reduced) {
    expect(await notice.evaluate((node) => node.closest('.toast-slot')!.getAnimations().length)).toBe(0);
    // Studio's shared reduced-motion rule uses a near-zero !important duration
    // for transition-event compatibility; assert the behavior, not serialization.
    const duration = await notice.evaluate((node) => getComputedStyle(node.closest('.toast-slot')!).transitionDuration);
    expect(duration.split(',').every((value) => parseFloat(value) <= .001)).toBe(true);
  }
  // Observe the actual close commit, including a retained normal-motion subtree.
  await notice.evaluate((node) => {
    const slot = node.closest<HTMLElement>('.toast-slot')!;
    (window as any).__notificationExit = null;
    const observer = new MutationObserver(() => {
      if (slot.dataset.motionState !== 'closed') return;
      (window as any).__notificationExit = {
        inert: slot.inert, hidden: slot.getAttribute('aria-hidden'), animations: slot.getAnimations().length,
      };
      observer.disconnect();
    });
    observer.observe(slot, { attributes: true, attributeFilter: ['data-motion-state', 'inert', 'aria-hidden'] });
  });
  const dismiss = notice.getByRole('button', { name: 'Dismiss notice', exact: true });
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await dismiss.press('Enter');
  await expect(opener).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as any).__notificationExit)).not.toBeNull();
  const exit = await page.evaluate(() => (window as any).__notificationExit);
  expect(exit.inert).toBe(true);
  expect(exit.hidden).toBe('true');
  if (reduced) expect(exit.animations).toBe(0);
  await expect(notice).toHaveCount(0);
  await expectEvidenceStable(page);
});
