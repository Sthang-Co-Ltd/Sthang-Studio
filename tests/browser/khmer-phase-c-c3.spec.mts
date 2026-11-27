import { expect, test as base, type Page } from '@playwright/test';
import { CAPTION_LOOKS, applyCaptionLook, type ProcessingJob, type RegenerationProposal } from '@kcs/shared';
import { messagesFor, type Locale } from '../../apps/web/src/i18n/index.js';
import { appearance, cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const createdAt = '2026-11-22T14:30:00.000Z';
const jobMessage = 'Synthetic Activity completion message.';
const unknownMessage = 'Synthetic message for a future stage.';
const candidateReason = 'Selected using local alignment coverage, alignment score, low-confidence rate, and a small continuity bonus for user-accepted wording. This ranking is advisory—not proof of semantic correctness.';

async function openTool(page: Page, name: string) {
  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click();
}

async function setup(page: Page, locale: Locale) {
  const errors: string[] = [];
  const scrub = (message: string) => message.replace(/\b(?:https?|wss?):\/\/[^\s'"]+/g, '[url]');
  page.on('pageerror', (error) => errors.push(scrub(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(scrub(message.text()));
  });
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = locale;
  const project = state.projects[0];
  project.captionAppearance = applyCaptionLook(appearance, 'soft-glow');
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
    if (route.request().method() !== 'GET' || url.pathname !== `/api/media-preview/${project.id}` || source !== project.media.filename) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });

  const current = project.captions[0];
  const proposed = { ...current, text: 'Synthetic candidate wording' };
  const candidate = { model: 'fixture', alignmentCoverage: 1, meanAlignmentScore: 1, lowConfidenceTokens: 0, totalTokens: 3, advisoryScore: 1 };
  const proposal: RegenerationProposal = {
    id: 'phase-c-c3', projectId: project.id, projectTitle: project.title,
    createdAt, expiresAt: '2099-01-01', startMs: current.startMs, endMs: current.endMs,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'deep-verify',
    currentCaptions: [current], proposedCaptions: [proposed],
    changes: [{
      id: 'c3-change', startMs: current.startMs, endMs: current.endMs, beforeText: current.text, afterText: proposed.text,
      beforeStartMs: current.startMs, beforeEndMs: current.endMs, afterStartMs: proposed.startMs, afterEndMs: proposed.endMs,
      textChanged: true, timingChanged: false, timingDeltaMs: 0, confidence: 'high', protectedByLock: false,
    }],
    candidates: [
      { ...candidate, id: 'known', label: 'Strict acoustic pass', text: proposed.text, selected: true },
      { ...candidate, id: 'unknown', label: 'Synthetic candidate label', text: current.text, selected: false },
    ],
    selectedCandidateReason: candidateReason,
  };
  const job = { projectId: project.id, projectTitle: project.title, canResume: false, createdAt, updatedAt: createdAt };
  state.jobs = [
    { ...job, id: 'known-stage', type: 'regenerate-range', status: 'completed', stage: 'complete', progress: 100,
      message: jobMessage, completedAt: createdAt, proposalId: proposal.id },
    { ...job, id: 'unknown-stage', type: 'transcribe', status: 'failed', stage: 'future-stage', progress: 21,
      message: unknownMessage, error: 'Synthetic error detail', completedAt: createdAt },
  ] satisfies ProcessingJob[];
  const checkpoint = { projectId: project.id, createdAt, captionCount: project.captions.length,
    approvedCount: 0, textLockedCount: 0, timingLockedCount: 0 };
  await page.route(`**/api/projects/${project.id}/history`, (route) => route.fulfill({ json: [
    { ...checkpoint, id: 'mapped', source: 'manual-save', label: 'Before manual save' },
    { ...checkpoint, id: 'unmapped', source: 'custom-source', label: 'Before timing cleanup: My timing profile' },
  ] }));
  await page.route(`**/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));
  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  return errors;
}

test('English Activity retains the exact server message and stage name', async ({ page }) => {
  const errors = await setup(page, 'en');
  const { t } = messagesFor('en');
  await openTool(page, t('editor.tools.activity'));
  const known = page.getByRole('dialog', { name: t('activity.title') }).locator('.job-completed');
  await expect(known.locator('.job-copy > p[data-server-text]')).toHaveText(jobMessage);
  await known.locator('.job-details > summary').click();
  await expect(known.locator('.job-details dd').first()).toHaveText('complete');
  expect(errors).toEqual([]);
});

test('Khmer Activity, History, Compare and Looks render catalog values and preserve free-form text', async ({ page }) => {
  const errors = await setup(page, 'km');
  const { t } = messagesFor('km');

  await openTool(page, t('editor.tools.history'));
  const history = page.getByRole('dialog', { name: t('history.title') });
  const knownHistory = history.locator('article').first();
  await expect(knownHistory.locator('.history-copy > strong:not([data-server-text])')).toHaveText(t('server.historyLabel.manualSave'));
  await expect(knownHistory.locator('.history-copy > span:not([data-server-text])')).toContainText(t('server.historySource.manual-save'));
  await expect(knownHistory.getByRole('button')).toHaveAccessibleName(new RegExp(t('server.historyLabel.manualSave')));
  const unknownHistory = history.locator('article').last();
  await expect(unknownHistory.locator('.history-copy > strong[data-server-text]')).toHaveText('Before timing cleanup: My timing profile');
  await expect(unknownHistory.locator('.history-copy > span[data-server-text]')).toContainText('custom source');
  await history.getByRole('button', { name: t('history.close') }).click();

  await page.locator('.stage-rail [data-stage="appearance"]').click();
  const looks = page.locator('.caption-appearance-workspace');
  await expect(looks.locator('.appearance-look-card .appearance-look-copy > strong')).toHaveText(
    CAPTION_LOOKS.map(({ id }) => t(`looks.${id}`)),
  );
  await expect(looks.locator('.appearance-look-current')).toContainText(t('looks.soft-glow'));
  await expect(looks.locator('[data-deferred-text="look-name"]')).toHaveCount(0);

  await openTool(page, t('editor.tools.activity'));
  const activity = page.getByRole('dialog', { name: t('activity.title') });
  const known = activity.locator('.job-completed');
  const unknown = activity.locator('.job-failed');
  await expect(known.locator('.job-copy > p:not([data-server-text])')).toHaveText(t('server.stage.complete'));
  await expect(unknown.locator('.job-copy > p[data-server-text]')).toHaveText(unknownMessage);
  await expect(unknown.locator('em[data-server-text]')).toHaveText('Synthetic error detail');
  await known.locator('.job-details > summary').click();
  await expect(known.locator('.job-details dd:not([data-server-text])').first()).toHaveText(t('server.stageName.complete'));
  await unknown.locator('.job-details > summary').click();
  await expect(unknown.locator('.job-details dd[data-server-text]')).toHaveText('future stage');
  await known.getByRole('button', { name: t('activity.openResult') }).click();

  const candidates = page.locator('.regen-candidates');
  await candidates.getByText(t('compare.dock.candidateDetails'), { exact: true }).click();
  await expect(candidates.locator('strong:not([data-server-text])')).toHaveText(t('server.candidateLabel.strictAcoustic'));
  await expect(candidates.locator('strong[data-server-text]')).toHaveText('Synthetic candidate label');
  await expect(candidates.locator('article.selected p[data-server-text]')).toHaveText('Synthetic candidate wording');
  await expect(candidates.locator('.regen-candidate-note:not([data-server-text])')).toHaveText(t('server.selectedCandidateReason.advisoryRanking'));
  expect(errors).toEqual([]);
});
