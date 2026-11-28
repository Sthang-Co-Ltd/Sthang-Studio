import { test as base, expect, type Page } from '@playwright/test';
import type { ProcessingJob, RegenerationProposal } from '@kcs/shared';
import { captionTextForEditing } from '../../apps/web/src/caption-text.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const proposalId = 'compare-outcomes';
const viewportSizes = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1199, height: 900 }, { width: 390, height: 844 }];
const dock = (page: Page) => page.getByRole('region', { name: 'Caption comparison', exact: true });
const button = (page: Page, name: string) => dock(page).getByRole('button', { name, exact: true });
const menu = (page: Page) => dock(page).getByRole('menu', { name: 'Use part of the proposal', exact: true });
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });
const wording = (page: Page) => dock(page).getByRole('textbox', { name: 'Edit proposed caption wording', exact: true });
const disclose = (page: Page) => dock(page).locator('summary').filter({ hasText: 'Try another way' });
const takeChip = (page: Page) => dock(page).locator('.regen-title-copy span');

function comparisonProposal(state: FixtureState): RegenerationProposal {
  const current = structuredClone(state.projects[0].captions[0]);
  const proposed = { ...current, id: 'compare-proposed-caption', text: 'សំណើ Khmer proposal', startMs: 250, endMs: 1050 };
  return {
    id: proposalId, projectId: 'landscape', projectTitle: 'Audit landscape', createdAt: '2026-01-01',
    expiresAt: '2099-01-01', startMs: 100, endMs: 1150, lockedCaptionsPreserved: 0, unchangedCount: 0,
    passNumber: 1, strategy: 'standard', currentCaptions: [current], proposedCaptions: [proposed],
    changes: [{
      id: 'compare-change', startMs: current.startMs, endMs: proposed.endMs, beforeText: current.text, afterText: proposed.text,
      beforeStartMs: current.startMs, beforeEndMs: current.endMs, afterStartMs: proposed.startMs, afterEndMs: proposed.endMs,
      textChanged: true, timingChanged: true, timingDeltaMs: 50, confidence: 'high', protectedByLock: false,
    }],
  };
}

async function setupComparison(page: Page, configure?: (proposal: RegenerationProposal) => void) {
  const state = await installFixture(page);
  const proposal = comparisonProposal(state);
  configure?.(proposal);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.jobs = [{
    id: 'compare-outcomes-job', type: 'regenerate-range', projectId: proposal.projectId, projectTitle: proposal.projectTitle,
    status: 'completed', stage: 'complete', progress: 100, message: 'Comparison ready', canResume: false,
    createdAt: proposal.createdAt, updatedAt: proposal.createdAt, proposalId,
  } satisfies ProcessingJob];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(`**/regeneration-proposals/${proposalId}`, (route) => route.fulfill({ json: proposal }));
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await page.getByRole('dialog', { name: 'Activity', exact: true }).locator('article').filter({ hasText: 'Comparison ready' })
    .getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(wording(page)).toHaveValue(captionTextForEditing(proposal.proposedCaptions));
  return { state, proposal };
}

test('the default comparison is a choice between two versions', async ({ page }) => {
  await setupComparison(page);
  const footer = dock(page).locator('.regen-apply-actions');
  await expect(footer.getByRole('button')).toHaveText(['Keep current', 'Use part', 'Use proposed']);
  for (const label of ['Keep current', 'Use part', 'Use proposed']) await expect(button(page, label)).toBeVisible();
  const bounds = await footer.getByRole('button').evaluateAll((buttons) => buttons.map((node) => node.getBoundingClientRect().right));
  expect(bounds[2]).toBeGreaterThan(Math.max(bounds[0], bounds[1]));
  await expect(footer.locator('.primary')).toHaveText('Use proposed');
  await expect(dock(page).getByText(/\bpass\b|confidence|locks preserved|unchanged|Change 1 of 1/i)).toHaveCount(0);
  await expect(dock(page).locator('.regen-summary')).toHaveText('1 text change · 1 timing change');
  await expect(dock(page).getByRole('button', { name: /^Play this change, / })).toBeVisible();
  await expect(page.locator('.preview-version-badge')).toHaveText('Proposed');
  await button(page, 'Current').click();
  await expect(page.locator('.preview-version-badge')).toHaveText('Current captions');
});

test('the selected change shows intact Khmer wording and stays independent of the editable draft', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await setupComparison(page, (fixture) => {
    const change = fixture.changes[0];
    change.beforeText = 'យើង ទៅ ក្រុង';
    change.afterText = 'យើង នៅ ក្រុង';
    fixture.currentCaptions[0].text = change.beforeText;
    fixture.proposedCaptions[0].text = change.afterText;
    fixture.changes.push({ ...change, id: 'timing-only', beforeText: change.afterText, textChanged: false });
  });
  const diff = dock(page).locator('.regen-change-wording');
  await expect(diff.locator('dd')).toHaveText(['យើង ទៅ ក្រុង', 'យើង នៅ ក្រុង']);
  await expect(diff.locator('mark')).toHaveText(['ទៅ', 'នៅ']);
  await expect(diff.locator('dt')).toHaveText(['Current', 'Original proposal']);
  await wording(page).fill('សំណើដែលបានកែ');
  await expect(diff.locator('dd').last()).toHaveText('យើង នៅ ក្រុង');
  await diff.scrollIntoViewIfNeeded();
  expect(await diff.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('selected-change-320.png') });
  await button(page, 'Next proposed change').press('Enter');
  await expect(diff).toHaveCount(0);
  await expect(wording(page)).toHaveValue('សំណើដែលបានកែ');
});

for (const fallback of ['diff budget', 'missing segmenter']) test('Compare retains cue-local wording with ' + fallback, async ({ page }) => {
  const before = fallback === 'diff budget' ? 'ក'.repeat(256) : 'កម្ពុជា';
  const after = fallback === 'diff budget' ? 'ខ'.repeat(256) : 'ខ្មែរ';
  await setupComparison(page, (fixture) => {
    const added = { ...fixture.proposedCaptions[0], id: 'added-cue', startMs: 1200, endMs: 1800, text: 'Added cue' };
    const removed = { ...fixture.currentCaptions[0], id: 'removed-cue', startMs: 1900, endMs: 2200, text: 'Removed cue' };
    fixture.endMs = removed.endMs;
    fixture.currentCaptions[0].text = before;
    fixture.proposedCaptions[0].text = after;
    fixture.currentCaptions.push(removed);
    fixture.proposedCaptions.push(added);
    const first = fixture.changes[0];
    first.beforeText = before;
    first.afterText = after;
    fixture.changes.push(
      { ...first, id: added.id, startMs: added.startMs, endMs: added.endMs, beforeText: '', afterText: added.text },
      { ...first, id: removed.id, startMs: removed.startMs, endMs: removed.endMs, beforeText: removed.text, afterText: '' },
    );
  });
  await wording(page).fill('Edited whole range');
  const diff = dock(page).locator('.regen-change-wording');
  const next = button(page, 'Next proposed change');
  if (fallback === 'missing segmenter') {
    // Scope the missing API to a selection change in the running editor.
    // Shared caption processing uses the native segmenter at module startup.
    await next.press('Enter');
    const segmenter = await page.evaluateHandle(() => Intl.Segmenter);
    try {
      await page.evaluate(() => { Object.defineProperty(Intl, 'Segmenter', { value: undefined }); });
      await button(page, 'Previous proposed change').press('Enter');
      await expect(diff.locator('dt').first()).toHaveText('Current');
    } finally {
      await page.evaluate((native) => { Object.defineProperty(Intl, 'Segmenter', { value: native }); }, segmenter);
      await segmenter.dispose();
    }
  }
  await expect(diff.locator('dd')).toHaveText([before, after]);
  await expect(diff.locator('mark')).toHaveCount(0);
  await next.press('Enter');
  await expect(diff.locator('dt')).toHaveText('Added caption');
  await expect(diff.locator('dd')).toHaveText('Added cue');
  await next.press('Enter');
  await expect(diff.locator('dt')).toHaveText('Removed caption');
  await expect(diff.locator('dd')).toHaveText('Removed cue');
  await expect(wording(page)).toHaveValue('Edited whole range');
});

test('change navigation still seeks to the selected change with pre-roll', async ({ page }) => {
  const { proposal } = await setupComparison(page, (fixture) => {
    fixture.changes.push({ ...fixture.changes[0], id: 'compare-change-2', startMs: 900, endMs: 1100 });
  });
  await expect(dock(page).getByText('Change 1 of 2', { exact: true })).toBeVisible();
  await expect(button(page, 'Previous proposed change')).toBeDisabled();
  await button(page, 'Next proposed change').click();
  await expect(dock(page).getByText('Change 2 of 2', { exact: true })).toBeVisible();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo((proposal.changes[1].startMs - 350) / 1000, 2);
  await expect(button(page, 'Next proposed change')).toBeDisabled();
  await button(page, 'Previous proposed change').click();
  await expect(dock(page).getByText('Change 1 of 2', { exact: true })).toBeVisible();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(Math.max(0, proposal.changes[0].startMs - 350) / 1000, 2);
});

test('Use part focuses enabled choices, returns focus on Escape, and closes when focus leaves', async ({ page }) => {
  await setupComparison(page, (fixture) => { fixture.changes[0].timingChanged = false; });
  const trigger = button(page, 'Use part');
  const text = item(page, 'Use text only');
  await trigger.press('ArrowDown');
  await expect(text).toBeFocused();
  await expect(item(page, 'Use timing only')).toBeDisabled();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger).toHaveAttribute('aria-controls', (await menu(page).getAttribute('id'))!);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.press('ArrowUp');
  await expect(text).toBeFocused();
  await wording(page).focus();
  await expect(menu(page)).toHaveCount(0);
  await trigger.click();
  await expect(text).toBeFocused();
  await dock(page).locator('.regen-summary').click();
  await expect(menu(page)).toHaveCount(0);
});

test('Use part is disabled when neither text nor timing differs', async ({ page }) => {
  await setupComparison(page, (fixture) => { fixture.changes = []; fixture.lockedCaptionsPreserved = 1; });
  await expect(button(page, 'Use part')).toBeDisabled();
  await expect(dock(page).locator('.regen-summary')).toHaveText('Same as the current captions · 1 locked caption kept');
  await expect(dock(page).getByRole('button', { name: /^Play this change, / })).toHaveCount(0);
});

const edited = ' កម្ពុជា Edited wording ';
for (const decision of [
  { label: 'Use proposed', expected: { mode: 'all' } },
  { label: 'Use edited version', edit: true, expected: { mode: 'all', editedText: edited } },
  { label: 'Use text only', partial: true, expected: { mode: 'text-only', editedText: 'សំណើ Khmer proposal' } },
  { label: 'Use timing only', partial: true, expected: { mode: 'timing-only' } },
  { label: 'Keep current', expected: { mode: 'reject' } },
]) {
  test(`${decision.label} sends the original apply request body`, async ({ page }) => {
    const { state } = await setupComparison(page);
    const bodies: unknown[] = [];
    await page.route(`**/regeneration-proposals/${proposalId}/apply`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: state.projects[0] });
    });
    if (decision.edit) await wording(page).fill(edited);
    if (decision.partial) {
      await button(page, 'Use part').click();
      await item(page, decision.label).click();
    } else await button(page, decision.label).click();
    await expect(dock(page)).toHaveCount(0);
    expect(bodies).toEqual([decision.expected]);
  });
}

test('blank wording disables text and full use while leaving the reason visible', async ({ page }) => {
  await setupComparison(page);
  await wording(page).fill('  ');
  await expect(wording(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(wording(page)).toHaveAccessibleDescription('Enter wording before using the text or the whole proposal.');
  await expect(button(page, 'Use edited version')).toBeDisabled();
  await button(page, 'Use part').press('ArrowDown');
  await expect(item(page, 'Use text only')).toBeDisabled();
  await expect(item(page, 'Use timing only')).toBeFocused();
  await page.keyboard.press('Escape');
  await disclose(page).click();
  await expect(button(page, 'Another take')).toBeEnabled();
  await expect(button(page, 'Build on this wording')).toBeDisabled();
  await expect(button(page, 'Check more carefully')).toBeEnabled();
  await expect(button(page, 'Re-time my edited words')).toBeDisabled();
});

const refinements = [
  { label: 'Another take', strategy: 'alternative', baseline: false, edit: true },
  { label: 'Build on this wording', strategy: 'alternative', baseline: true, edit: true },
  { label: 'Check more carefully', strategy: 'deep-verify', baseline: true, edit: true },
  { label: 'Check more carefully', strategy: 'deep-verify', baseline: false, edit: false },
  { label: 'Re-time my edited words', strategy: 'manual-realign', baseline: true, edit: true },
];

for (const { label, strategy, baseline, edit } of refinements) {
  test(`${label} sends the original refine request body (${edit ? 'edited' : 'original'})`, async ({ page }) => {
    const { state, proposal } = await setupComparison(page);
    const bodies: unknown[] = [];
    const queued: ProcessingJob = {
      ...state.jobs[0], id: 'compare-refinement-job', type: 'refine-proposal', status: 'running', stage: 'refining',
      progress: 20, message: 'Synthetic refinement running', proposalId: undefined,
    };
    await page.route('**/api/jobs/refine-proposal', async (route) => {
      bodies.push(route.request().postDataJSON());
      state.jobs.unshift(queued);
      await route.fulfill({ status: 202, json: queued });
    });
    if (edit) await wording(page).fill(edited);
    await disclose(page).click();
    await dock(page).getByRole('textbox', { name: /Accuracy hint/ }).fill(' Keep Khmer names ');
    await button(page, label).click();
    await expect(dock(page).getByText('20% · You can keep comparing while the next version is prepared.', { exact: true })).toBeVisible();
    const { filename, size } = state.projects[0].media;
    expect(bodies).toEqual([{
      projectId: proposal.projectId, proposalId, strategy, useProposalAsBaseline: baseline,
      editedText: edit ? edited.trim() : proposal.proposedCaptions[0].text, accuracyHint: 'Keep Khmer names',
      expectedMedia: { filename, size }, generationModel: 'automatic',
    }]);
    for (const name of new Set(refinements.map((action) => action.label))) await expect(button(page, name)).toBeDisabled();
    await expect(button(page, 'Keep current')).toBeDisabled();
    await expect(button(page, 'Use part')).toBeDisabled();
    await expect(button(page, edit ? 'Use edited version' : 'Use proposed')).toBeDisabled();
  });
}

const takes: Array<[RegenerationProposal['strategy'], string | undefined, string | null]> = [
  ['standard', undefined, null],
  ['alternative', undefined, 'Another take'],
  ['alternative', 'A chosen baseline', 'Built on your wording'],
  ['deep-verify', undefined, 'Checked more carefully'],
  ['manual-realign', undefined, 'Re-timed your wording'],
];

for (const [strategy, baseline, label] of takes) {
  test(`take chip for ${strategy}${baseline ? ' with a baseline' : ''}`, async ({ page }) => {
    await setupComparison(page, (fixture) => {
      fixture.strategy = strategy;
      fixture.acceptedBaselineText = baseline;
    });
    if (label) await expect(takeChip(page)).toHaveText(label);
    else await expect(takeChip(page)).toHaveCount(0);
  });
}

test('the summary and change focus retain lock evidence', async ({ page }) => {
  await setupComparison(page, (fixture) => {
    fixture.lockedCaptionsPreserved = 2;
    fixture.changes[0].protectedByLock = true;
  });
  await expect(dock(page).locator('.regen-summary')).toHaveText('1 text change · 1 timing change · 2 locked captions kept');
  await expect(dock(page).getByRole('button', { name: /^Play this change, / })).toContainText('Locked');
});

test('Loop keeps its name while its pressed state changes', async ({ page }) => {
  await setupComparison(page);
  const loop = button(page, 'Loop');
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'false');
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
});

for (const viewport of viewportSizes) {
  test(`upward decision menu geometry at ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await setupComparison(page);
    const trigger = button(page, 'Use part');
    await trigger.scrollIntoViewIfNeeded();
    const capture = viewport.width === 1440 || viewport.width === 390;
    if (capture) {
      await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 3 && !video.seeking)).toBe(true);
      await page.screenshot({ path: info.outputPath(`compare-${viewport.width}-closed.png`), animations: 'disabled' });
    }
    await trigger.click();
    const measurement = await menu(page).evaluate((menu) => {
      const r = menu.getBoundingClientRect();
      const dock = menu.closest('.regeneration-dock')!.getBoundingClientRect();
      const inspector = menu.closest('.inspector-content')!.getBoundingClientRect();
      const trigger = menu.parentElement!.querySelector('button')!.getBoundingClientRect();
      const hit = (x: number, y: number) => menu.contains(document.elementFromPoint(x, y));
      return {
        menu: r.toJSON(), dock: dock.toJSON(), inspector: inspector.toJSON(),
        horizontalScroll: document.documentElement.scrollWidth - innerWidth,
        visible: r.left >= Math.max(0, dock.left, inspector.left)
          && r.right <= Math.min(innerWidth, dock.right, inspector.right)
          && r.top >= Math.max(0, dock.top, inspector.top)
          && r.bottom <= Math.min(innerHeight, dock.bottom, inspector.bottom)
          && r.bottom <= trigger.top
          && hit(r.left + 8, r.top + 8) && hit(r.right - 8, r.bottom - 8),
      };
    });
    expect(measurement, JSON.stringify({ viewport, ...measurement })).toMatchObject({ visible: true, horizontalScroll: 0 });
    if (viewport.width <= 1199) {
      const targets = dock(page).locator('.regen-apply-actions button');
      await expect(targets).toHaveCount(5);
      for (const height of await targets.evaluateAll((buttons) => buttons.map((node) => node.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(44);
      }
    }
    if (capture) await page.screenshot({ path: info.outputPath(`compare-${viewport.width}-open.png`), animations: 'disabled' });
  });
}
