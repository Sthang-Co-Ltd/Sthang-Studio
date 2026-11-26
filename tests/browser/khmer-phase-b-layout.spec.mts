import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, type ProcessingJob, type RegenerationProposal } from '@kcs/shared';
import { en } from '../../apps/web/src/i18n/messages/en/index.js';
import { km } from '../../apps/web/src/i18n/messages/km/index.js';
import { formatInterfaceDate } from '../../apps/web/src/i18n/dates.js';
import { appearance, cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { captureKhmerLayout } from './khmer-layout-assertions.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { deferredHighlight, stubHighlightRoutes } from './word-highlight-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const viewports = [
  { width: 1440, height: 900 }, { width: 1200, height: 800 },
  { width: 1280, height: 720 }, { width: 390, height: 844 },
];
const evidence = path.resolve('.codex-tmp/wave3b-final');
const isoDate = '2026-11-22T14:30:00.000Z';
const fixtureBefore = 'កម្ពុជា';
const fixtureAfter = 'ខ្មែរ';
const snapshotDate = (withTime: boolean) => formatInterfaceDate('km', isoDate, { time: withTime });

async function fixtures(page: Page, viewport: typeof viewports[number]) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page);
  state.profile.preferences.interfaceLanguage = 'km';
  state.profile.preferences.autosaveDelayMs = 60_000;
  const project = state.projects[0];
  project.createdAt = isoDate;
  project.updatedAt = isoDate;
  const current = project.captions[0];
  const proposed = { ...current, text: fixtureAfter, startMs: current.startMs + 50 };
  const proposal: RegenerationProposal = {
    id: 'phase-b-layout', projectId: project.id, projectTitle: project.title,
    createdAt: isoDate, expiresAt: '2099-01-01', startMs: current.startMs, endMs: current.endMs,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber: 1, strategy: 'standard',
    currentCaptions: [current], proposedCaptions: [proposed],
    changes: [{
      id: 'layout-change', startMs: current.startMs, endMs: current.endMs, beforeText: current.text, afterText: proposed.text,
      beforeStartMs: current.startMs, beforeEndMs: current.endMs, afterStartMs: proposed.startMs, afterEndMs: proposed.endMs,
      textChanged: true, timingChanged: true, timingDeltaMs: 50, confidence: 'high', protectedByLock: false,
    }],
  };
  const job = { projectId: project.id, projectTitle: project.title, canResume: false, createdAt: isoDate, updatedAt: isoDate };
  state.jobs = [
    { ...job, id: 'layout-running', projectId: state.projects[1].id, projectTitle: state.projects[1].title,
      type: 'transcribe', status: 'running', stage: 'alignment', progress: 52, message: 'Synthetic job running' },
    { ...job, id: 'layout-completed', type: 'regenerate-range', status: 'completed', stage: 'complete', progress: 100,
      message: 'Synthetic comparison ready', completedAt: isoDate, proposalId: proposal.id },
  ] satisfies ProcessingJob[];
  state.profile.correctionEvents = [{
    id: 'layout-correction', projectId: project.id, projectTitle: project.title, captionId: current.id,
    startMs: current.startMs, endMs: current.endMs, originalText: fixtureBefore, correctedText: fixtureAfter,
    suggestionKind: 'review', suggestedVocabularyLine: fixtureAfter, status: 'pending', createdAt: isoDate,
  }];
  state.fonts.push(...Array.from({ length: 25 }, (_, index) => ({
    name: 'Fixture Khmer ' + (index + 1), source: 'user-installed' as const, available: true, boldAvailable: true,
  })));
  await page.route('**/api/updates', (route) => route.fulfill({ json: {
    status: 'available', currentVersion: '0.90.0', offer: { version: '0.91.0', publishedAt: isoDate,
      releaseNotes: 'Synthetic release notes', manifestDigest: 'd'.repeat(64), downloaded: false },
  } }));
  await page.route('**/api/project-bin', (route) => route.fulfill({ json: { items: [{
    id: 'layout-bin', instanceId: 'layout-bin-instance', title: 'Archived fixture', captionCount: 2,
    binnedAt: isoDate, purging: false, restoreUntil: '2099-01-01T00:00:00.000Z',
  }] } }));
  await page.route('**/api/media-preview/*', (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source');
    if (route.request().method() !== 'GET' || !state.projects.some((item) =>
      url.pathname === '/api/media-preview/' + item.id && source === item.media.filename)) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });
  await page.route('**/api/projects/*/history', (route) => route.fulfill({ json: [{
    id: 'layout-checkpoint', projectId: project.id, createdAt: isoDate, source: 'manual-save',
    label: 'Synthetic checkpoint', captionCount: project.captions.length, approvedCount: 1, textLockedCount: 0, timingLockedCount: 0,
  }] }));
  await page.route('**/regeneration-proposals/' + proposal.id, (route) => route.fulfill({ json: proposal }));
  await page.route('**/api/video-export/*/check-layout', (route) => route.fulfill({ json: {
    status: 'blocked', width: 640, height: 360,
    issues: [{ code: 'outside-frame', captionIds: [current.id], message: 'Synthetic caption exceeds the picture.' }],
  } }));
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: [
    { version: 1, format: 'srt', preparedAt: isoDate, fingerprint: 'a'.repeat(64) },
  ] }));
  await page.route('**/api/caption-handoff/*/summary', (route) => route.fulfill({ json: {
    revision: 'a'.repeat(64), captionCount: project.captions.length, media: project.media,
    snapshot: createCaptionData({ captions: hydrateCaptionWordTimings(project).captions }),
  } }));
  return state;
}

function sweep(page: Page, state: FixtureState) {
  return async (surface: string, regions: string, anchor?: Locator) => {
    if (anchor) {
      await expect(anchor).toBeVisible();
      await anchor.scrollIntoViewIfNeeded();
    }
    await captureKhmerLayout(page, surface, regions, state.projects, {
      evidence, phase: 'B', fixtureContent: ['Archived fixture', 'Fixture Khmer', appearance.fontFamily, fixtureBefore, fixtureAfter],
    });
  };
}

async function enter(page: Page) {
  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
}

async function openTool(page: Page, name: string) {
  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click();
}

async function reveal(details: Locator) {
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

for (const viewport of viewports) {
  const size = viewport.width + 'x' + viewport.height;
  test('Khmer Export and Compare at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweep(page, state);
    const captions = state.projects[0].captions;
    captions[0].timingQuality = 'high';
    captions[1].timingQuality = 'high';
    captions[1].startMs = captions[0].endMs - 100;
    await enter(page);

    await page.locator('[data-stage="export"]').click();
    const workspace = page.locator('.export-workspace');
    const footer = workspace.locator('.export-finalize');
    await expect(footer).toHaveCSS('position', 'sticky');
    await capture('export-video', '.workspace-inspector', footer);
    await expect.soft(footer).toBeInViewport({ ratio: 1 });
    await workspace.getByRole('button', { name: km.export.checks.checkLayout, exact: true }).click();
    const videoChecks = workspace.locator('.export-check-details');
    await reveal(videoChecks);
    await expect(videoChecks.locator('[data-severity="blocker"]')).toHaveCount(1);
    await expect(videoChecks.locator('[data-severity="advisory"]')).toHaveCount(1);
    await capture('export-video-checks', '.export-checks', videoChecks.locator('[data-severity="blocker"]'));
    const history = workspace.locator('.export-history');
    await reveal(history);
    await expect(history.locator('time')).toContainText(snapshotDate(true));
    await capture('export-history', '.export-history', history.locator('time'));

    await workspace.locator('.export-mode-switch button').nth(1).click();
    const handoff = workspace.locator('.caption-handoff-panel');
    await expect(handoff.locator('select').first()).toHaveValue('capcut-desktop');
    await expect(handoff.locator('.handoff-destination-guide')).toBeVisible();
    await capture('export-captions', '.workspace-inspector', handoff.locator('.handoff-destination-guide'));
    const checks = workspace.locator('.export-check-details');
    await reveal(checks);
    await expect(checks).toContainText(km.export.checks.goToCaption.replace('{position}', '2'));
    await capture('export-checks', '.export-checks', checks.locator('summary'));

    await openTool(page, km.editor.tools.activity);
    const activity = page.locator('.job-modal');
    await expect(activity.locator('.job-running')).toBeVisible();
    await expect(activity.locator('.job-completed')).toBeVisible();
    await reveal(activity.locator('.job-running .job-details'));
    await expect(activity.locator('.job-running time')).toHaveText(snapshotDate(true));
    await capture('activity', '.job-modal', activity.locator('.job-running time'));
    await activity.getByRole('button', { name: km.activity.openResult, exact: true }).click();

    const dock = page.locator('.regeneration-dock');
    const trigger = dock.getByRole('button', { name: km.compare.dock.usePart, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const menu = dock.locator('.regen-part-menu');
    await expect(menu).toBeVisible();
    const geometry = await menu.evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      const dock = menu.closest('.regeneration-dock')!.getBoundingClientRect();
      const inspector = menu.closest('.inspector-content')!.getBoundingClientRect();
      const trigger = menu.parentElement!.querySelector('button')!.getBoundingClientRect();
      return { rect: rect.toJSON(), dock: dock.toJSON(), inspector: inspector.toJSON(), trigger: trigger.toJSON(),
        contained: rect.left >= Math.max(0, dock.left, inspector.left) &&
          rect.right <= Math.min(innerWidth, dock.right, inspector.right) &&
          rect.top >= Math.max(0, dock.top, inspector.top) &&
          rect.bottom <= Math.min(innerHeight, dock.bottom, inspector.bottom, trigger.top) &&
          menu.contains(document.elementFromPoint(rect.left + 8, rect.top + 8)) &&
          menu.contains(document.elementFromPoint(rect.right - 8, rect.bottom - 8)) };
    });
    expect.soft(geometry.contained, JSON.stringify(geometry)).toBe(true);
    const compareRegions = '.workspace-inspector, .preview-version-badge';
    await expect(page.locator('.preview-version-badge')).toHaveText(km.compare.dock.proposed);
    await capture('compare-use-part', compareRegions);
    await writeFile(path.join(evidence, size, 'compare-bounds.json'), JSON.stringify(geometry, null, 2));
    await page.keyboard.press('Escape');
    await dock.getByRole('button', { name: km.compare.dock.current, exact: true }).click();
    await expect(page.locator('.preview-version-badge')).toHaveText(en.workspace.currentCaptions);
    await capture('compare-current', compareRegions);
  });

  test('Khmer Appearance and Fine timing at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweep(page, state);
    const project = state.projects[0];
    project.captionAppearance = { ...appearance, highlightMode: 'off' };
    // Hydration would otherwise reconstruct usable word timing before the first Apply.
    project.transcript!.tokens = [];
    const highlight = await stubHighlightRoutes(page, project);
    const holdCandidates = highlight.holdCandidates = deferredHighlight();
    await enter(page);

    await page.locator('[data-stage="appearance"]').click();
    const workspace = page.locator('.caption-appearance-workspace');
    await expect(workspace.locator('.appearance-look-grid [data-deferred-text="look-name"]')).toHaveCount(6);
    await capture('appearance-looks', '.workspace-inspector', workspace.locator('.appearance-look-grid'));
    const font = workspace.locator('.appearance-font-search');
    const fontPicker = workspace.locator('.appearance-font-picker select');
    await capture('appearance-font-picker', '.workspace-inspector', fontPicker);
    await font.fill('Fixture Khmer');
    const fontResults = workspace.locator('.appearance-font-search-results');
    await expect(fontResults).toBeVisible();
    await fontResults.evaluate((node) => node.scrollIntoView({ block: 'end', inline: 'nearest' }));
    await capture('appearance-font-search', '.workspace-inspector');
    await page.keyboard.press('Escape');
    await capture('appearance-exact-inputs', '.workspace-inspector', workspace.locator('.appearance-number-control').first());
    await expandAppearanceSection(page, 'motion');
    await capture('appearance-motion', '.workspace-inspector', workspace.locator('.appearance-motion-section'));
    await expandAppearanceSection(page, 'words');
    const preparation = workspace.locator('.word-highlight-preparation');
    await workspace.getByRole('button', { name: km.appearance.workspace.highlightToggle, exact: true }).click();
    try {
      await expect(preparation.getByRole('progressbar')).toBeVisible();
      await capture('appearance-highlight-preparation', '.workspace-inspector', preparation);
    } finally {
      holdCandidates.release();
    }
    await expect(preparation).toHaveAccessibleName(km.appearance.highlight.results);
    await expect(preparation.getByRole('progressbar')).toHaveCount(0);
    await expect(preparation.getByRole('button', { name: km.appearance.undo })).toBeEnabled();
    await capture('appearance-highlight-results', '.workspace-inspector', preparation);
    await expandAppearanceSection(page, 'presets');
    await capture('appearance-presets', '.workspace-inspector', workspace.locator('.appearance-preset-bar'));

    await page.locator('[data-stage="captions"]').click();
    const tools = page.locator('.workspace-tool-strip');
    await tools.getByRole('button', { name: en.workspace.fineTiming, exact: true }).click();
    const timing = page.locator('.fine-timing');
    const surface = page.locator('.timing-waveform-surface');
    const playhead = surface.getByRole('slider', { name: km.timing.waveform.playhead, exact: true });
    const currentTime = () => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000));
    await expect(playhead).toHaveAttribute('aria-valuemax', '4000');
    await playhead.press('End');
    await expect.poll(currentTime).toBe(4000);
    await playhead.press('Home');
    await expect.poll(currentTime).toBe(0);
    const timingRegions = '.workspace-tool-strip, .workspace-inspector, .timing-waveform-surface';
    await capture('timing-waveform', timingRegions, surface.locator('.timing-waveform-toolbar'));
    await capture('timing-edges', timingRegions, timing.locator('.timing-options summary'));
    await surface.getByRole('button', { name: km.timing.waveform.wordTiming, exact: true }).click();
    await capture('timing-words', timingRegions, timing.locator('.word-timing-panel'));
    await reveal(timing.locator('.timing-options'));
    await capture('timing-options', timingRegions, timing.locator('.timing-options-controls'));
  });

  test('Khmer project tools and All projects at ' + size, async ({ page }) => {
    test.setTimeout(60_000);
    const state = await fixtures(page, viewport);
    const capture = sweep(page, state);
    state.projects[0].captions[0].text = fixtureBefore;
    state.projects[0].transcript!.contextMode = 'audio-only';
    await enter(page);

    const tools = page.locator('.workspace-tool-strip');
    await tools.getByRole('button', { name: en.workspace.accuracy, exact: true }).click();
    const accuracy = page.locator('.accuracy-card');
    await reveal(accuracy.locator('.generation-options'));
    await capture('accuracy', '.workspace-tool-strip, .workspace-inspector', accuracy.locator('.generation-options'));
    await tools.getByRole('button', { name: km.grouping.title, exact: true }).click();
    await capture('grouping', '.workspace-tool-strip, .workspace-inspector', page.locator('.controls-card'));

    await page.locator('[data-project-tools-trigger]').click();
    const menu = page.getByRole('menu', { name: km.editor.tools.menu });
    await expect(menu).toBeVisible();
    await capture('tools', '.workspace-tools-popover');
    if (viewport.height === 720) {
      const geometry = await menu.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
      await writeFile(path.join(evidence, size, 'tools-height.json'), JSON.stringify(geometry, null, 2));
      expect.soft(geometry.scrollHeight, 'Tools internal scroll at 1280x720').toBeLessThanOrEqual(geometry.clientHeight + 1);
      for (const item of await menu.getByRole('menuitem').all()) await expect.soft(item).toBeInViewport({ ratio: 1 });
    }
    await menu.getByRole('menuitem').filter({ hasText: km.editor.tools.technical }).click();
    await capture('technical-details', '.workspace-inspector', page.locator('.timing-card'));

    await openTool(page, km.editor.tools.history);
    const history = page.locator('.history-modal');
    await expect(history.locator('.history-copy')).toContainText(snapshotDate(true));
    await capture('history', '.history-modal', history);
    await history.locator('.history-modal-close').click();

    await openTool(page, km.editor.tools.correct);
    const find = page.locator('.find-replace-modal');
    await find.locator('.find-grid input').first().fill(fixtureBefore);
    await find.locator('.find-grid input').nth(1).fill(fixtureAfter);
    await capture('find-preview', '.find-replace-modal', find.locator('.find-preview-row').first());
    await find.getByRole('button', { name: km.find.closeLabel, exact: true }).click();

    await openTool(page, km.editor.tools.corrections);
    const inbox = page.locator('.correction-modal');
    await capture('correction-inbox', '.correction-modal', inbox.locator('.correction-card'));
    await inbox.getByRole('button', { name: km.inbox.close, exact: true }).click();

    await openTool(page, km.editor.tools.updates);
    const updates = page.locator('.update-panel');
    await expect(updates.locator('.update-version small')).toHaveText(snapshotDate(false));
    await capture('updates', '.update-panel');
    await updates.getByRole('button', { name: km.updates.close, exact: true }).click();

    await openTool(page, km.editor.tools.guide);
    const guide = page.locator('.new-user-guide');
    await capture('guide', '.new-user-guide', guide);
    await guide.getByRole('button', { name: km.guide.close, exact: true }).click();

    await page.getByRole('button', { name: km.editor.header.back, exact: true }).click();
    await page.getByRole('button', { name: km.home.launcher.allProjects, exact: true }).click();
    const library = page.locator('.project-library');
    const librarySort = library.getByRole('combobox', { name: km.library.sort, exact: true });
    await librarySort.selectOption('created');
    const projectCard = library.locator('[data-library-project="landscape"]');
    const dates = projectCard.locator('time');
    await expect(dates).toHaveText([snapshotDate(false), snapshotDate(false)]);
    await expect(dates.first()).toHaveAttribute('title', snapshotDate(true));
    await capture('library-project', '.project-library', projectCard);
    await library.locator('[data-library-more]').first().click();
    await expect(library.getByRole('menu')).toBeVisible();
    await capture('library-more', '.project-library');
    await page.keyboard.press('Escape');
    await library.getByRole('button', { name: km.library.recentlyDeleted, exact: true }).click();
    await capture('library-deleted', '.project-library, .project-bin', page.locator('.project-bin-row'));

    await page.getByRole('button', { name: km.home.launcher.settings, exact: true }).click();
    await page.getByRole('button', { name: 'System check', exact: true }).click();
    const storage = page.getByRole('region', { name: km.library.storageLabel, exact: true });
    await expect(storage.getByRole('status')).toContainText(km.library.storageCompleted.replace('{loaded}', '2').replace('{readable}', '2'));
    await capture('library-storage', '.project-storage-report', storage);
  });
}
