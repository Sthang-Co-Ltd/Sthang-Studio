import { test, expect, type Locator, type Page } from '@playwright/test';
import { openPanelArrangement } from './editor-layout-tools.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

let state: FixtureState;
let failure = false;
let hold: Promise<void> | undefined;
let modelWrites: any[];
let submissions: any[];
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); failure = false; hold = undefined; modelWrites = []; submissions = [];
  await page.route('**/api/projects/*/generation-model', async (route) => {
    const body = route.request().postDataJSON(); modelWrites.push(body);
    await hold;
    if (failure) return route.fulfill({ status: 500, json: { error: 'Could not save AI options. Try again.' } });
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const current = state.projects.find((p) => p.id === id)!;
    current.generationModel = body.generationModel;
    return route.fulfill({ json: current });
  });
  await page.route('**/api/jobs/transcribe', (route) => submit(route));
  await page.route('**/api/jobs/regenerate-range', (route) => submit(route));
  function submit(route: any) {
    const body = route.request().postDataJSON(); submissions.push(body);
    const job = { id: 'generation-fixture', type: 'transcribe' as const, projectId: body.projectId, projectTitle: 'Synthetic', status: 'queued' as const, stage: 'queued', progress: 0, message: 'Queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canResume: false };
    state.jobs = [job]; return route.fulfill({ status: 202, json: job });
  }
});
async function initialProject(page: Page) {
  state.projects[0].transcript = null; state.projects[0].captions = [];
  await openProject(page);
}
const modelNames = {
  automatic: 'Automatic', 'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen', 'gemini-3.6-flash': 'Gemini 3.6 Flash',
} as const;
type ModelId = keyof typeof modelNames;
const modelGroup = (page: Page) => page.getByRole('group', { name: 'Caption model', exact: true });
const applyModel = (page: Page) => page.getByRole('button', { name: 'Apply model', exact: true });
const radio = (group: Locator, id: ModelId) => group.getByRole('radio', { name: modelNames[id], exact: true });
const modelRow = (group: Locator, id: ModelId) => group.locator('label').filter({ hasText: modelNames[id] });
async function expectModelMark(container: Locator, id: ModelId) {
  const mark = container.locator('.generation-model-mark');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('data-model-family', id === 'automatic' ? 'automatic' : 'gemini');
  if (id !== 'automatic') {
    await expect.poll(() => mark.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  }
}
async function expectSummaryModel(page: Page, id: ModelId) {
  const summary = page.locator('.generation-options > summary');
  await expect(summary).toContainText(modelNames[id]);
  await expectModelMark(summary, id);
}
async function options(page: Page) {
  const details = page.locator('.generation-options');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return modelGroup(page);
}

for (const missingKey of [true, false]) {
  const actionName = missingKey ? 'Connect AI' : 'Open System check';
  test(`generation setup opens ${actionName} when timing is unavailable without submitting a job`, async ({ page }) => {
    state.projects[0].transcript = null;
    state.projects[0].captions = [];
    const [healthResponse, settingsResponse] = await Promise.all([
      page.waitForResponse('**/api/health'),
      page.waitForResponse('**/api/system/llm-settings'),
      page.goto('/'),
    ]);
    const health = await healthResponse.json();
    const settings = { ...await settingsResponse.json(), configured: !missingKey };
    await page.route('**/api/health', (route) => route.fulfill({ json: {
      ...health, llm: settings, timing: { ...health.timing, configured: false },
    } }));
    await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: settings }));
    await page.route('**/api/system/doctor', (route) => route.fulfill({ json: {
      generatedAt: '2026-01-01T00:00:00.000Z', engineVersion: 'synthetic', overall: 'warning', checks: [],
      environment: { platform: 'Synthetic Windows', node: 'test', appRoot: 'Synthetic app', apiPort: 1, webOrigin: 'http://127.0.0.1' },
    } }));
    await page.reload();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    const workspace = page.getByRole('complementary', { name: 'Generate captions workspace' });
    await expect(workspace.getByText('Ready to generate captions', { exact: true })).toHaveCount(0);
    await workspace.getByRole('button', { name: actionName, exact: true }).press('Enter');
    if (missingKey) await expect(dialog.getByLabel('API key', { exact: true })).toBeVisible();
    else await expect(dialog.locator('#system-check-status')).toBeAttached();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.toast.error')).toHaveCount(0);
    expect(submissions).toHaveLength(0);
  });
}

async function mockCaptionSetup(page: Page) {
  const setup = { key: false, timing: false, healthUnavailable: false, rejectKey: false, saves: 0 };
  const settings = () => ({ provider: 'gemini', configured: setup.key, keySource: setup.key ? 'secure-store' : 'none', model: 'synthetic',
    fallbackModel: '', maskedKey: null, canForgetSecureKey: setup.key, secureStorageAvailable: true, secureStorageLabel: 'Fixture storage', environmentFallbackAvailable: false, updatedAt: null });
  await page.route('**/api/health', (route) => route.fulfill(setup.healthUnavailable ? { status: 503, json: { error: 'Status unavailable' } }
    : { json: { ok: true, engineVersion: 'fixture', llm: settings(), timing: { configured: setup.timing } } }));
  await page.route('**/api/system/llm-settings/test', (route) => route.fulfill(setup.rejectKey ? { status: 401, json: { error: 'The fixture key was rejected.' } }
    : { json: { ok: true, level: 'success', provider: 'gemini', model: 'synthetic', latencyMs: 1, message: 'Connection checked.' } }));
  await page.route('**/api/system/llm-settings', (route) => {
    if (route.request().method() === 'PUT') { setup.key = true; setup.saves++; }
    return route.fulfill({ json: settings() });
  });
  await page.route('**/api/system/doctor', (route) => route.fulfill({ json: { generatedAt: '2026-01-01T00:00:00.000Z', engineVersion: 'fixture',
    overall: setup.timing ? 'ok' : 'error', checks: [{ id: 'kfa', label: 'Khmer timing', status: setup.timing ? 'ok' : 'error', detail: setup.timing ? 'Ready' : 'Setup required' }],
    environment: { platform: 'Fixture', node: 'test', appRoot: 'Fixture', apiPort: 1, webOrigin: 'http://127.0.0.1' } } }));
  return setup;
}

test('caption setup advances from a rejected key through a repaired timing check without starting a job', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const setup = await mockCaptionSetup(page);
  await initialProject(page);
  const action = page.locator('.transcribe-card button.primary');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(action).toHaveText('Connect AI');
  await action.press('Enter');
  await dialog.getByLabel('API key', { exact: true }).fill('synthetic-key');
  const save = dialog.getByRole('button', { name: 'Test & save', exact: true });
  setup.rejectKey = true;
  await save.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('The fixture key was rejected.');
  await expect(save).toBeFocused();
  expect(setup.saves).toBe(0);
  setup.rejectKey = false;
  await save.press('Enter');
  await expect(dialog.getByText(/AI settings saved securely/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).press('Enter');
  await expect(action).toHaveText('Open System check');
  await expect(action).toBeFocused();
  await action.press('Enter');
  await expect(dialog.getByText('Setup needs attention', { exact: true })).toBeVisible();
  setup.timing = true;
  setup.healthUnavailable = true;
  await dialog.getByRole('button', { name: 'Run checks', exact: true }).press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('could not confirm caption setup');
  await expect(action).toHaveText('Retry setup checks');
  const retry = dialog.getByRole('button', { name: 'Retry system check', exact: true });
  await expect(retry).toBeFocused();
  setup.healthUnavailable = false;
  await retry.press('Enter');
  await expect(dialog.getByText('System checks passed', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).press('Enter');
  await expect(action).toHaveText('Generate captions');
  await expect(action).toBeFocused();
  await expect(action).toBeEnabled();
  expect(setup.saves).toBe(1);
  expect(submissions).toHaveLength(0);
});

test('late startup and key-save health reads cannot reverse a newer timing check', async ({ page }) => {
  const setup = await mockCaptionSetup(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let hold = true, started = 0, finished = 0;
  await page.route('**/api/health', async (route) => {
    if (!hold) return route.fallback();
    started++;
    await pending;
    await route.fulfill({ json: { ok: true, engineVersion: 'fixture', timing: { configured: false } } });
    finished++;
  });
  try {
    await initialProject(page);
    const action = page.locator('.transcribe-card button.primary');
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect.poll(() => started).toBeGreaterThan(0);
    const startupReads = started;
    await action.press('Enter');
    await dialog.getByLabel('API key', { exact: true }).fill('synthetic-key');
    await dialog.getByRole('button', { name: 'Test & save', exact: true }).press('Enter');
    await expect.poll(() => started).toBeGreaterThan(startupReads);
    hold = false;
    setup.timing = true;
    await dialog.getByRole('button', { name: 'System check', exact: true }).click();
    await dialog.getByRole('button', { name: 'Run checks', exact: true }).click();
    await expect(dialog.getByText('System checks passed', { exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(started);
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(action).toHaveText('Generate captions');
    await expect(action).toBeEnabled();
    expect(submissions).toHaveLength(0);
  } finally { release(); }
});

test('generation stays unavailable while submission is pending and while the accepted job is queued', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/jobs/transcribe', async (route) => {
    attempts++;
    await pending;
    await route.fallback();
  });
  await initialProject(page);
  const primary = page.locator('.transcribe-card button.primary');
  try {
    await primary.click();
    await expect.poll(() => attempts).toBe(1);
    await expect(primary).toBeDisabled();
    await expect(primary).not.toHaveText('Generate captions');
  } finally { release(); }
  await page.getByRole('button', { name: 'Close Activity', exact: true }).click();
  await expect(primary).toBeDisabled();
  await expect(primary).not.toHaveText('Generate captions');
  expect(submissions).toHaveLength(1);
});

test('optional Accuracy entry reflects saved project context', async ({ page }, info) => {
  await page.route('**/api/projects/landscape/context', (route) => {
    const { transcriptionContext } = route.request().postDataJSON();
    state.projects[0].transcriptionContext = transcriptionContext;
    return route.fulfill({ json: state.projects[0] });
  });
  await initialProject(page);
  const generate = page.getByRole('complementary', { name: 'Generate captions workspace' });
  const add = generate.getByRole('button', { name: 'Add context', exact: true });
  const edit = generate.getByRole('button', { name: 'Edit context', exact: true });
  const accuracy = page.getByRole('complementary', { name: 'Accuracy workspace' });
  const description = accuracy.getByLabel('What is this video about?', { exact: true });
  const close = accuracy.getByRole('button', { name: 'Close tool', exact: true });
  const toolbarAccuracy = page.getByRole('button', { name: 'Accuracy', exact: true });
  await expect(toolbarAccuracy).toHaveCount(0);
  await expect((await openPanelArrangement(page)).getByRole('button', { name: 'Reset layout', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(generate.getByText('Optional', { exact: true })).toBeVisible();
  await expect(generate.getByRole('button', { name: 'Generate captions', exact: true })).toBeEnabled();
  const row = generate.locator('.generation-accuracy');
  await expect(row.locator('+ .generation-options')).toBeVisible();
  await generate.screenshot({ path: info.outputPath('accuracy-entry-desktop.png') });

  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator('.editor-toolbar')).toBeHidden();
  await add.scrollIntoViewIfNeeded();
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('accuracy-entry-mobile.png') });
  await add.press('Enter');
  await expect(description).toBeFocused();
  await expect(toolbarAccuracy).toHaveAttribute('aria-pressed', 'true');
  await description.fill('A clip about the Studio launch.');
  await close.click();
  await expect(add).toBeFocused();
  await add.click();
  await expect(description).toHaveValue('A clip about the Studio launch.');
  await accuracy.getByRole('button', { name: 'Save for this project', exact: true }).click();
  await expect(page.getByText('Accuracy context saved.', { exact: true })).toBeVisible();
  await close.click();
  await expect(edit).toBeFocused();
  await expect(toolbarAccuracy).toHaveCount(0);

  await openProject(page);
  await edit.click();
  await expect(description).toHaveValue('A clip about the Studio launch.');
  await description.press('Escape');
  await expect(edit).toBeFocused();
  expect(submissions).toHaveLength(0);
});

test('closing Accuracy with its active toolbar button focuses Add context', async ({ page }) => {
  await initialProject(page);
  const entry = page.getByRole('button', { name: 'Add context', exact: true });
  const toolbarAccuracy = page.getByRole('button', { name: 'Accuracy', exact: true });
  await entry.press('Enter');
  await expect(toolbarAccuracy).toHaveAttribute('aria-pressed', 'true');
  await toolbarAccuracy.press('Enter');
  await expect(toolbarAccuracy).toHaveCount(0);
  await expect(entry).toBeFocused({ timeout: 2000 });
});

for (const key of ['Enter', 'Escape']) {
  test(`closing legacy Accuracy from the inspector with ${key} focuses Edit context`, async ({ page }) => {
    state.projects[0].transcript!.tokens = [];
    state.projects[0].transcriptionContext = { description: '', vocabulary: ['Studio'] };
    await openProject(page);
    await page.getByRole('button', { name: 'Fine timing', exact: true }).press('Enter');
    const toolbarAccuracy = page.getByRole('button', { name: 'Accuracy', exact: true });
    await toolbarAccuracy.press('Enter');
    const accuracy = page.getByRole('complementary', { name: 'Accuracy workspace' });
    await accuracy.getByRole('button', { name: 'Close tool', exact: true }).press(key);
    await expect(toolbarAccuracy).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit context', exact: true })).toBeFocused({ timeout: 2000 });
    await expect(page.getByRole('button', { name: 'Fine timing', exact: true })).toBeVisible();
  });
}

test('closing Accuracy cannot move focus after leaving the project', async ({ page }) => {
  Object.assign(state.projects[1], {
    transcript: null, captions: [], transcriptionContext: { description: '', vocabulary: ['Second project'] },
  });
  await initialProject(page);
  await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
  const close = page.getByRole('button', { name: 'Close tool', exact: true });
  const heldFrames = await close.evaluate((button: HTMLButtonElement) => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => frames.push(callback);
    try { button.click(); }
    finally { window.requestAnimationFrame = requestFrame; }
    (window as Window & { releaseAccuracyCloseFrames?: () => void }).releaseAccuracyCloseFrames = () => {
      for (const frame of frames) frame(performance.now());
    };
    return frames.length;
  });
  expect(heldFrames).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Add context', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.getByRole('button', { name: 'Edit context', exact: true })).toBeVisible();
  const generate = page.getByRole('button', { name: 'Generate captions', exact: true });
  await generate.focus();
  await page.evaluate(() => (window as Window & { releaseAccuracyCloseFrames?: () => void }).releaseAccuracyCloseFrames!());
  await expect(generate).toBeFocused();
});

for (const surface of ['Generate', 'Accuracy'] as const) {
  test(`AI options is clickable and keyboard-usable in ${surface} across viewport sizes`, async ({ page }, info) => {
    if (surface === 'Generate') await initialProject(page);
    else {
      await openProject(page);
      await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
    }
    const disclosure = page.locator('.generation-options');
    const summary = disclosure.locator(':scope > summary');
    const group = modelGroup(page);
    for (const [width, height] of [[1440, 1000], [1183, 1244], [320, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(group).toBeHidden();
      await expectSummaryModel(page, 'automatic');
      await summary.evaluate((node) => { node.blur(); node.scrollIntoView({ block: 'start' }); });
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await summary.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`ai-options-${width}-closed.png`) });
      await summary.click();
      await expect(group).toBeVisible();
      await expect(radio(group, 'automatic')).toBeChecked();
      for (const id of Object.keys(modelNames) as ModelId[]) {
        const row = modelRow(group, id);
        await expect(radio(group, id)).toHaveValue(id);
        await expectModelMark(row, id);
        expect(await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (width === 320) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await disclosure.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await summary.focus();
      await summary.press('Enter');
      await expect(group).toBeHidden();
      await summary.press('Enter');
      await expect(group).toBeVisible();
      expect(await summary.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
      await summary.evaluate((node) => { node.blur(); node.scrollIntoView({ block: 'start' }); });
      if (width >= 1200) {
        await page.locator('.workspace-inspector').screenshot({ path: info.outputPath(`ai-options-${width}-open.png`) });
        await summary.hover();
        await page.locator('.workspace-inspector').screenshot({ path: info.outputPath('ai-options-hover.png') });
        await page.mouse.move(0, 0);
      } else await page.screenshot({ path: info.outputPath(`ai-options-${width}-open.png`) });
      await summary.focus();
      await summary.press('Enter');
    }
    expect(modelWrites).toHaveLength(0);
    expect(submissions).toHaveLength(0);
  });
}

test('Generate offers all four choices, saves Hydrogen per project, survives reopening, and never writes global settings', async ({ page }) => {
  await initialProject(page);
  const group = await options(page);
  await expect(radio(group, 'automatic')).toBeChecked();
  await expect(group.locator('label')).toHaveText(Object.values(modelNames));
  for (const value of ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-4-hydrogen', 'automatic', 'gemini-4-hydrogen'] as const) {
    await modelRow(group, value).click();
    await expect(radio(group, value)).toBeEnabled();
    await expect(radio(group, value)).toBeChecked();
    await expect(group.locator('.generation-model-check')).toHaveCount(1);
    await expect(modelRow(group, value).locator('.generation-model-check')).toBeVisible();
    await applyModel(page).click();
    await expectSummaryModel(page, value);
  }
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  await expectSummaryModel(page, 'automatic');
  await expect(radio(await options(page), 'automatic')).toBeChecked();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(modelGroup(page)).toBeHidden();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await expect(radio(await options(page), 'gemini-4-hydrogen')).toBeChecked();
  expect(modelWrites).toHaveLength(5);
  expect(state.requests.filter((r) => r.path === '/api/system/llm-settings' && r.method !== 'GET')).toEqual([]);
});

test('Generate waits for Apply and submits saved Hydrogen with a different draft', async ({ page }) => {
  const { transcript, captions } = state.projects[0];
  await initialProject(page); const group = await options(page);
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  await modelRow(group, 'gemini-4-hydrogen').click();
  await applyModel(page).click();
  await expect(group.getByRole('radio', { disabled: true })).toHaveCount(4);
  await expectSummaryModel(page, 'automatic');
  await expect(page.getByRole('button', { name: 'Generate captions', exact: true })).toBeDisabled();
  expect(submissions).toHaveLength(0);
  release();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await modelRow(group, 'gemini-3.6-flash').click();
  await expect(radio(group, 'gemini-3.6-flash')).toBeChecked();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].generationModel).toBe('gemini-4-hydrogen');
  expect(modelWrites).toHaveLength(1);
  await page.getByRole('button', { name: 'Close Activity', exact: true }).click();
  Object.assign(state.projects[0], { transcript, captions });
  state.jobs = [{ ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100, resultProjectId: 'landscape' }];
  await expect(page.getByText('Captions are ready. Watch them on the video, then check 2 flagged captions in Review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add context', exact: true })).toHaveCount(0);
  const toolbarAccuracy = page.getByRole('button', { name: 'Accuracy', exact: true });
  await toolbarAccuracy.press('Enter');
  await expect(page.getByRole('button', { name: 'Improve all captions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close tool', exact: true }).press('Enter');
  await expect(toolbarAccuracy).toBeFocused();
});

test('failed Apply preserves captions and the saved summary and can retry the same draft', async ({ page }) => {
  const captions = structuredClone(state.projects[0].captions);
  await openProject(page); await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  const group = await options(page); failure = true;
  await modelRow(group, 'gemini-3.8-flash').click();
  await applyModel(page).click();
  await expect(page.getByText('Could not save AI options. Try again.', { exact: true })).toBeVisible();
  await expect(radio(group, 'gemini-3.8-flash')).toBeChecked();
  await expectSummaryModel(page, 'automatic');
  expect(state.projects[0].captions).toEqual(captions); expect(state.projects[0].generationModel).toBeUndefined();
  failure = false;
  await applyModel(page).click();
  await expectSummaryModel(page, 'gemini-3.8-flash');
  expect(modelWrites.map((write) => write.generationModel)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
});

test('full regeneration waits for Apply, uses saved Hydrogen, and locks the choice during the caption save', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  const group = await options(page);
  const regenerate = page.getByRole('button', { name: 'Improve all captions', exact: true });
  let releaseModel!: () => void;
  hold = new Promise<void>((resolve) => { releaseModel = resolve; });
  await modelRow(group, 'gemini-4-hydrogen').click();
  await applyModel(page).click();
  await expect(regenerate).toBeDisabled();
  await expectSummaryModel(page, 'automatic');
  expect(submissions).toHaveLength(0);
  releaseModel();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await modelRow(group, 'gemini-3.8-flash').click();
  await expect(radio(group, 'gemini-3.8-flash')).toBeChecked();
  let release!: () => void; const barrier = new Promise<void>((r) => { release = r; }); let entered = false;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    entered = true; await barrier; const body = route.request().postDataJSON(); state.projects[0].captions = body.captions;
    return route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Edited Khmer wording');
  await regenerate.click();
  await expect.poll(() => entered).toBe(true);
  await expect(group.getByRole('radio', { disabled: true })).toHaveCount(4); expect(submissions).toHaveLength(0);
  release(); await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].generationModel).toBe('gemini-4-hydrogen');
  expect(modelWrites).toHaveLength(1);
});

test('a model-related failure reveals AI options and the selector remains usable on small screens', async ({ page }, info) => {
  state.jobs = [{ id: 'failed-fixture', type: 'transcribe', projectId: 'landscape', projectTitle: 'Synthetic', status: 'failed', stage: 'failed', progress: 22, message: 'Failed', error: "Google's safety filters blocked this transcription request.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canResume: true }];
  await initialProject(page);
  await expect(page.locator('.generation-options')).toHaveAttribute('open', '');
  const group = modelGroup(page);
  const hydrogen = radio(group, 'gemini-4-hydrogen');
  const row = modelRow(group, 'gemini-4-hydrogen');
  await row.click();
  await applyModel(page).click();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await page.screenshot({ path: info.outputPath('generation-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.generation-options > summary').press('Tab');
  await expect(hydrogen).toBeFocused();
  expect(await hydrogen.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
  await expect(row).toHaveCSS('outline-style', 'solid');
  await expect(row).toHaveCSS('outline-width', '2px');
  await page.screenshot({ path: info.outputPath('generation-mobile.png'), fullPage: true });
  await page.locator('.generation-options > summary').click();
  await expectSummaryModel(page, 'gemini-4-hydrogen');
  await page.locator('.generation-options').screenshot({ path: info.outputPath('generation-mobile-hydrogen-folded.png') });
});

test('a delayed completed-job response cannot undo a newer saved model choice', async ({ page }) => {
  await initialProject(page); const group = await options(page);
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await page.getByRole('button', { name: 'Close Activity', exact: true }).click();
  const stale = structuredClone(state.projects[0]);
  let release!: () => void; const barrier = new Promise<void>((r) => { release = r; }); let reading = false;
  await page.route('**/api/projects/landscape', async (route) => {
    if (reading) return route.fallback();
    reading = true; await barrier; return route.fulfill({ json: stale });
  });
  state.jobs = [{ ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100, resultProjectId: 'landscape' }];
  await expect.poll(() => reading).toBe(true);
  const flash = radio(group, 'gemini-3.6-flash');
  await expect(flash).toBeEnabled();
  await modelRow(group, 'gemini-3.6-flash').click();
  await applyModel(page).click();
  await expectSummaryModel(page, 'gemini-3.6-flash');
  release(); await expect(page.getByText('Background caption generation completed.', { exact: true })).toBeVisible();
  await expect(flash).toBeChecked();
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].generationModel).toBe('gemini-3.6-flash');
});
