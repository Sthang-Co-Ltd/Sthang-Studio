import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let requests: Array<{ path: string; method: string; body: any }>;
const notice = (page: Page) => page.getByRole('dialog', { name: 'Help make Khmer captions world-class', exact: true });
const writes = () => requests.filter((request) => request.path === '/api/profile' && request.method === 'PATCH');
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.analyticsConsent = 'unset';
  state.profile.preferences.khmerContributionConsent = 'unset';
  state.profile.preferences.privacyUpgradeNoticeVersion = undefined;
  requests = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path !== '/api/profile' && !path.startsWith('/api/contribution/')) return;
    requests.push({ path, method: request.method(), body: request.method() === 'PATCH' ? request.postDataJSON() : null });
  });
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: {
    consent: 'unset', endpointConfigured: true, contributorEnrolled: false, queued: 0, submitted: 0,
    verified: 0, rejected: 0, withdrawn: 0, verifiedAudioMs: 0, withdrawalPending: false,
  } }));
});
async function openNotice(page: Page) {
  await page.goto('/');
  await expect(notice(page)).toBeVisible();
}
function unchangedChoices() {
  expect(state.profile.preferences.khmerContributionConsent).toBe('unset');
  expect(state.profile.preferences.analyticsConsent).toBe('unset');
  expect(requests.filter((request) => request.path.startsWith('/api/contribution/')).every((request) => request.method === 'GET')).toBe(true);
}

for (const failedMethod of ['GET', 'PATCH'] as const) for (const action of ['Not now', 'Escape'] as const) {
  test('notice ' + action + ' survives ' + failedMethod + ' failure', async ({ page }, info) => {
    await page.setViewportSize({ width: action === 'Escape' ? 390 : 1440, height: 1000 });
    await openNotice(page);
    const gate = deferred();
    let held = 0;
    await page.route('**/api/profile', async (route) => {
      if (route.request().method() !== failedMethod) return route.fallback();
      held++; await gate.promise;
      return route.fulfill({ status: 503, json: { error: 'Synthetic optional notice failure' } });
    });
    try {
      if (action === 'Escape') await page.keyboard.press('Escape');
      else await notice(page).getByRole('button', { name: 'Not now', exact: true }).click();
      await expect.poll(() => held).toBe(1);
      await expect(notice(page)).toBeVisible();
      await expect(notice(page).getByRole('button', { name: 'Not now', exact: true })).toBeDisabled();
      unchangedChoices();
      if (failedMethod === 'PATCH' && action === 'Escape') {
        await page.screenshot({ path: info.outputPath('notice-marker-pending-390.png'), animations: 'disabled' });
      }
      gate.release();
      await expect(notice(page)).toHaveCount(0);
      unchangedChoices();
      expect(state.profile.preferences.privacyUpgradeNoticeVersion).toBeUndefined();
      expect(writes()).toHaveLength(failedMethod === 'PATCH' ? 1 : 0);
      if (failedMethod === 'PATCH') expect(writes()[0].body.preferences).toMatchObject({
        privacyUpgradeNoticeVersion: '0.8', analyticsConsent: 'unset', khmerContributionConsent: 'unset',
      });
      // The failed optional marker cannot keep the editor behind a focus trap.
      await page.getByRole('button', { name: /Audit landscape/ }).click();
      await expect(page.locator('.media-stage video')).toBeVisible();
      if (failedMethod === 'PATCH' && action === 'Escape') {
        await page.screenshot({ path: info.outputPath('notice-dismissed-editor-390.png'), animations: 'disabled' });
      }
    } finally { gate.release(); }
  });
}

test('notice dismissal saves its marker only', async ({ page }) => {
  await openNotice(page);
  const gate = deferred();
  let held = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    held = true; await gate.promise;
    return route.fallback();
  });
  try {
    await notice(page).getByRole('button', { name: 'Not now', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await expect(notice(page)).toBeVisible();
    unchangedChoices();
    gate.release();
    await expect(notice(page)).toHaveCount(0);
    expect(writes()).toHaveLength(1);
    expect(state.profile.preferences.privacyUpgradeNoticeVersion).toBe('0.8');
    unchangedChoices();
    expect(writes()[0].body.preferences).toMatchObject({
      privacyUpgradeNoticeVersion: '0.8', analyticsConsent: 'unset', khmerContributionConsent: 'unset',
    });
  } finally { gate.release(); }
});

test('notice choice and review failures remain retryable', async ({ page }) => {
  await openNotice(page);
  let fail = true;
  await page.route('**/api/profile', (route) => {
    if (route.request().method() !== 'PATCH' || !fail) return route.fallback();
    const granted = route.request().postDataJSON().preferences.khmerContributionConsent === 'granted';
    return route.fulfill({ status: 503, json: { error: granted ? 'Synthetic consent save failure' : 'Synthetic notice review failure' } });
  });
  await notice(page).getByRole('button', { name: 'Help improve Khmer captions', exact: true }).click();
  await expect(notice(page).getByRole('alert')).toHaveText('Synthetic consent save failure');
  await expect(notice(page)).toBeVisible();
  await expect(notice(page).getByRole('button', { name: 'Help improve Khmer captions', exact: true })).toBeEnabled();
  unchangedChoices();
  expect(state.profile.preferences.privacyUpgradeNoticeVersion).toBeUndefined();
  await notice(page).getByRole('button', { name: 'Review privacy & analytics settings', exact: true }).click();
  await expect(notice(page).getByRole('alert')).toHaveText('Synthetic notice review failure');
  await expect(notice(page)).toBeVisible();
  unchangedChoices();
  fail = false;
  await notice(page).getByRole('button', { name: 'Help improve Khmer captions', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(writes()).toHaveLength(3);
  expect(state.profile.preferences.khmerContributionConsent).toBe('granted');
  expect(state.profile.preferences.analyticsConsent).toBe('unset');
  expect(state.profile.preferences.privacyUpgradeNoticeVersion).toBe('0.8');
  expect(requests.filter((request) => request.path.startsWith('/api/contribution/')).every((request) => request.method === 'GET')).toBe(true);
});
