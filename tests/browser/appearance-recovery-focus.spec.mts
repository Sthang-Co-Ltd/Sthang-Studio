import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { appearance, cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.fonts.push({ id: 'studio:removable', name: 'Creator Khmer', available: true, boldAvailable: true, source: 'studio-imported', removable: true });
  state.profile.captionAppearances = [{ id: 'removable-preset', name: 'Saved appearance', appearance: { ...appearance },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const saveState = (page: Page) => page.locator('.appearance-save-state');
const retry = (page: Page) => saveState(page).getByRole('button', { name: 'Retry', exact: true });
const font = (page: Page) => page.getByLabel('Khmer font', { exact: true });
const presetSummary = (page: Page) => page.locator('.appearance-presets-disclosure > summary');
const exactSize = (page: Page) => page.getByRole('spinbutton', { name: 'Exact size', exact: true });
type Kind = 'font' | 'preset';
const remove = (page: Page, kind: Kind) => kind === 'font'
  ? page.locator('.appearance-font-manager').getByRole('button', { name: 'Remove', exact: true })
  : page.getByRole('button', { name: 'Delete preset', exact: true });
const continuation = (page: Page, kind: Kind) => kind === 'font' ? font(page) : presetSummary(page);

async function openAppearance(page: Page) {
  await openProject(page);
  await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(font(page)).toBeEnabled();
  await expect(font(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => {
    document.querySelector('video')?.pause();
    (window as any).__appearanceRecoveryNodes = [document.querySelector('video'), document.querySelector('.caption-list')];
  });
}
async function openRemoval(page: Page, kind: Kind) {
  if (kind === 'font') state.projects[0].captionAppearance = { ...appearance, fontFamily: 'Creator Khmer' };
  await openAppearance(page);
  if (kind === 'font') await page.locator('.appearance-font-manager > summary').click();
  else {
    await expandAppearanceSection(page, 'presets');
    await page.getByLabel('Preset', { exact: true }).selectOption('removable-preset');
    await page.locator('.appearance-preset-tools > summary').click();
  }
}
async function confirm(page: Page, kind: Kind, accepted = true) {
  await remove(page, kind).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const decision = accepted
    ? dialog.getByRole('button', { name: kind === 'font' ? 'Remove font' : 'Delete preset', exact: true })
    : dialog.locator('.studio-confirm-cancel');
  await decision.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return document.activeElement === node && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1
      && (hit === node || hit !== null && node.contains(hit));
  })).toBe(true);
}
async function preserved(page: Page, captions: unknown) {
  expect(state.projects[0].captions).toEqual(captions);
  expect(await page.evaluate(() => (window as any).__appearanceRecoveryNodes.every((node: Element, index: number) =>
    node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function interceptRemoval(page: Page, kind: Kind, handler: () => Promise<boolean>) {
  await page.route(kind === 'font' ? '**/api/video-export/fonts/*' : '**/api/profile', async (route) => {
    const method = route.request().method();
    if (kind === 'font' ? method !== 'DELETE' : method !== 'PATCH' || !route.request().postDataJSON().captionAppearances) return route.fallback();
    if (!await handler()) return route.fulfill({ status: 503, json: { error: 'Synthetic removal failure' } });
    return route.fallback();
  });
}

for (const kind of ['font', 'preset'] as const) for (const width of [1440, 390]) {
  test(`${kind} removal keeps Cancel and confirmed continuation focused at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const gate = deferred();
    let writes = 0;
    await interceptRemoval(page, kind, async () => { writes++; await gate.promise; return true; });
    try {
      await openRemoval(page, kind);
      const captions = structuredClone(state.projects[0].captions);
      const look = structuredClone(state.projects[0].captionAppearance);
      await confirm(page, kind, false);
      await expect(remove(page, kind)).toBeFocused();
      expect(writes).toBe(0);
      await confirm(page, kind);
      await expect.poll(() => writes).toBe(1);
      await visibleFocus(continuation(page, kind));
      await page.screenshot({ path: info.outputPath(`${kind}-removal-focus-${width}.png`) });
      if (width === 390) { await exactSize(page).focus(); await exactSize(page).fill('83'); }
      gate.release();
      await expect(remove(page, kind)).toHaveCount(0);
      if (width === 390) { await expect(exactSize(page)).toBeFocused(); await expect(exactSize(page)).toHaveValue('83'); }
      else await expect(continuation(page, kind)).toBeFocused();
      expect(writes).toBe(1);
      expect(state.projects[0].captionAppearance).toEqual(look);
      await preserved(page, captions);
    } finally { gate.release(); }
  });
}

for (const kind of ['font', 'preset'] as const) test(`failed ${kind} removal keeps its current choice and offers a deliberate retry`, async ({ page }) => {
  await page.setViewportSize({ width: kind === 'font' ? 390 : 1440, height: 1000 });
  let succeeds = false; let writes = 0;
  await interceptRemoval(page, kind, async () => { writes++; return succeeds; });
  await openRemoval(page, kind);
  const before = structuredClone(state.projects[0]);
  await confirm(page, kind);
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic removal failure' })).toBeVisible();
  await expect(remove(page, kind)).toBeEnabled();
  await visibleFocus(continuation(page, kind));
  expect(state.projects[0]).toEqual(before);
  succeeds = true;
  await confirm(page, kind);
  await expect(remove(page, kind)).toHaveCount(0);
  await expect(continuation(page, kind)).toBeFocused();
  expect(writes).toBe(2);
  expect(state.projects[0]).toEqual(before);
});

for (const width of [1440, 390]) test(`appearance save Retry keeps a stable focus target through failure and success at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await openAppearance(page);
  const captions = structuredClone(state.projects[0].captions);
  state.appearanceFailure = true;
  await exactSize(page).fill('79');
  await exactSize(page).press('Enter');
  await expect(retry(page)).toBeVisible();
  const gate = deferred();
  let retried = 0;
  await page.route('**/api/video-export/landscape/appearance', async (route) => {
    retried++;
    if (retried > 1) await gate.promise;
    return route.fallback();
  });
  try {
    await retry(page).evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expect(retry(page)).toBeVisible();
    await expect.poll(() => retried).toBe(1);
    await visibleFocus(saveState(page));
    if (width === 390) expect((await retry(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    state.appearanceFailure = false;
    await retry(page).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => retried).toBe(2);
    await expect(saveState(page)).toContainText('Saving appearance…');
    await visibleFocus(saveState(page));
    await page.screenshot({ path: info.outputPath(`appearance-save-retry-focus-${width}.png`) });
    if (width === 390) { await exactSize(page).focus(); await exactSize(page).fill('87'); }
    gate.release();
    await expect(saveState(page)).toContainText('Saved automatically');
    if (width === 390) { await expect(exactSize(page)).toBeFocused(); await expect(exactSize(page)).toHaveValue('87'); }
    else await expect(saveState(page)).toBeFocused();
    expect(state.projects[0].captionAppearance?.fontSize1080).toBe(79);
    expect(retried).toBe(2);
    await preserved(page, captions);
  } finally { gate.release(); }
});
