import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  state.projects[0].captions.forEach((caption) => { caption.timingQuality = 'low'; caption.approved = false; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function openMedia(page: Page, kind: 'video' | 'audio', workspace: 'Review' | 'Fine timing') {
  if (kind === 'audio') {
    state.projects[0].media = {
      ...state.projects[0].media, filename: 'keyboard.wav', originalName: 'keyboard.wav',
      mimeType: 'audio/wav', url: '/media/keyboard.wav',
    };
    await page.route('**/media/keyboard.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: createSyntheticWav(4, 440) }));
  }
  if (kind === 'audio') {
    await page.goto('/');
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await expect(page.locator('audio')).toBeVisible();
    await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 1);
    await page.locator('audio').evaluate((element: HTMLAudioElement) => {
      element.pause(); element.currentTime = 0.5; element.dispatchEvent(new Event('timeupdate'));
    });
  } else await openProject(page);
  if (workspace === 'Review') await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  else {
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await expect(page.locator('.fine-timing')).toBeVisible();
    await expect(page.locator('.waveform-loading')).toHaveCount(0);
  }
  const player = page.locator(kind).first();
  await expect(player).toBeVisible();
  await player.evaluate((element: HTMLMediaElement) => {
    element.pause();
    (window as any).__mediaShortcutPlays = 0;
    element.play = () => { (window as any).__mediaShortcutPlays++; return Promise.resolve(); };
    (window as any).__mediaShortcutNodes = [element, document.querySelector('.caption-list')];
  });
  return player;
}

async function key(page: Page, init: KeyboardEventInit) {
  // Retargeted native media events arrive at the video/audio host. Synthetic
  // dispatch checks ownership without invoking browser navigation or downloads.
  return page.evaluate((init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
    document.activeElement?.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);
}

async function snapshot(page: Page, kind: 'video' | 'audio') {
  return page.evaluate((kind) => ({
    rows: [...document.querySelectorAll<HTMLElement>('.caption-row')].map((row) => ({
      id: row.dataset.captionId,
      approved: row.classList.contains('approved'),
      selected: row.classList.contains('selected-range'),
      wording: row.querySelector('textarea')?.value,
      timing: [...row.querySelectorAll('input')].map((input) => input.value),
    })),
    time: document.querySelector<HTMLMediaElement>(kind)!.currentTime,
    plays: (window as any).__mediaShortcutPlays,
    focus: document.activeElement?.tagName,
    workspace: document.querySelector('.workspace-inspector:not([hidden])')?.getAttribute('aria-label'),
  }), kind);
}

async function expectRetainedNodes(page: Page, kind: 'video' | 'audio') {
  expect(await page.evaluate((kind) => (window as any).__mediaShortcutNodes.every(
    (node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : kind),
  ), kind)).toBe(true);
}

for (const kind of ['video', 'audio'] as const) {
  test('native ' + kind + ' controls keep Review keys while deliberate Save and Find still work', async ({ page }) => {
    const player = await openMedia(page, kind, 'Review');
    await player.focus();
    await expect(player).toBeFocused();
    const before = await snapshot(page, kind);
    for (const init of [
      ...['ArrowUp', 'ArrowDown', 'Enter', 'a', 's', 'r', 'e', 'j', ' ', 'Escape'].map((key) => ({ key })),
      { key: 'ArrowRight', altKey: true }, { key: 'ArrowLeft', altKey: true },
    ]) expect(await key(page, init), JSON.stringify(init)).toBe(false);
    expect(await snapshot(page, kind)).toEqual(before);
    await expect(page.getByRole('complementary', { name: 'Review workspace', exact: true })).toBeVisible();
    // Also exercise an actual native control key: it must not browse the queue.
    await player.press('ArrowDown');
    await expect(page.locator('[data-caption-id="c1"]')).toHaveClass(/selected-range/);
    await expect(page.locator('.caption-row')).toHaveCount(3);
    await expect(page.locator('.caption-row.approved')).toHaveCount(0);
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      expect(await key(page, { key: 's', [modifier]: true })).toBe(true);
      expect(await key(page, { key: 'f', [modifier]: true })).toBe(true);
      await expect(page.locator('.find-replace-modal')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.find-replace-modal')).toHaveCount(0);
      await expect(player).toBeFocused();
    }
    await expectRetainedNodes(page, kind);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await key(page, { key: 'ArrowDown' })).toBe(true);
    await expect(page.locator('[data-caption-id="c2"]')).toHaveClass(/selected-range/);
  });

  test('native ' + kind + ' controls do not replay, nudge or undo Fine timing', async ({ page }) => {
    const player = await openMedia(page, kind, 'Fine timing');
    const start = page.getByLabel('Fine timing start', { exact: true });
    await expect(start).toHaveValue('00:00.200');
    await page.getByRole('button', { name: 'Move later', exact: true }).click();
    await expect(start).toHaveValue('00:00.250');
    await player.focus();
    await expect(player).toBeFocused();
    const before = await snapshot(page, kind);
    for (const init of [
      { key: 'r' }, { key: 'Escape' }, { key: 'ArrowRight', altKey: true }, { key: 'ArrowLeft', altKey: true },
      { key: 'z', ctrlKey: true }, { key: 'z', metaKey: true },
      { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'z', metaKey: true, shiftKey: true },
    ]) expect(await key(page, init), JSON.stringify(init)).toBe(false);
    expect(await snapshot(page, kind)).toEqual(before);
    await expect(start).toHaveValue('00:00.250');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await expectRetainedNodes(page, kind);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await key(page, { key: 'z', ctrlKey: true })).toBe(true);
    await expect(start).toHaveValue('00:00.200');
  });
}
