import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.projects[0].captions[0].text = 'old';
});
const panel = (page: Page) => page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
const apply = (page: Page) => panel(page).getByRole('button', { name: 'Replace editable matches', exact: true });
const retry = (page: Page) => panel(page).getByRole('button', { name: 'Retry glossary save', exact: true });
async function find(page: Page, remember = 'global') {
  await openProject(page);
  await page.keyboard.press('Control+f');
  await panel(page).getByLabel('Find', { exact: true }).fill('old');
  await panel(page).getByLabel('Replace with', { exact: true }).fill('old!');
  await panel(page).getByLabel('Remember this correction', { exact: true }).selectOption(remember);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('global glossary Retry never repeats an applied replacement, including rapid double activation', async ({ page }, info) => {
  let writes = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.defaultVocabulary) return route.fallback();
    writes++;
    if (writes === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic glossary failure' } });
    return route.fallback();
  });
  await find(page);
  await apply(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(retry(page)).toBeEnabled();
  await expect(panel(page)).toContainText('Captions updated; glossary not saved');
  await expect(panel(page).locator('dd')).toHaveText('old! | old');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
  expect(writes).toBe(1);
  await page.screenshot({ path: info.outputPath('glossary-retry.png') });
  await retry(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
  expect(writes).toBe(2);
  expect(state.profile.defaultVocabulary).toContain('old! | old');
});

test('project glossary false acknowledgement is retryable and preserves other Accuracy text', async ({ page }) => {
  state.projects[0].transcriptionContext = { description: 'Keep this context', vocabulary: ['Existing term'] };
  let writes = 0;
  await page.route('**/api/projects/landscape/context', async (route) => {
    writes++;
    if (writes === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic context failure' } });
    const body = route.request().postDataJSON();
    state.projects[0] = { ...state.projects[0], transcriptionContext: body.transcriptionContext, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: state.projects[0] });
  });
  await find(page, 'project');
  await apply(page).click();
  await expect(retry(page)).toBeEnabled();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
  await retry(page).click();
  await expect(panel(page)).toHaveCount(0);
  expect(writes).toBe(2);
  expect(state.projects[0].transcriptionContext).toEqual({ description: 'Keep this context', vocabulary: ['Existing term', 'old! | old'] });
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
});

test('a successful HTTP response that omits the glossary rule never confirms it as saved', async ({ page }) => {
  await page.route('**/api/profile', (route) => route.request().method() === 'PATCH' && route.request().postDataJSON()?.defaultVocabulary
    ? route.fulfill({ json: state.profile }) : route.fallback());
  await find(page);
  await apply(page).click();
  await expect(retry(page)).toBeEnabled();
  await expect(panel(page)).toContainText('Captions updated; glossary not saved');
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
});

test('a normalized project reply cannot confirm a missing rule or discard newer Accuracy edits', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.projects[0].transcriptionContext = { description: 'Original context', vocabulary: ['Existing term'] };
  const gate = deferred(); let writes = 0;
  await page.route('**/api/projects/landscape/context', async (route) => {
    writes++;
    const body = route.request().postDataJSON();
    if (writes === 1) await gate.promise;
    state.projects[0] = { ...state.projects[0], transcriptionContext: writes === 1
      ? { ...body.transcriptionContext, vocabulary: ['Existing term'] } : body.transcriptionContext,
      updatedAt: new Date().toISOString() };
    return route.fulfill({ json: state.projects[0] });
  });
  try {
    await find(page, 'project'); await apply(page).click();
    await expect.poll(() => writes).toBe(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Accuracy/ }).click();
    const description = page.getByLabel('What is this clip about?', { exact: true });
    await description.fill('Newer context កម្ពុជា');
    await page.keyboard.press('Control+f');
    gate.resolve();
    await expect(retry(page)).toBeEnabled();
    await expect(description).toHaveValue('Newer context កម្ពុជា');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('old!');
    await retry(page).click();
    await expect(panel(page)).toHaveCount(0);
    expect(state.projects[0].transcriptionContext).toEqual({ description: 'Newer context កម្ពុជា', vocabulary: ['Existing term', 'old! | old'] });
    expect(writes).toBe(2);
  } finally { gate.resolve(); }
});

test('closing and reopening a pending save preserves newer captions and does not close the new visit', async ({ page }) => {
  const gate = deferred();
  let writes = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.defaultVocabulary) return route.fallback();
    writes++; await gate.promise; return route.fallback();
  });
  try {
    await find(page); await apply(page).click();
    await expect.poll(() => writes).toBe(1);
    await expect(panel(page).getByRole('button', { name: 'Saving glossary…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer កម្ពុជា');
    await page.keyboard.press('Control+f');
    await expect(panel(page)).toContainText('Captions updated; saving glossary…');
    gate.resolve();
    await expect(panel(page)).toContainText('Captions updated; glossary saved');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Newer កម្ពុជា');
    await panel(page).getByRole('button', { name: 'New correction', exact: true }).click();
    await expect(panel(page).getByLabel('Find', { exact: true })).toBeFocused();
    expect(writes).toBe(1);
  } finally { gate.resolve(); }
});

test('a late glossary reply from another project cannot alter its captions or close its Find sheet', async ({ page }) => {
  const gate = deferred(); let held = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.defaultVocabulary) return route.fallback();
    held = true; await gate.promise; return route.fallback();
  });
  try {
    await find(page); await apply(page).click();
    await expect.poll(() => held).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => state.projects[0].captions[0].text).toBe('old!');
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+f');
    await panel(page).getByLabel('Find', { exact: true }).fill('A new search');
    gate.resolve();
    await expect.poll(() => state.profile.defaultVocabulary.includes('old! | old')).toBe(true);
    await expect(panel(page).getByLabel('Find', { exact: true })).toHaveValue('A new search');
    await expect(panel(page).locator('.find-glossary-result')).toHaveCount(0);
    expect(state.projects[1].transcriptionContext?.vocabulary || []).not.toContain('old! | old');
  } finally { gate.resolve(); }
});

test.describe('narrow glossary recovery', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('long rules wrap and continuing retains form values without another glossary request', async ({ page }, info) => {
    let writes = 0;
    await page.route('**/api/profile', (route) => {
      if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.defaultVocabulary) return route.fallback();
      writes++; return route.fulfill({ status: 503, json: { error: 'Synthetic glossary failure' } });
    });
    await find(page);
    const replacement = 'កម្ពុជា'.repeat(35);
    await panel(page).getByLabel('Replace with', { exact: true }).fill(replacement);
    await apply(page).click();
    await expect(retry(page)).toBeEnabled();
    await expect(panel(page).locator('dd')).toHaveText(`${replacement} | old`);
    expect(await panel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await retry(page).scrollIntoViewIfNeeded();
    await expect(retry(page)).toBeInViewport();
    await page.screenshot({ path: info.outputPath('glossary-retry-390.png') });
    await panel(page).getByRole('button', { name: 'Continue without saving glossary', exact: true }).click();
    await expect(panel(page).getByLabel('Find', { exact: true })).toBeFocused();
    await expect(panel(page).getByLabel('Find', { exact: true })).toHaveValue('old');
    await expect(panel(page).getByLabel('Replace with', { exact: true })).toHaveValue(replacement);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(replacement);
    expect(writes).toBe(1);
  });
});

for (const width of [1440, 390]) test.describe(`preview pages ${width}`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  test('page changes reveal the first new match and announce position without losing form values', async ({ page }, info) => {
    const basis = state.projects[0].captions[0];
    state.projects[0].captions = Array.from({ length: 65 }, (_, i) => ({ ...basis, id: `p${i}`, text: `old ${i + 1} កម្ពុជា`, startMs: i * 50, endMs: i * 50 + 40 }));
    await find(page, 'none');
    const preview = panel(page).locator('.find-preview');
    await preview.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const next = panel(page).getByRole('button', { name: 'Next matches', exact: true });
    await next.focus(); await next.press('Enter');
    await expect(panel(page).getByRole('group', { name: 'Caption preview 31 of 65', exact: true })).toBeFocused();
    expect(await preview.evaluate((node) => node.scrollTop)).toBe(0);
    await expect(panel(page).locator('.find-preview-pages [role="status"]')).toHaveText('Page 2 of 3 · Captions 31–60 of 65');
    await expect(preview.locator('.find-before').first()).toHaveText('old 31 កម្ពុជា');
    expect(await panel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await panel(page).locator('.find-preview-pages').evaluate((node) => node.scrollIntoView({ block: 'end', behavior: 'instant' }));
    if (width === 390) {
      const previousBox = await panel(page).getByRole('button', { name: 'Previous matches', exact: true }).boundingBox();
      const nextBox = await next.boundingBox();
      expect(previousBox!.y).toBe(nextBox!.y);
      expect(previousBox!.width).toBeCloseTo(nextBox!.width, 0);
    }
    await page.screenshot({ path: info.outputPath(`find-page-range-${width}.png`) });
    await next.click();
    await expect(next).toBeDisabled();
    await expect(panel(page).getByRole('group', { name: 'Caption preview 61 of 65', exact: true })).toBeFocused();
    await panel(page).getByRole('button', { name: 'Previous matches', exact: true }).click();
    await expect(preview.locator('.find-before').first()).toHaveText('old 31 កម្ពុជា');
    await panel(page).getByLabel('Find', { exact: true }).fill('old 6');
    await expect(panel(page).getByLabel('Find', { exact: true })).toBeFocused();
    await expect(preview.locator('.find-before').first()).toHaveText('old 6 កម្ពុជា');
    await expect(panel(page).getByLabel('Replace with', { exact: true })).toHaveValue('old!');
    expect(await preview.evaluate((node) => node.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`find-paging-${width}.png`) });
  });
});
