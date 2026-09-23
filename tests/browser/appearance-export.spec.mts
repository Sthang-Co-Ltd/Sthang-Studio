import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, appearance, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function appearancePanel(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
}

test('native preview is the caption image at the contained video frame, including resize', async ({ page }) => {
  state.native = true;
  await openProject(page);
  const image = page.locator('.native-caption-image');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('alt', 'កម្ពុជា CapCut');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  const assertGeometry = async () => {
    const boxes = await page.evaluate(() => {
      const video = document.querySelector('video')!;
      const v = video.getBoundingClientRect(); const img = document.querySelector('.native-caption-image')!.getBoundingClientRect();
      const scale = Math.min(v.width / video.videoWidth, v.height / video.videoHeight);
      return { x: img.x, y: img.y, width: img.width, height: img.height, expectedX: v.x + (v.width - video.videoWidth * scale) / 2, expectedY: v.y + (v.height - video.videoHeight * scale) / 2, expectedW: video.videoWidth * scale, expectedH: video.videoHeight * scale };
    });
    for (const [actual, expected] of [[boxes.x, boxes.expectedX], [boxes.y, boxes.expectedY], [boxes.width, boxes.expectedW], [boxes.height, boxes.expectedH]]) expect(Math.abs(actual - expected)).toBeLessThan(1);
  };
  await assertGeometry();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await image.boundingBox())?.width).toBeLessThan(390);
  await assertGeometry();
});

test('appearance edits persist across tools and export sends the same saved settings snapshot', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  await page.getByLabel(/^Size /).fill('88');
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  expect(state.projects[0].captionAppearance?.fontSize1080).toBe(88);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: /Captioned video/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Advanced video settings', { exact: true })).toBeVisible();
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.body.resolution).toBe('720p');
  await page.getByRole('button', { name: /Render captioned video/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.studio-confirm-cancel')).toBeFocused();
  await dialog.getByRole('button', { name: 'Render anyway' }).click();
  await expect.poll(() => state.requests.find((r) => r.path.endsWith('/jobs') && r.method === 'POST')?.body.appearance.fontSize1080).toBe(88);
  expect(state.requests.find((r) => r.path.endsWith('/jobs') && r.method === 'POST')?.body.settings.resolution).toBe('720p');
});

test('appearance controls keep the last native caption visible while the newest look renders', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  const image = page.locator('.native-caption-image');
  await expect(image).toBeVisible();
  await page.getByText('More appearance', { exact: true }).click();

  // Make each changed-look render slow enough that rapid slider input overlaps it.
  // Studio should retain the last valid native frame and coalesce toward the newest look.
  state.previewDelay = (body) => body.appearance.fontSize1080 === appearance.fontSize1080 ? 0 : 350;
  const size = page.getByLabel(/^Size /);
  const position = page.getByLabel(/^Position /);
  const outline = page.locator('.appearance-more label.range-field').filter({ hasText: /^Outline / }).locator('input[type="range"]');
  const shadow = page.locator('.appearance-more label.range-field').filter({ hasText: /^Shadow / }).locator('input[type="range"]');

  await size.fill('66');
  await expect.poll(() => state.requests.some((item) => item.path.endsWith('/preview') && item.body.appearance.fontSize1080 === 66)).toBe(true);
  await page.waitForTimeout(35);
  await expect(image).toBeVisible();
  await expect(page.locator('.native-preview-status')).toHaveCount(0);

  // A second movement of the same slider must not cancel/restart the first native
  // render into starvation. It should stay visible and converge to the newest value.
  await size.fill('78');
  await page.waitForTimeout(35);
  await expect(image).toBeVisible();
  await expect(page.locator('.native-preview-status')).toHaveCount(0);

  await position.fill('28');
  await page.waitForTimeout(35);
  await expect(image).toBeVisible();
  await expect(page.locator('.native-preview-status')).toHaveCount(0);

  await outline.fill('7');
  await shadow.fill('5');
  await page.waitForTimeout(35);
  await expect(image).toBeVisible();
  await expect(page.locator('.native-preview-status')).toHaveCount(0);

  await expect.poll(() => {
    const request = state.requests.filter((item) => item.path.endsWith('/preview')).at(-1);
    return request ? [
      request.body.appearance.fontSize1080,
      request.body.appearance.positionBottomPct,
      request.body.appearance.outlineWidth1080,
      request.body.appearance.shadowWidth1080,
    ] : [];
  }, { timeout: 5000 }).toEqual([78, 28, 7, 5]);
  await expect(image).toBeVisible();
});

test('failed appearance saves block export and recovery retries without losing the edited look', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  state.appearanceFailure = true;
  await page.getByLabel(/^Size /).fill('90');
  await expect(page.getByText('Appearance could not be saved')).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByText(/latest caption appearance could not be saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Render captioned video/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit appearance' }).click();
  await expect(page.getByLabel(/^Size /)).toHaveValue('90');
  state.appearanceFailure = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  expect(state.projects[0].captionAppearance?.fontSize1080).toBe(90);
});

test('drag feedback moves native pixels before a slow render and release converges without queued intermediate values', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  const surface = page.locator('.native-caption-surface');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  state.previewDelay = () => 700;
  const position = page.getByLabel(/^Position /);
  await position.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse' });
  await position.fill('28');
  await expect(surface).toHaveAttribute('data-preview-mode', 'interpolated');
  const firstMatrix = await page.locator('.native-caption-canvas').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).f);
  const displayedHeight = (await surface.boundingBox())!.height;
  const expected = (Math.max(8, Math.round(360 * appearance.positionBottomPct / 100)) - Math.round(360 * 28 / 100)) * displayedHeight / 360;
  expect(Math.abs(firstMatrix - expected)).toBeLessThan(0.1);
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.body.appearance.positionBottomPct).toBe(28);
  const count = state.requests.filter((r) => r.path.endsWith('/preview')).length;
  for (const value of ['29', '30', '31', '32']) await position.fill(value);
  await expect(surface).toHaveAttribute('data-preview-mode', 'interpolated');
  expect(state.requests.filter((r) => r.path.endsWith('/preview')).length).toBe(count);
  await position.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse' });
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  expect(await page.locator('.native-caption-canvas').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  const sent = state.requests.filter((r) => r.path.endsWith('/preview')).slice(count);
  expect(sent.at(-1)?.body.appearance.positionBottomPct).toBe(32);
  expect(sent.every((r) => r.body.timesMs.length === 1 && r.body.captions.length === 1)).toBe(true);
  expect(sent.some((r) => [29, 30, 31].includes(r.body.appearance.positionBottomPct))).toBe(false);
});

test('keyboard and cancelled drags settle exactly; transforms never carry into a caption gap', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  const surface = page.locator('.native-caption-surface');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  state.previewDelay = () => 250;
  const size = page.getByLabel(/^Size /);
  await size.focus();
  await page.keyboard.down('ArrowRight');
  await expect(surface).toHaveAttribute('data-preview-mode', 'interpolated');
  await page.keyboard.up('ArrowRight');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  await size.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch' });
  await size.fill('62');
  await expect(surface).toHaveAttribute('data-preview-mode', 'interpolated');
  await size.dispatchEvent('pointercancel', { pointerId: 2, pointerType: 'touch' });
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  await size.fill('64');
  await seek(page, 1100);
  await expect(page.locator('.native-caption-image')).toHaveCount(0);
  await seek(page, 1500);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('alt', 'ខ្មែររបស់យើង');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
});

test('real native pixels remain visible through drag refinement and decoded exact replacement', async ({ page }, testInfo) => {
  state.native = true;
  await openProject(page); await appearancePanel(page);
  const surface = page.locator('.native-caption-surface');
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  state.previewDelay = () => 1200;
  await page.getByLabel(/^Position /).fill('25');
  await expect(surface).toHaveAttribute('data-preview-mode', 'interpolated');
  await page.locator('.media-stage').scrollIntoViewIfNeeded();
  await expect(page.getByText('Interactive preview · refining layout…', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-drag-refining.png') });
  await expect(surface).toHaveAttribute('data-preview-mode', 'exact');
  await page.screenshot({ path: testInfo.outputPath('native-drag-exact.png') });
  expect(await page.locator('.native-caption-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
});

test('regular-only fonts automatically fall back to Regular without changing the rest of the appearance', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  await page.getByLabel(/^Size /).fill('74');
  await page.getByLabel('Khmer font', { exact: true }).selectOption('Regular-only fixture');
  await expect(page.getByText(/Studio switched Weight to Regular/)).toBeVisible();
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  expect(state.projects[0].captionAppearance?.fontSize1080).toBe(74);
  expect(state.projects[0].captionAppearance?.bold).toBe(false);
  await page.getByText('More appearance', { exact: true }).click();
  const regular = page.getByRole('button', { name: 'Regular', exact: true });
  await expect(regular).toHaveAttribute('aria-pressed', 'false');
  await expect(regular).toBeDisabled();
});

test('Add font is discoverable, selects the imported family, and Manage added fonts removes only the Studio copy', async ({ page }) => {
  state.fonts.push(...Array.from({ length: 25 }, (_, index) => ({
    name: `Installed Khmer ${String(index + 1).padStart(2, '0')}`,
    available: true,
    boldAvailable: index % 2 === 0,
    source: 'windows-system' as const,
  })));
  await openProject(page); await appearancePanel(page);
  await expect(page.getByRole('button', { name: 'Add font…', exact: true })).toBeVisible();
  await expect(page.getByText(/compatible Khmer fonts installed on this computer are ready to use/i)).toBeVisible();
  await expect(page.getByLabel('Khmer font', { exact: true }).locator('optgroup[label^="Installed on this computer"]')).toHaveCount(1);
  const fontSearch = page.getByLabel('Find Khmer font');
  await expect(fontSearch).toBeVisible();
  await fontSearch.fill('Installed Khmer 17');
  const liveResult = page.locator('.appearance-font-search-results').getByRole('button', { name: /Installed Khmer 17/ });
  await expect(liveResult).toBeVisible();
  await liveResult.click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Installed Khmer 17');
  await expect(fontSearch).toHaveValue('');

  await page.locator('.appearance-font-file-input').setInputFiles({
    name: 'creator-khmer.ttf',
    mimeType: 'font/ttf',
    buffer: Buffer.from('synthetic-font-fixture'),
  });
  await expect.poll(() => state.requests.filter((request) => request.path === '/api/video-export/fonts' && request.method === 'POST').length).toBe(1);
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Creator Khmer');
  await expect(page.getByText(/Added “Creator Khmer”/)).toBeVisible();
  await expect(page.getByText(/Studio is using Regular/)).toBeVisible();
  await expect.poll(() => state.projects[0].captionAppearance?.bold).toBe(false);
  await expect(page.getByText('Manage added fonts', { exact: false })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const addButton = page.getByRole('button', { name: 'Add font…', exact: true });
  expect((await addButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByText('Manage added fonts', { exact: false }).click();
  const remove = page.getByRole('button', { name: 'Remove', exact: true });
  expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await remove.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('This project will keep the font name');
  await dialog.getByRole('button', { name: 'Remove font', exact: true }).click();
  await expect(page.getByText(/Removed “Creator Khmer” from Studio/)).toBeVisible();
  expect(state.fonts.some((font) => font.source === 'studio-imported')).toBe(false);
  expect(state.fonts.some((font) => font.source !== 'studio-imported')).toBe(true);
});

test('newer appearance and project switches reject stale preview responses', async ({ page }) => {
  state.previewDelay = (body) => body.appearance.fontSize1080 === 80 ? 750 : 0;
  await openProject(page); await appearancePanel(page);
  await page.getByLabel(/^Size /).fill('80');
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.body.appearance.fontSize1080).toBe(80);
  await page.getByLabel(/^Size /).fill('96');
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.body.appearance.fontSize1080).toBe(96);
  await expect(page.locator('.native-caption-image')).toBeVisible();
  await page.getByRole('button', { name: /Back to projects/ }).click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.path).toBe('/api/video-export/second/preview');
  expect(state.requests.filter((r) => r.path.endsWith('/preview')).at(-1)?.body.appearance.textColor).toBe('#FF8000');
});

test('missing preview does not masquerade as a CSS match; retry restores it and gaps remain empty', async ({ page }) => {
  state.previewError = 'Synthetic renderer unavailable';
  await openProject(page);
  await expect(page.getByText('Synthetic renderer unavailable')).toBeVisible();
  await expect(page.locator('.native-caption-image')).toHaveCount(0);
  state.previewError = '';
  await page.getByRole('button', { name: 'Retry preview' }).click();
  await expect(page.locator('.native-caption-image')).toBeVisible();
  await seek(page, 1100);
  await expect(page.locator('.native-caption-image')).toHaveCount(0);
  await seek(page, 1500);
  await expect(page.locator('.native-caption-image')).toHaveAttribute('alt', 'ខ្មែររបស់យើង');
});

test('empty gateway preview responses recover automatically without exposing a JSON parser error', async ({ page }) => {
  state.previewGatewayFailures = 3;
  await openProject(page);
  await expect(page.locator('.native-caption-image')).toBeVisible();
  await expect(page.getByText(/Unexpected end of JSON input/i)).toHaveCount(0);
  expect(state.requests.filter((request) => request.path.endsWith('/preview')).length).toBeGreaterThanOrEqual(4);
});

test('preset management and computed controls keep their real accessible states and touch targets', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  const size = page.getByLabel(/^Size /); await size.fill('74');
  await page.getByText('Manage presets', { exact: true }).click();
  await page.getByLabel('Save current look as').fill('Khmer test look');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByLabel('Preset', { exact: true })).not.toHaveValue('');
  await expect(page.getByRole('button', { name: 'Delete preset', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  expect(state.profile.captionAppearances).toHaveLength(1);
  await page.getByRole('alertdialog').locator('.studio-confirm-cancel').click();
  await expect(page.getByRole('button', { name: 'Delete preset', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('More appearance', { exact: true }).click();
  for (const button of await page.locator('.appearance-grid button, .appearance-workspace-footer button, .appearance-preset-tools-body > button').all()) {
    if (await button.isVisible()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const fonts = await page.locator('.caption-appearance-workspace').evaluate((root) => [...root.querySelectorAll('button,label,span,strong')].filter((e) => e.getBoundingClientRect().height).map((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect(Math.min(...fonts)).toBeGreaterThanOrEqual(10);
});

test('SRT remains a separate text-and-timing export mode without appearance controls', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Captions file/ }).click();
  await expect(page.getByRole('button', { name: /Captions file/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Visual styling stays controlled by the destination editing app/)).toBeVisible();
  await expect(page.locator('.export-workspace input[type="color"]')).toHaveCount(0);
  expect(state.projects[0].captionAppearance).toEqual(appearance);
});

test('export settings grid and preset selector preserve unified field wrappers and full-width layout at desktop', async ({ page }) => {
  await openProject(page);
  await appearancePanel(page);

  // 1. Preset bar at desktop: single label child wrapping select, occupying full available width
  const presetBar = page.locator('.appearance-preset-bar');
  const presetLabel = presetBar.locator('> label[for="appearance-preset-select"]');
  await expect(presetLabel).toBeVisible();
  await expect(presetLabel.locator('#appearance-preset-select')).toBeVisible();
  const presetBarBox = (await presetBar.boundingBox())!;
  const presetSelectBox = (await page.locator('#appearance-preset-select').boundingBox())!;
  expect(presetSelectBox.width).toBeGreaterThanOrEqual(presetBarBox.width * 0.9);
  await expect(page.getByLabel('Preset', { exact: true })).toHaveId('appearance-preset-select');

  // 2. Export workspaces at desktop: setting grid has exactly 3 children
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const settingGrid = page.locator('.export-setting-grid');
  await expect(settingGrid).toBeVisible();
  expect(await settingGrid.locator('> *').count()).toBe(3);

  // Resolution block
  const resLabel = settingGrid.locator('> label[for="export-resolution-select"]');
  await expect(resLabel).toBeVisible();
  await expect(resLabel.locator('#export-resolution-select')).toBeVisible();
  const resLabelBox = (await resLabel.boundingBox())!;
  const resSelectBox = (await page.locator('#export-resolution-select').boundingBox())!;
  expect(resSelectBox.x).toBeGreaterThanOrEqual(resLabelBox.x - 2);
  expect(resSelectBox.x + resSelectBox.width).toBeLessThanOrEqual(resLabelBox.x + resLabelBox.width + 2);

  // Frame rate block
  const fpsLabel = settingGrid.locator('> label[for="export-framerate-select"]');
  await expect(fpsLabel).toBeVisible();
  await expect(fpsLabel.locator('#export-framerate-select')).toBeVisible();
  const fpsLabelBox = (await fpsLabel.boundingBox())!;
  const fpsSelectBox = (await page.locator('#export-framerate-select').boundingBox())!;
  expect(fpsSelectBox.x).toBeGreaterThanOrEqual(fpsLabelBox.x - 2);
  expect(fpsSelectBox.x + fpsSelectBox.width).toBeLessThanOrEqual(fpsLabelBox.x + fpsLabelBox.width + 2);

  // 3. Advanced video settings grid has exactly 3 children
  await page.getByText('Advanced video settings', { exact: true }).click();
  const advancedGrid = page.locator('.export-advanced-grid');
  await expect(advancedGrid).toBeVisible();
  expect(await advancedGrid.locator('> *').count()).toBe(3);

  // Codec block
  const codecLabel = advancedGrid.locator('> label[for="export-codec-select"]');
  await expect(codecLabel).toBeVisible();
  await expect(codecLabel.locator('#export-codec-select')).toBeVisible();
  const codecLabelBox = (await codecLabel.boundingBox())!;
  const codecSelectBox = (await page.locator('#export-codec-select').boundingBox())!;
  expect(codecSelectBox.x).toBeGreaterThanOrEqual(codecLabelBox.x - 2);
  expect(codecSelectBox.x + codecSelectBox.width).toBeLessThanOrEqual(codecLabelBox.x + codecLabelBox.width + 2);

  // Encoder block
  const encLabel = advancedGrid.locator('> label[for="export-encoder-select"]');
  await expect(encLabel).toBeVisible();
  await expect(encLabel.locator('#export-encoder-select')).toBeVisible();
  const encLabelBox = (await encLabel.boundingBox())!;
  const encSelectBox = (await page.locator('#export-encoder-select').boundingBox())!;
  expect(encSelectBox.x).toBeGreaterThanOrEqual(encLabelBox.x - 2);
  expect(encSelectBox.x + encSelectBox.width).toBeLessThanOrEqual(encLabelBox.x + encLabelBox.width + 2);

  // Custom bitrate block
  const bitrateLabel = advancedGrid.locator('> label[for="export-bitrate-input"]');
  await expect(bitrateLabel).toBeVisible();
  await expect(bitrateLabel.locator('#export-bitrate-input')).toBeVisible();
  const bitrateLabelBox = (await bitrateLabel.boundingBox())!;
  const bitrateInputBox = (await page.locator('#export-bitrate-input').boundingBox())!;
  expect(bitrateInputBox.x).toBeGreaterThanOrEqual(bitrateLabelBox.x - 2);
  expect(bitrateInputBox.x + bitrateInputBox.width).toBeLessThanOrEqual(bitrateLabelBox.x + bitrateLabelBox.width + 2);
});
