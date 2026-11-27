import { test as base, expect, type Locator, type Page } from '@playwright/test';
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
  state.profile.preferences.autoPlayNextReview = false;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
async function openEditor(page: Page) {
  await openProject(page);
  await page.evaluate(() => {
    document.querySelector('video')?.pause();
    (window as any).__captionEntryNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
  });
  await page.locator('[data-caption-id="c1"] .row-index').click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
}
async function sameNodes(page: Page) {
  expect(await page.evaluate(() => (window as any).__captionEntryNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function selectedIds(page: Page) {
  return page.locator('.caption-row.selected-range').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-caption-id')));
}
async function visibleField(field: Locator) {
  await expect.poll(() => field.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const points = [[rect.left + 6, rect.top + 6], [rect.right - 6, rect.top + 6],
      [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 6, rect.bottom - 6], [rect.right - 6, rect.bottom - 6]];
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth
      && rect.top >= 0 && rect.bottom <= innerHeight && points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === node || (hit !== null && node.contains(hit));
      });
  })).toBe(true);
}
async function editKeyReceipt(page: Page) {
  return page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    const field = document.querySelector<HTMLTextAreaElement>('[data-caption-id="c1"] textarea')!;
    return { handled: event.defaultPrevented, focused: document.activeElement === field,
      start: field.selectionStart, end: field.selectionEnd, length: field.value.length };
  });
}

for (const width of [1440, 390]) test(`E makes Review text editing immediately ready and preserves early Khmer composition at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openEditor(page);
  await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
  await page.locator('[data-caption-id="c1"] .row-index').click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.clock.install();
  const before = structuredClone(state.projects[0].captions);
  const entry = await editKeyReceipt(page);
  expect(entry).toEqual({ handled: true, focused: true, start: 0, end: entry.length, length: entry.length });
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await field.dispatchEvent('compositionstart', { data: 'ថ្មី' });
  await page.keyboard.insertText('ថ្មី កម្ពុជា');
  await page.clock.runFor(280);
  await expect(field).toBeFocused();
  expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual(['ថ្មី កម្ពុជា'.length, 'ថ្មី កម្ពុជា'.length]);
  await field.dispatchEvent('compositionend', { data: 'ថ្មី កម្ពុជា' });
  await page.keyboard.insertText('!');
  await expect(field).toHaveValue('ថ្មី កម្ពុជា!');
  await visibleField(field);
  await page.screenshot({ path: info.outputPath(`caption-entry-khmer-${width}.png`), animations: 'disabled' });
  expect(await selectedIds(page)).toEqual(['c1']);
  expect(state.projects[0].captions).toEqual(before);
  await sameNodes(page);
});

for (const width of [1440, 390]) test(`Edit caption text yields to a newer caption destination without a delayed selection reset at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openEditor(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Word timing', exact: true }).click();
  await page.clock.install();
  const before = structuredClone(state.projects[0].captions);
  const receipt = await page.getByRole('button', { name: 'Edit caption text', exact: true }).evaluate((button: HTMLButtonElement) => {
    button.focus(); button.click();
    const first = document.querySelector<HTMLTextAreaElement>('[data-caption-id="c1"] textarea')!;
    const immediatelyFocused = document.activeElement === first;
    document.querySelector<HTMLTextAreaElement>('[data-caption-id="c2"] textarea')!.focus();
    return immediatelyFocused;
  });
  expect(receipt).toBe(true);
  await page.clock.runFor(280);
  await expect(page.getByLabel('Caption 2 text', { exact: true })).toBeFocused();
  expect(await selectedIds(page)).toEqual(['c2']);
  expect(state.projects[0].captions).toEqual(before);
  await sameNodes(page);
});

test('an editing entry never selects over a newer same-field draft and caret', async ({ page }) => {
  await openEditor(page);
  await page.clock.install();
  await editKeyReceipt(page);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await field.fill('Keep newer wording កម្ពុជា');
  await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 5));
  await page.clock.runFor(280);
  await page.keyboard.insertText('exact ');
  await expect(field).toHaveValue('Keep exact newer wording កម្ពុជា');
  expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([11, 11]);
  await sameNodes(page);
});

test('E yields to newer native player focus and preserves its playback position', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openEditor(page);
  await page.clock.install();
  const before = await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }));
  await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
    document.querySelector<HTMLVideoElement>('video')!.focus();
  });
  await page.clock.runFor(280);
  await expect(page.locator('video')).toBeFocused();
  expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, paused: node.paused }))).toEqual(before);
  expect(await selectedIds(page)).toEqual(['c1']);
  await sameNodes(page);
});

test('the editing shortcut respects a text lock and becomes immediately usable after explicit unlock', async ({ page }) => {
  state.projects[0].captions[0].textLocked = true;
  await openEditor(page);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  const before = await field.inputValue();
  expect((await editKeyReceipt(page)).focused).toBe(false);
  await expect(field).toHaveAttribute('readonly', '');
  await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Unlock text', exact: true }).click();
  await page.locator('[data-caption-id="c1"] .row-index').click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  expect((await editKeyReceipt(page)).focused).toBe(true);
  await expect(field).not.toHaveAttribute('readonly', '');
  await expect(field).toHaveValue(before);
  await sameNodes(page);
});
