import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let keyRemovals: number;
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const findDialog = (page: Page) => page.getByRole('dialog', { name: 'Correct everywhere', exact: true });
const confirmation = (page: Page) => page.getByRole('alertdialog', { name: 'Forget saved key?', exact: true });
const keyInput = (page: Page) => settings(page).locator('.ai-key-field input');
const forget = (page: Page) => settings(page).getByRole('button', { name: 'Forget saved key', exact: true });
const baseline = { provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: null, model: 'synthetic-model', fallbackModel: '', secureStorageAvailable: true, secureStorageLabel: 'Test storage', environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null };

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  keyRemovals = 0;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: baseline }));
  await page.route('**/api/system/llm-settings/key', (route) => {
    keyRemovals++;
    return route.fulfill({ json: { ...baseline, configured: false, keySource: 'none', canForgetSecureKey: false } });
  });
});
async function openSettings(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await expect(settings(page)).toBeVisible();
}
async function dispatchKey(target: Locator, key: string, variant: KeyboardEventInit & { altGraph?: boolean }) {
  return target.evaluate((node, { key, variant }) => {
    const { altGraph, ...init } = variant;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    if (altGraph) Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, { key, variant });
}
async function ignoredEscape(target: Locator, dialog: Locator) {
  for (const variant of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { altGraph: true }, { isComposing: true }, { keyCode: 229 }]) {
    await target.focus();
    expect(await dispatchKey(target, 'Escape', variant)).toBe(false);
    await expect(dialog).toBeVisible();
    await expect(target).toBeFocused();
  }
}
async function traversalBoundaries(page: Page, first: Locator, last: Locator) {
  for (const variant of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { altGraph: true }]) {
    await last.focus();
    expect(await dispatchKey(last, 'Tab', variant)).toBe(false);
    await expect(last).toBeFocused();
    await first.focus();
    expect(await dispatchKey(first, 'Tab', { ...variant, shiftKey: true })).toBe(false);
    await expect(first).toBeFocused();
  }
  await last.focus(); await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
}
function noEdits(before: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(before);
  // Native preview rendering uses POST without changing project or profile data.
  expect(state.requests.filter((request) => !['GET', 'HEAD'].includes(request.method)
    && !(request.method === 'POST' && request.path === '/api/video-export/landscape/preview'))).toHaveLength(0);
  expect(keyRemovals).toBe(0);
}

for (const width of [1440, 390]) test('Settings key boundaries ' + width, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const before = structuredClone(state.projects[0].captions);
  await openProject(page);
  await openSettings(page);
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
  const field = settings(page).getByLabel('Key terms for all projects', { exact: true });
  const first = settings(page).getByRole('button', { name: 'Close settings', exact: true });
  // The interface-language field is the Profile tab's final control (Wave 3a).
  const last = settings(page).getByRole('group', { name: 'Language', exact: true }).getByRole('button', { name: 'ខ្មែរ', exact: true });
  await field.fill('Draft កម្ពុជា');
  await ignoredEscape(field, settings(page));
  await traversalBoundaries(page, first, last);
  await field.focus(); await field.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeVisible(); await expect(field).toBeFocused(); await expect(field).toHaveValue('Draft កម្ពុជា');
  await page.screenshot({ path: info.outputPath('settings-compose-' + width + '.png'), animations: 'disabled' });
  await field.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  await openSettings(page);
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
  await field.focus(); await field.dispatchEvent('compositionstart');
  // Moving away clears a composition even if its end event is omitted.
  await last.focus(); await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  noEdits(before);
});

for (const width of [1440, 390]) test('Find key boundaries ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const before = structuredClone(state.projects[0].captions);
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.focus(); await page.keyboard.press('Control+f');
  const dialog = findDialog(page);
  const field = dialog.getByLabel('Find', { exact: true });
  await expect(field).toBeFocused();
  await field.fill('No matching draft កម្ពុជា');
  await ignoredEscape(field, dialog);
  await traversalBoundaries(page,
    dialog.getByRole('button', { name: 'Close find and correct', exact: true }),
    dialog.getByRole('button', { name: 'Cancel', exact: true }));
  await field.focus(); await field.dispatchEvent('compositionstart'); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible(); await expect(field).toBeFocused(); await expect(field).toHaveValue('No matching draft កម្ពុជា');
  await field.dispatchEvent('compositionend'); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(caption).toBeFocused();
  await page.keyboard.press('Control+f'); await expect(dialog).toBeVisible();
  await field.focus(); await field.dispatchEvent('compositionstart');
  await dialog.getByLabel('Replace with', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(caption).toBeFocused();
  noEdits(before);
});

for (const width of [1440, 390]) test('Nested confirmation keys ' + width, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const before = structuredClone(state.projects[0].captions);
  await openProject(page); await openSettings(page);
  await keyInput(page).fill('synthetic-unsaved-replacement');
  await keyInput(page).dispatchEvent('compositionstart');
  await forget(page).click();
  const dialog = confirmation(page);
  await expect(dialog).toBeVisible();
  // Clear the app-wide composition signal; the parent hook already saw focus leave.
  await keyInput(page).dispatchEvent('compositionend');
  const cancel = dialog.locator('.studio-confirm-cancel');
  await expect(cancel).toBeFocused();
  await ignoredEscape(cancel, dialog);
  await traversalBoundaries(page, dialog.locator('.studio-confirm-close'),
    dialog.getByRole('button', { name: 'Forget saved key', exact: true }));
  await page.screenshot({ path: info.outputPath('confirm-keys-' + width + '.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings(page)).toBeVisible(); await expect(forget(page)).toBeFocused();
  await expect(keyInput(page)).toHaveValue('synthetic-unsaved-replacement');
  await forget(page).press('Enter'); await expect(dialog).toBeVisible(); await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0); await expect(forget(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
  noEdits(before);
});
