import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('Review explains the selected caption and keeps other rows quiet', async ({ page }) => {
  const { projects } = await installFixture(page);
  const [first, second] = projects[0].captions;
  first.timingQuality = 'low';
  second.timingQuality = 'medium';
  await openProject(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Captions panel', exact: true })).toBeVisible();
  const actions = page.getByRole('group', { name: 'Caption 2', exact: true }).locator('.row-actions');
  await expect(actions).toHaveCSS('opacity', '1');
  const timestamp = page.getByLabel('Caption 1 start time', { exact: true });
  expect(await timestamp.evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return style.fontSize === '13px' && context.measureText('00:00.200').width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  })).toBe(true);
  await page.locator('.stage-rail').getByRole('button', { name: /^Review\b/ }).click();
  const reasons = page.locator('.review-reasons');
  await expect(page.getByRole('heading', { level: 2, name: 'Review queue panel', exact: true })).toBeVisible();
  await expect(reasons.getByText('Timing may be off', { exact: true })).toBeVisible();
  await expect(reasons.getByText('Play it and check that the caption matches the voice.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Caption 2', exact: true }).locator('.risk-reasons')).toHaveText('Review suggested');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(reasons.getByText('Listen to check timing', { exact: true })).toBeVisible();
  await expect(reasons.getByText('Timing may be off', { exact: true })).toHaveCount(0);
});

test('phone Review keeps approval in view while keyboard scrolling reads the reasons', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page);
  await openProject(page);
  await page.locator('.stage-rail').getByRole('button', { name: /^Review\b/ }).click();
  await expect(page.getByRole('button', { name: 'Approve & next', exact: true })).toBeInViewport({ ratio: 1 });
  const reasons = page.getByRole('list', { name: 'Review reasons', exact: true });
  await page.getByRole('button', { name: 'Close tool', exact: true }).press('Tab'); await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(reasons).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => reasons.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(reasons.getByText('Timing may be off', { exact: true })).toHaveCount(1);
});

for (const width of [1280, 390]) test(`Render remains visible and leaves keyboard focus clear at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
  await installFixture(page);
  await openProject(page);
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
  const render = page.getByRole('button', { name: 'Render captioned video', exact: true });
  await expect(render).toBeEnabled();
  const headings = ['Preview panel', 'Captions panel', 'Export panel'];
  for (const name of headings) {
    const heading = page.getByRole('heading', { level: 2, name, exact: true });
    await expect(heading).toBeVisible();
    expect(await heading.locator('strong').evaluate((title) => title.scrollWidth <= title.clientWidth)).toBe(true);
  }
  const footer = page.locator('.export-finalize');
  const ancestors = await footer.evaluate((footer) => {
    const path = [];
    for (let node = footer.parentElement; node; node = node.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(node);
      path.push({ name: node.classList[0], overflowX, overflowY });
      if (overflowY !== 'visible' || overflowX !== 'visible') break;
    }
    return path;
  });
  expect(ancestors.at(-1)).toEqual({ name: width === 1280 ? 'inspector-content' : 'editor-workbench', overflowX: 'auto', overflowY: 'auto' });
  if (width === 1280) {
    expect(await page.locator('.inspector-content').evaluate((node) => node.scrollTop)).toBe(0);
  } else {
    const settings = page.getByText('Video settings', { exact: true });
    await settings.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(settings).toBeInViewport({ ratio: 1 });
  }
  await expect(render).toBeInViewport({ ratio: 1 });
  const renderBox = (await render.boundingBox())!;
  if (width === 390) {
    const preview = (await page.locator('.stage-column').boundingBox())!;
    expect(renderBox.y).toBeGreaterThanOrEqual(preview.y + preview.height);
    expect(renderBox.height).toBeGreaterThanOrEqual(44);
  }
  const resolution = page.getByLabel('Resolution', { exact: true });
  await page.getByLabel('Frame rate', { exact: true }).evaluate(async (node: HTMLSelectElement, scroller) => {
    node.focus({ preventScroll: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const resolution = document.querySelector('#export-resolution-select')!;
    const footer = document.querySelector('.export-finalize')!;
    document.querySelector(scroller)!.scrollTop += resolution.getBoundingClientRect().top - footer.getBoundingClientRect().top - 8;
  }, width === 1280 ? '.inspector-content' : '.editor-workbench');
  expect((await resolution.boundingBox())!.y).toBeGreaterThan((await footer.boundingBox())!.y);
  await page.keyboard.press('Shift+Tab');
  await expect(resolution).toBeFocused();
  await expect.poll(() => resolution.evaluate((node) => {
    const control = node.getBoundingClientRect();
    const footer = document.querySelector('.export-finalize')!.getBoundingClientRect();
    return control.bottom + 4 <= footer.top && [control.top + 1, control.bottom - 1].every((y) =>
      node.contains(document.elementFromPoint(control.x + control.width / 2, y)));
  })).toBe(true);
});
