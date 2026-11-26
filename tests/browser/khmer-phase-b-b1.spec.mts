import { test as base, expect } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, type RegenerationProposal } from '@kcs/shared';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

test('English Export, restore, repair and Compare preserve their existing copy', async ({ page }) => {
  test.setTimeout(60_000);
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = 'en';
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
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.media-alignment-notice strong')).toHaveText('Audio alignment not verified.');

  await page.locator('[data-stage="export"]').click();
  const workspace = page.locator('.export-workspace');
  await expect(workspace.getByRole('button', { name: 'Render captioned video', exact: true })).toBeVisible();
  const checks = workspace.getByRole('region', { name: 'Check before export', exact: true });
  await expect(checks).toBeVisible();

  const history = workspace.locator('.export-history');
  await history.locator('summary').click();
  await expect(history.getByText('No recorded exports. Earlier exports have unknown freshness.')).toBeVisible();

  await workspace.getByRole('button', { name: /^Captions file/ }).click();
  const handoff = workspace.locator('.caption-handoff-panel');
  await expect(handoff.getByText('In CapCut Desktop, use Captions → Add Captions to import it.')).toBeVisible();
  await handoff.locator('.handoff-advanced > summary').click();
  await handoff.locator('input[type="file"]').setInputFiles({
    name: 'synthetic.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await expect(workspace.locator('.caption-restore-review').getByRole('heading')).toHaveText('Review caption import');
  await workspace.getByRole('button', { name: 'Keep current captions', exact: true }).click();

  const issues = checks.locator('.export-check-details');
  if (await issues.getAttribute('open') === null) await issues.locator('summary').click();
  await checks.getByRole('button', { name: 'Go to caption 2', exact: true }).click();
  const repair = page.getByRole('region', { name: 'Export review', exact: true });
  await expect(repair.locator('#export-repair-title')).toHaveText('Fixing an export issue · Caption 2');
  await repair.getByRole('button', { name: 'Finish export review', exact: true }).click();

  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menuitem').filter({ hasText: en.editor.tools.activity }).click();
  await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  const compare = page.getByRole('region', { name: 'Caption comparison', exact: true });
  await expect(compare.getByRole('button', { name: 'Use proposed', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});
