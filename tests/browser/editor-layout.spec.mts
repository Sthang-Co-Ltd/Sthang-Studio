import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, capabilities, type FixtureState } from './fixtures.mjs';

let portrait: Buffer;
let state: FixtureState;
test.beforeAll(async () => {
  await prepareFixtures();
  const file = path.join(process.env.STHANG_STUDIO_STATE_ROOT!, 'layout-portrait.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=0x304035:s=360x640:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { windowsHide: true, timeout: 30_000 });
  portrait = await fs.readFile(file);
});
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  await page.setViewportSize({ width: 2048, height: 1041 });
});

async function portraitProject(page: Page) {
  state.native = true;
  state.capabilities = { ...capabilities, source: { ...capabilities.source, width: 360, height: 640, displayWidth: 360, displayHeight: 640 }, resolutions: [{ id: 'source', label: 'Original', width: 360, height: 640, upscaled: false }] };
  await page.route('**/media/landscape.mp4', (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ status: 200, contentType: 'video/mp4', body: portrait });
    const start = Number(range[1]); const end = Math.min(range[2] ? Number(range[2]) : portrait.length - 1, portrait.length - 1);
    return route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'Content-Range': `bytes ${start}-${end}/${portrait.length}`, 'Accept-Ranges': 'bytes' }, body: portrait.subarray(start, end + 1) });
  });
  await openProject(page);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoHeight)).toBe(640);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 2 && !video.seeking)).toBe(true);
  await seek(page, 300);
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(300);
}

test('preview and full caption list survive every tool switch without changing media size or remounting', async ({ page }) => {
  await portraitProject(page);
  await page.evaluate(() => { (window as any).__layoutMedia = document.querySelector('video'); (window as any).__layoutCaptions = document.querySelector('.caption-panel'); });
  const preview = (await page.locator('.media-stage').boundingBox())!;
  expect(preview.height).toBeGreaterThan(650);
  for (const name of ['Fine timing', 'Appearance', 'Accuracy', 'Caption grouping', 'Details', 'Export']) {
    await page.getByRole('button', { name: name === 'Accuracy' ? /^Accuracy/ : name, exact: name !== 'Accuracy' }).click();
    await expect(page.locator('.workspace-inspector')).toBeVisible();
    const current = (await page.locator('.media-stage').boundingBox())!;
    expect(Math.abs(current.height - preview.height), name).toBeLessThan(1);
    expect(Math.abs(current.width - preview.width), name).toBeLessThan(1);
    await expect(page.locator('.caption-panel')).toBeInViewport({ ratio: 1 });
    expect(await page.locator('.caption-row').count()).toBe(3);
    expect(await page.evaluate(() => (window as any).__layoutMedia === document.querySelector('video') && (window as any).__layoutCaptions === document.querySelector('.caption-panel'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await expect(page.locator('.workspace-inspector')).toBeHidden();
  expect((await page.locator('.media-stage').boundingBox())!.height).toBe(preview.height);
});

test('portrait appearance uses a large preview and one inspector with all caption rows available', async ({ page }) => {
  await portraitProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  for (const selector of ['.appearance-motion-disclosure', '.appearance-word-details', '.appearance-more', '.appearance-presets-disclosure']) await expect(page.locator(selector)).not.toHaveAttribute('open');
  await expect(page.getByLabel(/^Size /)).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel(/^Position /)).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.native-caption-image')).toBeVisible();
  await expect.poll(() => page.locator('.native-caption-image').evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([360, 640]);
  const geometry = await page.locator('video').evaluate((video: HTMLVideoElement) => {
    const rect = video.getBoundingClientRect();
    return { height: Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight) * video.videoHeight };
  });
  expect(geometry.height).toBeGreaterThan(650);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/refined-a-appearance.png', fullPage: true });
});

test('docked waveform stays wide and redraws after switching to the smaller-screen layout', async ({ page }) => {
  await portraitProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.locator('.waveform-loading')).toHaveCount(0);
  const dock = (await page.locator('.editor-timing-dock').boundingBox())!;
  const video = (await page.locator('.media-stage').boundingBox())!;
  expect(dock.x).toBeGreaterThan(video.x + video.width);
  expect(dock.width).toBeGreaterThan(900);
  await page.screenshot({ path: 'test-results/refined-a-timing.png', fullPage: true });
  for (const width of [1100, 1440, 2048]) {
    await page.setViewportSize({ width, height: 1041 });
    const canvas = page.locator('.waveform-data-canvas');
    await expect.poll(() => canvas.evaluate((element) => Math.abs(element.getBoundingClientRect().width - element.parentElement!.clientWidth))).toBeLessThan(2);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.getContext('2d')!.getImageData(10, 70, 1, 1).data[3])).toBeGreaterThan(0);
  }
});

test('pane resizing works with pointer and keyboard, persists locally, and can be reset', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const divider = page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true });
  const initial = (await page.locator('.media-stage').boundingBox())!.width;
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await page.locator('.media-stage').boundingBox())!.width).toBeGreaterThan(initial + 10);
  const inspector = page.getByRole('separator', { name: 'Resize Captions and Tool', exact: true });
  const box = (await inspector.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x - 50, box.y + box.height / 2); await page.mouse.up();
  const changed = (await page.locator('.media-stage').boundingBox())!.width;
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sthang:editor-layout:v2')!));
  expect(Object.keys(stored).sort()).toEqual(['inspector', 'order', 'preview']);
  expect(stored.inspector).toBeGreaterThan(.28);
  await page.reload(); await openProject(page);
  await expect.poll(async () => (await page.locator('.media-stage').boundingBox())!.width).toBe(changed);
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await expect.poll(async () => (await page.locator('.media-stage').boundingBox())!.width).toBe(initial);
});

test('layout remains usable when optional layout storage is corrupt or unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sthang:editor-layout:v2', '{bad json');
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'sthang:editor-layout:v2') throw new Error('Synthetic storage failure'); return write.call(this, key, value); };
  });
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
});

test('browsing a long caption list keeps its position and follow choice across tools', async ({ page }) => {
  state.projects[0].captions = Array.from({ length: 20 }, (_, index) => ({ id: `layout-${index}`, startMs: index * 180, endMs: index * 180 + 160, text: `ខ្មែរកម្ពុជា ${index + 1}`, timingSource: 'stt' as const, timingQuality: 'high' as const }));
  await openProject(page);
  const list = page.locator('.caption-list');
  await list.hover(); await page.mouse.wheel(0, 350);
  await expect(page.locator('.caption-panel').getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
  const top = await list.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(100);
  for (const name of ['Appearance', 'Fine timing', 'Details']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(top);
    await expect(page.locator('.caption-panel').getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    expect(await page.locator('.caption-row').count()).toBe(20);
  }
});

test('timing action labels remain readable at smaller desktop pane widths and Close restores focus', async ({ page }) => {
  await openProject(page);
  for (const width of [1280, 1440, 2048]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.locator('.fine-timing').count() === 0) await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    const labels = await page.locator('.timing-edge-actions button').evaluateAll((buttons) => buttons.map((button) => ({ label: button.textContent?.trim(), fits: button.scrollWidth <= button.clientWidth + 1 })));
    expect(labels.every((item) => item.fits), JSON.stringify(labels)).toBe(true);
  }
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fine timing', exact: true })).toBeFocused();
  await expect(page.locator('.workspace-inspector')).toBeHidden();
});
