import { expect, test as base } from '@playwright/test';
import { appearance, cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('Appearance and Fine timing render their English fallback in a Khmer profile', async ({ page }) => {
  const errors: string[] = [];
  const withoutUrls = (message: string) => message.replace(/\b(?:https?|wss?):\/\/[^\s'"]+/g, '[url]');
  page.on('pageerror', (error) => errors.push(withoutUrls(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(withoutUrls(message.text()));
  });
  const state = await installFixture(page);
  // Use the owned frontend and synthetic startup responses from the interface-language smoke test.
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
  state.projects[0].captionAppearance = { ...appearance, highlightMode: 'word' };
  state.fonts.push(...Array.from({ length: 25 }, (_, index) => ({
    name: `Fixture Khmer ${index + 1}`,
    source: 'user-installed' as const,
    available: true,
    boldAvailable: true,
  })));

  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  await page.locator('.stage-rail [data-stage="appearance"]').click();
  const workspace = page.locator('.caption-appearance-workspace');
  await expect(workspace).toHaveAccessibleName('Caption appearance');
  await expect(workspace.locator('.appearance-look-current')).toHaveText('Current look Clean');
  await expect(workspace.locator('.appearance-number-control').getByRole('spinbutton', { name: 'Exact size' })).toBeVisible();
  await expect(workspace.locator('.appearance-font-search')).toHaveAttribute('placeholder', 'Find among 27 installed Khmer fonts…');
  await expect(workspace.locator('.word-highlight-preparation')).toHaveAccessibleName('Word highlight results');

  await page.locator('.stage-rail [data-stage="captions"]').click();
  await page.locator('.workspace-tool-strip').getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.fine-timing')).toHaveAccessibleName('Fine timing editor');
  const waveform = page.locator('.timing-waveform-surface');
  await expect(waveform.getByRole('button', { name: 'Caption edges', exact: true })).toBeVisible();
  await waveform.getByRole('button', { name: 'Word timing', exact: true }).click();
  const words = page.locator('.word-timing-panel');
  await expect(words).toHaveAccessibleName('Word timing controls');
  await expect(words.getByRole('button', { name: 'Sync words', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
