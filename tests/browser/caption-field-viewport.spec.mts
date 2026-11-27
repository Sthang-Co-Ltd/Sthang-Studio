import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('mobile caption focus preserves deliberate outer browsing and an offscreen preventScroll return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page);
  await openProject(page);
  const field = page.getByLabel(`Caption ${state.projects[0].captions.length} text`, { exact: true });
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const geometry = () => field.evaluate((node: HTMLTextAreaElement) => {
    const box = node.getBoundingClientRect();
    const list = node.closest<HTMLElement>('.caption-list')!;
    const owner = node.closest<HTMLElement>('.editor-workbench')!;
    const port = owner.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    return { fieldTop: box.top, fieldBottom: box.bottom, listTop: listBox.top, listBottom: listBox.bottom,
      portBottom: port.top + owner.clientTop + owner.clientHeight, outerScroll: owner.scrollTop, innerScroll: list.scrollTop,
      active: document.activeElement === node, selection: [node.selectionStart, node.selectionEnd],
      sameField: (window as any).__offscreenCaptionField === node };
  });
  await field.click();
  await settle();
  await page.locator('.editor-workbench').evaluate(node => { node.scrollTop = 0; });
  await settle();
  const before = await geometry();
  expect(before.active).toBe(true);
  expect(before.outerScroll).toBe(0);
  expect(before.fieldTop, JSON.stringify(before)).toBeGreaterThanOrEqual(before.portBottom);
  expect(before.fieldTop).toBeGreaterThanOrEqual(before.listTop - 1);
  expect(before.fieldBottom).toBeLessThanOrEqual(before.listBottom + 1);

  await page.getByLabel('Open project tools', { exact: true }).focus();
  await field.evaluate((node: HTMLTextAreaElement) => {
    (window as any).__offscreenCaptionField = node;
    node.setSelectionRange(2, 2);
    node.focus({ preventScroll: true });
  });
  await settle();
  const after = await geometry();
  expect(after).toMatchObject({ active: true, sameField: true, selection: [2, 2],
    outerScroll: before.outerScroll, innerScroll: before.innerScroll });
});

test('mobile notice dismissal returns to a caption under the sticky preview without scrolling it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoLoopReview = false;
  state.profile.preferences.autoPlayNextReview = false;
  const first = state.projects[0].captions[0];
  state.projects[0].captions = Array.from({ length: 12 }, (_, index) => ({ ...first,
    id: `focus-notice-${index + 1}`, text: `កម្ពុជា ${index + 1}`,
    startMs: 100 + index * 300, endMs: 350 + index * 300, approved: false }));
  await openProject(page);
  await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
  await page.getByText('More review options', { exact: true }).click();
  await page.getByRole('button', { name: 'Lock text', exact: true }).click();
  const notice = page.locator('[data-toast-timer="notice"]');
  await expect(notice).toHaveText('Selected text locked.');
  const field = page.getByLabel('Caption 1 text', { exact: true });
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await field.focus();
  await settle();
  await field.evaluate((node: HTMLTextAreaElement) => {
    const owner = node.closest<HTMLElement>('.editor-workbench')!;
    const preview = owner.querySelector('.stage-column')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    (window as any).__noticeCaptionNodes = [node, node.closest('.caption-list'), document.querySelector('video')];
    node.setSelectionRange(2, 2);
    owner.scrollTop += box.top - (preview.bottom - box.height - 12);
  });
  await settle();
  const geometry = () => field.evaluate((node: HTMLTextAreaElement) => {
    const owner = node.closest<HTMLElement>('.editor-workbench')!;
    const list = node.closest<HTMLElement>('.caption-list')!;
    const box = node.getBoundingClientRect(), port = owner.getBoundingClientRect(), listBox = list.getBoundingClientRect();
    const preview = owner.querySelector('.stage-column')!.getBoundingClientRect();
    return { fieldTop: box.top, fieldBottom: box.bottom, listTop: listBox.top, listBottom: listBox.bottom,
      portTop: port.top, portBottom: port.bottom, previewBottom: preview.bottom,
      outerScroll: owner.scrollTop, innerScroll: list.scrollTop, active: document.activeElement === node,
      selection: [node.selectionStart, node.selectionEnd],
      sameNodes: (window as any).__noticeCaptionNodes.every((saved: Element, index: number) => saved === [node, list, document.querySelector('video')][index]) };
  });
  const before = await geometry();
  expect(before.active).toBe(true);
  expect(before.fieldTop, JSON.stringify(before)).toBeGreaterThan(before.portTop);
  expect(before.fieldBottom, JSON.stringify(before)).toBeLessThan(before.previewBottom);
  expect(before.fieldBottom).toBeLessThan(before.portBottom);
  expect(before.fieldTop).toBeGreaterThanOrEqual(before.listTop - 1);
  expect(before.fieldBottom).toBeLessThanOrEqual(before.listBottom + 1);
  const dismiss = notice.getByRole('button', { name: 'Dismiss notice', exact: true });
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(field).toBeFocused();
  await settle();
  expect(await geometry()).toMatchObject({ active: true, sameNodes: true, selection: [2, 2],
    outerScroll: before.outerScroll, innerScroll: before.innerScroll });
});
