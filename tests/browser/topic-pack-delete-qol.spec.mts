import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const heading = (page: Page) => settings(page).getByRole('heading', { name: 'Topic packs', exact: true });
const glossary = (page: Page) => settings(page).getByLabel('Global protected vocabulary', { exact: true });
const packName = (page: Page) => settings(page).getByLabel('Topic pack name', { exact: true });
const remove = (page: Page, name: string) => settings(page).getByRole('button', { name: 'Delete topic pack ' + name, exact: true });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function openProfile(page: Page) {
  await openProject(page);
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
}
async function visibleHeading(target: Locator) {
  const result = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2;
    const points = [rect.top + Math.min(2, rect.height / 4), (rect.top + rect.bottom) / 2, rect.bottom - Math.min(2, rect.height / 4)];
    return {
      fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      hits: points.map((y) => { const hit = document.elementFromPoint(x, y); return hit === node || Boolean(hit && node.contains(hit)); }),
    };
  });
  expect(result).toEqual({ fullyVisible: true, hits: [true, true, true] });
}
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.projects[0].transcriptionContext = { description: 'Context កម្ពុជា', vocabulary: ['Original term'] };
  state.profile.defaultVocabulary = ['Saved glossary'];
  state.profile.topicPacks = ['First context', 'Target context', 'Last context'].map((name, index) => ({
    id: 'pack-' + index, name, description: 'Saved context ' + index, vocabulary: ['Saved term ' + index],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const width of [1440, 390]) test('topic delete focus at ' + width, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const gate = deferred();
  const writes: any[] = [];
  const originalProject = structuredClone(state.projects[0]);
  const originalPacks = structuredClone(state.profile.topicPacks);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON(); writes.push(body);
    if (writes.length === 1) await gate.promise;
    state.profile = { ...state.profile, topicPacks: structuredClone(body.topicPacks) };
    return route.fulfill({ json: state.profile });
  });
  try {
    await openProfile(page);
    await glossary(page).fill('Unsaved glossary កម្ពុជា');
    await packName(page).fill('Unsaved pack name');
    await remove(page, 'Target context').focus();
    await remove(page, 'Target context').press('Enter');
    await expect.poll(() => writes.length).toBe(1);
    await expect(heading(page)).toBeFocused();
    await visibleHeading(heading(page));
    await expect(settings(page).getByText('Deleting topic pack “Target context”…', { exact: true })).toBeVisible();
    await expect(settings(page).getByRole('button', { name: 'Save glossary', exact: true })).toBeDisabled();
    await expect(settings(page).getByRole('button', { name: 'Save context as pack', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('packs-pending-' + width + '.png'), animations: 'disabled' });
    await packName(page).fill('Newer pack draft');
    gate.release();
    await expect(remove(page, 'Target context')).toHaveCount(0);
    await expect(settings(page).getByText('Deleted topic pack “Target context”.', { exact: true })).toBeVisible();
    await expect(packName(page)).toBeFocused();
    await expect(packName(page)).toHaveValue('Newer pack draft');
    await expect(glossary(page)).toHaveValue('Unsaved glossary កម្ពុជា');
    expect(state.profile.topicPacks).toEqual(originalPacks.filter((pack) => pack.id !== 'pack-1'));
    for (const name of ['First context', 'Last context']) {
      await remove(page, name).focus();
      await remove(page, name).press('Enter');
      await expect(remove(page, name)).toHaveCount(0);
      await expect(heading(page)).toBeFocused();
      await visibleHeading(heading(page));
    }
    await expect(settings(page).getByText('No topic packs yet.', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('packs-empty-' + width + '.png'), animations: 'disabled' });
    expect(writes).toHaveLength(3);
    expect(writes.every((body) => Object.keys(body).length === 1 && Array.isArray(body.topicPacks))).toBe(true);
    expect(state.profile.defaultVocabulary).toEqual(['Saved glossary']);
    expect(state.projects[0]).toEqual(originalProject);
    await expect(packName(page)).toHaveValue('Newer pack draft');
    await expect(glossary(page)).toHaveValue('Unsaved glossary កម្ពុជា');
  } finally { gate.release(); }
});

for (const failure of ['request', 'receipt'] as const) test('topic delete ' + failure + ' retries', async ({ page }) => {
  const gate = deferred(); const finished = deferred();
  const writes: any[] = [];
  const originalProject = structuredClone(state.projects[0]);
  const originalPacks = structuredClone(state.profile.topicPacks);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON(); writes.push(body);
    if (writes.length === 1) {
      await gate.promise;
      try {
        return await route.fulfill(failure === 'request'
          ? { status: 503, json: { error: 'Synthetic delete failure' } }
          : { json: state.profile });
      } finally { finished.release(); }
    }
    state.profile = { ...state.profile, topicPacks: structuredClone(body.topicPacks) };
    return route.fulfill({ json: state.profile });
  });
  try {
    await openProfile(page);
    await glossary(page).fill('Keep glossary draft');
    await packName(page).fill('Keep pack draft');
    await remove(page, 'Target context').evaluate((button: HTMLButtonElement) => {
      const root = button.closest('[role="dialog"]')!;
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
      button.focus(); button.click(); button.click();
      buttons.find((item) => item.textContent?.trim() === 'Save glossary')?.click();
      buttons.find((item) => item.textContent?.trim() === 'Save context as pack')?.click();
    });
    await expect.poll(() => writes.length).toBe(1);
    await expect(heading(page)).toBeFocused();
    await expect(remove(page, 'Target context')).toBeDisabled();
    if (failure === 'receipt') {
      await settings(page).getByRole('button', { name: 'AI connection', exact: true }).click();
      await settings(page).locator('.ai-key-field input').fill('synthetic-newer-draft');
    } else {
      await glossary(page).fill('Newer glossary draft');
    }
    gate.release(); await finished.promise;
    if (failure === 'receipt') {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(settings(page).locator('.ai-key-field input')).toBeFocused();
      await expect(settings(page).locator('.ai-key-field input')).toHaveValue('synthetic-newer-draft');
      await settings(page).getByRole('button', { name: 'Profile', exact: true }).click();
    }
    await expect(settings(page).getByRole('alert')).toContainText('Could not confirm deletion of topic pack “Target context”.');
    if (failure === 'request') await expect(glossary(page)).toBeFocused();
    await expect(remove(page, 'Target context')).toBeEnabled();
    expect(state.profile.topicPacks).toEqual(originalPacks);
    await expect(packName(page)).toHaveValue('Keep pack draft');
    await expect(glossary(page)).toHaveValue(failure === 'request' ? 'Newer glossary draft' : 'Keep glossary draft');
    await expect(page.locator('.toast.notice').filter({ hasText: 'Profile updated.' })).toHaveCount(0);
    await remove(page, 'Target context').focus();
    await remove(page, 'Target context').press('Enter');
    await expect(remove(page, 'Target context')).toHaveCount(0);
    await expect(settings(page).getByText('Deleted topic pack “Target context”.', { exact: true })).toBeVisible();
    await expect(heading(page)).toBeFocused();
    await expect(settings(page).getByRole('alert')).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(state.profile.topicPacks).toEqual(originalPacks.filter((pack) => pack.id !== 'pack-1'));
    expect(state.projects[0]).toEqual(originalProject);
  } finally { gate.release(); }
});
