import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

async function openTimeline(page: Page) {
  const button = page.getByRole('button', { name: /Fine timing/i });
  await button.click();
  await expect(page.locator('.waveform-card')).toBeVisible();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
}

function getTestHooks(page: Page) {
  return page.evaluate(() => {
    const hooks = (window as any).__STHANG_TEST_HOOKS__;
    if (!hooks) {
      throw new Error('Observation seam __STHANG_TEST_HOOKS__ is not available on window');
    }
    return {
      spectrumComputeCount: hooks.spectrumComputeCount as number,
      spectrumCacheHitCount: hooks.spectrumCacheHitCount as number,
      audioCacheHitCount: hooks.audioCacheHitCount as number,
      scheduledSpectrumCount: hooks.scheduledSpectrumCount as number,
      publishedSpectrumCount: hooks.publishedSpectrumCount as number,
      computedSpectrumKeys: [...hooks.computedSpectrumKeys] as string[],
      publishedSpectra: (hooks.publishedSpectra || []) as Array<{ key: string; bands: number; columns: number; values: number[] }>,
    };
  });
}

test('Waveform mode avoids spectrum computation on standard load and stays computation-free across seeking', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // In waveform mode, computeSpectrum and scheduledSpectrum should have strictly 0 invocations
  const hooks = await getTestHooks(page);
  expect(hooks.spectrumComputeCount).toBe(0);
  expect(hooks.scheduledSpectrumCount).toBe(0);

  // Waveform canvas is active
  await expect(page.locator('.waveform-card canvas')).toBeVisible();
  await expect(page.locator('button[title="Waveform"]')).toHaveClass(/selected/);
  await expect(page.locator('button[title="Spectral view"]')).not.toHaveClass(/selected/);

  // Seek and verify waveform stays computation-free
  await seek(page, 1500);
  await seek(page, 2500);
  const hooksAfterSeek = await getTestHooks(page);
  expect(hooksAfterSeek.spectrumComputeCount).toBe(0);
  expect(hooksAfterSeek.scheduledSpectrumCount).toBe(0);
});

test('Activating Spectral view computes spectrum once and caches the result', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Switch to spectral view
  const spectrumBtn = page.locator('button[title="Spectral view"]');
  await spectrumBtn.click();
  await expect(spectrumBtn).toHaveClass(/selected/);

  // Expect exactly 1 computeSpectrum invocation
  await expect.poll(async () => (await getTestHooks(page)).spectrumComputeCount).toBe(1);

  // Return to waveform mode
  const waveformBtn = page.locator('button[title="Waveform"]');
  await waveformBtn.click();
  await expect(waveformBtn).toHaveClass(/selected/);

  // Return to spectral view again with unchanged audio
  await spectrumBtn.click();
  await expect(spectrumBtn).toHaveClass(/selected/);

  // Compute count should remain strictly 1 (cached spectrum reused)
  const computeCountAfter = (await getTestHooks(page)).spectrumComputeCount;
  expect(computeCountAfter).toBe(1);
});

test('Unmounting and remounting WaveformEditor reuses in-memory decoded audio and cached spectrum', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Switch to spectrum and verify computation
  await page.locator('button[title="Spectral view"]').click();
  await expect.poll(async () => (await getTestHooks(page)).spectrumComputeCount).toBe(1);

  // Close timeline by clicking Fine timing button again
  await page.getByRole('button', { name: /Fine timing/i }).click();
  await expect(page.locator('.waveform-card')).toHaveCount(0);

  // Reopen timeline
  await openTimeline(page);

  // Verify memory cache hit occurred and zero additional spectrum computations occurred
  const hooks = await getTestHooks(page);
  expect(hooks.audioCacheHitCount).toBeGreaterThanOrEqual(1);
  expect(hooks.spectrumComputeCount).toBe(1);
});

test('Initial spectrum preference computes spectrum on initial mount', async ({ page }) => {
  state.profile.preferences.waveformMode = 'spectrum';
  await openProject(page);
  await openTimeline(page);

  // Since preference was spectrum, it should compute and select spectral view
  await expect(page.locator('button[title="Spectral view"]')).toHaveClass(/selected/);
  await expect.poll(async () => (await getTestHooks(page)).spectrumComputeCount).toBe(1);
});

test('Waveform pending work: schedules without executing immediately and flushes on timer', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Inject a 150ms delay for spectrum computation
  await page.evaluate(() => {
    (window as any).__STHANG_TEST_HOOKS__.spectrumDelayMs = 150;
  });

  // Switch to spectral view
  await page.locator('button[title="Spectral view"]').click();

  // Immediately check hooks: work must be scheduled without executing yet
  const hooksImmediately = await getTestHooks(page);
  expect(hooksImmediately.scheduledSpectrumCount).toBe(1);
  expect(hooksImmediately.spectrumComputeCount).toBe(0);
  expect(hooksImmediately.publishedSpectrumCount).toBe(0);

  // Wait for the delay to expire and work to complete
  await expect.poll(async () => (await getTestHooks(page)).spectrumComputeCount).toBe(1);
  const hooksFlushed = await getTestHooks(page);
  expect(hooksFlushed.publishedSpectrumCount).toBe(1);
});

test('Waveform pending work: unmount before running prevents stale spectrum computation and publication', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // Inject a 3000ms delay for spectrum computation
  await page.evaluate(() => {
    (window as any).__STHANG_TEST_HOOKS__.spectrumDelayMs = 3000;
  });

  // Switch to spectral view
  await page.locator('button[title="Spectral view"]').click();

  // Verify scheduled but not yet computed
  const hooksScheduled = await getTestHooks(page);
  expect(hooksScheduled.scheduledSpectrumCount).toBe(1);
  expect(hooksScheduled.spectrumComputeCount).toBe(0);

  // Immediately unmount before the timer expires
  await page.getByRole('button', { name: /Fine timing/i }).click();
  await expect(page.locator('.waveform-card')).toHaveCount(0);

  // Wait a short buffer (100ms) to ensure no background leaks occur
  await page.waitForTimeout(100);

  // Verify that neither computation nor publication occurred
  const hooksAfterWait = await getTestHooks(page);
  expect(hooksAfterWait.spectrumComputeCount).toBe(0);
  expect(hooksAfterWait.publishedSpectrumCount).toBe(0);
});

test('Waveform pending work: project identity and audio change while pending cancels stale work and publishes 880Hz vs 440Hz spectrum', async ({ page }) => {
  await openProject(page);
  await openTimeline(page);

  // 1. In project 1 (landscape: 440 Hz tone), schedule spectrum with a 5000ms delay
  await page.evaluate(() => {
    (window as any).__STHANG_TEST_HOOKS__.spectrumDelayMs = 5000;
  });

  await page.locator('button[title="Spectral view"]').click();

  // Verify project 1 work is scheduled but NOT computed
  const pendingHooksA = await getTestHooks(page);
  expect(pendingHooksA.scheduledSpectrumCount).toBe(1);
  expect(pendingHooksA.spectrumComputeCount).toBe(0);

  // 2. WHILE project 1 spectrum computation is still pending, navigate away to project 2 (second: 880 Hz tone)
  await page.getByLabel('Back to projects').click();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);

  // In project 2, reset delay to 0 for immediate computation
  await page.evaluate(() => {
    (window as any).__STHANG_TEST_HOOKS__.spectrumDelayMs = 0;
  });

  await openTimeline(page);
  await page.locator('button[title="Spectral view"]').click();

  // Await project 2 computation to complete
  await expect.poll(async () => (await getTestHooks(page)).publishedSpectra.length).toBe(1);

  const hooksAfterB = await getTestHooks(page);
  // Total computed is exactly 1 (Project 1's pending timer was cancelled and never computed)
  expect(hooksAfterB.spectrumComputeCount).toBe(1);
  expect(hooksAfterB.computedSpectrumKeys).toHaveLength(1);
  expect(hooksAfterB.computedSpectrumKeys[0]).toContain('second');

  const spec880 = hooksAfterB.publishedSpectra[0];
  expect(spec880.key).toContain('second');

  // Determine peak frequency band for 880 Hz audio (second project)
  let peakBand880 = 0;
  let maxEnergy880 = 0;
  for (let b = 0; b < spec880.bands; b++) {
    let sum = 0;
    for (let c = 0; c < 10; c++) sum += spec880.values[c * spec880.bands + b];
    if (sum > maxEnergy880) {
      maxEnergy880 = sum;
      peakBand880 = b;
    }
  }
  expect(peakBand880).toBe(4);

  // 3. Navigate back to project 1 and compute its spectrum now with delay 0
  await page.getByLabel('Back to projects').click();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.media-stage video')).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await seek(page, 500);

  await openTimeline(page);
  await page.locator('button[title="Spectral view"]').click();

  await expect.poll(async () => (await getTestHooks(page)).publishedSpectra.length).toBe(2);

  const finalHooks = await getTestHooks(page);
  expect(finalHooks.spectrumComputeCount).toBe(2);
  const spec440 = finalHooks.publishedSpectra[1];
  expect(spec440.key).toContain('landscape');

  // Determine peak frequency band for 440 Hz audio (landscape project)
  let peakBand440 = 0;
  let maxEnergy440 = 0;
  for (let b = 0; b < spec440.bands; b++) {
    let sum = 0;
    for (let c = 0; c < 10; c++) sum += spec440.values[c * spec440.bands + b];
    if (sum > maxEnergy440) {
      maxEnergy440 = sum;
      peakBand440 = b;
    }
  }
  expect(peakBand440).toBe(2);
  expect(peakBand880).toBeGreaterThan(peakBand440);
});
