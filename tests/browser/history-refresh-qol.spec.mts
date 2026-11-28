import { test as base, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await closeOwnedBrowserContext(context);
  },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const checkpoint = { id: 'saved-qol', projectId: 'landscape', label: 'Before correction', source: 'manual-save', createdAt: '2026-01-01T00:00:00.000Z', captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0 };
async function openHistory(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  return page.getByRole('dialog', { name: 'Project history', exact: true });
}

for (const width of [1440, 390]) test('History guards a loaded refresh, retains focus and recovers at ' + width + 'px', async ({ page }, info) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  const gate = deferred();
  let reads = 0;
  await page.route('**/api/projects/landscape/history', async (route) => {
    const read = ++reads;
    if (read === 2) await gate.promise;
    if (read === 2) return route.fulfill({ status: 503, json: { error: 'Synthetic refresh failure' } });
    return route.fulfill({ json: [{ ...checkpoint, label: read > 2 ? 'After refresh' : checkpoint.label }] });
  });
  try {
    await openProject(page);
    const caption = page.getByLabel('Caption 1 text', { exact: true });
    const draft = 'ខ្មែរ unsaved before history refresh';
    await caption.fill(draft);
    await page.evaluate(() => { (window as any).__historyNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
    const dialog = await openHistory(page);
    await expect(dialog.getByText(checkpoint.label, { exact: true })).toBeVisible();
    const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expect(dialog).toContainText('Refreshing history…');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh).toBeFocused();
    await expect(dialog.getByText(checkpoint.label, { exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    await refresh.evaluate((button: HTMLButtonElement) => button.click());
    expect(reads).toBe(2);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('history-pending-' + width + '.png') });
    gate.resolve();
    const retry = dialog.getByRole('button', { name: 'Retry history', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('The last loaded history is still shown.');
    await expect(retry).toBeFocused();
    await expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    await retry.press('Enter');
    await expect(dialog.getByText('After refresh', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
    expect(reads).toBe(3);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(caption).toHaveValue(draft);
    await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
    expect(await page.evaluate(() => (window as any).__historyNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
    expect(state.requests.filter((item) => item.method === 'POST' && item.path.includes('/history/'))).toHaveLength(0);
  } finally { gate.resolve(); }
});

test('History keeps lock counts on their checkpoint and Restore aligned at desktop and phone widths', async ({ page }, info) => {
  await installFixture(page);
  await page.route('**/api/projects/landscape/history', (route) => route.fulfill({ json: [
    { ...checkpoint, textLockedCount: 2, timingLockedCount: 3 },
    { ...checkpoint, id: 'second', label: 'Before updating a long Khmer caption · មុនពេលកែសម្រួលអក្សររត់' },
  ] }));
  await openProject(page);
  const dialog = await openHistory(page);
  const rows = dialog.locator('article');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const copy = rows.first().locator('.history-copy');
    const lockCounts = copy.getByText('2 text locks · 3 timing locks', { exact: true });
    await expect(lockCounts).toBeHidden();
    const disclosure = copy.locator('summary');
    await disclosure.press('Enter');
    await expect(lockCounts).toBeVisible();
    await expect(rows.nth(1).locator('details')).not.toHaveAttribute('open');
    const reason = (await copy.locator('strong').boundingBox())!;
    const date = (await copy.locator('time').boundingBox())!;
    if (width === 320) expect(date.y).toBeGreaterThanOrEqual(reason.y + reason.height);
    else expect(date.x + date.width).toBeLessThanOrEqual(reason.x);
    const actions = rows.getByRole('button', { name: /^Restore / });
    await expect(actions).toHaveCount(2);
    const [firstX, secondX] = await actions.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().x));
    expect(firstX).toBeCloseTo(secondX, 1);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('checkpoint-' + width + '.png') });
    await disclosure.press('Space');
    await expect(lockCounts).toBeHidden();
  }
});

test('closing a pending History refresh permits a fresh visit and ignores the old result', async ({ page }) => {
  await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const old = deferred();
  const current = deferred();
  const oldFinished = deferred();
  let reads = 0;
  await page.route('**/api/projects/landscape/history', async (route) => {
    const read = ++reads;
    if (read === 2) await old.promise;
    if (read === 3) await current.promise;
    try {
      await route.fulfill({ json: [{ ...checkpoint, label: read === 2 ? 'Stale checkpoint' : read === 3 ? 'Current checkpoint' : checkpoint.label }] });
    } finally { if (read === 2) oldFinished.resolve(); }
  });
  try {
    await openProject(page);
    let dialog = await openHistory(page);
    await expect(dialog).toContainText('1 saved version');
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await dialog.getByRole('button', { name: 'Close history', exact: true }).click();
    dialog = await openHistory(page);
    await expect.poll(() => reads).toBe(3);
    old.resolve();
    await oldFinished.promise;
    await expect(dialog).toContainText('Loading history…');
    await expect(dialog.getByText('Stale checkpoint', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    current.resolve();
    await expect(dialog.getByText('Current checkpoint', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('1 saved version');
    expect(reads).toBe(3);
  } finally { old.resolve(); current.resolve(); }
});
