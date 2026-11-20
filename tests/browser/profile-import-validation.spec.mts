import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.defaultVocabulary = ['Keep saved term'];
  state.profile.topicPacks = [{ id: 'keep-pack', name: 'Keep topic pack', description: 'Keep saved topic', vocabulary: ['Keep entity'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  state.projects[0].transcriptionContext = { description: 'Current project context កម្ពុជា', vocabulary: ['Project entity'] };
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const glossary = (page: Page) => settings(page).getByLabel('Global protected vocabulary', { exact: true });
const packName = (page: Page) => settings(page).getByLabel('Topic pack name', { exact: true });
const input = (page: Page) => settings(page).locator('input[type=file]');
const feedback = (page: Page) => settings(page).locator('.profile-import-feedback');
async function openProfile(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
  await glossary(page).fill('Keep unsaved glossary កម្ពុជា');
  await packName(page).fill('Keep unsaved pack name');
}
function selectedFile(value: unknown) {
  return { name: 'studio-profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) };
}

for (const width of [1440, 390]) test(`corrupt profile core structure never submits or clears current settings and drafts at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  let imports = 0;
  await page.route('**/api/profile/import', (route) => {
    imports++; return route.fulfill({ status: 503, json: { error: 'Unexpected corrupt profile submission' } });
  });
  const saved = structuredClone(state.profile);
  const malformed: Array<{ name: string; value: unknown }> = [
    { name: 'truncated', value: { version: 1, defaultVocabulary: ['Incomplete'] } },
    { name: 'version', value: { ...saved, version: 2 } },
    { name: 'vocabulary', value: { ...saved, defaultVocabulary: [42] } },
  ];
  for (const field of ['styles', 'topicPacks', 'correctionRules', 'correctionEvents'] as const) {
    const missing = { ...saved } as Record<string, unknown>;
    delete missing[field];
    malformed.push({ name: `missing-${field}`, value: missing }, { name: `invalid-${field}`, value: { ...saved, [field]: {} } });
  }
  malformed.push(
    { name: 'missing-preferences', value: { ...saved, preferences: undefined } },
    { name: 'array-preferences', value: { ...saved, preferences: [] } },
    { name: 'missing-timestamp', value: { ...saved, updatedAt: undefined } },
    { name: 'empty-timestamp', value: { ...saved, updatedAt: '  ' } },
  );
  await openProfile(page); await glossary(page).focus();
  for (const candidate of malformed) {
    await input(page).setInputFiles(selectedFile(candidate.value));
    await expect(feedback(page), candidate.name).toHaveAttribute('role', 'alert');
    await expect(feedback(page), candidate.name).toContainText('not a readable Studio profile');
    await expect(feedback(page), candidate.name).toContainText('Your settings and drafts are unchanged.');
    await expect(settings(page).getByRole('button', { name: 'Import profile', exact: true }), candidate.name).toBeEnabled();
    await expect(input(page), candidate.name).toHaveValue('');
    await expect(glossary(page), candidate.name).toBeFocused();
    await expect(glossary(page), candidate.name).toHaveValue('Keep unsaved glossary កម្ពុជា');
    await expect(packName(page), candidate.name).toHaveValue('Keep unsaved pack name');
    await expect(settings(page).getByText('Keep topic pack', { exact: true }), candidate.name).toBeVisible();
    expect(imports, candidate.name).toBe(0);
    expect(state.profile, candidate.name).toEqual(saved);
  }
  await expect(settings(page).getByRole('button', { name: 'Choose another profile', exact: true })).toBeEnabled();
  expect(await settings(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await feedback(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`profile-core-validation-${width}.png`) });
});

for (const format of ['current', 'legacy'] as const) test(`a complete ${format} profile remains importable through same-file retry without losing newer form focus`, async ({ page }, info) => {
  await page.setViewportSize({ width: format === 'legacy' ? 390 : 1440, height: 900 });
  const first = deferred(); const retry = deferred();
  const submissions: unknown[] = [];
  const full = { ...structuredClone(state.profile), defaultVocabulary: ['Imported term'], captionAppearances: [], videoExportPresets: [],
    lastVideoExportSettings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' } };
  const { captionAppearances: _looks, videoExportPresets: _presets, lastVideoExportSettings: _last, ...legacy } = full;
  const imported = format === 'legacy' ? legacy : full;
  const file = { ...selectedFile(imported), name: format === 'legacy' ? 'sthang-studio-profile-before-restoring-the-interview-and-its-saved-caption-settings.json' : 'studio-profile.json' };
  await page.route('**/api/profile/import', async (route) => {
    const submitted = route.request().postDataJSON();
    submissions.push(structuredClone(submitted));
    if (submissions.length === 1) { await first.promise; return route.fulfill({ status: 503, json: { error: 'Synthetic profile import failure' } }); }
    await retry.promise;
    state.profile = { ...submitted, preferences: { ...submitted.preferences, analyticsConsent: 'unset', khmerContributionConsent: 'unset', privacyUpgradeNoticeVersion: state.profile.preferences.privacyUpgradeNoticeVersion } };
    return route.fulfill({ json: state.profile });
  });
  try {
    await openProfile(page);
    const choose = settings(page).getByRole('button', { name: 'Import profile', exact: true });
    const keep = page.getByRole('button', { name: 'Keep current', exact: true });
    const replace = page.getByRole('button', { name: 'Replace profile', exact: true });
    await choose.focus();
    await input(page).setInputFiles(file);
    await expect(keep).toBeVisible();
    await expect(keep).toBeFocused();
    const review = page.getByRole('alertdialog');
    await expect(review).toContainText(file.name);
    expect(await review.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('profile-import-review-' + format + '.png') });
    await keep.press('Enter');
    await expect(replace).toBeHidden();
    expect(submissions).toHaveLength(0);
    expect(state.profile.defaultVocabulary).toEqual(['Keep saved term']);
    await expect(glossary(page)).toHaveValue('Keep unsaved glossary កម្ពុជា');
    await expect(packName(page)).toHaveValue('Keep unsaved pack name');
    await input(page).setInputFiles(file);
    await replace.press('Enter');
    await expect.poll(() => submissions.length).toBe(1);
    await glossary(page).focus();
    first.release();
    await expect(feedback(page)).toContainText('Could not confirm the profile import.');
    await expect(glossary(page)).toBeFocused();
    await expect(glossary(page)).toHaveValue('Keep unsaved glossary កម្ពុជា');
    await expect(input(page)).toHaveValue('');
    await feedback(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`profile-valid-${format}-retry.png`) });
    await settings(page).getByRole('button', { name: 'Retry import', exact: true }).press('Enter');
    await expect.poll(() => submissions.length).toBe(2);
    expect(await settings(page).evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await packName(page).fill('Newer name while retrying');
    retry.release();
    await expect(feedback(page)).toContainText('Profile imported. Your unsaved glossary text is still in the form.');
    await expect(packName(page)).toBeFocused();
    await expect(packName(page)).toHaveValue('Newer name while retrying');
    await expect(glossary(page)).toHaveValue('Keep unsaved glossary កម្ពុជា');
    await expect(settings(page).getByRole('button', { name: 'Retry import', exact: true })).toHaveCount(0);
    expect(submissions).toEqual([imported, imported]);
    expect(state.profile.defaultVocabulary).toEqual(['Imported term']);
    expect(state.profile.topicPacks).toEqual(imported.topicPacks);
    if (format === 'legacy') expect(Object.hasOwn(submissions[0] as object, 'videoExportPresets')).toBe(false);
  } finally { first.release(); retry.release(); }
});
