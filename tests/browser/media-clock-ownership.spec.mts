import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); } finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.addInitScript(() => {
    // Only programmatic dispatchEvent calls are counted. Native browser media
    // events are deliberately excluded, so the assertion isolates Studio's
    // synthetic clock updates and remains independent of decoder cadence.
    const emitted = new WeakMap<HTMLMediaElement, number>();
    (window as any).__mediaClockOwnership = {
      emitted,
      retired: null as HTMLMediaElement | null,
      captionField: null as HTMLTextAreaElement | null,
    };
    const original = HTMLMediaElement.prototype.dispatchEvent;
    HTMLMediaElement.prototype.dispatchEvent = function (this: HTMLMediaElement, event: Event) {
      if (event.type === 'timeupdate') emitted.set(this, (emitted.get(this) ?? 0) + 1);
      return original.call(this, event);
    };
  });
});

async function pulseClock(page: Page, owner: 'current' | 'retired') {
  return page.evaluate((owner) => {
    const probe = (window as any).__mediaClockOwnership as {
      emitted: WeakMap<HTMLMediaElement, number>;
      retired: HTMLMediaElement | null;
    };
    const media = owner === 'current'
      ? document.querySelector<HTMLMediaElement>('.media-stage video, .media-stage audio')
      : probe.retired;
    if (!media) throw new Error(`Missing ${owner} media player`);
    const before = probe.emitted.get(media) ?? 0;
    // The media stays paused: a synthetic play event must still cause exactly
    // one immediate clock sync from a currently bound owner.
    media.dispatchEvent(new Event('play'));
    return { emitted: (probe.emitted.get(media) ?? 0) - before, connected: media.isConnected };
  }, owner);
}

test('caption edits retain one clock and native input while decoder retry retires the old owner', async ({ page }) => {
  await openProject(page);
  const video = page.locator('.media-stage video');
  await expect.poll(() => video.evaluate((media: HTMLVideoElement) => media.seeking)).toBe(false);
  await video.evaluate((media: HTMLVideoElement) => {
    media.pause();
    (window as any).__mediaClockOwnership.retired = media;
  });
  expect(await pulseClock(page, 'current')).toEqual({ emitted: 1, connected: true });

  const field = page.getByLabel('Caption 1 text', { exact: true });
  const edited = 'ខ្មែរ caption stays editable through clock updates';
  await field.fill(edited);
  await field.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(3, 3);
    (window as any).__mediaClockOwnership.captionField = element;
  });
  // A draft render cannot rebind the same player, duplicate its event handlers,
  // or replace the focused native caption field.
  expect(await pulseClock(page, 'current')).toEqual({ emitted: 1, connected: true });
  await expect(field).toBeFocused();
  expect(await field.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([3, 3]);
  expect(await page.evaluate(() => {
    const probe = (window as any).__mediaClockOwnership;
    return probe.retired === document.querySelector('video') && probe.captionField === document.querySelector('.caption-row textarea');
  })).toBe(true);

  await video.evaluate((media: HTMLVideoElement) => {
    Object.defineProperty(media, 'error', { configurable: true, value: { code: 2 } });
    media.dispatchEvent(new Event('error'));
  });
  await page.locator('.source-media-status').getByRole('button', { name: 'Retry playback', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const old = (window as any).__mediaClockOwnership.retired as HTMLMediaElement;
    const current = document.querySelector('video');
    return Boolean(current && old !== current && !old.isConnected && current.isConnected);
  })).toBe(true);

  expect(await pulseClock(page, 'retired')).toEqual({ emitted: 0, connected: false });
  expect(await pulseClock(page, 'current')).toEqual({ emitted: 1, connected: true });
  await expect(field).toHaveValue(edited);
  await field.focus();
  expect(await field.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(3, 3);
    return [(window as any).__mediaClockOwnership.captionField === element, element.selectionStart, element.selectionEnd];
  })).toEqual([true, 3, 3]);
});

test('audio clock is disposed on project exit and reattached only to the newly opened player', async ({ page }) => {
  state.projects[0].media = {
    ...state.projects[0].media,
    filename: 'keyboard.wav', originalName: 'keyboard.wav',
    mimeType: 'audio/wav', url: '/media/keyboard.wav',
  };
  await page.route('**/media/keyboard.wav', (route) => route.fulfill({
    contentType: 'audio/wav', body: createSyntheticWav(4, 440),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage audio')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 1);
  await page.locator('.media-stage audio').evaluate((media: HTMLAudioElement) => {
    media.pause();
    (window as any).__mediaClockOwnership.retired = media;
  });
  expect(await pulseClock(page, 'current')).toEqual({ emitted: 1, connected: true });

  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.locator('main.workspace')).toHaveCount(0);
  expect(await pulseClock(page, 'retired')).toEqual({ emitted: 0, connected: false });

  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage audio')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 1);
  expect(await page.evaluate(() => {
    const old = (window as any).__mediaClockOwnership.retired as HTMLMediaElement;
    const current = document.querySelector('audio');
    return Boolean(current && old !== current && !old.isConnected && current.isConnected);
  })).toBe(true);
  expect(await pulseClock(page, 'current')).toEqual({ emitted: 1, connected: true });
  expect(await pulseClock(page, 'retired')).toEqual({ emitted: 0, connected: false });
});
