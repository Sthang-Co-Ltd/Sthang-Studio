import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.setViewportSize({ width: 1440, height: 1000 });
});

const nameField = (page: Page) => page.getByLabel('Save current appearance as', { exact: true });
const notice = (page: Page) => page.locator('.appearance-preset-notice');
const picker = (page: Page) => page.getByLabel('Preset', { exact: true });

async function openPresets(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await expandAppearanceSection(page, 'presets');
  await page.getByText('Manage presets', { exact: true }).click();
  await expect(nameField(page)).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdPresetWrite(page: Page) {
  const gate = deferred();
  let received = false;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.captionAppearances) return route.fallback();
    received = true;
    await gate.promise;
    await route.fallback();
  });
  return { received: () => received, release: gate.resolve };
}

test('a new preset confirms beside the form only after saving and clears when its name is edited', async ({ page }, info) => {
  await openPresets(page);
  const originalAppearance = structuredClone(state.projects[0].captionAppearance);
  await nameField(page).fill('  Clean Khmer  ');
  const hold = await holdPresetWrite(page);
  try {
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    const submitting = page.getByRole('button', { name: 'Saving…', exact: true });
    await expect(submitting).toBeDisabled();
    await expect(submitting).toHaveAttribute('aria-busy', 'true');
    await expect(notice(page)).toHaveCount(0);
    hold.release();
    await expect(notice(page)).toHaveText('Saved “Clean Khmer”.');
    await expect(notice(page)).toHaveAttribute('role', 'status');
    await notice(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('preset-saved.png') });
    expect(await notice(page).evaluate((node) => Boolean(node.closest('.appearance-preset-tools-body')))).toBe(true);
    expect(state.profile.captionAppearances).toHaveLength(1);
    expect(state.profile.captionAppearances![0].name).toBe('Clean Khmer');
    expect(state.profile.captionAppearances![0].appearance).toEqual(originalAppearance);
    await expect(nameField(page)).toHaveValue('');
    await expect(picker(page)).toHaveValue(state.profile.captionAppearances![0].id);
    await nameField(page).fill('Another look');
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
  } finally { hold.release(); }
});

test('trimmed case-insensitive names visibly update the existing preset and retain its identity', async ({ page }) => {
  state.profile.captionAppearances = [{
    id: 'existing-look', name: 'Clean Khmer', appearance: { ...state.projects[0].captionAppearance!, fontSize1080: 44 },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  await openPresets(page);
  await expect(picker(page).locator('option[value="existing-look"]')).toHaveCount(1);
  await nameField(page).fill('  clean KHMER  ');
  const hold = await holdPresetWrite(page);
  try {
    await page.getByRole('button', { name: 'Update preset', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    await expect(page.getByRole('button', { name: 'Updating…', exact: true })).toBeDisabled();
    await expect(notice(page)).toHaveCount(0);
    hold.release();
    await expect(notice(page)).toHaveText('Updated “clean KHMER”.');
    expect(state.profile.captionAppearances).toHaveLength(1);
    expect(state.profile.captionAppearances![0]).toMatchObject({
      id: 'existing-look', name: 'clean KHMER', createdAt: '2026-01-01T00:00:00.000Z',
      appearance: state.projects[0].captionAppearance,
    });
    await expect(picker(page)).toHaveValue('existing-look');
  } finally { hold.release(); }
});

test('a failed preset save keeps its input and exposes retry without a success receipt', async ({ page }) => {
  await openPresets(page);
  let fail = true;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.captionAppearances || !fail) return route.fallback();
    await route.fulfill({ status: 503, json: { error: 'Synthetic preset save failure' } });
  });
  await nameField(page).fill('Retry this look');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic preset save failure' })).toBeVisible();
  await expect(nameField(page)).toHaveValue('Retry this look');
  await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeEnabled();
  await expect(notice(page)).toHaveCount(0);
  expect(state.profile.captionAppearances).toHaveLength(0);
  fail = false;
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(notice(page)).toHaveText('Saved “Retry this look”.');
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic preset save failure' })).toHaveCount(0);
});

for (const editName of [true, false]) test(`pending saves retain their clicked appearance while newer appearance edits stay current (rename: ${editName})`, async ({ page }) => {
  await openPresets(page);
  const size = page.getByLabel('Exact size', { exact: true });
  await size.fill('78'); await size.press('Enter');
  await nameField(page).fill('Clicked look');
  const hold = await holdPresetWrite(page);
  try {
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect.poll(hold.received).toBe(true);
    if (editName) await nameField(page).fill('Newer draft name');
    await size.fill('86'); await size.press('Enter');
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    hold.release();
    await expect.poll(() => state.profile.captionAppearances?.length).toBe(1);
    await expect(page.getByRole('button', { name: editName ? 'Save preset' : 'Update preset', exact: true })).toBeEnabled();
    expect(state.profile.captionAppearances![0]).toMatchObject({ name: 'Clicked look', appearance: { fontSize1080: 78 } });
    await expect(nameField(page)).toHaveValue(editName ? 'Newer draft name' : 'Clicked look');
    await expect(size).toHaveValue('86');
    await expect(picker(page)).toHaveValue('');
    await expect(notice(page)).toHaveCount(0);
  } finally { hold.release(); }
});
