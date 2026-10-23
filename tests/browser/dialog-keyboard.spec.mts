import { test, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.addInitScript(() => sessionStorage.setItem('sthang:updates-checked:v1', '1'));
  await page.route('**/api/updates', (route) => route.fulfill({ json: { status: 'unconfigured', currentVersion: 'test', supported: false, message: 'Synthetic fixture' } }));
});
async function openTool(page: Page, name: RegExp) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}
async function expectTrapped(page: Page, dialog: Locator) {
  for (const key of ['Tab', 'Shift+Tab']) for (let index = 0; index < 24; index++) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
}

for (const [menu, name] of [
  [/Correct everywhere/, 'Find & Correct Everywhere'], [/^History/, 'Project history'],
  [/Processing jobs/, 'Activity'], [/Correction inbox/, 'Correction Inbox'], [/^Settings/, 'Settings'],
  [/Check for updates/, 'Studio updates'],
] as const) test(`${name} traps both Tab directions, isolates playback shortcuts and restores its opener`, async ({ page }, info) => {
  await openProject(page); await openTool(page, menu);
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expectTrapped(page, dialog);
  // An attempted focus escape must be redirected back into the active surface.
  await page.getByLabel('Caption 1 text', { exact: true }).focus();
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const position = await page.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime);
  await page.keyboard.press('r');
  expect(await page.locator('video').evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(position);
  expect(await page.locator('video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  if (name === 'Settings') await page.screenshot({ path: info.outputPath('settings-focus-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
});

test('Find preserves native field keys and composition Escape, then restores the original caption field', async ({ page }) => {
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true }); await caption.focus();
  await page.keyboard.press('Control+f');
  const dialog = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  await expect(dialog.getByLabel('Find', { exact: true })).toBeFocused();
  await dialog.getByLabel('Find', { exact: true }).evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })));
  await expect(dialog).toBeVisible();
  const match = dialog.locator('label:has-text("Match") select');
  await match.focus(); await match.press('ArrowDown');
  await expect(match).toHaveValue('case-insensitive'); await expect(dialog).toBeVisible();
  await dialog.getByLabel('Find', { exact: true }).focus();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(caption).toBeFocused();
});

test('busy Updates cannot dismiss, leak keys, or gain install/download authority', async ({ page }) => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const methods: string[] = [];
  await page.route(/\/api\/updates(?:\/.*)?$/, async (route) => {
    methods.push(route.request().method()); enter(); await gate;
    await route.fulfill({ json: { status: 'unconfigured', currentVersion: 'test', supported: false, message: 'Synthetic fixture' } });
  });
  try {
    await openProject(page); await openTool(page, /Check for updates/); await entered;
    const dialog = page.getByRole('dialog', { name: 'Studio updates', exact: true });
    await expect(dialog.getByRole('button', { name: 'Close updates' })).toBeDisabled();
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    release(); await expect(dialog.getByRole('button', { name: 'Close updates' })).toBeEnabled();
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    expect(methods).toEqual(['GET']);
  } finally { release(); }
});

test('privacy introduction shares containment and Escape keeps both consents unset', async ({ page }, info) => {
  state.profile.preferences.khmerContributionConsent = 'unset'; state.profile.preferences.analyticsConsent = 'unset';
  state.profile.preferences.privacyUpgradeNoticeVersion = undefined;
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: { consent: 'unset', endpointConfigured: true, contributorEnrolled: false, queued: 0, submitted: 0, verified: 0, rejected: 0, withdrawn: 0, verifiedAudioMs: 0, withdrawalPending: false } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Help make Khmer captions world-class', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element === document.activeElement)).toBe(true);
  await expectTrapped(page, dialog);
  await page.screenshot({ path: info.outputPath('privacy-focus-mobile.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.profile.preferences.khmerContributionConsent).toBe('unset');
  expect(state.profile.preferences.analyticsConsent).toBe('unset');
});
