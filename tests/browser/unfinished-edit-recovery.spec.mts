import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { hydrateCaptionWordTimings, type CaptionProject, type CaptionSegment, type RegenerationProposal, type TranscriptionContext } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

interface CaptionWrite {
  captions: CaptionSegment[];
  expectedMedia: { filename: string; size: number };
  recordCorrections?: boolean;
  recoveryExpectedUpdatedAt?: string;
}
interface ContextWrite {
  transcriptionContext: TranscriptionContext;
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt?: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(page: Page) {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.projects[0] = hydrateCaptionWordTimings(state.projects[0]);
  state.projects[0].captions[0].approved = true;
  state.projects[0].captions[2].approved = true;
  state.projects[0].transcriptionContext = { description: 'Saved synthetic context', vocabulary: ['SavedBrand | saved alias'] };
  const original = structuredClone(state.projects[0]);
  const captionWrites: CaptionWrite[] = [];
  const contextWrites: ContextWrite[] = [];
  const controls = {
    captionFailure: false,
    contextFailure: false,
    captionGate: undefined as Promise<void> | undefined,
    contextGate: undefined as Promise<void> | undefined,
  };
  let revision = 0;
  const nextRevision = () => new Date(Date.UTC(2026, 9, 19, 15, 0, ++revision)).toISOString();

  // These are synthetic API acknowledgments, not durable server-storage evidence.
  // Keep canonical fixture state separate from the browser's local recovery copy.
  await page.route('**/api/projects/landscape/captions', async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const body = request.postDataJSON() as CaptionWrite;
    captionWrites.push(structuredClone(body));
    state.requests.push({ path: '/api/projects/landscape/captions', method: request.method(), body });
    if (controls.captionFailure) return route.fulfill({ status: 503, json: { error: 'Synthetic caption save failure' } });
    const reply: CaptionProject = { ...structuredClone(state.projects[0]), captions: structuredClone(body.captions), updatedAt: nextRevision() };
    if (controls.captionGate) await controls.captionGate;
    state.projects[0] = structuredClone(reply);
    return route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
  });
  await page.route('**/api/projects/landscape/context', async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const body = request.postDataJSON() as ContextWrite;
    contextWrites.push(structuredClone(body));
    state.requests.push({ path: '/api/projects/landscape/context', method: request.method(), body });
    if (controls.contextFailure) return route.fulfill({ status: 503, json: { error: 'Synthetic Accuracy save failure' } });
    const reply: CaptionProject = { ...structuredClone(state.projects[0]), transcriptionContext: structuredClone(body.transcriptionContext), updatedAt: nextRevision() };
    if (controls.contextGate) await controls.contextGate;
    state.projects[0] = structuredClone(reply);
    return route.fulfill({ json: reply });
  });
  return { state, original, captionWrites, contextWrites, controls };
}

function recoveryNotice(page: Page) {
  return page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
}

async function openAccuracy(page: Page) {
  const button = page.getByRole('button', { name: /^Accuracy/ });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  return {
    description: page.getByLabel('What is this clip about?', { exact: true }),
    vocabulary: page.getByLabel('Exact terms to preserve', { exact: true }),
  };
}

async function hasUnloadGuard(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function expectCapturedWhileFocused(page: Page, field: Locator, text: string) {
  await expect(field).toBeFocused();
  // Observe the copy before dispatching beforeunload/pagehide or blurring. This
  // distinguishes per-input protection from an unload-only best effort.
  await expect.poll(() => page.evaluate((value) => Object.keys(localStorage).some((key) => {
    const raw = localStorage.getItem(key);
    return key.startsWith('sthang-studio:unfinished-edits:') && raw !== null && raw.includes(value);
  }), text)).toBe(true);
}

async function reloadAndReopen(page: Page) {
  const acceptUnload = async (dialog: import('@playwright/test').Dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  };
  page.on('dialog', acceptUnload);
  try { await page.reload(); }
  finally { page.off('dialog', acceptUnload); }
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
}

async function finishResponse(page: Page, suffix: string, release: () => void) {
  const response = page.waitForResponse((value) => value.url().endsWith(suffix) && value.request().method() === 'PUT');
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function expectRestoreUnavailable(notice: Locator) {
  const enabledRestore = notice.getByRole('button', { name: 'Restore draft', exact: true }).and(notice.locator('button:enabled'));
  await expect(enabledRestore).toHaveCount(0);
  await expect(notice.getByRole('button', { name: 'Download draft', exact: true })).toBeEnabled();
  await expect(notice.getByRole('button', { name: 'Discard draft', exact: true })).toBeEnabled();
}

function noLearningOrGeneration(state: FixtureState) {
  expect(state.profile.correctionEvents).toEqual([]);
  expect(state.requests.filter((request) => request.method === 'POST' &&
    /(?:\/jobs|\/transcribe|\/regenerate-range|\/refine-proposal|\/postprocess-timing|\/resegment|\/caption-word-timing(?:\/batch-apply)?|\/corrections|\/contribution(?:\/|$))/.test(request.path))).toEqual([]);
}

test('clean sessions and normalized Accuracy fields do not install an unload guard or create recovery', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  expect(await hasUnloadGuard(page)).toBe(false);
  const fields = await openAccuracy(page);
  await fields.description.fill(`  ${f.original.transcriptionContext!.description}  `);
  await fields.vocabulary.fill('  SavedBrand | saved alias  \n\n');
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(await hasUnloadGuard(page)).toBe(false);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(recoveryNotice(page)).toHaveCount(0);
  expect(f.captionWrites).toEqual([]);
  expect(f.contextWrites).toEqual([]);
});

test('a focused unsaved caption survives reload and explicit recovery without approval or stale timing', async ({ page }, testInfo) => {
  const f = await fixture(page);
  const text = 'សួស្តីអតិថិជន TS១១ រក្សាសេចក្ដីព្រាង';
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill(text);
  await expectCapturedWhileFocused(page, caption, text);
  expect(f.captionWrites).toEqual([]);
  expect(await hasUnloadGuard(page)).toBe(true);
  await reloadAndReopen(page);

  const notice = recoveryNotice(page);
  await expect(notice).toContainText('Unfinished edits found');
  await expect(notice.getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await expect(caption).toHaveValue(f.original.captions[0].text);
  expect(f.state.projects[0].captions).toEqual(f.original.captions);
  expect(f.captionWrites).toEqual([]);
  for (const viewport of [{ width: 1440, height: 1000, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const box = await notice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    await notice.screenshot({ path: testInfo.outputPath(`unfinished-recovery-${viewport.name}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await notice.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(caption).toHaveValue(text);
  expect(f.captionWrites).toEqual([]);
  expect(f.state.projects[0].captions[0].text).toBe(f.original.captions[0].text);
  expect(await hasUnloadGuard(page)).toBe(true);

  const savedBasis = f.state.projects[0].updatedAt;
  await page.locator('.save-action').click();
  await expect.poll(() => f.captionWrites.length).toBe(1);
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(f.captionWrites[0].recordCorrections).toBe(false);
  expect(f.captionWrites[0].recoveryExpectedUpdatedAt).toBe(savedBasis);
  expect(f.captionWrites[0].captions[0]).toMatchObject({ text, approved: false });
  expect(f.captionWrites[0].captions[2]).toEqual(f.original.captions[2]);
  const recoveredTiming = f.captionWrites[0].captions[0].wordTiming;
  if (recoveredTiming) {
    expect(recoveredTiming.text).toBe(text);
    expect(recoveredTiming.words.every((word) => word.needsReview === true)).toBe(true);
  }
  expect(await hasUnloadGuard(page)).toBe(false);
  noLearningOrGeneration(f.state);
  await reloadAndReopen(page);
  await expect(caption).toHaveValue(text);
  await expect(recoveryNotice(page)).toHaveCount(0);
});

test('a failed caption save remains actionable after notice expiry and Retry save clears the guard', async ({ page }, testInfo) => {
  const f = await fixture(page);
  f.controls.captionFailure = true;
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill('A failed save must keep this unfinished correction');
  // Blurring into an unchanged caption submits exactly one text-edit save.
  await page.getByLabel('Caption 2 text', { exact: true }).focus();
  const failure = page.getByRole('alert').filter({ hasText: "Couldn't save changes" });
  await expect(failure).toBeVisible();
  await expect.poll(() => f.captionWrites.length).toBe(1);
  expect(await hasUnloadGuard(page)).toBe(true);
  // The ordinary notice timeout is 4.2 seconds. This failure must outlive it,
  // and must not restart repeated autosaves while the failure is unresolved.
  await page.waitForTimeout(4600);
  await expect(failure).toBeVisible();
  expect(f.captionWrites).toHaveLength(1);
  await failure.screenshot({ path: testInfo.outputPath('unfinished-save-failure.png') });
  await expect(caption).toHaveValue('A failed save must keep this unfinished correction');
  expect(f.state.projects[0].captions).toEqual(f.original.captions);

  f.controls.captionFailure = false;
  await failure.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect.poll(() => f.captionWrites.length).toBe(2);
  await expect(failure).toHaveCount(0);
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(f.state.projects[0].captions[0].text).toBe('A failed save must keep this unfinished correction');
  expect(await hasUnloadGuard(page)).toBe(false);
});

test('Accuracy-only edits block failed navigation and recover independently of saved captions', async ({ page }) => {
  const f = await fixture(page);
  f.controls.contextFailure = true;
  await openProject(page);
  const fields = await openAccuracy(page);
  const description = 'Unfinished context for the TS11 agricultural cargo clip';
  const vocabulary = 'TS11 | TS១១\nកំពង់ផែ';
  await fields.description.fill(description);
  await fields.vocabulary.fill(vocabulary);
  await expectCapturedWhileFocused(page, fields.vocabulary, 'កំពង់ផែ');
  expect(await hasUnloadGuard(page)).toBe(true);
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: "Couldn't save changes" })).toBeVisible();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
  await expect(fields.description).toHaveValue(description);
  expect(f.contextWrites).toHaveLength(1);
  expect(f.captionWrites).toEqual([]);
  expect(f.state.projects[0]).toEqual(f.original);

  await reloadAndReopen(page);
  await expect(recoveryNotice(page)).toBeVisible();
  expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
  await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
  const restoredFields = await openAccuracy(page);
  await expect(restoredFields.description).toHaveValue(description);
  await expect(restoredFields.vocabulary).toHaveValue(vocabulary);
  expect(f.contextWrites).toHaveLength(1);
  expect(await hasUnloadGuard(page)).toBe(true);

  f.controls.contextFailure = false;
  await page.locator('.save-action').click();
  await expect.poll(() => f.contextWrites.length).toBe(2);
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(f.contextWrites[1].expectedUpdatedAt).toBe(f.original.updatedAt);
  expect(f.state.projects[0].transcriptionContext).toEqual({ description, vocabulary: ['TS11 | TS១១', 'កំពង់ផែ'] });
  expect(f.state.projects[0].captions).toEqual(f.original.captions);
  expect(f.captionWrites).toEqual([]);
  expect(await hasUnloadGuard(page)).toBe(false);
  noLearningOrGeneration(f.state);
});

for (const changed of ['captions', 'Accuracy context', 'media'] as const) {
  test(`a recovery copy is refused when saved ${changed} changed, while download and discard stay available`, async ({ page }) => {
    const f = await fixture(page);
    const text = 'Local-only unfinished text kept for comparison';
    await openProject(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill(text);
    await expectCapturedWhileFocused(page, caption, text);
    if (changed === 'captions') f.state.projects[0].captions[0].text = 'A different saved correction';
    if (changed === 'Accuracy context') f.state.projects[0].transcriptionContext = { description: 'Context saved in another session', vocabulary: ['OtherBrand'] };
    if (changed === 'media') f.state.projects[0].media = { ...f.state.projects[0].media, filename: 'replacement.mp4', originalName: 'replacement.mp4', url: '/media/replacement.mp4', size: 7777 };
    f.state.projects[0].updatedAt = '2026-10-19T16:00:00.000Z';
    const currentCanonical = structuredClone(f.state.projects[0]);
    await reloadAndReopen(page);
    const notice = recoveryNotice(page);
    await expect(notice).toBeVisible();
    await expectRestoreUnavailable(notice);
    await expect(caption).toHaveValue(currentCanonical.captions[0].text);
    expect(f.captionWrites).toEqual([]);
    expect(f.contextWrites).toEqual([]);

    if (changed === 'media') {
      const download = page.waitForEvent('download');
      await notice.getByRole('button', { name: 'Download draft', exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('sthang-unfinished-draft.json');
      const copy = JSON.parse(await fs.readFile((await file.path())!, 'utf8'));
      expect(copy.projectId).toBe('landscape');
      expect(copy.captions[0].text).toBe(text);
      await notice.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await page.getByRole('alertdialog', { name: 'Discard this recovery draft?', exact: true })
        .getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(notice).toHaveCount(0);
      expect(f.state.projects[0]).toEqual(currentCanonical);
    }
    noLearningOrGeneration(f.state);
  });
}

test('Restore draft rechecks canonical state after offering recovery and refuses a newly stale basis', async ({ page }) => {
  const f = await fixture(page);
  const text = 'Draft awaiting an explicit restore decision';
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  await caption.fill(text);
  await expectCapturedWhileFocused(page, caption, text);
  await reloadAndReopen(page);
  const notice = recoveryNotice(page);
  await expect(notice.getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  const readsBefore = f.state.requests.filter((request) => request.method === 'GET' && request.path === '/api/projects/landscape').length;
  f.state.projects[0].captions[2].text = 'Saved elsewhere after this recovery offer';
  f.state.projects[0].updatedAt = '2026-10-19T17:00:00.000Z';
  await notice.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect.poll(() => f.state.requests.filter((request) => request.method === 'GET' && request.path === '/api/projects/landscape').length).toBeGreaterThan(readsBefore);
  await expectRestoreUnavailable(notice);
  await expect(caption).not.toHaveValue(text);
  expect(f.state.projects[0].captions[2].text).toBe('Saved elsewhere after this recovery offer');
  expect(f.captionWrites).toEqual([]);
  expect(f.contextWrites).toEqual([]);
  noLearningOrGeneration(f.state);
});

test('an unrelated full-project reply cannot rebase recovered edits onto another session\'s changed caption', async ({ page }) => {
  const f = await fixture(page);
  const proposal: RegenerationProposal = {
    id: 'synthetic-recovery-proposal', projectId: 'landscape', projectTitle: f.original.title,
    createdAt: '2026-10-19T10:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    startMs: 0, endMs: 1000, lockedCaptionsPreserved: 0, unchangedCount: 1,
    changes: [], currentCaptions: [structuredClone(f.original.captions[0])],
    proposedCaptions: [structuredClone(f.original.captions[0])], passNumber: 1, strategy: 'standard',
  };
  f.state.jobs = [{
    id: 'synthetic-completed-proposal', type: 'regenerate-range', projectId: 'landscape', projectTitle: f.original.title,
    status: 'completed', stage: 'completed', progress: 100, message: 'Synthetic completed proposal ready for review',
    canResume: false, createdAt: proposal.createdAt, updatedAt: proposal.createdAt, completedAt: proposal.createdAt,
    proposalId: proposal.id,
  }];
  await page.route(`**/api/projects/landscape/regeneration-proposals/${proposal.id}`, (route) => route.fulfill({ json: proposal }));
  const rejections: Array<{ mode: string }> = [];
  await page.route(`**/api/projects/landscape/regeneration-proposals/${proposal.id}/apply`, async (route) => {
    const body = route.request().postDataJSON() as { mode: string };
    rejections.push(body);
    expect(body.mode).toBe('reject');
    f.state.requests.push({ path: `/api/projects/landscape/regeneration-proposals/${proposal.id}/apply`, method: route.request().method(), body });
    // Rejecting does not change captions; its full-project reply reports the
    // canonical state, including another session's already-saved caption B.
    return route.fulfill({ json: structuredClone(f.state.projects[0]) });
  });

  const recoveredA = 'Recovered caption A stays local while the proposal is discarded';
  const foreignB = 'Caption B was saved by another session';
  await openProject(page);
  const captionA = page.getByLabel('Caption 1 text', { exact: true });
  const captionB = page.getByLabel('Caption 2 text', { exact: true });
  await captionA.fill(recoveredA);
  await expectCapturedWhileFocused(page, captionA, recoveredA);
  await reloadAndReopen(page);

  // Open the existing completed proposal while the editor is still canonical,
  // before restoring A. Opening Activity after restore would save A first.
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  const dock = page.getByRole('region', { name: 'Live regeneration review', exact: true });
  await expect(dock).toBeVisible();
  await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(captionA).toHaveValue(recoveredA);
  await expect(dock).toBeVisible();
  expect(f.captionWrites).toEqual([]);

  f.state.projects[0].captions[1].text = foreignB;
  f.state.projects[0].updatedAt = '2026-10-19T18:00:00.000Z';
  await dock.getByRole('button', { name: 'Keep current', exact: true }).click();
  await expect(dock).toHaveCount(0);
  expect(rejections).toHaveLength(1);
  await expect(captionA).toHaveValue(recoveredA);
  await expect(captionB).toHaveValue(f.original.captions[1].text);
  expect(f.state.projects[0].captions[1].text).toBe(foreignB);
  expect(f.captionWrites).toEqual([]);

  await reloadAndReopen(page);
  await expect(captionA).toHaveValue(f.original.captions[0].text);
  await expect(captionB).toHaveValue(foreignB);
  await expect(recoveryNotice(page)).toBeVisible();
  await expectRestoreUnavailable(recoveryNotice(page));
  expect(f.state.projects[0].captions[1].text).toBe(foreignB);
  expect(f.captionWrites).toEqual([]);
  expect(f.contextWrites).toEqual([]);
  noLearningOrGeneration(f.state);
});

test('a delayed caption acknowledgment cannot delete the newer focused edit or its reload recovery', async ({ page }) => {
  const f = await fixture(page);
  const gate = deferred();
  f.controls.captionGate = gate.promise;
  const submitted = 'First caption version sent to save';
  const newer = 'Newer caption typed while its older version saves';
  try {
    await openProject(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    await caption.fill(submitted);
    await page.keyboard.press('Control+s');
    await expect.poll(() => f.captionWrites.length).toBe(1);
    await caption.fill(newer);
    await expectCapturedWhileFocused(page, caption, newer);
    await finishResponse(page, '/captions', gate.resolve);
    await expect(caption).toHaveValue(newer);
    expect(f.state.projects[0].captions[0].text).toBe(submitted);
    expect(await hasUnloadGuard(page)).toBe(true);
    await reloadAndReopen(page);
    await expect(caption).toHaveValue(submitted);
    await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
    await expect(caption).toHaveValue(newer);
    expect(f.captionWrites).toHaveLength(1);
    expect(f.state.projects[0].captions[0].text).toBe(submitted);
  } finally { gate.resolve(); }
});

test('a delayed Accuracy acknowledgment retains newer context in the editor and in recovery', async ({ page }) => {
  const f = await fixture(page);
  const gate = deferred();
  f.controls.contextGate = gate.promise;
  try {
    await openProject(page);
    const fields = await openAccuracy(page);
    await fields.description.fill('First submitted Accuracy description');
    await page.getByRole('button', { name: 'Save for project', exact: true }).click();
    await expect.poll(() => f.contextWrites.length).toBe(1);
    const newer = 'Newer Accuracy description typed during its older save';
    await fields.description.fill(newer);
    await expectCapturedWhileFocused(page, fields.description, newer);
    await finishResponse(page, '/context', gate.resolve);
    await expect(fields.description).toHaveValue(newer);
    expect(f.state.projects[0].transcriptionContext?.description).toBe('First submitted Accuracy description');
    expect(await hasUnloadGuard(page)).toBe(true);
    await reloadAndReopen(page);
    await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
    const restoredFields = await openAccuracy(page);
    await expect(restoredFields.description).toHaveValue(newer);
    expect(f.contextWrites).toHaveLength(1);
    expect(f.captionWrites).toEqual([]);
  } finally { gate.resolve(); }
});

test('reverting Accuracy to its old baseline during a pending save stays protected and saves the final value before leaving', async ({ page }) => {
  const f = await fixture(page);
  const gate = deferred();
  f.controls.contextGate = gate.promise;
  const baseline = f.original.transcriptionContext!.description!;
  const submitted = 'Intermediate Accuracy value already sent to the server';
  try {
    await openProject(page);
    const fields = await openAccuracy(page);
    await fields.description.fill(submitted);
    await page.getByRole('button', { name: 'Save for project', exact: true }).click();
    await expect.poll(() => f.contextWrites.length).toBe(1);
    await fields.description.fill(baseline);
    await expect(fields.description).toBeFocused();
    // Read the actual editable recovery field. A substring search would pass
    // incorrectly because the old baseline also appears in the saved basis.
    await expect.poll(() => page.evaluate((value) => Object.keys(localStorage).some((key) => {
      if (!key.startsWith('sthang-studio:unfinished-edits:')) return false;
      try { return JSON.parse(localStorage.getItem(key) || 'null')?.accuracy?.description === value; }
      catch { return false; }
    }), baseline)).toBe(true);
    expect(await hasUnloadGuard(page)).toBe(true);
    expect(f.contextWrites).toHaveLength(1);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
    await expect(fields.description).toHaveValue(baseline);
    expect(f.contextWrites).toHaveLength(1);

    await finishResponse(page, '/context', gate.resolve);
    await expect.poll(() => f.contextWrites.length).toBe(2);
    await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
    expect(f.contextWrites.map((write) => write.transcriptionContext.description)).toEqual([submitted, baseline]);
    expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
    expect(f.captionWrites).toEqual([]);
    expect(await hasUnloadGuard(page)).toBe(false);
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    const reopened = await openAccuracy(page);
    await expect(reopened.description).toHaveValue(baseline);
    await expect(recoveryNotice(page)).toHaveCount(0);
  } finally { gate.resolve(); }
});

test('Khmer composition blocks forced saving and preserves the composition-final text without blur', async ({ page }) => {
  const f = await fixture(page);
  await openProject(page);
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  const partial = 'សេចក្ដីព្រា';
  const final = 'សេចក្ដីព្រាងភាសាខ្មែរដែលមិនទាន់រក្សាទុក';
  await caption.focus();
  await caption.dispatchEvent('compositionstart', { data: '' });
  await caption.evaluate((element: HTMLTextAreaElement, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
  }, partial);
  await expect(caption).toHaveValue(partial);
  await expect(page.locator('.save-action')).toBeDisabled();
  await page.keyboard.press('Control+s');
  expect(f.captionWrites).toEqual([]);
  await caption.evaluate((element: HTMLTextAreaElement, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, final);
  await expect(caption).toHaveValue(final);
  await expectCapturedWhileFocused(page, caption, final);
  expect(f.captionWrites).toEqual([]);
  expect(await hasUnloadGuard(page)).toBe(true);
  await reloadAndReopen(page);
  await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(caption).toHaveValue(final);
  expect(f.captionWrites).toEqual([]);
  noLearningOrGeneration(f.state);
});
