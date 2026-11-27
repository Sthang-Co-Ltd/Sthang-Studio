import path from 'node:path';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { CAPTION_LOOKS, type ProcessingJob, type RegenerationProposal, type SystemDoctorReport } from '@kcs/shared';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { translate } from '../../apps/web/src/i18n/translate.js';
import { cleanFixtures, fixtureMedia, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { captureKhmerLayout, openKhmerTool, revealDetails } from './khmer-layout-assertions.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const viewports = [
  { width: 1440, height: 900 }, { width: 1200, height: 800 },
  { width: 1280, height: 720 }, { width: 390, height: 844 },
];
const evidence = path.resolve('.codex-tmp/wave3c-final');
const date = '2026-11-22T14:30:00.000Z';
const replacement = 'replacement.mp4';
const draftText = 'សេចក្ដីព្រាងសាកល្បង';
const replacementText = 'អក្សររត់សាកល្បង';
const failedDetail = 'Synthetic processing error.';
const unknownCheckpoint = 'Synthetic checkpoint with no mapping';
const storageLabel = en.settings.secureStorage.win32;
const llm = {
  provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: '••••',
  model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.6-flash', secureStorageAvailable: true,
  secureStorageLabel: storageLabel, environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null,
};

async function fixtures(page: Page, viewport: typeof viewports[number]) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page);
  state.profile.preferences = { ...state.profile.preferences, interfaceLanguage: 'km', autosaveDelayMs: 60_000 };
  await page.route('**/api/system/llm-settings', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: llm }) : route.fallback());
  await page.route('**/api/updates', (route) => route.fulfill({ json: { status: 'up-to-date', currentVersion: '0.90.0' } }));
  await page.route('**/api/media-preview/*', (route) => {
    const source = new URL(route.request().url()).searchParams.get('source');
    return route.request().method() === 'GET' && state.projects.some((project) => project.media.filename === source)
      ? route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } }) : route.fallback();
  });
  return state;
}

async function enter(page: Page) {
  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
}

function sweeper(page: Page, state: FixtureState) {
  return async (surface: string, region: string, anchor?: Locator) => {
    if (anchor) {
      await expect(anchor).toBeVisible();
      await anchor.scrollIntoViewIfNeeded();
    }
    await captureKhmerLayout(page, surface, region, state.projects, {
      evidence, phase: 'C', fixtureContent: [replacement],
    });
  };
}

async function actionsInView(page: Page, actions: Locator) {
  await expect(actions.first()).toBeVisible();
  if (page.viewportSize()!.height !== 720 && page.viewportSize()!.width !== 390) return;
  for (const action of await actions.all()) {
    await expect.soft(action).toBeInViewport({ ratio: 1 });
    expect.soft(await action.evaluate((node) => {
      const { left, width, top, height } = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    }), 'Dialog action is unobstructed').toBe(true);
  }
  expect.soft(await page.evaluate(() => scrollY), 'Dialog leaves the page at its original scroll position').toBe(0);
}

async function settingsTab(page: Page, tab: keyof typeof km.settings.tabs) {
  await page.getByRole('button', { name: km.home.launcher.settings, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: km.settings.title, exact: true });
  await dialog.getByRole('button', { name: km.settings.tabs[tab], exact: true }).click();
  return dialog;
}

async function stubContributionStatus(page: Page, state: FixtureState) {
  await page.route('**/api/contribution/status', (route) => {
    const consent = state.profile.preferences.khmerContributionConsent;
    return route.fulfill({ json: { consent, endpointConfigured: true, contributorEnrolled: consent === 'granted',
      queued: 1, submitted: 2, verified: 3, rejected: 0, withdrawn: 0, verifiedAudioMs: 23_000, withdrawalPending: false } });
  });
}

for (const viewport of viewports) {
  const size = viewport.width + 'x' + viewport.height;

  test('Phase C Khmer Settings and manual diagnostic copy at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    await stubContributionStatus(page, state);
    const report: SystemDoctorReport = {
      generatedAt: date, engineVersion: 'test', overall: 'error',
      environment: { platform: 'win32 x64', node: 'v24.13.0', appRoot: 'Synthetic root', apiPort: 1, webOrigin: 'http://127.0.0.1' },
      checks: [
        { id: 'node', label: en.system.check.node, status: 'ok', detail: 'Synthetic Node detail' },
        { id: 'gemini-storage', label: en.system.check['gemini-storage'], status: 'warning', detail: 'Synthetic key storage detail' },
        { id: 'python', label: en.system.check.python, status: 'error', detail: 'Synthetic runtime detail', fix: en.system.timingFix.win32 },
      ],
    };
    await page.route('**/api/system/doctor', (route) => route.fulfill({ json: report }));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } },
      });
      document.execCommand = () => false;
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'km');
    let dialog = await settingsTab(page, 'profile');
    const languageSwitch = dialog.locator('.interface-language-switch');
    await expect(languageSwitch.getByRole('button', { name: 'ខ្មែរ', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await capture('settings-profile', '.profile-settings', languageSwitch);

    await dialog.getByRole('button', { name: km.settings.tabs.ai, exact: true }).click();
    const storage = dialog.locator('.secure-storage-note strong:not([data-server-text])');
    await expect(storage).toHaveText(km.settings.secureStorage.win32);
    await capture('settings-ai', '.profile-settings', storage);

    await dialog.getByRole('button', { name: km.settings.tabs.privacy, exact: true }).click();
    await expect(dialog.getByText(km.privacy.analytics.title, { exact: true })).toBeVisible();
    await capture('settings-privacy', '.profile-settings');
    const contributor = dialog.locator('.privacy-card-contributor');
    await expect(contributor.getByRole('button', { name: km.privacy.keepPrivate, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await capture('settings-contributor-off', '.profile-settings', contributor.getByRole('button', { name: km.privacy.keepPrivate, exact: true }));
    state.profile.preferences.khmerContributionConsent = 'granted';
    await page.reload();
    dialog = await settingsTab(page, 'privacy');
    const enabled = dialog.getByRole('button', { name: km.privacy.contributor.enabled, exact: true });
    await expect(enabled).toHaveAttribute('aria-pressed', 'true');
    await capture('settings-contributor-on', '.profile-settings', enabled);

    await dialog.getByRole('button', { name: km.settings.tabs.doctor, exact: true }).click();
    await dialog.getByRole('button', { name: km.system.run, exact: true }).click();
    const checks = dialog.locator('.doctor-checks');
    await expect(checks.locator('strong:not([data-server-text])')).toHaveText(
      [km.system.check.node, km.system.check['gemini-storage'], km.system.check.python],
    );
    for (const status of ['ok', 'warning', 'error']) await expect(checks.locator('.doctor-' + status)).toHaveCount(1);
    await expect(checks.locator('em:not([data-server-text])')).toHaveText(km.system.timingFix.win32);
    await capture('settings-system-check', '.profile-settings', checks.locator('em'));
    await dialog.getByRole('button', { name: km.system.copy, exact: true }).click();
    const manualCopy = dialog.getByRole('textbox', { name: translate('km', 'dialogs.copyReport.manualLabel', { label: km.system.copy }), exact: true });
    await expect(dialog.getByRole('alert')).toHaveText(km.dialogs.copyReport.failed);
    await expect(manualCopy).toHaveValue(JSON.stringify(report, null, 2));
    await capture('copy-report-failed', '.profile-settings', manualCopy);
  });

  test('Phase C Khmer privacy prompts at ' + size, async ({ page }) => {
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    await stubContributionStatus(page, state);
    state.profile.preferences.khmerContributionConsent = 'unset';
    delete state.profile.preferences.privacyUpgradeNoticeVersion;
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'km');
    const upgrade = page.getByRole('dialog', { name: km.privacy.promptTitle, exact: true });
    await expect(upgrade).toBeVisible();
    await actionsInView(page, upgrade.locator('.privacy-upgrade-actions button'));
    await capture('privacy-upgrade', '.privacy-upgrade-dialog');
    await upgrade.getByRole('button', { name: km.privacy.upgrade.review, exact: true }).click();
    const review = page.getByRole('dialog', { name: km.privacy.upgrade.reviewTitle, exact: true });
    await expect(review.getByText(km.privacy.analytics.title, { exact: true })).toBeVisible();
    await capture('privacy-upgrade-review', '.privacy-upgrade-dialog');

    state.profile.preferences.privacyUpgradeNoticeVersion = '0.8';
    await page.reload();
    await expect(upgrade).toHaveCount(0);
    // Invoke the existing SRT-link listener without making an export request.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/api/projects/synthetic/export.srt';
      link.addEventListener('click', (event) => event.preventDefault());
      document.body.append(link);
      link.click();
      link.remove();
    });
    const invitation = page.getByRole('complementary', { name: km.privacy.invitation.label, exact: true });
    await expect(invitation.getByRole('button', { name: km.privacy.invitation.join, exact: true })).toBeVisible();
    await capture('contribution-invitation', '.contribution-prompt');
  });

  test('Phase C Khmer replacement, recovery and confirmation at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    await enter(page);
    const chooser = page.waitForEvent('filechooser');
    await openKhmerTool(page, km.editor.tools.replace);
    await (await chooser).setFiles({ name: replacement, mimeType: 'video/mp4', buffer: fixtureMedia() });
    const replace = page.getByRole('dialog', { name: km.dialogs.media.replaceTitle, exact: true });
    await expect(replace).toBeVisible();
    await actionsInView(page, replace.locator('.media-replacement-actions button'));
    await capture('replace-media', '.media-replacement-dialog');
    await replace.getByRole('button', { name: km.common.cancel, exact: true }).click();

    await page.getByLabel(translate('km', 'editor.row.text', { number: 1 }), { exact: true }).fill(draftText);
    await expect.poll(() => page.evaluate((draft) => Object.keys(localStorage).some((key) =>
      key.startsWith('sthang-studio:unfinished-edits:') && localStorage.getItem(key)?.includes(draft)), draftText)).toBe(true);
    page.once('dialog', (dialog) => void dialog.accept());
    await enter(page);
    const recovery = page.getByRole('region', { name: km.dialogs.draft.label, exact: true });
    const discard = recovery.getByRole('button', { name: km.dialogs.discardDraft.confirm, exact: true });
    await capture('unfinished-edit-recovery', '[aria-label="' + km.dialogs.draft.label + '"]', discard);
    await discard.click();
    const confirm = page.getByRole('alertdialog', { name: km.dialogs.discardDraft.title, exact: true });
    const keep = confirm.getByRole('button', { name: km.dialogs.discardDraft.cancel, exact: true });
    await actionsInView(page, confirm.getByRole('button'));
    await capture('confirmation', '[role="alertdialog"]');
    await keep.click();
    await expect(recovery).toBeVisible();
  });

  test('Phase C Khmer Activity, History and Compare at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    const project = state.projects[0];
    const current = project.captions[0];
    const proposed = { ...current, text: replacementText };
    const evidenceCounts = { model: 'fixture', alignmentCoverage: 1, meanAlignmentScore: 1, lowConfidenceTokens: 0, totalTokens: 3, advisoryScore: 1 };
    const proposal: RegenerationProposal = {
      id: 'phase-c-layout-comparison', projectId: project.id, projectTitle: project.title,
      createdAt: date, expiresAt: '2099-01-01', startMs: current.startMs, endMs: current.endMs,
      lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'deep-verify',
      currentCaptions: [current], proposedCaptions: [proposed],
      changes: [{ id: 'phase-c-layout-change', startMs: current.startMs, endMs: current.endMs,
        beforeText: current.text, afterText: proposed.text, beforeStartMs: current.startMs, beforeEndMs: current.endMs,
        afterStartMs: proposed.startMs, afterEndMs: proposed.endMs, textChanged: true,
        timingChanged: false, timingDeltaMs: 0, confidence: 'high', protectedByLock: false }],
      candidates: [
        { ...evidenceCounts, id: 'strict', label: en.server.candidateLabel.strictAcoustic, text: proposed.text, selected: true },
        { ...evidenceCounts, id: 'context', label: en.server.candidateLabel.contextAware, text: current.text, selected: false },
      ],
      selectedCandidateReason: en.server.selectedCandidateReason.advisoryRanking,
    };
    const job = { projectId: project.id, projectTitle: project.title, canResume: false, createdAt: date, updatedAt: date };
    state.jobs = [
      { ...job, id: 'interrupted', type: 'transcribe', status: 'interrupted', stage: 'interrupted',
        progress: 51, message: 'Synthetic interruption. Choose Resume to continue.', canResume: true },
      { ...job, id: 'running', type: 'transcribe', projectId: state.projects[1].id, projectTitle: state.projects[1].title,
        status: 'running', stage: 'alignment', progress: 52, message: 'Synthetic processing in progress.' },
      { ...job, id: 'failed', type: 'transcribe', status: 'failed', stage: 'failed',
        progress: 48, message: 'Synthetic failure status.', error: failedDetail, completedAt: date },
      { ...job, id: 'complete', type: 'regenerate-range', status: 'completed', stage: 'complete',
        progress: 100, message: 'Synthetic result ready.', completedAt: date, proposalId: proposal.id },
    ] satisfies ProcessingJob[];
    await page.route('**/regeneration-proposals/' + proposal.id, (route) => route.fulfill({ json: proposal }));
    const checkpoint = { projectId: project.id, createdAt: date, captionCount: project.captions.length,
      approvedCount: 1, textLockedCount: 0, timingLockedCount: 0 };
    await page.route('**/api/projects/' + project.id + '/history', (route) => route.fulfill({ json: [
      { ...checkpoint, id: 'manual', source: 'manual-save', label: en.server.historyLabel.manualSave },
      { ...checkpoint, id: 'spacing', source: 'cleanup', label: en.server.historyLabel.spacingCleanup },
      { ...checkpoint, id: 'unmapped', source: 'system', label: unknownCheckpoint },
    ] }));
    await enter(page);

    await openKhmerTool(page, km.editor.tools.history);
    const history = page.getByRole('dialog', { name: km.history.title, exact: true });
    await expect(history.locator('.history-copy > strong:not([data-server-text])')).toHaveText(
      [km.server.historyLabel.manualSave, km.server.historyLabel.spacingCleanup],
    );
    await expect(history.locator('.history-copy > span:not([data-server-text])').first()).toContainText(km.server.historySource['manual-save']);
    await expect(history.locator('.history-copy > strong[data-server-text]')).toHaveText(unknownCheckpoint);
    await capture('history', '.history-modal');
    await history.getByRole('button', { name: km.history.close, exact: true }).click();

    await openKhmerTool(page, km.editor.tools.activity);
    const activity = page.getByRole('dialog', { name: km.activity.title, exact: true });
    const interrupted = activity.locator('.job-interrupted');
    const running = activity.locator('.job-running');
    const failed = activity.locator('.job-failed');
    await expect(interrupted.locator('.job-copy > p:not([data-server-text])')).toHaveText(km.server.resumable.interrupted);
    await expect(interrupted.getByRole('button', { name: km.activity.resume, exact: true })).toBeVisible();
    await expect(running.locator('.job-copy > p:not([data-server-text])')).toHaveText(km.server.stage.alignment);
    await expect(failed.locator('.job-copy > p:not([data-server-text])')).toHaveText(km.server.stage.failed);
    await expect(failed.locator('em[data-server-text]')).toHaveText(failedDetail);
    await capture('activity-interrupted', '.job-modal', interrupted);
    await capture('activity-running', '.job-modal', running);
    await capture('activity-failed', '.job-modal', failed);

    await activity.locator('.job-completed').getByRole('button', { name: km.activity.openResult, exact: true }).click();
    const candidates = page.locator('.regen-candidates');
    await revealDetails(candidates);
    await expect(candidates.locator('strong:not([data-server-text])')).toHaveText(
      [km.server.candidateLabel.strictAcoustic, km.server.candidateLabel.contextAware],
    );
    await expect(candidates.locator('.regen-candidate-note:not([data-server-text])')).toHaveText(km.server.selectedCandidateReason.advisoryRanking);
    await capture('compare-candidate-details', '.regeneration-dock', candidates.locator('.regen-candidate-note'));
  });

  test('Phase C Khmer Looks, media preparation, Review focus and Guide at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    const project = state.projects[0];
    project.captions[0].startMs = 600;
    project.captions[0].endMs = 1100;
    state.profile.preferences.reviewFocusMode = 'brackets-label';
    let releasePreview!: () => void;
    const preparing = new Promise<void>((resolve) => { releasePreview = resolve; });
    state.previewHold = () => preparing;
    let processing = true;
    await page.route('**/api/media-preview/landscape*', (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { source: project.media.filename, state: processing ? 'processing' : 'original',
        videoCodec: 'h264', progress: 32.5 } }) : route.fallback());
    try {
      await enter(page);
      await seek(page, 800);
      const sourceStatus = page.locator('.source-media-status[role="status"]');
      const captionStatus = page.locator('.native-preview-status[role="status"]');
      await expect(sourceStatus).toContainText(translate('km', 'media.playback.preparingProgress', { progress: 32.5 }));
      await expect(sourceStatus.getByRole('button', { name: km.media.playback.cancelPreparation, exact: true })).toBeVisible();
      await expect(captionStatus).toHaveText(km.media.caption.preparing);
      await capture('media-preparation', '.native-preview-status, .source-media-status', sourceStatus);
    } finally {
      processing = false;
      releasePreview();
    }
    await expect(page.locator('.native-caption-image')).toBeVisible();
    await page.locator('[data-stage="review"]').click();
    const frame = page.locator('.review-focus-frame');
    await expect(frame).toHaveCount(0);
    await seek(page, 800);
    await expect(frame.locator('.review-focus-corner')).toHaveCount(4);
    const label = frame.locator('.review-focus-label');
    await expect(label).toHaveText(km.media.caption.reviewing);
    await expect.soft(label).toBeInViewport({ ratio: 1 });
    await capture('media-review-focus', '.review-focus-frame', label);

    await page.locator('[data-stage="appearance"]').click();
    const grid = page.locator('.appearance-look-grid');
    const titles = grid.locator('.appearance-look-copy > strong');
    await expect(titles).toHaveText(CAPTION_LOOKS.map(({ id }) => km.looks[id]));
    await capture('appearance-looks', '.appearance-look-grid, .appearance-look-current', grid);
    expect.soft(await titles.evaluateAll((elements) => elements
      .map((element) => ({ title: element.textContent, height: element.scrollHeight, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }))
      .filter(({ height, lineHeight }) => height > 2 * lineHeight + 1)), 'Look titles fit in two lines').toEqual([]);

    await openKhmerTool(page, km.editor.tools.guide);
    const shortcuts = page.locator('.new-user-guide .guide-shortcuts');
    await revealDetails(shortcuts);
    const approveKeys = shortcuts.getByText(km.guide.shortcutApproveKeys, { exact: true });
    await expect(approveKeys).toBeVisible();
    await capture('guide-keyboard-shortcuts', '.new-user-guide', approveKeys);
  });

  test('Phase C Khmer error and notice share the toast stack at ' + size, async ({ page }) => {
    const state = await fixtures(page, viewport);
    const capture = sweeper(page, state);
    await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({
      status: 503, json: { error: 'Synthetic caption save failure.' },
    }));
    await enter(page);
    await page.getByLabel(translate('km', 'editor.row.text', { number: 1 }), { exact: true }).fill(draftText);
    await page.getByRole('button', { name: km.editor.save.save, exact: true }).click();
    const stack = page.locator('.workspace > .toast-stack');
    const error = stack.locator('.save-failure');
    await expect(error).toContainText(km.notices.save.couldNotSave);
    await page.locator('[data-stage="review"]').click();
    await page.getByRole('button', { name: km.review.card.skip, exact: true }).click();
    const notice = stack.locator('.review-undo-toast');
    await expect(notice.getByRole('button', { name: km.review.undo.action, exact: true })).toBeVisible();
    await expect(error.locator('[data-server-text]')).toHaveText('Synthetic caption save failure.');
    await capture('toast-stack', '.workspace > .toast-stack', error);
    const first = (await error.boundingBox())!;
    const second = (await notice.boundingBox())!;
    expect.soft(first.y + first.height, 'Error ends above the notice').toBeLessThanOrEqual(second.y + 1);
  });
}
