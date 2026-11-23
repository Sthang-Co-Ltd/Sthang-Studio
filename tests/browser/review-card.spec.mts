import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const cardText = (page: Page) => review(page).locator('.review-caption-text');
const actions = (page: Page) => review(page).locator('.review-primary-actions');
const decision = (page: Page, name: string) => actions(page).getByRole('button', { name, exact: true });
const field = (page: Page) => page.getByRole('textbox', { name: 'Caption 1 text', exact: true });
const captionWrites = (state: FixtureState) => state.requests.filter(({ path, method }) =>
  path === '/api/projects/landscape/captions' && method === 'PUT').map(({ body }) => body);

async function enterReview(page: Page) {
  await page.locator('.stage-rail').getByRole('button', { name: /^Review/ }).click();
  await expect(review(page)).toBeVisible();
}

async function capture(page: Page, filename: string) {
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) =>
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking)).toBe(true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: path.resolve('.codex-tmp/wave2b3', filename) });
}

test('the card presents exact Khmer text, position, reasons and decisions in order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await installFixture(page);
  const wording = 'កម្ពុជា\nខ្មែររបស់យើង';
  state.projects[0].captions[0].text = wording;
  await openProject(page);
  await enterReview(page);

  await expect(review(page).locator('.review-selection')).toHaveText('Caption 1 · 00:00.200 – 00:01.000');
  expect(await cardText(page).textContent()).toBe(wording);
  await expect(review(page).getByRole('list', { name: 'Review reasons' })).toBeVisible();
  await expect(actions(page)).toBeVisible();
  expect(await review(page).evaluate((root) => {
    const parts = ['.review-card-head', '.review-caption', '.review-reasons', '.review-primary-actions'];
    return parts.map((selector) => Array.from(root.querySelector('.review-active')!.children).indexOf(root.querySelector(selector)!));
  })).toEqual([0, 1, 2, 3]);

  const edit = await decision(page, 'Improve…').boundingBox();
  const approve = await decision(page, 'Approve & next').boundingBox();
  expect(approve!.x).toBeGreaterThanOrEqual(edit!.x + edit!.width);
  const typography = await cardText(page).evaluate((node) => {
    const css = getComputedStyle(node);
    return {
      khmerFirst: css.fontFamily.split(',')[0].replace(/["']/g, '') === 'Noto Sans Khmer',
      size: css.fontSize,
      lineHeight: parseFloat(css.lineHeight) / parseFloat(css.fontSize),
      whitespace: css.whiteSpace,
    };
  });
  expect(typography).toMatchObject({ khmerFirst: true, size: '18px', whitespace: 'pre-wrap' });
  expect(typography.lineHeight).toBeGreaterThanOrEqual(1.7);
  const geometry = await actions(page).evaluate((bar) => ({
    gap: bar.getBoundingClientRect().top - bar.previousElementSibling!.getBoundingClientRect().bottom,
    scrollable: bar.closest('.inspector-content')!.scrollHeight > bar.closest('.inspector-content')!.clientHeight,
  }));
  expect(geometry.scrollable).toBe(false);
  expect(geometry.gap).toBeGreaterThan(0);
  await capture(page, 'review-1440x900.png');
});

test('live card text adds no caption writes to the existing edit and save path', async ({ page, context }) => {
  const control = await context.newPage();
  const baseline = await installFixture(control);
  const state = await installFixture(page);
  const wording = 'ថ្មី\nខ្មែររបស់យើង';
  for (const [target, fixture, inReview] of [[control, baseline, false], [page, state, true]] as const) {
    fixture.profile.preferences.autosaveDelayMs = 60_000;
    await openProject(target);
    if (inReview) await enterReview(target);
    expect(captionWrites(fixture)).toHaveLength(0);
    await field(target).fill(wording);
    if (inReview) expect(await cardText(target).textContent()).toBe(wording);
    expect(captionWrites(fixture)).toHaveLength(0);
    await target.locator('.stage-rail').getByRole('button', { name: 'Captions', exact: true }).focus();
    await expect.poll(() => captionWrites(fixture).length).toBe(1);
  }
  expect(captionWrites(state)).toEqual(captionWrites(baseline));
  await control.close();
});

test('Edit text shares keyboard focus and list reveal with E without transcript tokens', async ({ page }) => {
  const state = await installFixture(page);
  state.projects[0].transcript = null;
  await openProject(page);
  await enterReview(page);
  const edit = review(page).getByRole('group', { name: 'Caption text', exact: true }).getByRole('button', { name: 'Edit text', exact: true });
  await expect(edit).toHaveAttribute('aria-keyshortcuts', 'E');
  await expect(decision(page, 'Edit text')).toHaveCount(0);
  await expect(decision(page, 'Improve…')).toHaveCount(0);

  const list = page.locator('.caption-list');
  const readFocus = () => field(page).evaluate((node: HTMLTextAreaElement) => ({
    focusVisible: node.matches(':focus-visible'),
    isSelected: node.selectionStart === 0 && node.selectionEnd === node.value.length,
    scroll: node.closest('.caption-list')!.scrollTop,
  }));
  await review(page).locator('.inspector-heading').evaluate((node: HTMLElement) => node.focus({ preventScroll: true }));
  await page.keyboard.press('e');
  await expect(field(page)).toBeFocused();
  const keyboard = await readFocus();
  await list.evaluate((node) => { node.scrollTop = 0; });
  await edit.press('Enter');
  await expect(field(page)).toBeFocused();
  const button = await readFocus();
  expect(keyboard).toMatchObject({ focusVisible: true, isSelected: true });
  expect(button).toMatchObject({ focusVisible: true, isSelected: true });
  expect(button.scroll).toBeLessThanOrEqual(keyboard.scroll);
});

test('row selection, approval, Skip, Previous and Undo show their current target', async ({ page }) => {
  const state = await installFixture(page);
  const captions = state.projects[0].captions;
  captions[2].timingQuality = 'low';
  await openProject(page);
  await enterReview(page);
  await page.getByRole('group', { name: 'Caption 2', exact: true }).locator('.row-index').click();
  await expect(cardText(page)).toHaveText(captions[1].text);
  await decision(page, 'Previous').click();
  await expect(cardText(page)).toHaveText(captions[0].text);
  await decision(page, 'Approve & next').click();
  await expect(cardText(page)).toHaveText(captions[1].text);
  await decision(page, 'Skip').click();
  await expect(cardText(page)).toHaveText(captions[2].text);
  await decision(page, 'Previous').click();
  await expect(cardText(page)).toHaveText(captions[1].text);
  await page.locator('.review-undo-toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cardText(page)).toHaveText(captions[0].text);
});

test('More review options keeps the profile request and existing advanced controls', async ({ page }) => {
  const state = await installFixture(page);
  await openProject(page);
  await enterReview(page);
  const options = review(page).locator('.advanced-review-tools');
  const profile = options.getByRole('combobox', { name: 'Review profile', exact: true });
  await expect(profile).toBeHidden();
  await options.getByText('More review options', { exact: true }).click();
  await expect(profile).toBeVisible();
  await expect(options.getByRole('combobox', { name: 'Review focus', exact: true })).toBeVisible();
  for (const name of ['Play with context', 'Lock text', 'Lock timing', 'Unlock']) {
    await expect(options.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await profile.selectOption('capcut-srt');
  await expect.poll(() => state.requests
    .filter(({ path, method }) => path === '/api/profile' && method === 'PATCH')
    .map(({ body }) => body)).toEqual([{ preferences: { qaProfileId: 'capcut-srt' } }]);
});

test('a range begins with the first caption and reports additional selections', async ({ page }) => {
  const state = await installFixture(page);
  state.projects[0].captions[2].timingQuality = 'low';
  await openProject(page);
  await enterReview(page);
  await page.getByRole('group', { name: 'Caption 3', exact: true }).locator('.row-index').click({ modifiers: ['Shift'] });
  await expect(review(page).locator('.review-selection')).toContainText('+2 more selected');
  await expect(cardText(page)).toHaveText(state.projects[0].captions[0].text);
});

test('long content leaves the desktop decision bar fully visible at scroll zero', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const state = await installFixture(page);
  const wording = 'Repeat this caption. '.repeat(30).slice(0, 600);
  state.projects[0].captions[0].text = wording;
  await openProject(page);
  await enterReview(page);
  await expect(review(page).getByRole('list', { name: 'Review reasons' }).getByRole('listitem')).toHaveCount(3);
  expect(await cardText(page).textContent()).toBe(wording);
  expect(await decision(page, 'Approve & next').evaluate((node) => {
    const port = node.closest('.inspector-content')!;
    const box = node.getBoundingClientRect();
    const bounds = port.getBoundingClientRect();
    return port.scrollHeight > port.clientHeight && port.scrollTop === 0
      && box.top >= bounds.top && box.bottom <= bounds.bottom && box.bottom <= innerHeight
      && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await capture(page, 'review-1366x768.png');
});

test('phone content and all card buttons fit without covering the list or preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page);
  await openProject(page);
  await enterReview(page);
  await cardText(page).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await expect(cardText(page)).toBeInViewport();
  await capture(page, 'review-390x844.png');
  await review(page).getByText('More review options', { exact: true }).click();
  for (const button of await review(page).locator('.review-active').getByRole('button').all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await decision(page, 'Approve & next').scrollIntoViewIfNeeded();
  expect(await actions(page).evaluate((node) => {
    const bar = node.getBoundingClientRect();
    const preview = document.querySelector('.stage-column')!.getBoundingClientRect();
    const list = document.querySelector('.caption-list')!.getBoundingClientRect();
    const port = node.closest('.editor-workbench')!;
    const inspector = node.closest('.inspector-content')!;
    return {
      fits: [document.documentElement, port, inspector].every((element) => element.scrollWidth <= element.clientWidth + 1),
      clearsPreview: bar.top >= preview.bottom,
      clearsList: bar.top >= list.bottom,
    };
  })).toEqual({ fits: true, clearsPreview: true, clearsList: true });
});
