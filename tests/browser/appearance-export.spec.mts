import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, appearance, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function appearancePanel(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font')).toBeEnabled();
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

test('regular-only fonts never silently drop bold and allow the user to resolve the mismatch', async ({ page }) => {
  await openProject(page); await appearancePanel(page);
  await page.getByLabel('Khmer font').selectOption('Regular-only fixture');
  await expect(page.getByRole('alert').filter({ hasText: 'Bold Regular-only fixture is unavailable' })).toBeVisible();
  await page.getByText('More appearance', { exact: true }).click();
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(bold).toBeEnabled();
  await bold.click();
  await expect(page.getByRole('button', { name: 'Regular', exact: true })).toBeDisabled();
  await expect(page.getByText('Saved automatically', { exact: true })).toBeVisible();
  expect(state.projects[0].captionAppearance?.bold).toBe(false);
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
