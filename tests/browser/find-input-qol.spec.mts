import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
const original = 'កម្ពុជា old old';
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.projects[0].captions[0].text = original;
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const panel = (page: Page) => page.getByRole('dialog', { name: 'Correct everywhere', exact: true });
const find = (page: Page) => panel(page).getByLabel('Find', { exact: true });
const replacement = (page: Page) => panel(page).getByLabel('Replace with', { exact: true });
const apply = (page: Page) => panel(page).getByRole('button', { name: 'Replace editable matches', exact: true });
async function openFind(page: Page) {
  await page.keyboard.press('Control+f');
  await expect(panel(page)).toBeVisible();
}
async function expectSelectedQuery(page: Page, value: string) {
  await expect(find(page)).toHaveValue(value);
  await expect(find(page)).toBeFocused();
  await expect.poll(() => find(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, value.length]);
}
async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function rememberNodes(page: Page) {
  await page.evaluate(() => { (window as any).__findQolNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function expectUnchanged(page: Page, captions: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(captions);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(original);
  expect(await page.evaluate(() => (window as any).__findQolNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}

for (const width of [1440, 390]) {
  test(`opening and reopening Find selects its seeded Khmer query once at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openProject(page);
    const before = structuredClone(state.projects[0].captions);
    await rememberNodes(page);
    await openFind(page);
    await expectSelectedQuery(page, original);
    await page.keyboard.type('កម្ពុជា');
    await expect(find(page)).toHaveValue('កម្ពុជា');
    await nextFrames(page);
    await page.keyboard.type('ថ្មី');
    await expect(find(page)).toHaveValue('កម្ពុជាថ្មី');
    await expect.poll(() => find(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual(['កម្ពុជាថ្មី'.length, 'កម្ពុជាថ្មី'.length]);
    await replacement(page).fill('រក្សាពាក្យជំនួស');
    await panel(page).getByRole('combobox', { name: 'Match', exact: true }).selectOption('case-insensitive');
    await panel(page).getByRole('combobox', { name: 'Scope', exact: true }).selectOption('selection');
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await openFind(page);
    await expectSelectedQuery(page, original);
    await expect(replacement(page)).toHaveValue('រក្សាពាក្យជំនួស');
    await expect(panel(page).getByRole('combobox', { name: 'Match', exact: true })).toHaveValue('case-insensitive');
    await expect(panel(page).getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('selection');
    await page.keyboard.type('ពាក្យ');
    await expect(find(page)).toHaveValue('ពាក្យ');
    await nextFrames(page);
    await page.keyboard.type('ថ្មី');
    await expect(find(page)).toHaveValue('ពាក្យថ្មី');
    await page.screenshot({ path: info.outputPath(`find-seeded-query-${width}.png`) });
    await expectUnchanged(page, before);
  });

  test(`invalid regex is associated and announced, then clears without changing drafts at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openProject(page);
    const before = structuredClone(state.projects[0].captions);
    await rememberNodes(page);
    await openFind(page);
    await replacement(page).fill('new');
    await panel(page).getByRole('combobox', { name: 'Match', exact: true }).selectOption('regex');
    await find(page).fill('[');
    const error = panel(page).getByRole('alert');
    await expect(error).toHaveText('Invalid regular expression. Check the Find pattern.');
    await expect(find(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(find(page)).toHaveAccessibleDescription('Invalid regular expression. Check the Find pattern.');
    expect(await find(page).getAttribute('aria-describedby')).toBe(await error.getAttribute('id'));
    await expect(find(page)).toBeFocused();
    await expect(find(page)).toHaveValue('[');
    await expect(replacement(page)).toHaveValue('new');
    await expect(apply(page)).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`find-invalid-regex-${width}.png`) });
    await find(page).fill('old');
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    expect(await find(page).getAttribute('aria-invalid')).toBeNull();
    expect(await find(page).getAttribute('aria-describedby')).toBeNull();
    await expect(find(page)).toBeFocused();
    await expect(find(page)).toHaveValue('old');
    await expect(replacement(page)).toHaveValue('new');
    await expect(panel(page).locator('.find-after')).toHaveText('កម្ពុជា new new');
    await expect(apply(page)).toBeEnabled();
    expect(await panel(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expectUnchanged(page, before);
  });
}

test('opening query selection yields to focus movement and never reselects after later user edits', async ({ page }) => {
  await openProject(page);
  const before = structuredClone(state.projects[0].captions);
  await rememberNodes(page);
  await page.evaluate(() => {
    (window as any).__findQolSelectCalls = 0;
    const originalSelect = HTMLInputElement.prototype.select;
    HTMLInputElement.prototype.select = function () {
      if (this === document.querySelector('.find-grid input')) (window as any).__findQolSelectCalls++;
      originalSelect.call(this);
    };
    const moveFocus = (event: FocusEvent) => {
      if (event.target !== document.querySelector('.find-grid input')) return;
      document.removeEventListener('focusin', moveFocus);
      document.querySelectorAll<HTMLInputElement>('.find-grid input')[1]?.focus();
    };
    document.addEventListener('focusin', moveFocus);
  });
  await openFind(page);
  await expect(find(page)).toHaveValue(original);
  await expect(replacement(page)).toBeFocused();
  await replacement(page).fill('Keep this newer replacement');
  await nextFrames(page);
  await expect(replacement(page)).toBeFocused();
  expect(await page.evaluate(() => (window as any).__findQolSelectCalls)).toBe(0);

  await find(page).focus();
  await find(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(input.value.length, input.value.length));
  await page.keyboard.type('!');
  await nextFrames(page);
  await expect(find(page)).toHaveValue(original + '!');
  await expect(replacement(page)).toHaveValue('Keep this newer replacement');
  await expect(find(page)).toBeFocused();
  expect(await find(page).evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(original.length + 1);
  expect(await page.evaluate(() => (window as any).__findQolSelectCalls)).toBe(0);
  await expectUnchanged(page, before);
});
