import { expect, test as base } from '@playwright/test';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { appearance, cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

for (const locale of ['en', 'km'] as const) test('Appearance and Fine timing render catalog copy (' + locale + ')', async ({ page }) => {
  const messages = locale === 'km' ? km : en;
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
  state.profile.preferences.interfaceLanguage = locale;
  state.projects[0].captionAppearance = { ...appearance, highlightMode: 'word' };
  state.fonts.push(...Array.from({ length: 25 }, (_, index) => ({
    name: `Fixture Khmer ${index + 1}`,
    source: 'user-installed' as const,
    available: true,
    boldAvailable: true,
  })));

  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await page.locator('.stage-rail [data-stage="appearance"]').click();
  const workspace = page.locator('.caption-appearance-workspace');
  await expect(workspace).toHaveAccessibleName(messages.appearance.workspace.title);
  await expect(workspace.locator('.appearance-look-current')).toHaveText(messages.appearance.looks.current.replace('<b>{look}</b>', 'Clean'));
  await expect(workspace.locator('.appearance-number-control').getByRole('spinbutton', { name: messages.appearance.range.exact.replace('{label}', messages.appearance.workspace.size.toLocaleLowerCase('en')) })).toBeVisible();
  await expect(workspace.locator('.appearance-font-search')).toHaveAttribute('placeholder', messages.appearance.fontSearch.placeholder.replace('{count}', '27'));
  await expect(workspace.locator('.word-highlight-preparation')).toHaveAccessibleName(messages.appearance.highlight.results);

  await page.locator('.stage-rail [data-stage="captions"]').click();
  await page.locator('.workspace-tool-strip').getByRole('button', { name: en.workspace.fineTiming, exact: true }).click();
  await expect(page.locator('.fine-timing')).toHaveAccessibleName(messages.timing.waveform.title);
  const waveform = page.locator('.timing-waveform-surface');
  await expect(waveform.getByRole('button', { name: messages.timing.waveform.captionEdges, exact: true })).toBeVisible();
  await waveform.getByRole('button', { name: messages.timing.waveform.wordTiming, exact: true }).click();
  const words = page.locator('.word-timing-panel');
  await expect(words).toHaveAccessibleName(messages.timing.words.controls);
  await expect(words.getByRole('button', { name: messages.timing.words.sync, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
