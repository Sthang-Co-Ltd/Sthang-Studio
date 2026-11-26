import { expect, test } from '@playwright/test';
import type { CorrectionEvent } from '../../packages/shared/src/index.js';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('English project tools preserve their existing copy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = 'en';
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
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  const accuracy = page.locator('.accuracy-card');
  await expect(accuracy.getByLabel('What is this video about?', { exact: true })).toBeVisible();
  await accuracy.locator('.generation-options > summary').click();
  await expect(accuracy.getByText('Caption model', { exact: true })).toBeVisible();

  await page.locator('.workspace-tool-strip').getByRole('button', { name: 'Caption grouping', exact: true }).click();
  await expect(page.locator('.controls-card').getByRole('button', { name: 'Apply grouping', exact: true })).toBeVisible();

  const openTool = async (tool: string) => {
    await page.locator('[data-project-tools-trigger]').click();
    await page.getByRole('menu', { name: en.editor.tools.menu }).getByText(tool, { exact: true }).click();
  };
  await openTool(en.editor.tools.technical);
  await expect(page.locator('.timing-card')).toContainText('Studio used compatibility transcription without Accuracy recognition hints. Review ambiguous names.');

  for (const [tool, dialog, copy, close] of [
    [en.editor.tools.activity, 'Activity', 'No jobs yet.', 'Close Activity'],
    [en.editor.tools.history, 'Project history', 'History appears after a meaningful edit or automatic change.', 'Close history'],
    [en.editor.tools.correct, 'Correct everywhere', 'Preview every occurrence. Locked text stays unchanged.', 'Close find and correct'],
    [en.editor.tools.corrections, 'Correction inbox', 'Suggested memory', 'Close correction inbox'],
    [en.editor.tools.updates, 'Updates', 'Signed releases. You choose when to install.', 'Close updates'],
  ]) {
    await openTool(tool);
    const sheet = page.getByRole('dialog', { name: dialog, exact: true });
    await expect(sheet.getByText(copy, { exact: true })).toBeVisible();
    if (tool === en.editor.tools.corrections) {
      await expect(sheet.locator('.correction-meta b')).toHaveText(legacySuggestion);
      await expect(sheet.locator('.decision-label')).toHaveText(legacyDecision);
    }
    await sheet.getByRole('button', { name: close, exact: true }).click();
  }

  await openTool(en.editor.tools.guide);
  const guide = page.getByRole('complementary', { name: 'Sthang Studio guide', exact: true });
  await expect(guide.getByText('Caption workflow', { exact: true })).toBeVisible();
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click();

  await page.getByRole('button', { name: en.editor.header.back, exact: true }).click();
  await page.getByRole('button', { name: en.home.launcher.allProjects, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All projects', exact: true })).toBeVisible();
  const more = page.locator('[data-library-more]').first();
  await more.click();
  await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recently deleted', exact: true }).click();
  await expect(page.getByText('Nothing in Recently deleted.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: en.home.launcher.settings, exact: true }).click();
  await page.getByRole('button', { name: 'System check', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved project storage', exact: true }).getByRole('status'))
    .toHaveText('Storage check complete. 2 loaded in this session · 2 readable project files at last check');
  expect(errors).toEqual([]);
});
