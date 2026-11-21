import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { openAccuracy } from './accuracy-workspace.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); }
    finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.defaultVocabulary = ['Saved glossary'];
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.projects[0].transcriptionContext = { description: 'Keep this context កម្ពុជា', vocabulary: ['Project term'] };
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const save = (page: Page) => page.getByRole('button', { name: 'Save globally', exact: true });
const feedback = (page: Page) => page.locator('#accuracy-global-glossary-feedback');
const vocabulary = (page: Page) => page.getByLabel('Exact terms to preserve', { exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function start(page: Page) {
  await openProject(page);
  return openAccuracy(page);
}
async function doubleActivate(page: Page) {
  await save(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
}
async function assertActionGeometry(page: Page, minimumHeight: number, requireViewport: boolean) {
  const actions = page.getByRole('complementary', { name: 'Accuracy workspace', exact: true }).locator('.accuracy-actions > button');
  await expect(actions).toHaveCount(3);
  for (const action of await actions.all()) {
    await action.scrollIntoViewIfNeeded();
    const geometry = await action.evaluate((button) => {
      const content = button.closest('.inspector-content');
      if (!(content instanceof HTMLElement)) throw new Error('Accuracy actions need their inspector content.');
      const frame = content.getBoundingClientRect();
      const style = getComputedStyle(content);
      const rect = button.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        contentLeft: frame.left + content.clientLeft + Number.parseFloat(style.paddingLeft),
        contentRight: frame.left + content.clientLeft + content.clientWidth - Number.parseFloat(style.paddingRight),
        contentTop: frame.top + content.clientTop, contentBottom: frame.top + content.clientTop + content.clientHeight,
        scrollWidth: content.scrollWidth, clientWidth: content.clientWidth,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
      };
    });
    const label = await action.innerText();
    expect(geometry.width, label).toBeGreaterThan(0);
    expect(geometry.height, label).toBeGreaterThanOrEqual(minimumHeight);
    expect(geometry.left, label).toBeGreaterThanOrEqual(geometry.contentLeft - 1);
    expect(geometry.right, label).toBeLessThanOrEqual(geometry.contentRight + 1);
    expect(geometry.top, label).toBeGreaterThanOrEqual(geometry.contentTop - 1);
    expect(geometry.bottom, label).toBeLessThanOrEqual(geometry.contentBottom + 1);
    expect(geometry.scrollWidth, label).toBeLessThanOrEqual(geometry.clientWidth + 1);
    if (requireViewport) {
      expect(geometry.left, label).toBeGreaterThanOrEqual(0);
      expect(geometry.right, label).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.top, label).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom, label).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const limit of ['long term', 'long list'] as const) test(`global glossary reports a ${limit} partial acknowledgement and keeps the exact draft`, async ({ page }, info) => {
  await page.setViewportSize({ width: limit === 'long list' ? 390 : 1440, height: 1000 });
  const raw = limit === 'long term' ? `  ${'x'.repeat(301)}  \n\nខ្មែរ  ` : Array.from({ length: 301 }, (_, index) => `Term ${index + 1}`).join('\n');
  let writes = 0;
  await page.route('**/api/profile', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: { defaultVocabulary?: string[] } = route.request().postDataJSON();
    if (!body.defaultVocabulary) return route.fallback();
    writes++;
    const accepted = limit === 'long term' ? ['Saved glossary', 'x'.repeat(300), 'ខ្មែរ'] : body.defaultVocabulary.slice(0, 300);
    state.profile = { ...state.profile, defaultVocabulary: accepted };
    return route.fulfill({ json: state.profile });
  });
  await start(page);
  await vocabulary(page).fill(raw);
  await doubleActivate(page);
  await expect(feedback(page)).toHaveAttribute('role', 'alert');
  await expect(feedback(page)).toHaveText('Some glossary terms were not saved. Your text is kept. Shorten the list or long terms, then try again.');
  await expect(vocabulary(page)).toHaveValue(raw);
  await expect(vocabulary(page)).toHaveAttribute('aria-describedby', /accuracy-global-glossary-feedback/);
  await expect(page.getByLabel('What is this clip about?', { exact: true })).toHaveValue('Keep this context កម្ពុជា');
  await expect(save(page)).toBeEnabled();
  await expect(page.getByText('Global glossary saved.', { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  expect(state.requests.filter((request) => request.path.endsWith('/context') && request.method === 'PUT')).toHaveLength(0);
  if (limit === 'long list') {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await feedback(page).scrollIntoViewIfNeeded();
    await assertActionGeometry(page, 44, true);
    await page.screenshot({ path: info.outputPath('accuracy-global-partial-390.png') });
  }
});

test('failed global saving guards duplicate activation, keeps raw input and retries the current glossary once', async ({ page }) => {
  const gate = deferred();
  const writes: string[][] = [];
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: { defaultVocabulary?: string[] } = route.request().postDataJSON();
    if (!body.defaultVocabulary) return route.fallback();
    writes.push([...body.defaultVocabulary]);
    if (writes.length === 1) {
      await gate.promise;
      return route.fulfill({ status: 503, json: { error: 'Synthetic glossary failure' } });
    }
    return route.fallback();
  });
  try {
    await start(page);
    await vocabulary(page).fill('  Submitted term  \nSubmitted term\n\nខ្មែរ ');
    await doubleActivate(page);
    const pending = page.getByRole('button', { name: 'Saving globally…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => writes.length).toBe(1);
    await pending.press('Enter'); await pending.press('Space');
    expect(writes).toHaveLength(1);
    gate.release();
    await expect(feedback(page)).toHaveAttribute('role', 'alert');
    await expect(feedback(page)).toHaveText('Could not save the global glossary. Your text is kept; try again.');
    await expect(vocabulary(page)).toHaveValue('  Submitted term  \nSubmitted term\n\nខ្មែរ ');
    await expect(save(page)).toBeEnabled();
    await vocabulary(page).fill('  Retry term  \nខ្មែរ ');
    await expect(feedback(page)).toHaveCount(0);
    await save(page).click();
    await expect(feedback(page)).toHaveAttribute('role', 'status');
    await expect(feedback(page)).toHaveText('Global glossary saved.');
    expect(writes).toEqual([['Saved glossary', 'Submitted term', 'ខ្មែរ'], ['Saved glossary', 'Retry term', 'ខ្មែរ']]);
    await expect(vocabulary(page)).toHaveValue('  Retry term  \nខ្មែរ ');
  } finally { gate.release(); }
});

test('a late global response keeps newer raw vocabulary and a later saved Review preference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const gate = deferred();
  const writes: string[][] = [];
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: { defaultVocabulary?: string[] } = route.request().postDataJSON();
    if (!body.defaultVocabulary) return route.fallback();
    writes.push([...body.defaultVocabulary]);
    state.profile = { ...state.profile, defaultVocabulary: [...body.defaultVocabulary] };
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    return route.fulfill({ json: acknowledged });
  });
  try {
    await start(page);
    await vocabulary(page).fill('  Submitted term  \nខ្មែរ ');
    await doubleActivate(page);
    await expect.poll(() => writes.length).toBe(1);
    await vocabulary(page).fill('  Newer term  \n\nMixed កម្ពុជា  ');
    const review = page.locator('.header-actions').getByRole('button', { name: /^Review\b/ });
    await review.click();
    await page.getByRole('checkbox', { name: 'Auto-play next', exact: true }).check();
    await expect.poll(() => state.profile.preferences.autoPlayNextReview).toBe(true);
    await openAccuracy(page);
    await expect(vocabulary(page)).toHaveValue('  Newer term  \n\nMixed កម្ពុជា  ');
    gate.release();
    await expect(feedback(page)).toHaveAttribute('role', 'status');
    await expect(feedback(page)).toHaveText('Earlier glossary saved globally. Your newer Accuracy edits are kept; save again to include newer terms.');
    await expect(vocabulary(page)).toHaveValue('  Newer term  \n\nMixed កម្ពុជា  ');
    expect(writes).toEqual([['Saved glossary', 'Submitted term', 'ខ្មែរ']]);
    await review.click();
    await expect(page.getByRole('checkbox', { name: 'Auto-play next', exact: true })).toBeChecked();
    await openAccuracy(page);
    await expect(vocabulary(page)).toHaveValue('  Newer term  \n\nMixed កម្ពុជា  ');
    await expect(page.getByLabel('What is this clip about?', { exact: true })).toHaveValue('Keep this context កម្ពុជា');
  } finally { gate.release(); }
});

test('a complete normalized acknowledgement saves globally without rewriting raw Accuracy input', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const writes: string[][] = [];
  await page.route('**/api/profile', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: { defaultVocabulary?: string[] } = route.request().postDataJSON();
    if (body.defaultVocabulary) writes.push([...body.defaultVocabulary]);
    return route.fallback();
  });
  await start(page);
  const raw = '  New term  \nNew term\n  Saved glossary \nខ្មែរ ';
  await vocabulary(page).fill(raw);
  await save(page).click();
  await expect(feedback(page)).toHaveAttribute('role', 'status');
  await expect(feedback(page)).toHaveText('Global glossary saved.');
  await expect(vocabulary(page)).toHaveValue(raw);
  expect(writes).toEqual([['Saved glossary', 'New term', 'ខ្មែរ']]);
  expect(state.profile.defaultVocabulary).toEqual(['Saved glossary', 'New term', 'ខ្មែរ']);
  await feedback(page).scrollIntoViewIfNeeded();
  await assertActionGeometry(page, 36, false);
  await page.screenshot({ path: info.outputPath('accuracy-global-saved-1440.png') });
});

test('an older global-save response cannot replace a newer acknowledged Find glossary rule', async ({ page }) => {
  state.projects[0].captions[0].text = 'old';
  const gate = deferred();
  let writes = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: { defaultVocabulary?: string[] } = route.request().postDataJSON();
    if (!body.defaultVocabulary) return route.fallback();
    writes++;
    if (writes !== 1) return route.fallback();
    state.profile = { ...state.profile, defaultVocabulary: [...body.defaultVocabulary] };
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    return route.fulfill({ json: acknowledged });
  });
  try {
    await start(page);
    await vocabulary(page).fill('Submitted earlier term');
    await save(page).click();
    await expect.poll(() => writes).toBe(1);
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
    await find.getByLabel('Find', { exact: true }).fill('old');
    await find.getByLabel('Replace with', { exact: true }).fill('new!');
    await find.getByLabel('Remember this correction', { exact: true }).selectOption('global');
    await find.getByRole('button', { name: 'Replace editable matches', exact: true }).click();
    await expect(find).toHaveCount(0);
    await expect.poll(() => state.profile.defaultVocabulary.includes('new! | old')).toBe(true);
    expect(writes).toBe(2);
    gate.release();
    await expect(feedback(page)).toHaveAttribute('role', 'status');
    await expect(feedback(page)).toContainText('Earlier glossary');
    await expect(feedback(page)).not.toHaveText('Global glossary saved.');
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(settings.getByLabel('Global protected vocabulary', { exact: true })).toHaveValue(/new! \| old/);
    expect(state.profile.defaultVocabulary).toContain('new! | old');
    expect(writes).toBe(2);
  } finally { gate.release(); }
});
