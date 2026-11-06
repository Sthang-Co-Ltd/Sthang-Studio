import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function tool(page: Page, name: RegExp) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}
const checkpoint = { id: 'saved-1', projectId: 'landscape', label: 'Before correction', source: 'manual-save', createdAt: '2026-01-01T00:00:00.000Z', captionCount: 3, approvedCount: 0, textLockedCount: 0, timingLockedCount: 0 };

test('History distinguishes loading, failed loading, loaded entries and failed refresh without disturbing the editor', async ({ page }, info) => {
  const gate = deferred(); let reads = 0; let fail = true;
  await page.route('**/api/projects/landscape/history', async (route) => {
    reads++; if (reads === 1) await gate.promise;
    return fail ? route.fulfill({ status: 503, json: { error: 'Synthetic history failure' } }) : route.fulfill({ json: [checkpoint] });
  });
  try {
    await openProject(page); await tool(page, /^History/);
    const dialog = page.getByRole('dialog', { name: 'Project history', exact: true });
    await expect(dialog).toContainText('Loading history…');
    await expect(dialog.getByText('History appears after', { exact: false })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    gate.resolve();
    await expect(dialog.getByRole('button', { name: 'Retry history', exact: true })).toBeEnabled();
    await expect(dialog).toContainText('History unavailable');
    fail = false;
    await dialog.getByRole('button', { name: 'Retry history', exact: true }).click();
    await expect(dialog).toContainText('1 saved version');
    await expect(dialog.getByText('Before correction', { exact: true })).toBeVisible();
    fail = true;
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('The last loaded history is still shown.');
    await expect(dialog.getByText('Before correction', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('history-refresh-recovery.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[0].captions[0].text);
    expect(state.requests.filter((item) => item.method === 'POST' && item.path.includes('/history/'))).toHaveLength(0);
  } finally { gate.resolve(); }
});

test('History shows its empty explanation only after a successful empty response', async ({ page }) => {
  await openProject(page); await tool(page, /^History/);
  const dialog = page.getByRole('dialog', { name: 'Project history', exact: true });
  await expect(dialog).toContainText('0 saved versions');
  await expect(dialog).toContainText('History appears after a meaningful edit or automatic change.');
});

function correction() {
  state.profile.correctionEvents = [{ id: 'correction-1', projectId: 'landscape', projectTitle: 'Audit landscape', captionId: 'c1', startMs: 200, endMs: 1000,
    originalText: 'Old កម្ពុជា', correctedText: 'New កម្ពុជា', suggestedVocabularyLine: 'New | Old', suggestionKind: 'alias', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }];
}

for (const mode of ['modern', 'fallback', 'delayed fallback', 'failure'] as const) test(`correction copy ${mode} reports the actual outcome and retains modal focus`, async ({ page }, info) => {
  correction();
  if (mode === 'failure') await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((mode) => {
    (window as any).__copiedReport = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => {
      if (mode === 'delayed fallback') await new Promise<void>((_resolve, reject) => { (window as any).__rejectClipboard = () => reject(new Error('Synthetic delayed denial')); });
      if (mode !== 'modern') throw new Error('Synthetic clipboard denial');
      (window as any).__copiedReport = value;
    } } });
    document.execCommand = (command: string) => {
      if (command !== 'copy' || mode === 'failure') return false;
      (window as any).__copiedReport = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    };
  }, mode);
  await openProject(page); await tool(page, /^Correction inbox/);
  const dialog = page.getByRole('dialog', { name: 'Correction Inbox', exact: true });
  const copy = dialog.getByRole('button', { name: 'Copy report', exact: true });
  const originalWidth = (await copy.boundingBox())!.width;
  await copy.focus(); await copy.press('Enter');
  if (mode === 'delayed fallback') {
    await expect(copy.getByRole('status')).toHaveText('Copying…');
    await expect(copy).toBeFocused();
    await copy.press('Tab');
    const next = dialog.getByRole('button', { name: 'Remember for all projects', exact: true });
    await expect(next).toBeFocused();
    await page.evaluate(() => (window as any).__rejectClipboard());
    await expect(copy.getByRole('status')).toHaveText('Copied');
    await expect(next).toBeFocused();
  } else await expect(copy).toBeFocused();
  if (mode === 'failure') {
    await expect(dialog.getByRole('alert')).toContainText('Could not copy');
    await expect(copy.getByRole('status')).not.toHaveText('Copied');
    const manual = dialog.getByRole('textbox', { name: 'Copy report: text for manual copying', exact: true });
    await expect(manual).toHaveValue(/Before: Old កម្ពុជា[\s\S]*After: New កម្ពុជា/);
    await manual.focus();
    expect(await manual.evaluate((node: HTMLTextAreaElement) => node.selectionEnd! - node.selectionStart!)).toBe((await manual.inputValue()).length);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('copy-recovery-390.png') });
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
    await copy.click(); await expect(copy.getByRole('status')).toHaveText('Copied');
    await expect(manual).toHaveCount(0);
  } else {
    await expect(copy.getByRole('status')).toHaveText('Copied');
    expect((await copy.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
    expect(await page.evaluate(() => (window as any).__copiedReport)).toContain('Suggested memory: New | Old');
  }
});

test('diagnostic copy exposes failure recovery and confirms a successful retry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic denial'); } } });
    document.execCommand = () => false;
  });
  await page.route('**/api/system/doctor', (route) => route.fulfill({ json: { overall: 'ok', generatedAt: '2026-01-01T00:00:00.000Z', engineVersion: 'test', checks: [], environment: { platform: 'test', node: 'test', appRoot: 'synthetic', apiPort: 0, webOrigin: 'synthetic' } } }));
  await openProject(page); await tool(page, /^Settings/);
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'System check', exact: true }).click();
  await settings.getByRole('button', { name: 'Run checks', exact: true }).click();
  const copy = settings.getByRole('button', { name: 'Copy diagnostic report', exact: true });
  await copy.click();
  await expect(settings.getByRole('textbox', { name: 'Copy diagnostic report: text for manual copying', exact: true })).toHaveValue(/"overall": "ok"/);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
  await copy.click(); await expect(copy.getByRole('status')).toHaveText('Copied');
});
