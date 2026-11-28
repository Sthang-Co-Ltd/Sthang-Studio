import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const review = (page: Page) => page.getByRole('complementary', { name: 'Review workspace', exact: true });
const cardText = (page: Page) => review(page).locator('.review-caption-text');
const actions = (page: Page) => review(page).locator('.review-decision-actions');
const decision = (page: Page, name: string) => review(page).locator('.review-nav-actions, .review-decision-actions').getByRole('button', { name, exact: true });
const editText = (page: Page) => review(page).getByRole('button', { name: 'Edit text', exact: true });
const longCaption = 'Repeat this caption. '.repeat(30).slice(0, 600);
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
    const parts = ['.review-card-head', '.review-caption', '.review-reasons', '.review-nav-actions'];
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
  const textBox = (await cardText(page).boundingBox())!;
  const editBox = (await editText(page).boundingBox())!;
  expect(Math.abs(editBox.y - textBox.y)).toBeLessThanOrEqual(8);
  expect(editBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
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

test('phone Review keeps Undo clear of the next keyboard approval', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page);
  const captions = state.projects[0].captions;
  captions[2].timingQuality = 'low';
  await openProject(page);
  await enterReview(page);
  const approve = decision(page, 'Approve & next');
  await approve.press('Enter');
  await expect(cardText(page)).toHaveText(captions[1].text);
  await expect(approve).toBeFocused();
  const notice = page.locator('.review-undo-toast');
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(approve).toBeInViewport({ ratio: 1 });
  const actionBox = (await approve.boundingBox())!;
  const noticeBox = (await notice.boundingBox())!;
  expect(noticeBox.y).toBeGreaterThanOrEqual(actionBox.y + actionBox.height);
  await page.keyboard.press('Enter');
  await expect(cardText(page)).toHaveText(captions[2].text);
  await notice.getByRole('button', { name: 'Undo', exact: true }).press('Enter');
  await expect(cardText(page)).toHaveText(captions[1].text);
});

test.describe('phone Review touch targets', () => {
  test.use({ hasTouch: true });
  test('Undo is directly reachable over a pre-existing storage notice', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await installFixture(page);
    const captions = state.projects[0].captions;
    captions[2].timingQuality = 'low';
    await page.route('**/api/system/project-storage', (route) => route.fulfill({ json: {
      schemaVersion: 1, checkedAt: '2026-11-28T00:00:00.000Z', loadedProjectCount: 1,
      readableProjectCount: 1, unreadableProjectCount: 0, missingProjectCount: 0, duplicateProjectCount: 0,
      directoryUnreadable: false, orderUnreadable: false, legacyUnreadable: false, migrationPending: true, restartRequired: false,
    } }));
    await openProject(page);
    await enterReview(page);
    const storage = page.locator('.toast-stack .toast').filter({ has: page.getByRole('button', { name: 'Review storage', exact: true }) });
    await expect(storage).toBeInViewport({ ratio: 1 });
    const approve = decision(page, 'Approve & next');
    const rect = (await approve.boundingBox())!;
    const x = Math.round(rect.x + rect.width * 0.65);
    const y = Math.round(rect.y + rect.height / 2);
    await page.touchscreen.tap(x, y);
    await expect(cardText(page)).toHaveText(captions[1].text);
    const undo = page.locator('.review-undo-toast .toast-action');
    await expect.poll(() => undo.evaluate((button) => {
      const stack = button.closest<HTMLElement>('.toast-stack')!;
      const { x, y, width, height } = button.getBoundingClientRect();
      const top = stack.getBoundingClientRect().top + stack.clientTop;
      return y >= top - 1 && y + height <= top + stack.clientHeight + 1
        && document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button') === button;
    })).toBe(true);
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.matches('.review-approve-next'), [x, y])).toBe(true);
    const hit = (await undo.boundingBox())!;
    await page.touchscreen.tap(hit.x + hit.width / 2, hit.y + hit.height / 2);
    await expect(cardText(page)).toHaveText(captions[0].text);
    await expect(storage).toBeInViewport({ ratio: 1 });
  });

  for (const width of [320, 390]) for (const locale of ['en', 'km'] as const) {
    test(`repeated taps advance and deliberate Undo restores at ${width}px in ${locale}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
      const state = await installFixture(page);
      state.profile.preferences.interfaceLanguage = locale;
      const captions = state.projects[0].captions;
      captions[2].timingQuality = 'low';
      await openProject(page);
      await page.locator('[data-stage="review"]').tap();
      await page.evaluate(() => document.fonts.ready);
      const approve = page.locator('.review-approve-next');
      const current = page.locator('.review-caption-text');
      const notice = page.locator('.review-undo-toast');
      await expect(current).toHaveText(captions[0].text);
      await expect(approve).toBeInViewport({ ratio: 1 });
      const rect = (await approve.boundingBox())!;
      const x = Math.round(rect.x + rect.width * 0.65);
      const y = Math.round(rect.y + rect.height / 2);
      const targetAtPoint = () => page.evaluate(([x, y]) =>
        document.elementFromPoint(x, y)?.closest('button')?.matches('.review-approve-next') === true, [x, y]);
      await page.touchscreen.tap(x, y);
      await expect(current).toHaveText(captions[1].text);
      await expect(notice).toBeInViewport({ ratio: 1 });
      expect((await approve.boundingBox())!.y).toBeCloseTo(rect.y, 0);
      expect(await targetAtPoint()).toBe(true);
      await page.screenshot({ path: info.outputPath('after-first-approval.png') });
      await page.touchscreen.tap(x, y);
      await expect(current).toHaveText(captions[2].text);
      await notice.locator('.toast-action').tap();
      await expect(current).toHaveText(captions[1].text);
      await expect(notice).toHaveCount(0);
      expect(await targetAtPoint()).toBe(true);
      await page.touchscreen.tap(x, y);
      await expect(current).toHaveText(captions[2].text);
      if (width === 390 && locale === 'en') {
        await expect(notice).toHaveCount(0, { timeout: 12_000 });
      } else {
        await notice.getByRole('button').last().tap();
        await expect(notice).toHaveCount(0);
      }
      await expect(page.locator('.review-position-footer')).toBeVisible();
      expect((await approve.boundingBox())!.y).toBeCloseTo(rect.y, 0);
    });
  }
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

test('Review navigation and decisions keep their keyboard order', async ({ page }) => {
  const state = await installFixture(page);
  state.projects[0].captions[2].timingQuality = 'low';
  await openProject(page);
  await enterReview(page);
  await page.getByRole('group', { name: 'Caption 2', exact: true }).locator('.row-index').click();

  const previous = decision(page, 'Previous');
  await expect(previous).toBeEnabled();
  await expect(decision(page, 'Skip')).toBeEnabled();
  await previous.focus();
  await expect(previous).toBeFocused();
  for (const control of [
    decision(page, 'Replay'),
    decision(page, 'Skip'),
    review(page).getByRole('checkbox', { name: 'Auto-play next', exact: true }),
    decision(page, 'Improve…'),
    decision(page, 'Approve & next'),
  ]) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
  }
});

test('long content leaves the desktop decision bar fully visible at scroll zero', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const state = await installFixture(page);
  const wording = longCaption;
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

  const positions = () => actions(page).evaluate((bar) => {
    const navigation = bar.previousElementSibling!;
    return {
      scroll: bar.closest('.inspector-content')!.scrollTop,
      previous: navigation.querySelector('button:first-child')!.getBoundingClientRect().top,
      skip: navigation.querySelector('button:nth-child(3)')!.getBoundingClientRect().top,
      bottom: bar.getBoundingClientRect().bottom,
    };
  });
  const before = await positions();
  await review(page).locator('.inspector-content').evaluate((port) => port.scrollTo({ top: 24, behavior: 'instant' }));
  const after = await positions();
  expect(after.scroll).toBe(24);
  expect(after.previous).toBeCloseTo(before.previous - after.scroll, 0);
  expect(after.skip).toBeCloseTo(before.skip - after.scroll, 0);
  expect(after.bottom).toBeCloseTo(before.bottom, 0);
  await expect(decision(page, 'Approve & next')).toBeInViewport({ ratio: 1 });
});

test('phone content and all card buttons fit without covering the list or preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page);
  await openProject(page);
  await enterReview(page);
  await expect(decision(page, 'Approve & next')).toBeInViewport({ ratio: 1 });
  await capture(page, 'review-390x844.png');
  await cardText(page).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await expect(cardText(page)).toBeInViewport();
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

test('phone long-caption entry pins decisions only while the card is on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installFixture(page);
  state.projects[0].captions[0].text = longCaption;
  await openProject(page);
  await enterReview(page);

  const approve = decision(page, 'Approve & next');
  await expect(approve).toBeInViewport({ ratio: 1 });
  const card = review(page).locator('.review-card.review-active');
  const workbench = page.locator('.editor-workbench');
  await workbench.evaluate((port) => port.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.caption-list')).toBeInViewport();
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(844);
  await expect(actions(page)).not.toBeInViewport();

  await card.evaluate((node) => {
    const port = node.closest('.editor-workbench')!;
    const bounds = port.getBoundingClientRect();
    const target = bounds.top + port.clientHeight * 0.45;
    port.scrollTo({ top: port.scrollTop + node.getBoundingClientRect().top - target, behavior: 'instant' });
  });
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.y).toBeLessThan(844);
  expect(cardBox.y + cardBox.height).toBeGreaterThan(844);
  const rowBox = (await actions(page).boundingBox())!;
  const workbenchBox = (await workbench.boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeCloseTo(workbenchBox.y + workbenchBox.height, 0);
  await expect(approve).toBeInViewport({ ratio: 1 });
  await capture(page, 'review-390x844-long-mid-scroll.png');
});
