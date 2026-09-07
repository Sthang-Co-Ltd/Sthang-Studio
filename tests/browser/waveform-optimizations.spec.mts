import { test, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openTimeline(page: import('@playwright/test').Page) {
  const button = page.getByRole('button', { name: /Fine timing/i });
  await button.click();
  await expect(page.locator('.waveform-card')).toBeVisible();
  // Wait for loading indicator to clear
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
}

test('Waveform mode avoids spectrum computation on standard load', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // In waveform mode, computeSpectrum should have 0 invocations
  const computeCount = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  expect(computeCount).toBe(0);

  // Waveform canvas is active
  await expect(page.locator('.waveform-card canvas')).toBeVisible();
  await expect(page.locator('button[title="Waveform"]')).toHaveClass(/selected/);
  await expect(page.locator('button[title="Spectral view"]')).not.toHaveClass(/selected/);
});

test('Activating Spectral view computes spectrum once and caches the result', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Switch to spectral view
  const spectrumBtn = page.locator('button[title="Spectral view"]');
  await spectrumBtn.click();
  await expect(spectrumBtn).toHaveClass(/selected/);

  // Expect exactly 1 computeSpectrum invocation
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  }).toBe(1);

  // Return to waveform mode
  const waveformBtn = page.locator('button[title="Waveform"]');
  await waveformBtn.click();
  await expect(waveformBtn).toHaveClass(/selected/);

  // Return to spectral view again with unchanged audio
  await spectrumBtn.click();
  await expect(spectrumBtn).toHaveClass(/selected/);

  // Compute count should remain strictly 1 (cached spectrum reused)
  const computeCountAfter = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  expect(computeCountAfter).toBe(1);
});

test('Unmounting and remounting WaveformEditor reuses in-memory decoded audio and cached spectrum', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Switch to spectrum and verify computation
  await page.locator('button[title="Spectral view"]').click();
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  }).toBe(1);

  // Close timeline by clicking Fine timing button again
  await page.getByRole('button', { name: /Fine timing/i }).click();
  await expect(page.locator('.waveform-card')).toHaveCount(0);

  // Reopen timeline
  await openTimeline(page);

  // Verify memory cache hit occurred and zero additional spectrum computations occurred
  const audioCacheHits = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.audioCacheHitCount ?? 0);
  expect(audioCacheHits).toBeGreaterThanOrEqual(1);

  const computeCount = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  expect(computeCount).toBe(1);
});

test('Initial spectrum preference computes spectrum on initial mount', async ({ page }) => {
  state.profile.preferences.waveformMode = 'spectrum';
  await openProject(page);
  await openTimeline(page);

  // Since preference was spectrum, it should compute and select spectral view
  await expect(page.locator('button[title="Spectral view"]')).toHaveClass(/selected/);
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  }).toBe(1);
});

test('Audio identity contract: switching project with different audio reloads and isolates spectrum', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Compute spectrum for first project
  await page.locator('button[title="Spectral view"]').click();
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  }).toBe(1);

  const firstKeys = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.computedSpectrumKeys ?? []);
  expect(firstKeys.length).toBe(1);
  expect(firstKeys[0]).toContain('landscape');

  // Switch back to waveform mode so preference is saved as waveform
  await page.locator('button[title="Waveform"]').click();

  // Switch project to 'second' within SPA (preserving in-memory state)
  await page.getByLabel('Back to projects').click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);

  // Open timeline on second project
  await openTimeline(page);

  // In second project, default is waveform mode -> compute count should still be 1 (no spectrum for second yet)
  const computeCountOnSecond = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  expect(computeCountOnSecond).toBe(1);

  // Activate spectrum on second project
  await page.locator('button[title="Spectral view"]').click();
  await expect.poll(async () => {
    return page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.spectrumComputeCount ?? 0);
  }).toBe(2);

  const allKeys = await page.evaluate(() => (window as any).__STHANG_TEST_HOOKS__?.computedSpectrumKeys ?? []);
  expect(allKeys.length).toBe(2);
  expect(allKeys[1]).toContain('second');
});
