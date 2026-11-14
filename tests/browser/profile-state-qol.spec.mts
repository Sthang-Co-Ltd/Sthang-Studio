import { test as base, expect, type Page } from '@playwright/test';
import type { AppProfile } from '@kcs/shared';
import type { ProfilePatch } from '../../apps/web/src/profile-state.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { openAccuracy } from './accuracy-workspace.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); }
    finally { await closeOwnedBrowserContext(context); }
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.defaultVocabulary = ['Saved glossary'];
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.topicPacks = [{ id: 'target-pack', name: 'Target context', description: 'Reusable context', vocabulary: ['Pack term'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  state.projects[0].captions[0].text = 'old';
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const glossary = (page: Page) => settings(page).getByLabel('Global protected vocabulary', { exact: true });
const tools = (page: Page) => page.getByRole('navigation', { name: 'Caption workspace tools', exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openProfile(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
}
async function closeProfile(page: Page) {
  await settings(page).getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function rememberCorrection(page: Page) {
  await page.keyboard.press('Control+f');
  const find = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  await find.getByLabel('Find', { exact: true }).fill('old');
  await find.getByLabel('Replace with', { exact: true }).fill('new!');
  await find.getByLabel('Remember this correction', { exact: true }).selectOption('global');
  await find.getByRole('button', { name: 'Replace editable matches', exact: true }).click();
  await expect(find).toHaveCount(0);
  await expect.poll(() => state.profile.defaultVocabulary.includes('new! | old')).toBe(true);
}

test('a delayed Settings glossary receipt keeps a newer Review preference and Find rule on reopening', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const gate = deferred();
  let glossaryWrites = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: ProfilePatch = route.request().postDataJSON();
    if (!body.defaultVocabulary) return route.fallback();
    glossaryWrites++;
    if (glossaryWrites !== 1) return route.fallback();
    state.profile = { ...state.profile, defaultVocabulary: [...body.defaultVocabulary] };
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    return route.fulfill({ json: acknowledged });
  });
  try {
    await openProject(page); await openProfile(page);
    await glossary(page).fill('Submitted earlier glossary');
    await settings(page).getByRole('button', { name: 'Save glossary', exact: true }).click();
    await expect.poll(() => glossaryWrites).toBe(1);
    await closeProfile(page);
    await tools(page).getByRole('button', { name: /^Review/ }).click();
    await page.getByRole('checkbox', { name: 'Auto-play next', exact: true }).check();
    await expect.poll(() => state.profile.preferences.autoPlayNextReview).toBe(true);
    await rememberCorrection(page);
    gate.release();
    await openProfile(page);
    await expect(settings(page).locator('#profile-glossary-feedback')).toHaveText('Earlier glossary saved. Newer global glossary choices are shown.');
    await expect(glossary(page)).toHaveValue(/new! \| old/);
    await expect(glossary(page)).not.toHaveValue('Submitted earlier glossary');
    await settings(page).locator('#profile-glossary-feedback').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('settings-newer-glossary-390.png') });
    await closeProfile(page);
    await expect(page.getByRole('checkbox', { name: 'Auto-play next', exact: true })).toBeChecked();
    const accuracy = await openAccuracy(page);
    await expect(accuracy.vocabulary).toHaveValue(/new! \| old/);
    expect(glossaryWrites).toBe(2);
    expect(state.profile.defaultVocabulary).toContain('new! | old');
    expect(state.profile.preferences.autoPlayNextReview).toBe(true);
  } finally { gate.release(); }
});

test('a delayed topic-pack deletion publishes its pack change while keeping a newer rule and unsaved form text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const gate = deferred();
  let packWrites = 0;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: ProfilePatch = route.request().postDataJSON();
    if (!body.topicPacks) return route.fallback();
    packWrites++;
    state.profile = { ...state.profile, topicPacks: structuredClone(body.topicPacks) };
    const acknowledged = structuredClone(state.profile);
    await gate.promise;
    return route.fulfill({ json: acknowledged });
  });
  try {
    await openProject(page); await openProfile(page);
    await glossary(page).fill('Unrelated unsaved form text កម្ពុជា');
    await settings(page).getByRole('button', { name: 'Delete topic pack Target context', exact: true }).click();
    await expect.poll(() => packWrites).toBe(1);
    await closeProfile(page);
    await rememberCorrection(page);
    gate.release();
    await openProfile(page);
    await expect(settings(page).getByText('Deleted topic pack “Target context”.', { exact: true })).toBeVisible();
    await expect(settings(page).getByRole('button', { name: 'Delete topic pack Target context', exact: true })).toHaveCount(0);
    await expect(glossary(page)).toHaveValue('Unrelated unsaved form text កម្ពុជា');
    await expect(settings(page).locator('.profile-stats > div').first().locator('b')).toHaveText('2');
    expect(state.profile.defaultVocabulary).toContain('new! | old');
    expect(state.profile.topicPacks).toEqual([]);
    expect(packWrites).toBe(1);
  } finally { gate.release(); }
});

test('independent Review preferences send only their changed keys and survive reversed acknowledgements', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const first = deferred(); const second = deferred();
  const firstFinished = deferred(); const secondFinished = deferred();
  const writes: Array<Partial<AppProfile['preferences']>> = [];
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body: ProfilePatch = route.request().postDataJSON();
    if (!body.preferences) return route.fallback();
    writes.push(structuredClone(body.preferences));
    const index = writes.length;
    state.profile = { ...state.profile, preferences: { ...state.profile.preferences, ...body.preferences } };
    const acknowledged = structuredClone(state.profile);
    await (index === 1 ? first.promise : second.promise);
    try { await route.fulfill({ json: acknowledged }); }
    finally { (index === 1 ? firstFinished : secondFinished).release(); }
  });
  try {
    await openProject(page);
    await tools(page).getByRole('button', { name: /^Review/ }).click();
    const autoplay = page.getByRole('checkbox', { name: 'Auto-play next', exact: true });
    await autoplay.check();
    await expect.poll(() => writes.length).toBe(1);
    await page.getByText('Playback, focus, locks, timing and shortcuts', { exact: true }).click();
    const focus = page.getByLabel('Review focus', { exact: true });
    await focus.selectOption('off');
    await expect.poll(() => writes.length).toBe(2);
    expect(writes).toEqual([{ autoPlayNextReview: true }, { reviewFocusMode: 'off' }]);
    second.release(); await secondFinished.promise;
    first.release(); await firstFinished.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(autoplay).toBeChecked();
    await expect(focus).toHaveValue('off');
    expect(state.profile.preferences.autoPlayNextReview).toBe(true);
    expect(state.profile.preferences.reviewFocusMode).toBe('off');
    expect(writes).toHaveLength(2);
  } finally { first.release(); second.release(); }
});

test('a delayed profile import preserves newer raw Accuracy text while importing the acknowledged globals', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const gate = deferred();
  let imports = 0;
  const imported: AppProfile = { ...structuredClone(state.profile), defaultVocabulary: ['Imported term'] };
  await page.route('**/api/profile/import', async (route) => {
    imports++;
    const received: AppProfile = route.request().postDataJSON();
    state.profile = structuredClone(received);
    await gate.promise;
    return route.fulfill({ json: received });
  });
  try {
    await openProject(page); await openProfile(page);
    await settings(page).locator('input[type=file]').setInputFiles({ name: 'studio-profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await expect.poll(() => imports).toBe(1);
    await closeProfile(page);
    const accuracy = await openAccuracy(page);
    const raw = '  Newer term  \n\nExact raw កម្ពុជា  ';
    await accuracy.vocabulary.fill(raw);
    await accuracy.description.fill('Newer description after import started');
    gate.release();
    await openProfile(page);
    await expect(settings(page).locator('.profile-import-feedback')).toContainText('Profile imported.');
    await expect(glossary(page)).toHaveValue('Imported term');
    await closeProfile(page);
    await expect(accuracy.vocabulary).toHaveValue(raw);
    await expect(accuracy.description).toHaveValue('Newer description after import started');
    await accuracy.vocabulary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('profile-import-newer-accuracy-390.png') });
    expect(state.profile.defaultVocabulary).toEqual(['Imported term']);
    expect(imports).toBe(1);
  } finally { gate.release(); }
});
