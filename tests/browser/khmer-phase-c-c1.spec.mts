import { expect, test as base, type Page } from '@playwright/test';
import type { SystemDoctorReport } from '@kcs/shared';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
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

test('Settings, Profile, Privacy and System check use the English fallback in Khmer mode', async ({ page, errors }) => {
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
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('group', { name: 'Settings sections' })).toBeVisible();

  await settings.getByRole('button', { name: 'AI connection', exact: true }).click();
  const storageLabel = settings.locator('.secure-storage-note strong');
  await expect(storageLabel).toHaveText(storage);
  await expect(settings.locator('.secure-storage-note [data-server-text]')).toHaveCount(0);
  await expect(settings.locator('.ai-connection-copy span')).toContainText(storage);
  await expect(settings.locator('.ai-connection-copy [data-server-text]')).toHaveCount(0);

  await settings.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(settings.getByLabel('Key terms for all projects', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Import profile', exact: true })).toBeVisible();
  await expect(settings.getByText('1 term · Sample description', { exact: true })).toBeVisible();

  await settings.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(settings.getByText('Privacy & contribution', { exact: true })).toBeVisible();
  await expect(settings.getByText('Optional product analytics', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Keep my work private', exact: true })).toBeVisible();

  await settings.getByRole('button', { name: 'System check', exact: true }).click();
  await expect(settings.getByText('No report yet', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Run checks', exact: true }).click();
  await expect(settings.getByText('Ready with warnings', { exact: true })).toBeVisible();
  const checks = settings.locator('.doctor-checks');
  await expect(checks.locator('strong:not([data-server-text])')).toHaveText(['Python timing runtime', 'AI credential storage']);
  await expect(checks.locator('em:not([data-server-text])')).toHaveText(fix);
  await expect(checks.locator('span[data-server-text]')).toHaveText(['Synthetic timing detail', storage, 'New server detail']);
  await expect(checks.locator('strong[data-server-text]')).toHaveText('New server label');
  await expect(checks.locator('em[data-server-text]')).toHaveText('New server fix');
  expect(errors).toEqual([]);
});

test('the privacy upgrade and review show English fallback in Khmer mode', async ({ page, errors }) => {
  const state = await installKhmerFixture(page);
  state.profile.preferences.khmerContributionConsent = 'unset';
  state.profile.preferences.privacyUpgradeNoticeVersion = undefined;
  await page.route('**/api/contribution/status', (route) => route.fulfill({ json: contributionStatus }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  const upgrade = page.getByRole('dialog', { name: 'Help make Khmer captions world-class', exact: true });
  await expect(upgrade.getByText('Product analytics is separate', { exact: true })).toBeVisible();
  await upgrade.getByRole('button', { name: 'Review privacy & analytics settings', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Privacy choices', exact: true });
  await expect(review.getByText('Optional product analytics', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Help improve Khmer captions', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the contribution invitation shows English fallback in Khmer mode', async ({ page, errors }) => {
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
  const invitation = page.getByRole('complementary', { name: 'Khmer Caption Contributor invitation', exact: true });
  await expect(invitation.getByText('Help make Khmer captions world-class', { exact: true })).toBeVisible();
  await expect(invitation.locator('b')).toHaveText('after joining');
  await expect(invitation.getByRole('button', { name: 'Help improve Khmer', exact: true })).toBeVisible();
  await invitation.getByRole('button', { name: 'Dismiss for this session', exact: true }).click();
  await expect(invitation).toHaveCount(0);
  expect(errors).toEqual([]);
});
