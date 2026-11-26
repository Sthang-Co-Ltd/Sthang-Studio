import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const missing = {
  provider: 'gemini', configured: false, keySource: 'none', maskedKey: null, model: 'fixture-primary',
  fallbackModel: 'fixture-fallback', secureStorageAvailable: true, secureStorageLabel: 'Synthetic secure storage',
  environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
};
const connection = { ok: true, level: 'success', provider: 'gemini', model: missing.model, latencyMs: 1, message: 'Synthetic connection checked.' };
const fakeKey = 'fixture-home-setup-key';
const card = (page: Page) => page.getByRole('region', { name: 'Getting started' });
const step = (page: Page, name: RegExp) => card(page).getByRole('button', { name });
const ai = (page: Page) => step(page, /^Connect AI/);
const timing = (page: Page) => step(page, /^Set up Khmer timing/);
const check = (page: Page) => card(page).getByRole('button', { name: 'Check again', exact: true });
const save = (scope: Locator) => scope.getByRole('button', { name: 'Test & save', exact: true });
const key = (scope: Locator) => scope.getByLabel('API key', { exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const evidence = '.codex-tmp/wave2c1/';

async function freshSetup(page: Page, options: { configured?: boolean; userAgent?: string } = {}) {
  const fixture = await installFixture(page);
  fixture.projects = [];
  const state = { configured: options.configured ?? false, timing: 'missing', failSave: false, healthReads: 0,
    holdHealth: undefined as Promise<void> | undefined,
    requests: [] as { method: string; path: string; body: unknown }[] };
  await page.addInitScript((userAgent) => {
    if (userAgent) Object.defineProperty(navigator, 'userAgent', { value: userAgent });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'fixture-clipboard-key' } });
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    let appReadDismissal = false;
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === 'sthang:first-run-dismissed:v1' && !appReadDismissal) {
        appReadDismissal = true;
        if (!getItem.call(sessionStorage, 'fixture-setup-dismissed')) this.removeItem(name);
      }
      return getItem.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === 'sthang:first-run-dismissed:v1' && appReadDismissal) {
        setItem.call(sessionStorage, 'fixture-setup-dismissed', '1');
      }
      setItem.call(this, name, value);
    };
  }, options.userAgent);
  const llm = () => state.configured ? { ...missing, configured: true, keySource: 'secure-store', canForgetSecureKey: true } : missing;
  await page.route('**/api/health', async (route) => {
    state.healthReads++;
    await state.holdHealth;
    return route.fulfill(state.timing === 'failed' ? { status: 503, json: { error: 'Synthetic health failure' } }
      : { json: { ok: true, engineVersion: 'test', llm: llm(),
        timing: { configured: state.timing === 'ready', engine: 'kfa-local', model: 'synthetic', provider: 'local', device: 'cpu', language: 'km', paidApi: false } } });
  });
  await page.route('**/api/system/llm-settings', (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      state.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
      if (state.failSave) return route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } });
      state.configured = true;
    }
    return route.fulfill({ json: llm() });
  });
  await page.route('**/api/system/llm-settings/test', (route) => {
    const request = route.request();
    state.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return route.fulfill({ json: connection });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  return state;
}

for (const [width, height] of [[1440, 900], [1366, 768]]) test('both steps missing keeps the upload surface in view at ' + width + 'px', async ({ page }) => {
  await page.setViewportSize({ width, height });
  await freshSetup(page);
  await expect(card(page).getByRole('heading', { name: 'Caption setup' })).toBeVisible();
  await expect(card(page).getByRole('listitem')).toHaveCount(3);
  await expect(ai(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(key(card(page))).toHaveAttribute('type', 'password');
  await expect(key(card(page))).toHaveAttribute('autocomplete', 'off');
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(timing(page)).toContainText('Not set up yet');
  await expect(card(page).getByText('Drop a video below. You can add it now; captions need steps 1 and 2.')).toBeVisible();
  await expect(card(page).getByText('Model settings')).toHaveCount(0);
  const dropzone = page.getByRole('button', { name: 'Choose a video or audio file', exact: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const top = await dropzone.evaluate((node) => node.getBoundingClientRect().top);
  console.log('Home dropzone top at ' + width + 'x' + height + ' = ' + top + 'px');
  await page.screenshot({ path: evidence + 'home-' + width + 'x' + height + '.png' });
  await expect(dropzone).toBeInViewport();
});

test('inline Test & save uses the same requests as Settings and advances without exposing the saved key', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await freshSetup(page, { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
  await key(card(page)).fill(fakeKey);
  await card(page).getByRole('button', { name: 'Show typed key' }).click();
  await expect(key(card(page))).toHaveAttribute('type', 'text');
  await save(card(page)).click();
  await expect(card(page).getByText('Done · Gemini key saved', { exact: true })).toBeVisible();
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(card(page).locator('.ai-key-field input')).toHaveCount(0);
  expect(await page.evaluate((secret) => document.documentElement.outerHTML.includes(secret)
    || Array.from(document.querySelectorAll('input')).some((input) => input.value.includes(secret)), fakeKey)).toBe(false);
  await expect(page.locator('.toast-stack')).not.toContainText(fakeKey);
  await page.screenshot({ path: evidence + 'home-after-ai-save.png' });
  const inlineRequests = [...state.requests];

  state.configured = false;
  await page.reload();
  await expect(key(card(page))).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settings(page);
  await key(dialog).fill(fakeKey);
  await save(dialog).click();
  await expect(dialog.locator('.ai-key-field input')).toHaveValue('');
  await expect(dialog.getByRole('status').filter({ hasText: 'AI settings saved securely' })).toBeVisible();
  expect(state.requests.slice(2)).toEqual(inlineRequests);
  expect(inlineRequests).toEqual([
    { method: 'POST', path: '/api/system/llm-settings/test', body: { apiKey: fakeKey, model: missing.model } },
    { method: 'PUT', path: '/api/system/llm-settings', body: { apiKey: fakeKey, model: missing.model, fallbackModel: missing.fallbackModel } },
  ]);
});

test('save failure keeps the key and retry action in the open step', async ({ page }) => {
  const state = await freshSetup(page);
  state.failSave = true;
  await key(card(page)).fill(fakeKey);
  await save(card(page)).press('Enter');
  await expect(card(page).getByRole('alert')).toHaveText('Synthetic save failure');
  await expect(key(card(page))).toHaveValue(fakeKey);
  await expect(key(card(page))).toHaveAttribute('type', 'password');
  await expect(ai(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(save(card(page))).toBeFocused();
  await expect(save(card(page))).toBeEnabled();
});

test('timing recheck announces an incomplete read, survives failure, and becomes ready after retry', async ({ page }) => {
  const state = await freshSetup(page, { configured: true });
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'true');
  const status = card(page).getByRole('status');
  await expect(status).toHaveText('Not set up yet');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  const before = state.healthReads;
  let release!: () => void;
  state.holdHealth = new Promise<void>((resolve) => { release = resolve; });
  try {
    await check(page).press('Enter');
    const checking = card(page).getByRole('button', { name: 'Checking…', exact: true });
    await expect(checking).toHaveAttribute('aria-busy', 'true');
    await expect(checking).toBeEnabled();
    await expect(checking).toBeFocused();
    await checking.press('Enter');
  } finally { release(); state.holdHealth = undefined; }
  await expect(status).toHaveText('Still not set up. Finish the setup above, then check again. If this keeps happening, restart Studio.');
  expect(state.healthReads).toBe(before + 1);

  state.timing = 'failed';
  await check(page).press('Enter');
  await expect(status).toHaveText('Studio could not check right now. Try again.');
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(check(page)).toBeEnabled();
  await expect(check(page)).toBeFocused();

  state.timing = 'ready';
  await check(page).press('Enter');
  await expect(page.getByText('Studio ready', { exact: true })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(state.healthReads).toBe(before + 3);
});

for (const [platform, userAgent, filenames] of [
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ['Install Sthang Studio.bat', 'setup-local-timing-windows.bat']],
  ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', ['bash ./setup-local-timing-macos.sh']],
] as const) test('timing instructions name the setup files for ' + platform, async ({ page }) => {
  await freshSetup(page, { configured: true, userAgent });
  const instructions = card(page).getByText(/Khmer timing runs on this computer/);
  await expect(instructions).toBeVisible();
  for (const filename of filenames) await expect(instructions).toContainText(filename);
  expect((await instructions.innerText()).replace('./', '')).not.toMatch(/\b[A-Za-z]:|[\\/]/);
});

test('the keyboard reaches controls in order and disclosure headers retain visible focus', async ({ page }) => {
  await freshSetup(page);
  const home = card(page);
  const dismiss = home.getByRole('button', { name: 'Dismiss getting started' });
  await dismiss.focus();
  const nextTab = async (target: Locator) => {
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    expect(await target.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  };
  await nextTab(ai(page));
  await nextTab(home.getByRole('link', { name: 'Get a key' }));
  await nextTab(key(home));
  await key(home).fill(fakeKey);
  await nextTab(home.getByRole('button', { name: 'Show typed key' }));
  const paste = home.getByRole('button', { name: 'Paste from clipboard' });
  await nextTab(paste);
  await page.keyboard.press('Enter');
  await expect(key(home)).toHaveValue('fixture-clipboard-key');
  await nextTab(save(home));
  await nextTab(timing(page));
  expect(await timing(page).evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('2px');
  await page.keyboard.press('Space');
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(ai(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(timing(page)).toBeFocused();
  await nextTab(check(page));
  await nextTab(home.getByRole('button', { name: 'Open System check' }));
  await timing(page).press('Enter');
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(timing(page)).toBeFocused();
});

test('Home and Settings forms coexist with distinct IDs and independent drafts', async ({ page }) => {
  const state = await freshSetup(page);
  await key(card(page)).fill('fixture-home-draft');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settings(page);
  await key(dialog).fill('fixture-settings-draft');
  expect(await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    return ids.length === new Set(ids).size && document.querySelectorAll('.ai-key-field input').length === 2;
  })).toBe(true);
  const fullInput = dialog.getByLabel('Primary model', { exact: true });
  expect(await fullInput.evaluate((node: HTMLInputElement) => node.list instanceof HTMLDataListElement)).toBe(true);
  state.failSave = true;
  await save(dialog).click();
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic save failure');
  await expect(key(dialog)).toHaveValue('fixture-settings-draft');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(key(card(page))).toHaveValue('fixture-home-draft');
  state.failSave = false;
  await save(card(page)).click();
  await expect(card(page).getByText('Done · Gemini key saved')).toBeVisible();
  expect(state.requests).toHaveLength(4);
});

test('dismiss persists and restores the existing AI and timing fallbacks', async ({ page }) => {
  await freshSetup(page);
  await card(page).getByRole('button', { name: 'Dismiss getting started' }).click();
  await expect(card(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sthang:first-run-dismissed:v1'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Set up AI for caption generation' })).toBeVisible();
  await expect(page.getByText("Local timing isn't ready.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Set up AI for caption generation' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('phone setup controls have 44px targets and fit without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshSetup(page);
  const home = card(page);
  const requireTargets = async () => {
    for (const target of await home.locator('button:visible, a:visible, input:visible').all()) {
      const box = (await target.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await expect(key(home)).toBeVisible();
  await expect(timing(page)).toHaveAttribute('aria-expanded', 'false');
  await requireTargets();
  await page.screenshot({ path: evidence + 'home-390x844.png' });
  await timing(page).click();
  await expect(check(page)).toBeVisible();
  await requireTargets();
});
