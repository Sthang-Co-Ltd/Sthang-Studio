import { test, expect, type Page } from '@playwright/test';
import { buildCaptionWordTiming } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });
async function openExport(page: Page) {
  await openProject(page); await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByLabel('Resolution', { exact: true })).toBeEnabled();
}
async function widePanel(page: Page) {
  await page.setViewportSize({ width: 2048, height: 1400 });
  await page.addInitScript(() => localStorage.setItem('sthang:editor-layout:v2', JSON.stringify({ preview: .26, inspector: .44, order: ['preview', 'captions', 'inspector'] })));
}

test('graphite Export responds to panel width and retains choices and media through resizing and output switches', async ({ page }, info) => {
  await widePanel(page); await openExport(page);
  const workspace = page.locator('.export-workspace'); const grid = workspace.locator('.export-setting-grid');
  const resolution = page.getByLabel('Resolution', { exact: true }); const frameRate = page.getByLabel('Frame rate', { exact: true });
  expect((await workspace.boundingBox())!.width).toBeGreaterThan(600);
  expect(Math.abs((await resolution.boundingBox())!.y - (await frameRate.boundingBox())!.y)).toBeLessThan(2);
  expect((await frameRate.boundingBox())!.x).toBeGreaterThan((await resolution.boundingBox())!.x + 100);
  expect((await workspace.locator('.export-quality-choice').boundingBox())!.width).toBeCloseTo((await grid.boundingBox())!.width, 0);
  const support = workspace.getByRole('button', { name: 'Recheck video export support', exact: true });
  await expect(workspace.locator('.export-checks').getByRole('button', { name: 'Recheck video export support', exact: true })).toBeVisible();
  expect((await support.boundingBox())!.width).toBeLessThan((await workspace.locator('.export-checks').boundingBox())!.width / 2);
  await expect(workspace.locator('.export-finalize .export-summary-line')).toContainText('640×360');
  await expect(workspace.locator('.export-finalize')).toContainText('free');
  await page.locator('.workspace-inspector').screenshot({ path: info.outputPath('export-graphite-wide.png') });
  await resolution.selectOption('720p'); await frameRate.selectOption('30'); await page.getByRole('button', { name: 'High quality', exact: true }).click();
  await page.getByText('Manage presets', { exact: true }).click(); await page.getByLabel('Save video export preset as', { exact: true }).fill('Unsaved output name');
  await page.evaluate(() => { (window as any).__exportMedia = document.querySelector('video'); (window as any).__exportCaptions = document.querySelector('.caption-panel'); });
  await page.getByRole('separator', { name: 'Resize Captions and Tool', exact: true }).press('End');
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBeLessThan(540);
  expect((await frameRate.boundingBox())!.y).toBeGreaterThan((await resolution.boundingBox())!.y + 30);
  await expect(resolution).toHaveValue('720p'); await expect(frameRate).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'High quality', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Save video export preset as', { exact: true })).toHaveValue('Unsaved output name');
  expect(await page.evaluate(() => (window as any).__exportMedia === document.querySelector('video') && (window as any).__exportCaptions === document.querySelector('.caption-panel'))).toBe(true);
  expect(await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const modeFormats = workspace.locator('.export-mode-switch small');
  expect(Math.abs((await modeFormats.nth(0).boundingBox())!.y - (await modeFormats.nth(1).boundingBox())!.y)).toBeLessThan(2);
  await page.locator('.inspector-content').evaluate((node) => { node.scrollTop = 0; });
  await page.locator('.workspace-inspector').screenshot({ path: info.outputPath('export-graphite-narrow.png') });
  await page.getByRole('button', { name: /Captions file/ }).click(); await page.getByLabel('Caption destination', { exact: true }).selectOption('premiere');
  await page.getByRole('button', { name: /Captioned video MP4/ }).click(); await expect(resolution).toHaveValue('720p'); await expect(frameRate).toHaveValue('30');
  await page.getByRole('button', { name: /Captions file/ }).click(); await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('premiere');
  await page.getByRole('separator', { name: 'Resize Captions and Tool', exact: true }).press('Home');
  await page.locator('.inspector-content').evaluate((node) => { node.scrollTop = 0; });
  await page.locator('.workspace-inspector').screenshot({ path: info.outputPath('captions-graphite-wide.png') });
});

for (const width of [390, 820]) test(`both export paths remain readable and reachable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1050 }); await openExport(page);
  const workspace = page.locator('.export-workspace');
  await expect(page.getByRole('button', { name: 'Check layout', exact: true })).toBeVisible();
  expect(await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  if (width === 390) {
    const controls = workspace.locator('.export-mode-switch button, .export-checks button, .export-setting-grid select, .export-quality-choice button, .export-appearance-summary button, .export-finalize button');
    for (const control of await controls.all()) if (await control.isVisible()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('button', { name: /Captions file/ }).click();
  await expect(page.getByText('Text and timing only. Set visual styling in the destination editor.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  await page.locator('.handoff-advanced summary').click();
  expect(await workspace.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  // Capture the real scroll viewport; a full-height inspector capture is obscured by the retained sticky preview.
  await page.getByRole('button', { name: /Captions file/ }).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath(`captions-graphite-${width}.png`) });
});

for (const readiness of ['ready', 'needs review'] as const) test(`word-highlight information distinguishes ${readiness} without changing export decisions`, async ({ page }, info) => {
  await widePanel(page);
  const project = state.projects[0]; project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  for (const caption of project.captions) caption.wordTiming = buildCaptionWordTiming(caption, [{ id: `${caption.id}-word`, text: caption.text, startMs: caption.startMs, endMs: caption.endMs, spaceBefore: false, timingSource: 'stt', confidence: .99, alignmentScore: .99 }]);
  if (readiness === 'needs review') { delete project.captions[0].wordTiming; project.transcript = undefined; }
  await openExport(page);
  const note = page.locator('.export-warnings').filter({ hasText: 'Word highlights appear in captioned video.' });
  await expect(note).toContainText(readiness === 'ready' ? 'All captions with text have usable word timing.' : 'will remain plain because word timing needs review.');
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
  if (readiness === 'needs review') {
    const repair = note.getByRole('button', { name: 'Review word timing', exact: true });
    await expect(repair).toBeVisible();
    expect((await repair.boundingBox())!.height).toBeGreaterThanOrEqual(38);
  }
  await page.locator('.workspace-inspector').screenshot({ path: info.outputPath(`word-highlight-${readiness.replace(' ', '-')}.png`) });
});
