import { test, expect, type Page } from '@playwright/test';
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
async function options(page: Page) {
  const details = page.locator('.generation-options');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  return page.getByRole('combobox', { name: 'Caption model', exact: true });
}

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
  const description = accuracy.getByLabel('What is this clip about?', { exact: true });
  const close = accuracy.getByRole('button', { name: 'Close tool', exact: true });
  const toolbarAccuracy = page.getByRole('button', { name: /^Accuracy/ });
  await expect(toolbarAccuracy).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset layout', exact: true })).toBeVisible();
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
  await accuracy.getByRole('button', { name: 'Save for project', exact: true }).click();
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

for (const surface of ['Generate', 'Accuracy'] as const) {
  test(`AI options is clickable and keyboard-usable in ${surface} across viewport sizes`, async ({ page }, info) => {
    if (surface === 'Generate') await initialProject(page);
    else {
      await openProject(page);
      await page.getByRole('button', { name: /^Accuracy/ }).click();
    }
    const disclosure = page.locator('.generation-options');
    const summary = disclosure.locator(':scope > summary');
    const select = page.getByRole('combobox', { name: 'Caption model', exact: true });
    for (const [width, height] of [[1440, 1000], [1183, 1244], [320, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(select).toBeHidden();
      await summary.evaluate((node) => { node.blur(); node.scrollIntoView({ block: 'start' }); });
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await summary.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`ai-options-${width}-closed.png`) });
      await summary.click();
      await expect(select).toBeVisible();
      await expect(select).toHaveValue('automatic');
      expect(await disclosure.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await summary.focus();
      await summary.press('Enter');
      await expect(select).toBeHidden();
      await summary.press('Enter');
      await expect(select).toBeVisible();
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

test('Generate offers all three choices, saves per project, survives reopening, and never writes global settings', async ({ page }) => {
  await initialProject(page);
  const select = await options(page);
  await expect(select).toHaveValue('automatic');
  await expect(select.locator('option')).toHaveText(['Automatic', 'Gemini 3.8 Flash', 'Gemini 3.6 Flash']);
  for (const value of ['gemini-3.8-flash', 'gemini-3.6-flash', 'automatic', 'gemini-3.6-flash']) {
    await select.selectOption(value); await expect(select).toBeEnabled(); await expect(select).toHaveValue(value);
    await expect(page.getByRole('status').filter({ hasText: 'Saved for this project' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await expect(await options(page)).toHaveValue('automatic');
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(await options(page)).toHaveValue('gemini-3.6-flash');
  expect(modelWrites).toHaveLength(4);
  expect(state.requests.filter((r) => r.path === '/api/system/llm-settings' && r.method !== 'GET')).toEqual([]);
});

test('Generate waits for the choice save and submits the exact selected model', async ({ page }) => {
  const { transcript, captions } = state.projects[0];
  await initialProject(page); const select = await options(page);
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  await select.selectOption('gemini-3.6-flash');
  await expect(select).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Generate captions', exact: true })).toBeDisabled();
  expect(submissions).toHaveLength(0);
  release(); await expect(select).toBeEnabled();
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].generationModel).toBe('gemini-3.6-flash');
  await page.getByRole('button', { name: 'Close Activity', exact: true }).click();
  Object.assign(state.projects[0], { transcript, captions });
  state.jobs = [{ ...state.jobs[0], status: 'completed', stage: 'complete', progress: 100, resultProjectId: 'landscape' }];
  await expect(page.getByText('Background caption generation completed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add context', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Accuracy/ }).click();
  await expect(page.getByRole('button', { name: 'Preview full regeneration', exact: true })).toBeVisible();
});

test('failed option save restores the saved choice and keeps captions intact', async ({ page }) => {
  const captions = structuredClone(state.projects[0].captions);
  await openProject(page); await page.getByRole('button', { name: /^Accuracy/ }).click();
  const select = await options(page); failure = true;
  await select.selectOption('gemini-3.8-flash');
  await expect(select).toBeEnabled(); await expect(select).toHaveValue('automatic');
  await expect(page.getByText('Could not save AI options. Try again.', { exact: true })).toBeVisible();
  expect(state.projects[0].captions).toEqual(captions); expect(state.projects[0].generationModel).toBeUndefined();
});

test('full regeneration uses the project choice and locks it while prerequisite captions save', async ({ page }) => {
  await openProject(page); await page.getByRole('button', { name: /^Accuracy/ }).click();
  const select = await options(page); await select.selectOption('gemini-3.6-flash'); await expect(select).toBeEnabled();
  let release!: () => void; const barrier = new Promise<void>((r) => { release = r; }); let entered = false;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    entered = true; await barrier; const body = route.request().postDataJSON(); state.projects[0].captions = body.captions;
    return route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Edited Khmer wording');
  await page.getByRole('button', { name: 'Preview full regeneration', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await expect(select).toBeDisabled(); expect(submissions).toHaveLength(0);
  release(); await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].generationModel).toBe('gemini-3.6-flash');
});

test('a model-related failure reveals AI options and the selector remains usable on small screens', async ({ page }, info) => {
  state.jobs = [{ id: 'failed-fixture', type: 'transcribe', projectId: 'landscape', projectTitle: 'Synthetic', status: 'failed', stage: 'failed', progress: 22, message: 'Failed', error: "Google's safety filters blocked this transcription request.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canResume: true }];
  await initialProject(page);
  await expect(page.locator('.generation-options')).toHaveAttribute('open', '');
  const select = page.getByRole('combobox', { name: 'Caption model', exact: true });
  await select.selectOption('gemini-3.6-flash'); await expect(select).toBeEnabled();
  await page.screenshot({ path: info.outputPath('generation-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await select.scrollIntoViewIfNeeded();
  await expect(select).toBeVisible();
  expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await select.focus(); expect(await select.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
  await page.screenshot({ path: info.outputPath('generation-mobile.png'), fullPage: true });
});

test('a delayed completed-job response cannot undo a newer saved model choice', async ({ page }) => {
  await initialProject(page); const select = await options(page);
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
  await expect(select).toBeEnabled();
  await select.selectOption('gemini-3.6-flash'); await expect(select).toBeEnabled();
  release(); await expect(page.getByText('Background caption generation completed.', { exact: true })).toBeVisible();
  await expect(select).toHaveValue('gemini-3.6-flash');
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].generationModel).toBe('gemini-3.6-flash');
});
