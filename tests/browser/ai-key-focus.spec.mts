import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
const baseline = { provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: null, model: 'fixture-original', fallbackModel: 'fixture-fallback', secureStorageAvailable: true, secureStorageLabel: 'Test storage', environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null };
const removed = { ...baseline, configured: false, keySource: 'none', canForgetSecureKey: false };
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const key = (page: Page) => settings(page).locator('.ai-key-field input');
const model = (page: Page) => settings(page).getByLabel('Primary model', { exact: true });
const forget = (page: Page) => settings(page).getByRole('button', { name: 'Forget saved key', exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: baseline }));
});
async function openSettings(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await expect(key(page)).toBeVisible();
  await key(page).fill('fixture-unsaved-replacement');
  await model(page).fill('fixture-unsaved-model');
}
async function expectVisibleFocus(target: Locator) {
  await expect(target).toBeFocused();
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      && rect.left >= 0 && rect.right <= innerWidth
      && [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].every((y) => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
        return hit === node || (hit !== null && node.contains(hit));
      });
  })).toBe(true);
}
async function confirmRemoval(page: Page) {
  await forget(page).focus();
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('alertdialog', { name: 'Forget saved key?', exact: true });
  await confirmation.getByRole('button', { name: 'Forget saved key', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation).toHaveCount(0);
  await expectVisibleFocus(key(page));
}
async function expectSettled(page: Page, succeeds: boolean) {
  if (succeeds) {
    await expect(settings(page).getByText('Saved key removed. Add another key to generate captions.', { exact: true })).toBeVisible();
    await expect(forget(page)).toHaveCount(0);
  } else {
    await expect(settings(page).getByRole('alert')).toHaveText('Synthetic removal failure');
    await expect(forget(page)).not.toHaveAttribute('aria-busy', 'true');
  }
}

for (const width of [1440, 390]) test(`confirmed saved-key removal keeps a visible persistent target through failure and success at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | undefined;
  let removals = 0;
  let otherWrites = 0;
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\/system\/llm-settings(?:\/test)?$/.test(new URL(request.url()).pathname)) otherWrites++;
  });
  await page.route('**/api/system/llm-settings/key', async (route) => {
    const current = attempt;
    if (!current) throw new Error('Cancel must not remove a saved key.');
    removals++;
    await current.gate.promise;
    return route.fulfill(current.succeeds ? { json: removed } : { status: 503, json: { error: 'Synthetic removal failure' } });
  });
  await openSettings(page);
  await forget(page).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(forget(page)).toBeFocused();
  expect(removals).toBe(0);
  for (const succeeds of [false, true]) {
    const gate = deferred(); attempt = { succeeds, gate };
    try {
      await confirmRemoval(page);
      await expect.poll(() => removals).toBe(succeeds ? 2 : 1);
      await expect(forget(page)).toHaveAttribute('aria-busy', 'true');
      await expect(key(page)).toHaveValue('fixture-unsaved-replacement');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (!succeeds) await page.screenshot({ path: info.outputPath(`ai-key-removal-focus-${width}.png`), animations: 'disabled' });
      gate.release();
      await expectSettled(page, succeeds);
      await expectVisibleFocus(key(page));
      await expect(key(page)).toHaveValue('fixture-unsaved-replacement');
      await expect(model(page)).toHaveValue('fixture-unsaved-model');
      await page.keyboard.press('Tab');
      await expect(settings(page).getByRole('button', { name: 'Show typed key', exact: true })).toBeFocused();
    } finally { gate.release(); }
  }
  expect(removals).toBe(2);
  expect(otherWrites).toBe(0);
});

for (const succeeds of [false, true]) test(`saved-key removal ${succeeds ? 'success' : 'failure'} preserves newer model focus and entries`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const gate = deferred();
  let removals = 0;
  await page.route('**/api/system/llm-settings/key', async (route) => {
    removals++;
    await gate.promise;
    return route.fulfill(succeeds ? { json: removed } : { status: 503, json: { error: 'Synthetic removal failure' } });
  });
  try {
    await openSettings(page);
    await confirmRemoval(page);
    await model(page).fill('fixture-newer-model');
    await expect(model(page)).toBeFocused();
    gate.release();
    await expectSettled(page, succeeds);
    await expect(model(page)).toBeFocused();
    await expect(model(page)).toHaveValue('fixture-newer-model');
    await expect(key(page)).toHaveValue('fixture-unsaved-replacement');
    expect(removals).toBe(1);
  } finally { gate.release(); }
});
