import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { ProcessingJob, RegenerationProposal } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
let actions: Array<{ mode: string; editedText?: string }>;
const dock = (page: Page) => page.getByRole('region', { name: 'Live regeneration review', exact: true });
const wording = (page: Page) => dock(page).getByLabel('Edit proposed caption wording', { exact: true });
const hint = (page: Page) => dock(page).getByRole('textbox', { name: /Accuracy hint/ });
const revisedWording = 'ពាក្យថ្មី កម្ពុជា Newer wording';
const revisedHint = 'Keep Khmer names កម្ពុជា in this newer hint';
function proposal(id = 'q-main', text = 'សំណើ Khmer proposal', passNumber = 1): RegenerationProposal {
  const current = structuredClone(state.projects[0].captions[0]);
  const proposed = { ...current, id: `caption-${id}`, text, startMs: 250, endMs: 1050 };
  return { id, projectId: 'landscape', projectTitle: 'Audit landscape', createdAt: '2026-01-01', expiresAt: '2099-01-01', startMs: 100, endMs: 1150,
    lockedCaptionsPreserved: 0, unchangedCount: 0, passNumber, strategy: passNumber === 1 ? 'standard' : 'manual-realign', accuracyHint: 'Initial hint',
    currentCaptions: [current], proposedCaptions: [proposed], changes: [{ id: `change-${id}`, startMs: current.startMs, endMs: proposed.endMs, beforeText: current.text, afterText: text,
      beforeStartMs: current.startMs, beforeEndMs: current.endMs, afterStartMs: proposed.startMs, afterEndMs: proposed.endMs,
      textChanged: true, timingChanged: true, timingDeltaMs: 50, confidence: 'high', protectedByLock: false }] };
}
function job(id: string, proposalId?: string): ProcessingJob {
  return { id, type: proposalId ? 'regenerate-range' : 'refine-proposal', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: proposalId ? 'completed' : 'running', stage: proposalId ? 'complete' : 'refining', progress: proposalId ? 100 : 20,
    message: proposalId ? 'Initial take ready' : 'Synthetic refinement running', canResume: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', proposalId };
}
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); actions = [];
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.jobs = [job('initial-job', 'q-main')];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/regeneration-proposals/q-main', (route) => route.fulfill({ json: proposal() }));
  await page.route('**/regeneration-proposals/q-main/apply', async (route) => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({ json: state.projects[0] });
  });
});
async function activity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}
async function openInitialComparison(page: Page) {
  const panel = await activity(page);
  await panel.locator('article').filter({ hasText: 'Initial take ready' }).getByRole('button', { name: 'Open result', exact: true }).click();
  await expect(wording(page)).toHaveValue('សំណើ Khmer proposal');
}
async function openComparison(page: Page) {
  await openProject(page); await openInitialComparison(page);
  await page.evaluate(() => { document.querySelector('video')?.pause(); (window as any).__regenDraftNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function keptEvidence(page: Page, captions: FixtureState['projects'][number]['captions']) {
  expect(state.projects[0].captions).toEqual(captions);
  expect(await page.evaluate(() => (window as any).__regenDraftNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    const hits = [top + 2, top + height / 2, bottom - 2].map((y) => {
      const hit = document.elementFromPoint(left + width / 2, y);
      return { y, ownsPoint: hit === node || (hit !== null && node.contains(hit)), tag: hit?.tagName, class: hit?.getAttribute('class') };
    });
    return { focused: document.activeElement === node, inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: hits.every((hit) => hit.ownsPoint), rect: { left, top, right, bottom, width, height }, viewport: { width: innerWidth, height: innerHeight }, hits };
  })).toMatchObject({ focused: true, inViewport: true, uncovered: true });
}
async function visibleStage(page: Page) {
  await expect.poll(() => page.locator('.stage-column').evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    const hits = [left + 16, left + width / 4, left + width / 2, left + width * 3 / 4, right - 16].map((x) => {
      const hit = document.elementFromPoint(x, bottom - 3);
      return { x, ownsPoint: hit === node || (hit !== null && node.contains(hit)), tag: hit?.tagName, class: hit?.getAttribute('class') };
    });
    return { inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: hits.every((hit) => hit.ownsPoint), rect: { left, top, right, bottom, width, height }, hits };
  })).toMatchObject({ inViewport: true, uncovered: true });
}
async function editWithKeyboard(page: Page, field: 'wording' | 'hint', value: string) {
  await dock(page).getByRole('button', { name: 'Preview proposed captions', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(wording(page)).toBeFocused();
  if (field === 'hint') await page.keyboard.press('Tab');
  const target = field === 'wording' ? wording(page) : hint(page);
  await visibleFocus(target);
  await page.keyboard.press('Control+a'); await page.keyboard.insertText(value);
  await expect(target).toHaveValue(value);
  await visibleFocus(target);
}
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

for (const [width, mode] of [[1440, 'all'], [390, 'text-only']] as const) {
  test(`blank proposal wording cannot accept hidden text and a Khmer correction remains exact at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await openComparison(page);
    const before = structuredClone(state.projects[0].captions);
    const full = dock(page).getByRole('button', { name: 'Accept edited proposal', exact: true });
    const text = dock(page).getByRole('button', { name: 'Accept text only', exact: true });
    for (const empty of ['', ' \n\t ']) {
      await wording(page).fill(empty);
      await expect(wording(page)).toHaveAttribute('aria-invalid', 'true');
      const description = await wording(page).getAttribute('aria-describedby');
      await expect(page.locator(`[id="${description}"]`)).toHaveText('Enter wording before accepting text or the full proposal.');
      await expect(full).toBeDisabled(); await expect(text).toBeDisabled();
      await full.evaluate((button: HTMLButtonElement) => button.click()); await text.evaluate((button: HTMLButtonElement) => button.click());
      expect(actions).toEqual([]);
      await expect(dock(page).getByRole('button', { name: 'Keep current', exact: true })).toBeEnabled();
      await expect(dock(page).getByRole('button', { name: 'Accept timing only', exact: true })).toBeEnabled();
    }
    await full.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`blank-proposal-${width}.png`), animations: 'disabled' });
    await wording(page).fill(revisedWording);
    await expect(wording(page)).not.toHaveAttribute('aria-invalid');
    await expect(full).toBeEnabled(); await expect(text).toBeEnabled();
    await (mode === 'all' ? full : text).click();
    await expect(dock(page)).toHaveCount(0);
    expect(actions).toEqual([{ mode, editedText: revisedWording }]);
    await keptEvidence(page, before);
  });
}

test('empty wording preserves deliberate Keep current and timing-only decisions', async ({ page }) => {
  await openComparison(page); const before = structuredClone(state.projects[0].captions);
  await wording(page).fill('');
  await dock(page).getByRole('button', { name: 'Keep current', exact: true }).click();
  await expect(dock(page)).toHaveCount(0);
  expect(actions).toEqual([{ mode: 'reject' }]);
  await openInitialComparison(page); await wording(page).fill('   ');
  await dock(page).getByRole('button', { name: 'Accept timing only', exact: true }).click();
  await expect(dock(page)).toHaveCount(0);
  expect(actions).toEqual([{ mode: 'reject' }, { mode: 'timing-only' }]);
  await keptEvidence(page, before);
});

test('mobile keyboard entry reveals proposal wording with the normal preview and no notice', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await openComparison(page);
  const before = structuredClone(state.projects[0].captions);
  await expect(page.locator('.toast.notice')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
  await expect(page.locator('.toast-stack > *')).toHaveCount(0);
  const modes = dock(page).getByRole('group', { name: 'Caption preview version' });
  const current = modes.getByRole('button', { name: 'Current', exact: true });
  const proposed = modes.getByRole('button', { name: 'Proposed', exact: true });
  const previewCurrent = dock(page).getByRole('button', { name: 'Preview current captions', exact: true });
  const previewProposed = dock(page).getByRole('button', { name: 'Preview proposed captions', exact: true });
  await expect(current).toHaveAttribute('aria-pressed', 'false');
  await expect(previewCurrent).toHaveAttribute('aria-pressed', 'false');
  await expect(proposed).toHaveAttribute('aria-pressed', 'true');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'true');
  // Start from one stable, real keyboard entry point, then use ordinary Tab
  // traversal through the mode switch, playback actions and comparison cards.
  const tabTo = async (target: Locator, maximum = 12) => {
    for (let index = 0; index < maximum; index++) {
      if (await target.evaluate((node) => document.activeElement === node)) return;
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
  };
  await dock(page).getByRole('button', { name: 'Close regeneration review', exact: true }).focus();
  await tabTo(current);
  await page.keyboard.press('Enter');
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(previewCurrent).toHaveAttribute('aria-pressed', 'true');
  await expect(proposed).toHaveAttribute('aria-pressed', 'false');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'false');
  await tabTo(proposed);
  await page.keyboard.press('Space');
  await expect(proposed).toHaveAttribute('aria-pressed', 'true');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'true');
  await tabTo(previewCurrent);
  await page.keyboard.press('Enter');
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'false');
  await tabTo(previewProposed);
  await page.keyboard.press('Enter');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await visibleFocus(wording(page));
  await visibleStage(page);
  await expect.poll(() => page.locator('.stage-column').evaluate((node) =>
    node.getBoundingClientRect().top - node.closest('.editor-workbench')!.getBoundingClientRect().top)).toBeLessThanOrEqual(12);
  await page.keyboard.press('Control+a'); await page.keyboard.insertText(revisedWording);
  await expect(wording(page)).toHaveValue(revisedWording);
  await expect(proposed).toHaveAttribute('aria-pressed', 'true');
  await expect(previewProposed).toHaveAttribute('aria-pressed', 'true');
  await expect(current).toHaveAttribute('aria-pressed', 'false');
  await expect(previewCurrent).toHaveAttribute('aria-pressed', 'false');
  await visibleFocus(wording(page));
  await visibleStage(page);
  await expect(page.locator('.toast-stack > *')).toHaveCount(0);
  expect(actions).toEqual([]); await keptEvidence(page, before);
  await page.screenshot({ path: info.outputPath('proposal-wording-normal-preview-390.png'), animations: 'disabled' });
});

const editCases = [
  { width: 1440, field: 'wording', phase: 'job' }, { width: 1440, field: 'hint', phase: 'read' },
  { width: 390, field: 'hint', phase: 'job' }, { width: 390, field: 'wording', phase: 'read' },
] as const;
for (const { width, field, phase } of editCases) {
  test(`newer ${field} during the ${phase} keeps comparison focus and evidence at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); await openComparison(page);
    const before = structuredClone(state.projects[0].captions);
    const gate = deferred(); const finished = deferred(); let reads = 0;
    const next = proposal('q-next', 'សំណើថ្មី New completed take', 2);
    await page.route('**/api/jobs/refine-proposal', async (route) => {
      const queued = job('new-refinement'); state.jobs = [queued, ...state.jobs]; await route.fulfill({ status: 202, json: queued });
    });
    await page.route('**/regeneration-proposals/q-next', async (route) => {
      reads += 1; await gate.promise;
      try { await route.fulfill({ json: next }); } finally { finished.release(); }
    });
    try {
      await dock(page).getByRole('button', { name: 'Realign exact wording', exact: true }).click();
      await expect(dock(page)).toContainText('Synthetic refinement running');
      const fieldNode = field === 'wording' ? wording(page) : hint(page);
      const value = field === 'wording' ? revisedWording : revisedHint;
      if (phase === 'job') {
        await editWithKeyboard(page, field, value);
        if (width === 390) await visibleStage(page);
      }
      state.jobs = state.jobs.map((item) => item.id === 'new-refinement' ? { ...item, status: 'completed', stage: 'complete', progress: 100, message: 'New take ready', proposalId: 'q-next', updatedAt: '2026-01-02', completedAt: '2026-01-02' } : item);
      await expect.poll(() => reads).toBeGreaterThan(0);
      if (phase === 'read') {
        await editWithKeyboard(page, field, value);
        if (width === 390) await visibleStage(page);
      }
      gate.release(); await finished.promise;
      await expect(page.locator('.toast.notice').filter({ hasText: 'A new take is ready. Your current comparison is kept; open the result from Activity.' })).toBeVisible();
      await expect(fieldNode).toBeFocused(); await expect(fieldNode).toHaveValue(value);
      await visibleFocus(fieldNode);
      if (width === 390) await visibleStage(page);
      await expect(dock(page)).toContainText('Pass 1');
      await expect(wording(page)).toHaveValue(field === 'wording' ? revisedWording : 'សំណើ Khmer proposal');
      await expect(hint(page)).toHaveValue(field === 'hint' ? revisedHint : 'Initial hint');
      expect(actions).toEqual([]); await keptEvidence(page, before);
      await page.screenshot({ path: info.outputPath(`kept-comparison-${field}-${phase}-${width}.png`), animations: 'disabled' });
      const panel = await activity(page);
      await panel.locator('article').filter({ hasText: 'New take ready' }).getByRole('button', { name: 'Open result', exact: true }).click();
      await expect(wording(page)).toHaveValue('សំណើថ្មី New completed take');
      await expect(dock(page)).toContainText('Pass 2');
      await keptEvidence(page, before);
    } finally { gate.release(); }
  });
}

test('an unchanged submitted comparison still opens its completed refinement automatically', async ({ page }) => {
  await openComparison(page); const before = structuredClone(state.projects[0].captions);
  await wording(page).fill(revisedWording); await hint(page).fill(revisedHint);
  let submitted: any;
  await page.route('**/api/jobs/refine-proposal', async (route) => {
    submitted = route.request().postDataJSON();
    const queued = job('unchanged-refinement'); state.jobs = [queued, ...state.jobs]; await route.fulfill({ status: 202, json: queued });
  });
  await page.route('**/regeneration-proposals/q-next', (route) => route.fulfill({ json: proposal('q-next', 'សំណើថ្មី New completed take', 2) }));
  await dock(page).getByRole('button', { name: 'Realign exact wording', exact: true }).click();
  await expect(dock(page)).toContainText('Synthetic refinement running');
  expect(submitted).toMatchObject({ editedText: revisedWording, accuracyHint: revisedHint, strategy: 'manual-realign' });
  state.jobs = state.jobs.map((item) => item.id === 'unchanged-refinement' ? { ...item, status: 'completed', stage: 'complete', progress: 100, proposalId: 'q-next', updatedAt: '2026-01-02', completedAt: '2026-01-02' } : item);
  await expect(wording(page)).toHaveValue('សំណើថ្មី New completed take');
  await expect(dock(page)).toContainText('Pass 2');
  expect(actions).toEqual([]); await keptEvidence(page, before);
});
