import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.defaultVocabulary = ['Hydrated glossary កម្ពុជា'];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const homeSettings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });

for (const width of [1440, 390]) test('Settings keeps its shell and keyboard focus through unavailable data and one retry at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const initial = deferred();
  const retry = deferred();
  let failed = true;
  let reads = 0;
  await page.route('**/api/system/llm-settings', async (route) => {
    const fails = failed;
    reads++;
    await (fails ? initial.promise : retry.promise);
    return fails ? route.fulfill({ status: 503, json: { error: 'Synthetic settings read failure' } }) : route.fallback();
  });
  try {
    await page.goto('/');
    await homeSettings(page).click();
    const dialog = settings(page);
    await expect(dialog.getByRole('status')).toHaveText('Loading settings…');
    await expect(dialog.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
    await dialog.evaluate((node) => { (window as any).__settingsAvailabilityShell = node; });
    initial.release();
    await expect(dialog.getByRole('alert')).toHaveText('Could not load settings');
    await dialog.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(dialog.getByLabel('Key terms for all projects', { exact: true })).toHaveValue('Hydrated glossary កម្ពុជា');
    await dialog.getByRole('button', { name: 'AI connection', exact: true }).click();
    const retryButton = dialog.getByRole('button', { name: 'Retry settings', exact: true });
    await retryButton.focus();
    if (width === 390) expect((await retryButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('settings-unavailable-' + width + '.png') });
    const readsBefore = reads;
    failed = false;
    await retryButton.evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
    await expect(dialog.getByRole('status')).toHaveText('Loading settings…');
    await expect(dialog).toBeFocused();
    await expect.poll(() => reads).toBe(readsBefore + 1);
    expect(await dialog.evaluate((node) => node === (window as any).__settingsAvailabilityShell)).toBe(true);
    retry.release();
    await expect(dialog.getByLabel('Replace current key', { exact: true })).toBeVisible();
    await expect(dialog).toBeFocused();
    expect(await dialog.evaluate((node) => node === (window as any).__settingsAvailabilityShell)).toBe(true);
    await dialog.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(dialog.getByLabel('Key terms for all projects', { exact: true })).toHaveValue('Hydrated glossary កម្ពុជា');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(homeSettings(page)).toBeFocused();
  } finally { initial.release(); retry.release(); }
});

test('AI connection stays available while preferences load and closing Settings keeps late Profile data from reopening it', async ({ page }) => {
  const pending = deferred();
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await pending.promise;
    return route.fallback();
  });
  try {
    await page.goto('/');
    await homeSettings(page).click();
    await expect(settings(page).getByLabel('Replace current key', { exact: true })).toBeVisible();
    await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(settings(page).getByRole('status')).toHaveText('Loading settings…');
    await page.keyboard.press('Escape');
    await expect(settings(page)).toBeHidden();
    await expect(homeSettings(page)).toBeFocused();
    pending.release();
    await expect(page.getByRole('button', { name: 'Choose a video or audio file', exact: true })).toBeEnabled();
    await expect(settings(page)).toBeHidden();
    await expect(homeSettings(page)).toBeFocused();
    await homeSettings(page).click();
    await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(settings(page).getByLabel('Key terms for all projects', { exact: true })).toHaveValue('Hydrated glossary កម្ពុជា');
  } finally { pending.release(); }
});

test('topic packs explain their project prerequisite on Home and apply after a project opens', async ({ page }) => {
  state.profile.topicPacks = [{ id: 'available-pack', name: 'Creator context', description: 'Saved context កម្ពុជា',
    vocabulary: ['Pack term'], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'other-pack', name: 'Newsroom', description: 'News context',
      vocabulary: ['News term'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  await page.goto('/');
  await homeSettings(page).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
  const apply = settings(page).getByRole('button', { name: /^Apply\b.*Creator context$/ });
  await expect(settings(page).getByRole('button', { name: /^Apply\b.*Newsroom$/ })).toBeDisabled();
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveAccessibleDescription('Open a project to apply a topic pack.');
  await expect(settings(page).getByText('Open a project to apply a topic pack.', { exact: true })).toBeVisible();
  await apply.evaluate((node: HTMLButtonElement) => node.click());
  await expect(settings(page)).toBeVisible();
  await expect(page.getByText('Applied topic pack: Creator context', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(apply).toBeEnabled();
  await apply.press('Enter');
  await expect(settings(page)).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Accuracy workspace' })).toBeVisible();
  await expect(page.locator('#accuracy-context-description')).toBeFocused();
  await expect(page.locator('#accuracy-context-description')).toHaveValue('Saved context កម្ពុជា');
  await expect(page.locator('#accuracy-context-vocabulary')).toHaveValue(/Pack term/);
});
