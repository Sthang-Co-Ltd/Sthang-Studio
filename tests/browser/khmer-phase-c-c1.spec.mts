import { expect, test as base, type Page } from '@playwright/test';
import type { SystemDoctorReport } from '@kcs/shared';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { translatePlural } from '../../apps/web/src/i18n/translate.js';
import { cleanFixtures, installFixture, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend<{ errors: string[] }>({
  context: async ({ context }, use) => {
    try { await use(context); } finally { await closeOwnedBrowserContext(context); }
  },
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const viteHost = new URL(requireHarnessConfig().webOrigin).host;
    await page.routeWebSocket((url) => url.protocol === 'ws:' && url.host === viteHost && url.pathname === '/', (socket) => {
      socket.send(JSON.stringify({ type: 'connected' }));
    });
    await use(errors);
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

async function installKhmerFixture(page: Page) {
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = 'km';
  await page.route('**/api/updates', (route) => route.fulfill({ json: { status: 'up-to-date', currentVersion: '0.90.0' } }));
  return state;
}

const contributionStatus = {
  consent: 'unset', endpointConfigured: true, contributorEnrolled: false, queued: 0, submitted: 0,
  verified: 0, rejected: 0, withdrawn: 0, verifiedAudioMs: 0, withdrawalPending: false,
};

test('Settings, Profile, Privacy and System check use the Khmer catalog', async ({ page, errors }) => {
  const state = await installKhmerFixture(page);
  state.profile.topicPacks = [{
    id: 'sample-pack', name: 'ព័ត៌មាន', description: 'Sample description', vocabulary: ['សៀមរាប'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  const storage = 'Windows user-protected storage (DPAPI)';
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: {
    provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: '••••',
    model: 'synthetic', fallbackModel: '', secureStorageAvailable: true, secureStorageLabel: storage,
    environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null,
  } }));
  const fix = 'Run Install Sthang Studio.bat again from your download, or run setup-local-timing-windows.bat in the Studio folder. Then run the System check again.';
  const report: SystemDoctorReport = {
    generatedAt: '2026-01-01T00:00:00.000Z', engineVersion: 'synthetic', overall: 'warning',
    environment: { platform: 'win32 x64', node: 'synthetic', appRoot: 'Synthetic app', apiPort: 1, webOrigin: 'http://127.0.0.1' },
    checks: [
      { id: 'python', label: 'Python timing runtime', status: 'warning', detail: 'Synthetic timing detail', fix },
      { id: 'gemini-storage', label: 'AI credential storage', status: 'ok', detail: storage },
      { id: 'future-check', label: 'New server label', status: 'warning', detail: 'New server detail', fix: 'New server fix' },
    ],
  };
  await page.route('**/api/system/doctor', (route) => route.fulfill({ json: report }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  await page.getByRole('button', { name: km.home.launcher.settings, exact: true }).click();
  const settings = page.getByRole('dialog', { name: km.settings.title, exact: true });
  await expect(settings.getByRole('group', { name: km.settings.sections })).toBeVisible();

  await settings.getByRole('button', { name: km.settings.tabs.ai, exact: true }).click();
  const storageLabel = settings.locator('.secure-storage-note strong');
  await expect(storageLabel).toHaveText(km.settings.secureStorage.win32);
  await expect(settings.locator('.secure-storage-note [data-server-text]')).toHaveCount(0);
  await expect(settings.locator('.ai-connection-copy span')).toContainText(km.settings.secureStorage.win32);
  await expect(settings.locator('.ai-connection-copy [data-server-text]')).toHaveCount(0);

  await settings.getByRole('button', { name: km.settings.tabs.profile, exact: true }).click();
  await expect(settings.getByLabel(km.settings.glossary.label, { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: km.settings.profileImport.open, exact: true })).toBeVisible();
  await expect(settings.getByText(translatePlural('km', 'settings.packs.summary', 1,
    { description: state.profile.topicPacks[0].description }), { exact: true })).toBeVisible();

  await settings.getByRole('button', { name: km.settings.tabs.privacy, exact: true }).click();
  await expect(settings.getByText(km.privacy.title, { exact: true })).toBeVisible();
  await expect(settings.getByText(km.privacy.analytics.title, { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: km.privacy.keepPrivate, exact: true })).toBeVisible();

  await settings.getByRole('button', { name: km.settings.tabs.doctor, exact: true }).click();
  await expect(settings.getByText(km.system.empty, { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: km.system.run, exact: true }).click();
  await expect(settings.getByText(km.system.overall.warning, { exact: true })).toBeVisible();
  const checks = settings.locator('.doctor-checks');
  await expect(checks.locator('strong:not([data-server-text])')).toHaveText([km.system.check.python, km.system.check['gemini-storage']]);
  await expect(checks.locator('em:not([data-server-text])')).toHaveText(km.system.timingFix.win32);
  await expect(checks.locator('span[data-server-text]')).toHaveText(['Synthetic timing detail', storage, 'New server detail']);
  await expect(checks.locator('strong[data-server-text]')).toHaveText('New server label');
  await expect(checks.locator('em[data-server-text]')).toHaveText('New server fix');
  expect(errors).toEqual([]);
});

test('the privacy upgrade and review show Khmer catalog copy', async ({ page, errors }) => {
  const state = await installKhmerFixture(page);
  state.profile.preferences.khmerContributionConsent = 'unset';
  state.profile.preferences.privacyUpgradeNoticeVersion = undefined;
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: contributionStatus }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  const upgrade = page.getByRole('dialog', { name: km.privacy.promptTitle, exact: true });
  await expect(upgrade.getByText(km.privacy.upgrade.analyticsSeparate, { exact: true })).toBeVisible();
  await upgrade.getByRole('button', { name: km.privacy.upgrade.review, exact: true }).click();
  const review = page.getByRole('dialog', { name: km.privacy.upgrade.reviewTitle, exact: true });
  await expect(review.getByText(km.privacy.analytics.title, { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: km.privacy.helpImprove, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the contribution invitation shows Khmer catalog copy', async ({ page, errors }) => {
  const state = await installKhmerFixture(page);
  state.profile.preferences.khmerContributionConsent = 'unset';
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: contributionStatus }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  // Exercise the host's existing legacy SRT-link listener without exporting media.
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/api/projects/synthetic/export.srt';
    link.addEventListener('click', (event) => event.preventDefault());
    document.body.append(link);
    link.click();
    link.remove();
  });
  const invitation = page.getByRole('complementary', { name: km.privacy.invitation.label, exact: true });
  await expect(invitation.getByText(km.privacy.promptTitle, { exact: true })).toBeVisible();
  const bold = /<b>([^<]+)<\/b>/.exec(km.privacy.invitation.detail);
  expect(bold).not.toBeNull();
  await expect(invitation.locator('b')).toHaveText(bold![1]);
  await expect(invitation.getByRole('button', { name: km.privacy.invitation.join, exact: true })).toBeVisible();
  await invitation.getByRole('button', { name: km.privacy.invitation.dismiss, exact: true }).click();
  await expect(invitation).toHaveCount(0);
  expect(errors).toEqual([]);
});
