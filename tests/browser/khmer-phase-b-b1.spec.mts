import { test as base, expect } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, type RegenerationProposal } from '@kcs/shared';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

for (const locale of ['en', 'km'] as const) test('Export, restore, repair and Compare render catalog copy (' + locale + ')', async ({ page }) => {
  const messages = locale === 'km' ? km : en;
  test.setTimeout(60_000);
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = locale;
  const project = state.projects[0];
  project.mediaAlignment = { state: 'unverified-audio-change', acceptedAt: project.updatedAt, sourceRevision: project.updatedAt };
  // The Vite client still opens a socket with HMR disabled in the owned harness.
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
    if (route.request().method() !== 'GET' || url.pathname !== `/api/media-preview/${project.id}`
      || source !== project.media.filename) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });

  const current = project.captions[0];
  const proposed = { ...current, text: 'សំណើថ្មី' };
  const proposal: RegenerationProposal = {
    id: 'b1-compare-proposal', projectId: project.id, projectTitle: project.title,
    createdAt: '2026-01-01', expiresAt: '2099-01-01', startMs: current.startMs, endMs: current.endMs,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard',
    currentCaptions: [current], proposedCaptions: [proposed], changes: [],
  };
  state.jobs = [{
    id: 'b1-compare-job', type: 'regenerate-range', projectId: project.id, projectTitle: project.title,
    status: 'completed', stage: 'complete', progress: 100, message: 'Synthetic comparison ready', canResume: false,
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, proposalId: proposal.id,
  }];
  await page.route(`**/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));

  const candidate = createCaptionData({ captions: [proposed] });
  const revision = 'a'.repeat(64);
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/caption-handoff/*/summary', (route) => route.fulfill({
    json: { revision, captionCount: project.captions.length, media: project.media,
      snapshot: createCaptionData({ captions: hydrateCaptionWordTimings(project).captions }) },
  }));
  await page.route('**/api/caption-handoff/*/restore-preview', (route) => route.fulfill({
    json: { revision, candidate, candidateDigest: 'b'.repeat(64), warnings: [] },
  }));

  const errors: string[] = [];
  const withoutUrls = (message: string) => message.replace(/\b(?:https?|wss?):\/\/[^\s'"]+/g, '[URL]');
  page.on('console', (message) => { if (message.type() === 'error') errors.push(withoutUrls(message.text())); });
  page.on('pageerror', (error) => errors.push(withoutUrls(error.message)));

  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('.media-alignment-notice strong')).toHaveText(messages.export.repair.alignmentNotice.match(/<b>(.*?)<\/b>/)![1]);

  await page.locator('[data-stage="export"]').click();
  const workspace = page.locator('.export-workspace');
  await expect(workspace.getByRole('button', { name: messages.export.workspace.render, exact: true })).toBeVisible();
  const checks = workspace.getByRole('region', { name: messages.export.checks.title, exact: true });
  await expect(checks).toBeVisible();

  const history = workspace.locator('.export-history');
  await history.locator('summary').click();
  await expect(history.getByText(messages.export.history.empty)).toBeVisible();

  await workspace.locator('.export-mode-switch button').filter({ hasText: messages.export.workspace.captions }).click();
  const handoff = workspace.locator('.caption-handoff-panel');
  await expect(handoff.getByText(messages.export.destinations['capcut-desktop'].step2.replace(/<\/?(?:b|code)>/g, ''))).toBeVisible();
  await handoff.locator('.handoff-advanced > summary').click();
  await handoff.locator('input[type="file"]').setInputFiles({
    name: 'synthetic.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await expect(workspace.locator('.caption-restore-review').getByRole('heading')).toHaveText(messages.export.restore.title);
  await workspace.getByRole('button', { name: messages.export.restore.keepCurrent, exact: true }).click();

  const issues = checks.locator('.export-check-details');
  if (await issues.getAttribute('open') === null) await issues.locator('summary').click();
  await checks.getByRole('button', { name: messages.export.checks.goToCaption.replace('{position}', '2'), exact: true }).click();
  const repair = page.getByRole('region', { name: messages.export.repair.label, exact: true });
  await expect(repair.locator('#export-repair-title')).toHaveText(messages.export.repair.fixCaption.replace('{position}', '2'));
  await repair.getByRole('button', { name: messages.export.repair.finish, exact: true }).click();

  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menuitem').filter({ has: page.getByText(messages.editor.tools.activity, { exact: true }) }).click();
  await page.getByRole('dialog', { name: messages.activity.title, exact: true }).getByRole('button', { name: messages.activity.openResult, exact: true }).click();
  const compare = page.getByRole('region', { name: messages.compare.dock.label, exact: true });
  await expect(compare.getByRole('button', { name: messages.compare.dock.useProposed, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  expect(errors).toEqual([]);
});
