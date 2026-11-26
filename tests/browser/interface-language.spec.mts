import path from 'node:path';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const mirrorKey = 'sthang:interface-language:v1';
const evidence = path.resolve('.codex-tmp/wave3a1');
const prompt = (page: Page) => page.locator('.interface-language-prompt');
const homeSwitch = (page: Page) => page.locator('.home-tools').getByRole('group', { name: 'Language', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const option = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const mirror = (page: Page) => page.evaluate((key) => localStorage.getItem(key), mirrorKey);
const lang = (page: Page) => page.locator('html');
const languageWrites = (state: FixtureState) => state.requests
  .filter(({ path, method }) => path === '/api/profile' && method === 'PATCH')
  .map(({ body }) => body);

function hold() {
  let release!: () => void;
  const untilReleased = new Promise<void>((resolve) => { release = resolve; });
  return { untilReleased, release };
}

async function captureHome(page: Page, filename: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: path.join(evidence, filename), animations: 'disabled' });
}

async function expectChoice(control: Locator, locale: 'en' | 'km') {
  const english = option(control, 'English');
  const khmer = option(control, 'ខ្មែរ');
  await expect(english).toHaveAttribute('lang', 'en');
  await expect(khmer).toHaveAttribute('lang', 'km');
  await expect(english).toHaveAttribute('aria-pressed', String(locale === 'en'));
  await expect(khmer).toHaveAttribute('aria-pressed', String(locale === 'km'));
}

test('an unset profile shows the exact bilingual prompt without moving focus, then saves English once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await installFixture(page);
  delete state.profile.preferences.interfaceLanguage;
  const profileRead = hold();
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'GET') await profileRead.untilReleased;
    await route.fallback();
  });

  const guide = page.getByRole('button', { name: 'Guide', exact: true });
  try {
    await page.goto('/');
    await guide.focus();
    await expect(guide).toBeFocused();
    await expect(prompt(page)).toHaveCount(0);
  } finally {
    profileRead.release();
  }
  await expect(prompt(page).locator('p')).toHaveText('ចង់ប្រើជាភាសាខ្មែរទេ? Use Studio in Khmer?');
  await expect(prompt(page).locator('p [lang="km"]')).toHaveText('ចង់ប្រើជាភាសាខ្មែរទេ?');
  await expect(prompt(page).locator('p [lang="en"]')).toHaveText('Use Studio in Khmer?');
  await expect(option(prompt(page), 'ប្រើភាសាខ្មែរ').locator('[lang="km"]')).toHaveText('ប្រើភាសាខ្មែរ');
  await expect(guide).toBeFocused();
  await captureHome(page, 'home-1440x900.png');

  await option(prompt(page), 'Keep English').click();
  await expect(prompt(page)).toHaveCount(0);
  expect(languageWrites(state)).toEqual([{ preferences: { interfaceLanguage: 'en' } }]);
  await expect(lang(page)).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(option(homeSwitch(page), 'English')).toBeEnabled();
  await expect(prompt(page)).toHaveCount(0);
  await expect(lang(page)).toHaveAttribute('lang', 'en');
});

test('choosing Khmer saves it and supplies first-paint language while the reloaded profile is held', async ({ page }) => {
  const state = await installFixture(page);
  delete state.profile.preferences.interfaceLanguage;
  await page.goto('/');
  await option(prompt(page), 'ប្រើភាសាខ្មែរ').click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(lang(page)).toHaveAttribute('lang', 'km');
  await expect.poll(() => mirror(page)).toBe('km');
  expect(languageWrites(state)).toEqual([{ preferences: { interfaceLanguage: 'km' } }]);

  const profileRead = hold();
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'GET') await profileRead.untilReleased;
    await route.fallback();
  });
  try {
    const requested = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/profile');
    await page.reload();
    await requested;
    await expect(option(homeSwitch(page), 'ខ្មែរ')).toBeDisabled();
    await expect(lang(page)).toHaveAttribute('lang', 'km');
    await expectChoice(homeSwitch(page), 'km');
    await expect(prompt(page)).toHaveCount(0);
  } finally {
    profileRead.release();
  }
  await expect(option(homeSwitch(page), 'ខ្មែរ')).toBeEnabled();
  await expect(prompt(page)).toHaveCount(0);
});

test('Home and Settings Profile persist both options with native labels and pressed states', async ({ page }) => {
  const state = await installFixture(page);
  delete state.profile.preferences.interfaceLanguage;
  await page.goto('/');
  await expect(prompt(page)).toBeVisible();
  const language = homeSwitch(page);
  await expectChoice(language, 'en');
  await expect(page.locator('.home-tools > :last-child')).toHaveClass('interface-language-switch');
  await option(language, 'English').click();
  await expect(prompt(page)).toHaveCount(0);
  await option(language, 'ខ្មែរ').click();
  await expectChoice(language, 'km');
  await expect(lang(page)).toHaveAttribute('lang', 'km');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await option(settings(page), 'Profile').click();
  const field = settings(page).locator('.profile-body > :last-child');
  await expect(field.getByText('Interface language', { exact: true })).toBeVisible();
  const profileSwitch = field.getByRole('group', { name: 'Language', exact: true });
  await expectChoice(profileSwitch, 'km');
  await option(profileSwitch, 'English').click();
  await expectChoice(profileSwitch, 'en');
  await expect(lang(page)).toHaveAttribute('lang', 'en');
  await option(profileSwitch, 'ខ្មែរ').click();
  await expectChoice(profileSwitch, 'km');
  await expect(lang(page)).toHaveAttribute('lang', 'km');
  expect(languageWrites(state)).toEqual(['en', 'km', 'en', 'km'].map((interfaceLanguage) => ({ preferences: { interfaceLanguage } })));
  await expect.poll(() => mirror(page)).toBe('km');
});

test('the empty Khmer catalog renders English on Home, the editor, Review, Generate and Tools', async ({ page }) => {
  const errors: string[] = [];
  const withoutUrls = (message: string) => message.replace(/\b(?:https?|wss?):\/\/[^\s'"]+/g, '[url]');
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    errors.push(`${url ? new URL(url).pathname + ': ' : ''}${withoutUrls(message.text())}`);
  });
  page.on('pageerror', (error) => errors.push(withoutUrls(error.message)));
  const state = await installFixture(page);
  // Vite's development client still opens an HMR socket in this harness.
  // Acknowledge the owned frontend's connection locally without forwarding it.
  const viteHost = new URL(requireHarnessConfig().webOrigin).host;
  await page.routeWebSocket((url) => url.protocol === 'ws:' && url.host === viteHost && url.pathname === '/', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
  });
  await page.route('**/api/updates', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { status: 'unconfigured', currentVersion: 'test', supported: false, message: 'Synthetic fixture' } })
    : route.fallback());
  await page.route('**/api/media-preview/*', (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source');
    if (route.request().method() !== 'GET' || !state.projects.some((project) =>
      url.pathname === `/api/media-preview/${project.id}` && source === project.media.filename)) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });
  state.profile.preferences.interfaceLanguage = 'km';
  state.projects[1].transcript = null;
  state.projects[1].captions = [];
  await page.goto('/');
  await expect(lang(page)).toHaveAttribute('lang', 'km');
  await expect(page.getByRole('heading', { name: 'Create Khmer captions' })).toBeVisible();
  await expect(option(page.locator('main'), 'Choose a video or audio file')).toBeVisible();
  await openProject(page);

  await expect(option(page.locator('header'), 'Back to Home')).toBeVisible();
  const stages = page.getByRole('navigation', { name: 'Project stages' });
  await expect(stages.getByRole('button')).toHaveText(['Captions', /^Review/, 'Appearance', 'Export']);
  await expect(page.getByRole('textbox', { name: 'Caption 1 text', exact: true })).toBeVisible();
  await stages.getByRole('button', { name: /^Review/ }).click();
  const review = page.getByRole('complementary', { name: 'Review workspace' });
  const reasons = review.getByRole('list', { name: 'Review reasons' });
  await expect(reasons.getByText('Timing may be off', { exact: true })).toBeVisible();
  await expect(reasons.getByText('Play it and check that the caption matches the voice.')).toBeVisible();
  await expect(option(review, 'Approve & next')).toBeVisible();
  await page.getByLabel('Open project tools', { exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Project tools' }).getByText('Correct everywhere', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await openProject(page, 'second');
  const generate = page.locator('.transcribe-card');
  await expect(generate.getByText('Captions from audio')).toBeVisible();
  await expect(option(generate, 'Generate captions')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Khmer typography removes operational uppercase and tracking, sizes chips, and preserves the brand', async ({ page }) => {
  const state = await installFixture(page);
  state.projects[0].captions[0].approved = true;
  await page.goto('/');
  await expectChoice(homeSwitch(page), 'en');
  const brand = page.locator('.empty-stage .studio-product-name');
  const brandType = () => brand.evaluate((node) => {
    const { letterSpacing, textTransform, fontFamily, fontSize, lineHeight } = getComputedStyle(node);
    return { letterSpacing, textTransform, fontFamily, fontSize, lineHeight };
  });
  const englishBrand = await brandType();
  await option(page.locator('.home-tools'), 'Settings').click();
  const keyLabel = settings(page).locator('.ai-key-field > span');
  await expect(keyLabel).toHaveCSS('text-transform', 'uppercase');
  expect(await keyLabel.evaluate((node) => parseFloat(getComputedStyle(node).letterSpacing))).toBeGreaterThan(0);
  await option(settings(page), 'Profile').click();
  await option(settings(page).getByRole('group', { name: 'Language', exact: true }), 'ខ្មែរ').click();
  await expect(lang(page)).toHaveAttribute('lang', 'km');
  await option(settings(page), 'AI connection').click();
  await expect(keyLabel).toHaveCSS('text-transform', 'none');
  // Chromium can serialize zero tracking as "normal".
  await expect(keyLabel).toHaveCSS('letter-spacing', /^(?:0px|normal)$/);
  await expect(keyLabel).toHaveCSS('font-size', '13px');
  await option(settings(page), 'Close settings').click();
  expect(await brandType()).toEqual(englishBrand);
  await openProject(page);
  const chip = page.locator('.caption-state-line .state-approved').first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12);
});

test('a pending language save blocks a second PATCH and a failed save leaves language and mirror intact', async ({ page }) => {
  const state = await installFixture(page);
  const rejected = hold();
  const writes: unknown[] = [];
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.push(route.request().postDataJSON());
    await rejected.untilReleased;
    await route.fulfill({ status: 503, json: { error: 'Synthetic language save failure' } });
  });
  await page.goto('/');
  const language = homeSwitch(page);
  await expect.poll(() => mirror(page)).toBe('en');
  try {
    await option(language, 'ខ្មែរ').click();
    await expect(option(language, 'ខ្មែរ')).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => writes.length).toBe(1);
    await option(language, 'ខ្មែរ').evaluate((node: HTMLButtonElement) => node.click());
    await expectChoice(language, 'en');
    await expect(lang(page)).toHaveAttribute('lang', 'en');
    expect(await mirror(page)).toBe('en');
  } finally {
    rejected.release();
  }
  await expect(page.getByText('Studio could not save the language. Your current language is kept; try again.', { exact: true })).toBeVisible();
  await expect(option(language, 'ខ្មែរ')).not.toHaveAttribute('aria-busy', 'true');
  await expectChoice(language, 'en');
  await expect(lang(page)).toHaveAttribute('lang', 'en');
  expect(await mirror(page)).toBe('en');
  expect(state.profile.preferences.interfaceLanguage).toBe('en');
  expect(writes).toEqual([{ preferences: { interfaceLanguage: 'km' } }]);
});

test('the phone prompt and switch have 44px targets without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installFixture(page);
  delete state.profile.preferences.interfaceLanguage;
  await page.goto('/');
  await expect(prompt(page)).toBeVisible();
  const buttons = prompt(page).getByRole('button').or(homeSwitch(page).getByRole('button'));
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth))).toBe(390);
  await captureHome(page, 'home-390x844.png');
});
