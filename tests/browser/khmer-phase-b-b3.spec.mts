import { expect, test } from '@playwright/test';
import type { CorrectionEvent } from '../../packages/shared/src/index.js';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

for (const locale of ['en', 'km'] as const) test('Project tools render catalog copy (' + locale + ')', async ({ page }) => {
  const messages = locale === 'km' ? km : en;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = locale;
  const project = state.projects[0];
  if (!project.transcript) throw new Error('Expected a fixture transcript.');
  project.transcript.contextMode = 'audio-only';
  // Older saved profiles can carry codes outside the current enum.
  const legacySuggestion: string = 'constructor';
  const legacyDecision: string = 'toString';
  state.profile.correctionEvents = [{
    id: 'legacy-correction', projectId: project.id, projectTitle: project.title, captionId: project.captions[0].id,
    startMs: 0, endMs: 500, originalText: 'Before edit', correctedText: 'After edit',
    suggestionKind: legacySuggestion as CorrectionEvent['suggestionKind'], suggestedVocabularyLine: 'After edit',
    status: legacyDecision as CorrectionEvent['status'], createdAt: '2026-01-01T00:00:00.000Z',
  }];

  const viteHost = new URL(requireHarnessConfig().webOrigin).host;
  await page.routeWebSocket((url) => url.protocol === 'ws:' && url.host === viteHost && url.pathname === '/', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
  });
  await page.route('**/api/updates', (route) => route.fulfill({ json: { status: 'up-to-date', currentVersion: '0.90.0' } }));
  await page.route('**/api/project-bin', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/media-preview/*', (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source');
    if (route.request().method() !== 'GET' || !state.projects.some((item) =>
      url.pathname === '/api/media-preview/' + item.id && source === item.media.filename)) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });

  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);

  await page.getByRole('button', { name: en.workspace.accuracy, exact: true }).click();
  const accuracy = page.locator('.accuracy-card');
  await expect(accuracy.getByLabel(messages.accuracy.description, { exact: true })).toBeVisible();
  await accuracy.locator('.generation-options > summary').click();
  await expect(accuracy.getByText(messages.accuracy.captionModel, { exact: true })).toBeVisible();

  await page.locator('.workspace-tool-strip').getByRole('button', { name: messages.grouping.title, exact: true }).click();
  await expect(page.locator('.controls-card').getByRole('button', { name: messages.grouping.apply, exact: true })).toBeVisible();

  const openTool = async (tool: string) => {
    await page.locator('[data-project-tools-trigger]').click();
    await page.getByRole('menu', { name: messages.editor.tools.menu }).getByText(tool, { exact: true }).click();
  };
  await openTool(messages.editor.tools.technical);
  await expect(page.locator('.timing-card')).toContainText(messages.details.compatibilityAudioOnly);

  for (const [tool, dialog, copy, close] of [
    [messages.editor.tools.activity, messages.activity.title, messages.activity.empty, messages.activity.close],
    [messages.editor.tools.history, messages.history.title, messages.history.empty, messages.history.close],
    [messages.editor.tools.correct, messages.find.title, messages.find.help, messages.find.closeLabel],
    [messages.editor.tools.corrections, messages.inbox.title, messages.inbox.suggestion, messages.inbox.close],
    [messages.editor.tools.updates, messages.updates.title, messages.updates.help, messages.updates.close],
  ]) {
    await openTool(tool);
    const sheet = page.getByRole('dialog', { name: dialog, exact: true });
    await expect(sheet.getByText(copy, { exact: true })).toBeVisible();
    if (tool === messages.editor.tools.corrections) {
      await expect(sheet.locator('.correction-meta b')).toHaveText(legacySuggestion);
      await expect(sheet.locator('.decision-label')).toHaveText(legacyDecision);
    }
    await sheet.getByRole('button', { name: close, exact: true }).click();
  }

  await openTool(messages.editor.tools.guide);
  const guide = page.getByRole('complementary', { name: messages.guide.label, exact: true });
  await expect(guide.getByText(messages.guide.workflow, { exact: true })).toBeVisible();
  await guide.getByRole('button', { name: messages.guide.close, exact: true }).click();

  await page.getByRole('button', { name: messages.editor.header.back, exact: true }).click();
  await page.getByRole('button', { name: messages.home.launcher.allProjects, exact: true }).click();
  await expect(page.getByRole('heading', { name: messages.library.title, exact: true })).toBeVisible();
  const more = page.locator('[data-library-more]').first();
  await more.click();
  await expect(page.getByRole('menuitem', { name: messages.library.rename, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: messages.library.recentlyDeleted, exact: true }).click();
  await expect(page.getByText(messages.library.binEmpty, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: messages.home.launcher.settings, exact: true }).click();
  await page.getByRole('button', { name: 'System check', exact: true }).click();
  await expect(page.getByRole('region', { name: messages.library.storageLabel, exact: true }).getByRole('status'))
    .toHaveText(messages.library.storageCompleted.replace('{loaded}', '2').replace('{readable}', '2'));
  expect(errors).toEqual([]);
});
