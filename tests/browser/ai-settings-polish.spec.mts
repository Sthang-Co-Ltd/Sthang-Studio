import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
const baseline = { provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: null, model: 'fixture-original', fallbackModel: 'fixture-fallback', secureStorageAvailable: true, secureStorageLabel: 'Test storage', environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null };
const connection = { ok: true, level: 'success', provider: 'gemini', model: 'fixture-model', latencyMs: 1, message: 'Synthetic connection checked.' };
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const key = (page: Page) => settings(page).locator('.ai-key-field input');
const model = (page: Page) => settings(page).getByLabel('Primary model', { exact: true });
const fallback = (page: Page) => settings(page).getByLabel('Fallback model optional', { exact: true });
const save = (page: Page) => settings(page).getByRole('button', { name: 'Test & save', exact: true });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function openSettings(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await expect(key(page)).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: baseline }));
  await page.route('**/api/system/llm-settings/test', (route) => route.fulfill({ json: connection }));
});

test('saving acknowledges the captured AI settings and preserves newer key and model drafts', async ({ page }) => {
  const gate = deferred(); let saves = 0; let submitted: Record<string, string> = {};
  await page.route('**/api/system/llm-settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves++; submitted = route.request().postDataJSON();
    if (saves === 1) await gate.promise;
    return route.fulfill({ json: { ...baseline, model: submitted.model, fallbackModel: submitted.fallbackModel } });
  });
  try {
    await openSettings(page);
    await key(page).fill('fixture-first-key'); await model(page).fill('fixture-first-model'); await fallback(page).fill('fixture-first-fallback');
    await save(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => saves).toBe(1);
    await key(page).fill('fixture-newer-key'); await model(page).fill('fixture-newer-model'); await fallback(page).fill('fixture-newer-fallback');
    gate.resolve();
    await expect(settings(page).getByText('Earlier AI settings saved. Your newer edits are still unsaved.', { exact: true })).toBeVisible();
    expect(submitted).toEqual({ apiKey: 'fixture-first-key', model: 'fixture-first-model', fallbackModel: 'fixture-first-fallback' });
    await expect(key(page)).toHaveValue('fixture-newer-key'); await expect(model(page)).toHaveValue('fixture-newer-model'); await expect(fallback(page)).toHaveValue('fixture-newer-fallback');
    await expect(settings(page).locator('.ai-test-result')).toHaveCount(0);
    await save(page).click();
    await expect(settings(page).getByText('AI settings saved securely on this computer. No restart needed.', { exact: true })).toBeVisible();
    await expect(key(page)).toHaveValue(''); await expect(key(page)).toHaveAttribute('type', 'password');
    await expect(model(page)).toHaveValue('fixture-newer-model'); expect(saves).toBe(2);
  } finally { gate.resolve(); }
});

for (const response of ['success', 'failure'] as const) test(`a delayed connection ${response} never labels a newer draft`, async ({ page }) => {
  const gate = deferred(); let tests = 0;
  await page.route('**/api/system/llm-settings/test', async (route) => {
    tests++; if (tests === 1) { await gate.promise; return route.fulfill(response === 'success' ? { json: connection } : { status: 503, json: { error: 'Synthetic old connection failure' } }); }
    return route.fulfill({ json: connection });
  });
  try {
    await openSettings(page); await key(page).fill('fixture-before');
    const check = settings(page).getByRole('button', { name: 'Test connection', exact: true });
    await check.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => tests).toBe(1); await key(page).fill('fixture-after'); await model(page).fill('fixture-after-model');
    gate.resolve(); await expect(check).toBeEnabled();
    await expect(settings(page).locator('.ai-test-result, .ai-inline-message')).toHaveCount(0);
    await check.click(); await expect(settings(page).locator('.ai-test-result')).toContainText('Synthetic connection checked.');
    await expect(key(page)).toHaveValue('fixture-after'); expect(tests).toBe(2);
  } finally { gate.resolve(); }
});

test('failed AI saving keeps entries retryable and leaving a pending test cannot start a later save', async ({ page }) => {
  let fail = true; let saves = 0;
  await page.route('**/api/system/llm-settings', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves++;
    return route.fulfill(fail ? { status: 503, json: { error: 'Synthetic save failure' } } : { json: { ...baseline, ...route.request().postDataJSON(), apiKey: undefined } });
  });
  await openSettings(page); await key(page).fill('fixture-retry'); await model(page).fill('fixture-retry-model');
  await save(page).click(); await expect(settings(page).getByRole('alert')).toContainText('Synthetic save failure');
  await expect(key(page)).toHaveValue('fixture-retry'); await expect(model(page)).toHaveValue('fixture-retry-model');
  fail = false; await save(page).click(); await expect(key(page)).toHaveValue(''); expect(saves).toBe(2);
  const gate = deferred(); let held = false; let settled = false;
  await page.route('**/api/system/llm-settings/test', async (route) => { held = true; await gate.promise; await route.fulfill({ json: connection }); settled = true; });
  try {
    await key(page).fill('fixture-unmounted'); await save(page).click(); await expect.poll(() => held).toBe(true);
    await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    gate.resolve(); await expect.poll(() => settled).toBe(true);
    await settings(page).getByRole('button', { name: 'AI connection', exact: true }).click();
    await expect(key(page)).toHaveValue(''); await expect(settings(page).locator('.ai-test-result')).toHaveCount(0); expect(saves).toBe(2);
  } finally { gate.resolve(); }
});

for (const platform of ['Win32', 'MacIntel']) test(`blocked clipboard offers focused manual paste on ${platform}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((platform) => {
    Object.defineProperty(navigator, 'platform', { value: platform });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => { throw new Error('Synthetic denial'); } } });
  }, platform);
  await openSettings(page); await key(page).fill('fixture-kept');
  await settings(page).getByRole('button', { name: 'Paste from clipboard', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toContainText(platform === 'MacIntel' ? 'Command+V' : 'Ctrl+V');
  await expect(settings(page).getByRole('alert')).not.toContainText('Synthetic denial');
  await expect(key(page)).toBeFocused(); await expect(key(page)).toHaveValue('fixture-kept');
  expect(await settings(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await settings(page).getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`ai-paste-${platform}-390.png`) });
});

test('a late clipboard read preserves newer typing and empty clipboard has actionable feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => new Promise<string>((resolve) => { (window as any).__finishPaste = resolve; }) } });
  });
  await openSettings(page);
  const paste = settings(page).getByRole('button', { name: 'Paste from clipboard', exact: true });
  await paste.click(); await key(page).fill('fixture-newer');
  await page.evaluate(() => (window as any).__finishPaste('fixture-older')); await expect(paste).toBeEnabled();
  await expect(key(page)).toHaveValue('fixture-newer'); await expect(settings(page).locator('.ai-inline-message')).toHaveCount(0);
  await paste.click(); await page.evaluate(() => (window as any).__finishPaste('   '));
  await expect(settings(page).getByRole('alert')).toContainText('Clipboard is empty'); await expect(key(page)).toHaveValue('fixture-newer');
});

test('forget uses a contained Studio confirmation and preserves an unsaved replacement', async ({ page }, info) => {
  let removals = 0; let nativeDialogs = 0;
  page.on('dialog', (dialog) => { nativeDialogs++; void dialog.dismiss(); });
  await page.route('**/api/system/llm-settings/key', (route) => {
    removals++; return route.fulfill({ json: { ...baseline, configured: false, keySource: 'none', canForgetSecureKey: false } });
  });
  await openSettings(page); await key(page).fill('fixture-replacement'); await model(page).fill('fixture-draft-model');
  const forget = settings(page).getByRole('button', { name: 'Forget saved key', exact: true });
  await forget.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Forget saved key?', exact: true });
  await expect(confirmation).toBeVisible();
  for (let i = 0; i < 7; i++) { await page.keyboard.press('Tab'); expect(await confirmation.evaluate((node) => node.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0); await expect(forget).toBeFocused(); expect(removals).toBe(0);
  await forget.click(); await page.screenshot({ path: info.outputPath('forget-confirmation-desktop.png') });
  await confirmation.getByRole('button', { name: 'Forget saved key', exact: true }).click();
  await expect(settings(page).getByText('Saved key removed. Add another key to generate captions.', { exact: true })).toBeVisible();
  await expect(key(page)).toHaveValue('fixture-replacement'); await expect(model(page)).toHaveValue('fixture-draft-model'); expect(removals).toBe(1); expect(nativeDialogs).toBe(0);
});
