import { test, expect, type Page, type Request } from '@playwright/test';
import { normalizeCaptionAppearance } from '@kcs/shared';
import { cleanFixtures, expandAppearanceSection, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => { state = await installFixture(page); });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openAppearance(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await expandAppearanceSection(page, 'motion');
}

test('an obsolete request cannot erase the pending states of its replacement', async ({ page }) => {
  state.projects[0].captionAppearance = normalizeCaptionAppearance({ ...state.projects[0].captionAppearance, motionPreset: 'fade' });
  await openProject(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const first = deferred<Request>();
  const second = deferred<Request>();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  let requests = 0;
  const batches: number[][] = [];
  await page.route('**/api/video-export/*/preview', async (route) => {
    requests += 1;
    batches.push(route.request().postDataJSON().timesMs);
    if (requests === 1) { first.resolve(route.request()); await releaseFirst.promise; }
    if (requests === 2) { second.resolve(route.request()); await releaseSecond.promise; }
    await route.fallback().catch(() => {});
  });
  try {
    await seek(page, 230);
    await first.promise;
    // Phase 3 sends a missing CURRENT native paint before any future-frame
    // prefetch. Target the exact replacement paint instead of relying on the
    // former eight-state batch to include a future 1260 ms paint.
    await seek(page, 1260);
    const currentBatch = await second.promise;
    const times = currentBatch.postDataJSON().timesMs as number[];
    expect(times).toContain(1260);
    // The old abort settles after the replacement installed its pending set.
    // Moving inside the same pending paint interval must reuse that request,
    // not cancel it or launch a duplicate native render.
    await seek(page, 1265);
    releaseFirst.resolve();
    releaseSecond.resolve();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    expect(currentBatch.failure()).toBeNull();
    expect(batches.filter((times) => times.includes(1260)), JSON.stringify(batches)).toHaveLength(1);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
  }
});

test('static Looks can replay, stop and replay again using cached native frames', async ({ page }) => {
  state.native = true;
  await openAppearance(page);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const openingRequests = () => state.requests.filter((request) => request.path.endsWith('/preview') && request.body.timesMs.includes(200)).length;
  const before = openingRequests();
  const replay = page.getByRole('button', { name: 'Replay effect', exact: true });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(page.getByRole('button', { name: 'Stop replay', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await page.getByRole('button', { name: 'Stop replay', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await replay.click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  expect(openingRequests()).toBe(before);
});

test('Cancel preparation prevents delayed autoplay and allows another replay', async ({ page }) => {
  await openAppearance(page);
  const entered = deferred();
  const release = deferred();
  await page.route('**/api/video-export/*/preview', async (route) => {
    if (route.request().postDataJSON().appearance.motionPreset === 'fade') { entered.resolve(); await release.promise; }
    await route.fallback().catch(() => {});
  });
  try {
    await page.getByRole('group', { name: 'Caption motion' }).getByRole('button', { name: 'Fade', exact: true }).click();
    await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
    await entered.promise;
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    release.resolve();
    await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeEnabled();
    await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  } finally { release.resolve(); }
});

test('native player seeking releases replay without snapping back or pausing the new playback', async ({ page }) => {
  await openAppearance(page);
  await page.getByRole('button', { name: 'Replay effect', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 2.5; });
  await expect(page.getByRole('button', { name: 'Stop replay', exact: true })).toHaveCount(0);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(2.8);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
});

test('removing and re-adding the same selected font invalidates exact pixels and clears preview errors', async ({ page }) => {
  await openAppearance(page);
  const input = page.locator('.appearance-font-file-input');
  const syntheticFont = { name: 'Synthetic.ttf', mimeType: 'font/ttf', buffer: Buffer.from('fixture font upload') };
  await input.setInputFiles(syntheticFont);
  await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Creator Khmer');
  await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe('Creator Khmer');
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  const appearance = structuredClone(state.projects[0].captionAppearance);
  state.previewError = 'Selected font is unavailable. Add it again to preview.';
  await page.getByText('Manage added fonts', { exact: false }).click();
  await page.locator('.appearance-font-manager').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove font', exact: true }).click();
  await expect(page.locator('.native-preview-status.error')).toContainText('Selected font is unavailable');
  await expect(page.locator('.native-caption-surface[data-preview-mode="exact"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeDisabled();
  state.previewError = '';
  await input.setInputFiles(syntheticFont);
  await expect(page.locator('.native-caption-surface')).toHaveAttribute('data-preview-mode', 'exact');
  await expect(page.locator('.native-preview-status.error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeEnabled();
  expect(state.projects[0].captionAppearance).toEqual(appearance);
});

test('a font added during initial discovery remains selected and completes loading', async ({ page }) => {
  const entered = deferred();
  const release = deferred();
  const original = structuredClone(state.fonts);
  await page.route('**/api/video-export/fonts?refresh=1', async (route) => {
    entered.resolve();
    await release.promise;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fonts: original }) });
  });
  try {
    await openProject(page);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await entered.promise;
    await page.locator('.appearance-font-file-input').setInputFiles({ name: 'Synthetic.ttf', mimeType: 'font/ttf', buffer: Buffer.from('fixture font upload') });
    await expect(page.getByLabel('Khmer font', { exact: true })).toHaveValue('Creator Khmer');
    release.resolve();
    await expect(page.getByRole('button', { name: 'Replay effect', exact: true })).toBeEnabled();
    await expect(page.locator('.appearance-inline-warning').filter({ hasText: 'Creator Khmer is unavailable' })).toHaveCount(0);
    await expect.poll(() => state.projects[0].captionAppearance?.fontFamily).toBe('Creator Khmer');
  } finally { release.resolve(); }
});

test('saving a preset captures the clicked appearance and keeps newer changes marked Custom', async ({ page }) => {
  await openAppearance(page);
  const choose = (name: string) => page.getByRole('group', { name: 'Caption looks' }).getByRole('button', { name: new RegExp(`^${name}`) });
  await choose('Soft Glow').click();
  await expect.poll(() => state.projects[0].captionAppearance?.glowEnabled).toBe(true);
  const entered = deferred();
  const release = deferred();
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'GET') { entered.resolve(); await release.promise; }
    await route.fallback();
  });
  try {
    await expandAppearanceSection(page, 'presets');
    await page.getByText('Manage presets', { exact: true }).click();
    await page.getByPlaceholder('Example: Clean Khmer').fill('Saved glow');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await entered.promise;
    await choose('Bold Outline').click();
    release.resolve();
    await expect.poll(() => state.profile.captionAppearances?.length).toBe(1);
    expect(state.profile.captionAppearances![0].appearance.glowEnabled).toBe(true);
    await expect.poll(() => state.projects[0].captionAppearance?.glowEnabled).toBe(false);
    await expect(page.getByLabel('Preset', { exact: true })).toHaveValue('');
  } finally { release.resolve(); }
});

test('long Khmer samples remain bounded and the replay controls fit phone and tablet layouts', async ({ page }) => {
  const text = `${'ខ្មែរកម្ពុជា '.repeat(100)}👨‍👩‍👧‍👦`;
  state.projects[0].captions[0].text = text;
  await openAppearance(page);
  const samples = await page.locator('.appearance-look-preview > span').allTextContents();
  expect(samples).toHaveLength(6);
  // The browser creates these presentation samples. Use its ICU segmentation
  // when checking the bound, rather than a potentially different Node ICU.
  const sampleLengths = await page.locator('.appearance-look-preview > span').evaluateAll((elements) => {
    const segmenter = new Intl.Segmenter('km', { granularity: 'grapheme' });
    return elements.map((element) => [...segmenter.segment(element.textContent || '')].length);
  });
  expect(sampleLengths.every((length) => length <= 73), JSON.stringify(sampleLengths)).toBe(true);
  expect(samples.every((sample) => sample.endsWith('…'))).toBe(true);
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Replay effect', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator('.media-stage')).toBeInViewport();
    await expect(page.getByLabel('Replay target caption', { exact: true })).toContainText('ខ្មែរកម្ពុជា');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const replayBounds = await page.getByRole('button', { name: 'Replay effect', exact: true }).boundingBox();
    expect(replayBounds!.height).toBeGreaterThanOrEqual(width === 320 ? 44 : 36);
    await page.screenshot({ path: `test-results/caption-effects-polish-${width}.png`, fullPage: true });
  }
  expect(state.projects[0].captions[0].text).toBe(text);
});

test('appearance groups open independently without editing settings and remain usable on narrow screens', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await openAppearance(page);
  const initialAppearance = structuredClone(state.projects[0].captionAppearance);
  const groups = ['appearance-motion-disclosure', 'appearance-word-details', 'appearance-more', 'appearance-presets-disclosure'];

  for (const [width, height] of [[1440, 1000], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    for (const name of groups) {
      const group = page.locator(`.${name}`);
      const summary = group.locator(':scope > summary');
      const body = group.locator(':scope > .appearance-option-body');
      if (await group.getAttribute('open') !== null) {
        await summary.focus();
        await summary.press('Enter');
      }
      await expect(body).toBeHidden();
      await summary.focus();
      await summary.press('Enter');
      await expect(body).toBeVisible();
      if (name === 'appearance-presets-disclosure') {
        const management = group.locator('.appearance-preset-tools');
        if (await management.getAttribute('open') === null) await management.locator(':scope > summary').click();
      }

      expect(await group.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      for (const control of await body.locator('button,input,select,summary').all()) {
        // Default Reset controls retain layout space but are hidden and cannot be hit-tested.
        if (!await control.evaluate((node) => node.checkVisibility({ visibilityProperty: true }))) continue;
        expect(await control.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const bounds = node.closest('.appearance-option-body')!.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right + 1;
        })).toBe(true);
        if (width <= 620) {
          await control.evaluate((node) => node.scrollIntoView({ block: 'start' }));
          await expect(control).toBeInViewport();
          expect(await control.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          })).toBe(true);
        }
      }
      await summary.evaluate((node) => { node.blur(); node.scrollIntoView({ block: innerWidth <= 620 ? 'start' : 'center' }); });
      if (width === 1440) {
        await summary.hover();
        await page.locator('.workspace-inspector').screenshot({ path: testInfo.outputPath(`${name}-hover.png`), animations: 'disabled' });
        await page.mouse.move(0, 0);
      }
      const path = testInfo.outputPath(`${name}-${width}.png`);
      if (width <= 620) await page.screenshot({ path, animations: 'disabled' });
      else await page.locator('.workspace-inspector').screenshot({ path, animations: 'disabled' });
      await summary.focus();
      await summary.press('Enter');
      await expect(body).toBeHidden();
    }
    const first = page.locator('.appearance-motion-disclosure > summary');
    await page.locator('.appearance-option-group > summary').evaluateAll((nodes) => nodes.forEach((node) => (node as HTMLElement).blur()));
    await first.evaluate((node) => { node.blur(); node.scrollIntoView({ block: innerWidth <= 620 ? 'start' : 'center' }); });
    const path = testInfo.outputPath(`appearance-groups-collapsed-${width}.png`);
    if (width <= 620) await page.screenshot({ path, animations: 'disabled' });
    else await page.locator('.workspace-inspector').screenshot({ path, animations: 'disabled' });
  }
  expect(state.projects[0].captionAppearance).toEqual(initialAppearance);
});

for (const [width, height] of [[1440, 1000], [390, 844], [320, 740]]) test(`Outline Reset is hidden at its default and usable after editing at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await openAppearance(page);
  await page.locator('.appearance-more > summary').click();
  const outline = page.getByRole('spinbutton', { name: 'Exact outline', exact: true });
  const reset = page.locator('.appearance-more').getByRole('button', { name: 'Reset outline to 3 px', exact: true, includeHidden: true });
  await expect(outline).toHaveValue('3');
  await expect(reset).toBeHidden();
  await outline.fill('4.5');
  await outline.press('Enter');
  await expect(reset).toBeVisible();
  await expect.poll(() => state.projects[0].captionAppearance?.outlineWidth1080).toBe(4.5);
  await reset.click();
  await expect(outline).toHaveValue('3');
  await expect(reset).toBeHidden();
  await expect(outline).toBeFocused();
  await expect.poll(() => state.projects[0].captionAppearance?.outlineWidth1080).toBe(3);
});
