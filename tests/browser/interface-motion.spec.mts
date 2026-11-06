import { test, expect, type Page } from '@playwright/test';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
});
const tools = (page: Page) => page.getByLabel('Open project tools', { exact: true });
const save = (page: Page) => page.locator('.save-action');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const width of [1440, 390]) test(`menus can reverse dismissal without stale cleanup or moving evidence at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await openProject(page);
  const expected = webSourceIdentity(process.cwd());
  const actual = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
  expect(actual.buildId).toBe(expected.buildId);
  await info.attach('frontend-identity', { body: JSON.stringify({ buildId: actual.buildId, version: actual.version }), contentType: 'application/json' });
  await page.evaluate(() => { (window as any).__motionVideo = document.querySelector('video'); (window as any).__motionList = document.querySelector('.caption-panel'); });
  const before = await page.locator('.media-stage').boundingBox();
  await tools(page).click();
  await expect(page.getByRole('menuitem', { name: /^History/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(tools(page)).toBeFocused();
  // Reopen while the previous exit may still be painted; avoid click stability waits.
  await tools(page).evaluate((node: HTMLElement) => node.click());
  await expect(tools(page)).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => page.locator('.workspace-tools-popover').evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(page.getByRole('menuitem', { name: /^History/ })).toBeVisible();
  expect(await page.locator('.media-stage').boundingBox()).toEqual(before);
  expect(await page.evaluate(() => (window as any).__motionVideo === document.querySelector('video') && (window as any).__motionList === document.querySelector('.caption-panel'))).toBe(true);
  await page.screenshot({ path: info.outputPath(`tools-${width}.png`) });
  await page.keyboard.press('Escape');
  await expect(page.locator('.workspace-tools-menu')).not.toHaveAttribute('open');
});

for (const menu of ['tools', 'row']) test(`${menu} menu never consumes the topmost dialog's Escape`, async ({ page }) => {
  await openProject(page);
  if (menu === 'tools') await tools(page).click();
  else await page.getByLabel('More actions for caption 1', { exact: true }).click();
  await page.keyboard.press('Control+f');
  const dialog = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Only the dialog dismissed. The underlying menu still gets its own Escape.
  await expect(menu === 'tools' ? tools(page) : page.getByLabel('More actions for caption 1', { exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

for (const reduced of [false, true]) test(`sheet dismissal releases focus and rapid reopening survives, reduced motion ${reduced}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.setViewportSize({ width: reduced ? 390 : 1440, height: 1000 });
  await openProject(page);
  await tools(page).click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Project history', exact: true });
  await expect(dialog).toBeVisible();
  if (reduced) expect(await dialog.evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(tools(page)).toBeFocused();
  await expect(page.locator('[aria-modal=true]')).toHaveCount(0);
  await tools(page).evaluate((node: HTMLElement) => node.click());
  await page.getByRole('menuitem', { name: /^History/ }).evaluate((node: HTMLElement) => node.click());
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(dialog.getByRole('button', { name: 'Close history', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: info.outputPath(`history-${reduced ? 'reduced-mobile' : 'desktop'}.png`) });
  await page.keyboard.press('Escape');
  await expect(page.locator('.history-modal')).toHaveCount(0);
});

test('native arrangement dismissal is semantic immediately and early drag retains viewport coordinates', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1041 });
  await openProject(page);
  const trigger = page.getByRole('button', { name: 'Arrange panels', exact: true });
  const panel = page.getByRole('region', { name: 'Arrange panels', exact: true });
  for (let count = 0; count < 3; count++) {
    await trigger.evaluate((node: HTMLElement) => node.click());
    await expect(panel).toBeVisible();
    await panel.getByLabel('Close panel arrangement', { exact: true }).evaluate((node: HTMLElement) => node.click());
    await expect(panel).toHaveCount(0);
  }
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(panel).toBeVisible();
  // Keep the content mid-entrance while checking the real ghost's positioning.
  await page.locator('.editor-arrange-content').evaluate((node) => {
    const motion = node.animate([{ transform: 'scale(.98)' }, { transform: 'none' }], { duration: 1000, fill: 'both' });
    motion.pause(); motion.currentTime = 100;
  });
  const handle = panel.getByRole('button', { name: 'Drag Preview panel to reorder', exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pointer = { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 + 12 };
  await page.mouse.move(pointer.x, pointer.y);
  const ghost = page.locator('.editor-panel-ghost');
  await expect(ghost).toBeVisible();
  expect(await panel.evaluate((node) => getComputedStyle(node).transform)).toBe('none');
  expect(await ghost.evaluate((node) => Boolean(node.closest('.editor-arrange-content')))).toBe(false);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(ghost).toHaveCount(0);
});

test('press feedback leaves neighboring actions fixed and disabled Save remains inert', async ({ page }) => {
  await openProject(page);
  const exportButton = page.getByRole('button', { name: 'Export', exact: true });
  const before = await save(page).boundingBox();
  const box = (await exportButton.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect.poll(() => exportButton.evaluate((node) => getComputedStyle(node).translate)).toBe('0px 1px');
  expect(await save(page).boundingBox()).toEqual(before);
  await page.mouse.move(1, 1); await page.mouse.up();
  const disabled = (await save(page).boundingBox())!;
  await page.mouse.move(disabled.x + disabled.width / 2, disabled.y + disabled.height / 2); await page.mouse.down();
  expect(await save(page).evaluate((node) => getComputedStyle(node).translate)).toBe('none');
  await page.mouse.up();
});

for (const action of ['button', 'keyboard']) test(`manual ${action} save confirms only after acknowledgement and clears on a new edit`, async ({ page }, info) => {
  const gate = deferred();
  let entered = false;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    entered = true;
    const body = route.request().postDataJSON();
    const reply = { ...structuredClone(state.projects[0]), captions: body.captions, updatedAt: '2026-11-06T01:00:00.000Z' };
    await gate.promise;
    state.projects[0] = reply;
    await route.fulfill({ json: { project: reply, correctionsCreated: 0 } });
  });
  try {
    await openProject(page);
    await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
    await page.keyboard.press('Control+s');
    await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Explicitly saved sample');
    const width = (await save(page).boundingBox())!.width;
    if (action === 'button') await save(page).click(); else await page.keyboard.press('Control+s');
    await expect.poll(() => entered).toBe(true);
    await expect(save(page)).toHaveAttribute('aria-busy', 'true');
    await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
    gate.resolve();
    await expect(save(page)).toHaveAttribute('data-save-confirmed', 'true');
    expect((await save(page).boundingBox())!.width).toBe(width);
    await expect(save(page).getByRole('status')).toHaveText('Changes saved.');
    await page.screenshot({ path: info.outputPath(`saved-${action}.png`) });
    await field.fill('A newer unsaved edit');
    await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
  } finally { gate.resolve(); }
});

for (const outcome of ['failure', 'newer-edit']) test(`manual save never confirms ${outcome}`, async ({ page }) => {
  const gate = deferred();
  let entered = false;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    entered = true;
    const body = route.request().postDataJSON();
    await gate.promise;
    if (outcome === 'failure') return route.fulfill({ status: 503, json: { error: 'Synthetic save failure' } });
    state.projects[0] = { ...state.projects[0], captions: body.captions, updatedAt: '2026-11-06T01:00:00.000Z' };
    return route.fulfill({ json: { project: state.projects[0], correctionsCreated: 0 } });
  });
  try {
    await openProject(page);
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('Submitted sample');
    await page.keyboard.press('Control+s');
    await expect.poll(() => entered).toBe(true);
    if (outcome === 'newer-edit') await field.fill('Newer sample must remain unsaved');
    gate.resolve();
    await expect(save(page)).not.toHaveAttribute('aria-busy');
    await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
    await expect(save(page)).toContainText('Save');
    if (outcome === 'failure') await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    else await expect(field).toHaveValue('Newer sample must remain unsaved');
  } finally { gate.resolve(); }
});

test('background text-commit saving stays quiet', async ({ page }) => {
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Automatically saved sample');
  await page.getByLabel('Caption 2 text', { exact: true }).focus();
  await expect(save(page)).toBeDisabled();
  await expect(save(page)).toContainText('Saved');
  await expect(save(page)).not.toHaveAttribute('data-save-confirmed');
});
