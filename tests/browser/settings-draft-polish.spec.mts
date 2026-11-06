import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.projects[0].transcriptionContext = { description: 'Context កម្ពុជា', vocabulary: ['Original term'] };
  state.profile.defaultVocabulary = ['Saved glossary'];
});
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const glossary = (page: Page) => settings(page).getByLabel('Global protected vocabulary', { exact: true });
const packName = (page: Page) => settings(page).getByLabel('Topic pack name', { exact: true });
async function openProfile(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

for (const failure of ['request', 'missing acknowledgement'] as const) test(`topic pack ${failure} keeps its name and unsaved glossary, then retries once`, async ({ page }) => {
  let fail = true; let writes = 0;
  await page.route('**/api/profile', (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().topicPacks) return route.fallback();
    writes++;
    return fail ? route.fulfill(failure === 'request' ? { status: 503, json: { error: 'Synthetic profile failure' } } : { json: state.profile }) : route.fallback();
  });
  await openProfile(page);
  await glossary(page).fill('Unsaved glossary កម្ពុជា');
  await packName(page).fill('My context');
  const save = settings(page).getByRole('button', { name: 'Save context as pack', exact: true });
  await save.evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
  await expect(settings(page).locator('#profile-pack-feedback')).toContainText('Could not save topic pack');
  await expect(page.locator('.toast.notice').filter({ hasText: 'Profile updated.' })).toHaveCount(0);
  await expect(packName(page)).toHaveValue('My context');
  await expect(glossary(page)).toHaveValue('Unsaved glossary កម្ពុជា');
  expect(writes).toBe(1);
  fail = false; await save.click();
  await expect(settings(page).locator('#profile-pack-feedback')).toHaveText('Saved topic pack “My context”.');
  await expect(packName(page)).toHaveValue('');
  await expect(glossary(page)).toHaveValue('Unsaved glossary កម្ពុជា');
  expect(state.profile.defaultVocabulary).toEqual(['Saved glossary']);
  expect(state.profile.topicPacks).toHaveLength(1);
});

test('a glossary save acknowledges the submitted text while preserving newer input through close and reopen', async ({ page }) => {
  const gate = deferred(); let writes = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().defaultVocabulary) return route.fallback();
    writes++; if (writes === 1) await gate.promise; return route.fallback();
  });
  try {
    await openProfile(page); await glossary(page).fill('Submitted glossary');
    await settings(page).getByRole('button', { name: 'Save glossary', exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await glossary(page).fill('Newer glossary កម្ពុជា');
    gate.resolve();
    await expect(settings(page).locator('#profile-glossary-feedback')).toContainText('newer glossary edits are still unsaved');
    await expect(glossary(page)).toHaveValue('Newer glossary កម្ពុជា');
    expect(state.profile.defaultVocabulary).toEqual(['Submitted glossary']);
    await page.keyboard.press('Escape');
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(glossary(page)).toHaveValue('Newer glossary កម្ពុជា');
    await settings(page).getByRole('button', { name: 'Save glossary', exact: true }).click();
    await expect(settings(page).locator('#profile-glossary-feedback')).toHaveText('Glossary saved.');
    expect(state.profile.defaultVocabulary).toEqual(['Newer glossary កម្ពុជា']);
  } finally { gate.resolve(); }
});

test('glossary normalization omissions never clear the original draft or claim all terms saved', async ({ page }) => {
  await page.route('**/api/profile', (route) => route.request().method() === 'PATCH' && route.request().postDataJSON().defaultVocabulary
    ? route.fulfill({ json: state.profile }) : route.fallback());
  await openProfile(page); await glossary(page).fill('New term not accepted');
  await settings(page).getByRole('button', { name: 'Save glossary', exact: true }).click();
  await expect(settings(page).locator('#profile-glossary-feedback')).toContainText('Some glossary terms were not saved');
  await expect(page.locator('.toast.notice').filter({ hasText: 'Profile updated.' })).toHaveCount(0);
  await expect(glossary(page)).toHaveValue('New term not accepted');
});

test('a pending topic pack saves its captured name and retains a newer name', async ({ page }) => {
  const gate = deferred(); let held = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().topicPacks) return route.fallback();
    held = true; await gate.promise; return route.fallback();
  });
  try {
    await openProfile(page); await packName(page).fill('Captured name');
    await settings(page).getByRole('button', { name: 'Save context as pack', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await packName(page).fill('Newer name'); gate.resolve();
    await expect.poll(() => state.profile.topicPacks.length).toBe(1);
    expect(state.profile.topicPacks[0].name).toBe('Captured name');
    await expect(packName(page)).toHaveValue('Newer name');
    await expect(settings(page).locator('#profile-pack-feedback')).toHaveCount(0);
  } finally { gate.resolve(); }
});

test('profile import handles invalid files and same-file retry inline while preserving form drafts', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true; let imports = 0; let browserDialogs = 0;
  page.on('dialog', (dialog) => { browserDialogs++; void dialog.dismiss(); });
  await page.route('**/api/profile/import', (route) => {
    imports++;
    if (fail) return route.fulfill({ status: 503, json: { error: 'Synthetic import failure' } });
    state.profile = route.request().postDataJSON();
    return route.fulfill({ json: state.profile });
  });
  await openProfile(page); await glossary(page).fill('Keep draft កម្ពុជា'); await packName(page).fill('Keep pack name');
  const input = settings(page).locator('input[type=file]');
  const selectFile = (text: string) => input.setInputFiles({ name: 'studio-profile.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await selectFile('{');
  await expect(settings(page).getByRole('alert')).toContainText('not a readable Studio profile');
  await expect(input).toHaveValue('');
  await selectFile(JSON.stringify(['Not a profile']));
  await expect(settings(page).getByRole('alert')).toContainText('not a readable Studio profile');
  expect(imports).toBe(0); expect(browserDialogs).toBe(0);
  const imported = { ...state.profile, defaultVocabulary: ['Imported term'] };
  await selectFile(JSON.stringify(imported));
  await expect(settings(page).getByRole('button', { name: 'Retry import', exact: true })).toBeEnabled();
  await expect(glossary(page)).toHaveValue('Keep draft កម្ពុជា');
  await expect(packName(page)).toHaveValue('Keep pack name');
  expect(await settings(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await settings(page).locator('.profile-import-feedback').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('profile-import-recovery-390.png') });
  fail = false;
  await settings(page).getByRole('button', { name: 'Retry import', exact: true }).click();
  await expect(settings(page).locator('.profile-import-feedback')).toContainText('Profile imported. Your unsaved glossary text is still in the form.');
  await expect(glossary(page)).toHaveValue('Keep draft កម្ពុជា');
  await expect(packName(page)).toHaveValue('Keep pack name');
  expect(imports).toBe(2); expect(browserDialogs).toBe(0);
  expect(state.profile.defaultVocabulary).toEqual(['Imported term']);
});
