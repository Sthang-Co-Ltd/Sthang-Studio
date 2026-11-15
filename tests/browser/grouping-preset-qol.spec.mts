import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const controls = (page: Page) => page.locator('.controls-card');
const save = (page: Page) => page.getByRole('button', { name: 'Save grouping preset', exact: true });
async function openGrouping(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Caption grouping', exact: true }).click();
  await expect(controls(page)).toBeVisible();
  await controls(page).getByRole('button', { name: /^Dynamic/ }).click();
  await page.evaluate(() => { (window as any).__groupingPresetNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function unchanged(page: Page, captions: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(captions);
  expect(state.requests.filter((request) => request.path.endsWith('/resegment'))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__groupingPresetNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
for (const width of [1440, 390]) test(`grouping preset saves one submitted snapshot while newer choices remain at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const gate = deferred();
  const finished = deferred();
  const writes: any[] = [];
  const captions = structuredClone(state.projects[0].captions);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().styles) return route.fallback();
    const body = route.request().postDataJSON();
    writes.push(body);
    state.profile = { ...state.profile, styles: structuredClone(body.styles) };
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    try { await route.fulfill({ json: acknowledged }); } finally { finished.release(); }
  });
  try {
    await openGrouping(page);
    await controls(page).getByRole('slider').fill('24');
    await save(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    const pending = page.getByRole('button', { name: 'Saving grouping preset…', exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => writes.length).toBe(1);
    await controls(page).getByRole('button', { name: /^Phrase/ }).click();
    await controls(page).getByRole('slider').fill('30');
    await pending.evaluate((button) => button.scrollIntoView({ block: 'end', behavior: 'instant' }));
    await page.screenshot({ path: info.outputPath(`grouping-preset-pending-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close tool', exact: true }).click();
    await page.getByRole('button', { name: 'Caption grouping', exact: true }).click();
    await expect(pending).toBeDisabled();
    await pending.evaluate((button: HTMLButtonElement) => button.click());
    expect(writes).toHaveLength(1);
    const choice = controls(page).getByRole('button', { name: /^Phrase/ });
    await choice.focus();
    gate.release(); await finished.promise;
    await expect(save(page)).toBeEnabled();
    await expect(choice).toBeFocused();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(controls(page).getByRole('slider')).toHaveValue('30');
    await expect(page.getByText('Grouping preset saved: Dynamic, target 24 characters. Newer choices are kept in the controls.', { exact: true })).toBeVisible();
    expect(writes[0].styles.find((style: any) => style.id === 'my-tiktok-style')).toMatchObject({ mode: 'dynamic', maxChars: 24 });
    await unchanged(page, captions);
  } finally { gate.release(); }
});

test('failed grouping preset save preserves choices and allows an exact retry', async ({ page }) => {
  const writes: any[] = [];
  const captions = structuredClone(state.projects[0].captions);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().styles) return route.fallback();
    const body = route.request().postDataJSON(); writes.push(body);
    if (writes.length === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic grouping save failure' } });
    state.profile = { ...state.profile, styles: structuredClone(body.styles) };
    return route.fulfill({ json: state.profile });
  });
  await openGrouping(page);
  await controls(page).getByRole('button', { name: /^Line/ }).click();
  await controls(page).getByRole('slider').fill('34');
  await save(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic grouping save failure' })).toContainText('Your current grouping choices are kept.');
  await expect(save(page)).toBeEnabled();
  await expect(controls(page).getByRole('slider')).toHaveValue('34');
  await expect(controls(page).getByRole('button', { name: /^Line/ })).toHaveAttribute('aria-pressed', 'true');
  await save(page).click();
  await expect(page.getByText('Grouping preset saved: Line, target 34 characters.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await unchanged(page, captions);
});

test('late grouping acknowledgement preserves a newer review preference', async ({ page }) => {
  const gate = deferred(); const finished = deferred();
  const captions = structuredClone(state.projects[0].captions);
  let submitted = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().styles) return route.fallback();
    state.profile = { ...state.profile, styles: structuredClone(route.request().postDataJSON().styles) };
    const acknowledged = structuredClone(state.profile); submitted = true;
    await gate.promise;
    try { await route.fulfill({ json: acknowledged }); } finally { finished.release(); }
  });
  try {
    await openGrouping(page);
    await save(page).click();
    await expect.poll(() => submitted).toBe(true);
    await page.getByRole('navigation', { name: 'Caption workspace tools' }).getByRole('button', { name: /^Review/ }).click();
    const preference = page.getByRole('checkbox', { name: 'Auto-play next', exact: true });
    await preference.check();
    await expect.poll(() => state.profile.preferences.autoPlayNextReview).toBe(true);
    await preference.focus();
    gate.release(); await finished.promise;
    await expect(page.getByText('Grouping preset saved: Dynamic, target 18 characters.', { exact: true })).toBeVisible();
    await expect(preference).toBeChecked();
    await expect(preference).toBeFocused();
    await unchanged(page, captions);
  } finally { gate.release(); }
});

test('a success response without the submitted preset cannot claim it was saved', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().styles) return route.fallback();
    writes++;
    return route.fulfill({ json: state.profile });
  });
  await openGrouping(page);
  await controls(page).getByRole('slider').fill('28');
  await save(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The saved grouping preset could not be confirmed.' })).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await expect(controls(page).getByRole('slider')).toHaveValue('28');
  await expect(page.getByText(/^Grouping preset saved:/)).toHaveCount(0);
  expect(writes).toBe(1);
});
