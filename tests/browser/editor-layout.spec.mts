import { test, expect, type Locator, type Page } from '@playwright/test';
import { resetEditorLayout } from './editor-layout-tools.mjs';
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

test('preview and full caption list survive every tool switch with stable width and toolbar-dependent height', async ({ page }) => {
  await portraitProject(page);
  await page.evaluate(() => { (window as any).__layoutMedia = document.querySelector('video'); (window as any).__layoutCaptions = document.querySelector('.caption-panel'); });
  const preview = (await page.locator('.media-stage').boundingBox())!;
  expect(preview.height).toBeGreaterThan(650);
  const toolbarHeight = (await page.locator('.editor-toolbar').boundingBox())!.height;
  const rail = page.locator('.stage-rail');
  for (const name of ['Fine timing', 'Appearance', 'Accuracy', 'Caption grouping', 'Technical details', 'Export']) {
    if (name === 'Technical details') {
      await page.getByLabel('Open project tools', { exact: true }).click();
      await page.getByRole('menuitem', { name: /^Technical details/ }).click();
    } else if (name === 'Appearance' || name === 'Export') {
      await rail.getByRole('button', { name, exact: true }).click();
    } else {
      if (name === 'Accuracy') await rail.getByRole('button', { name: 'Captions', exact: true }).click();
      await page.getByRole('button', { name: name === 'Accuracy' ? /^Accuracy/ : name, exact: name !== 'Accuracy' }).click();
    }
    await expect(page.locator('.workspace-inspector')).toBeVisible();
    const current = (await page.locator('.media-stage').boundingBox())!;
    const expectedHeight = preview.height + (['Appearance', 'Export'].includes(name) ? toolbarHeight : 0);
    expect(Math.abs(current.height - expectedHeight), name).toBeLessThan(1);
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
  await page.locator('.stage-rail').getByRole('button', { name: 'Appearance', exact: true }).click();
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
  await page.locator('.stage-rail').getByRole('button', { name: 'Export', exact: true }).click();
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
  await resetEditorLayout(page);
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
  await resetEditorLayout(page);
  await page.getByRole('separator', { name: 'Resize Preview and Captions', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Move later', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].startMs).toBe(250);
});

test('browsing a long caption list keeps its position and follow choice across tools', async ({ page }) => {
  state.projects[0].captions = Array.from({ length: 20 }, (_, index) => ({ id: `layout-${index}`, startMs: index * 180, endMs: index * 180 + 160, text: `ខ្មែរកម្ពុជា ${index + 1}`, timingSource: 'stt' as const, timingQuality: 'high' as const }));
  await openProject(page);
  const list = page.locator('.caption-list');
  await list.hover(); await page.mouse.wheel(0, 350);
  await expect(page.locator('.caption-panel').getByRole('button', { name: 'Follow playback', exact: true, pressed: false })).toBeVisible();
  const top = await list.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(100);
  const rail = page.locator('.stage-rail');
  for (const name of ['Appearance', 'Fine timing', 'Technical details']) {
    if (name === 'Technical details') {
      await page.getByLabel('Open project tools', { exact: true }).click();
      await page.getByRole('menuitem', { name: /^Technical details/ }).click();
    } else if (name === 'Appearance') {
      await rail.getByRole('button', { name, exact: true }).click();
    } else {
      await rail.getByRole('button', { name: 'Captions', exact: true }).click();
      await page.getByRole('button', { name, exact: true }).click();
    }
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(top);
    await expect(page.locator('.caption-panel').getByRole('button', { name: 'Follow playback', exact: true, pressed: false })).toBeVisible();
    expect(await page.locator('.caption-row').count()).toBe(20);
  }
});

test('caption toolbar labels fit and phone controls keep their touch targets', async ({ page }) => {
  await openProject(page);
  const header = page.locator('.caption-panel .panel-head');
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await header.boundingBox();
    expect(bounds).toBeTruthy();
    for (const name of ['Current', 'Follow playback', 'Add caption']) {
      const button = header.getByRole('button', { name, exact: true });
      await expect(button.locator('span')).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
      if (width <= 390) expect(box.height).toBeGreaterThanOrEqual(44);
    }
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

async function expectUnobscured(target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect.poll(() => target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    return [bounds.top + 2, bounds.bottom - 2].every((y) => element.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
}

test('phone project without captions shows the Generate captions action on entry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  delete state.projects[0].transcript;
  state.projects[0].captions = [];
  await openProject(page);

  const generate = page.getByRole('button', { name: 'Generate captions', exact: true });
  await expect(generate).toBeEnabled();
  await expectUnobscured(generate);
  await expect(page.locator('.media-stage video')).toBeVisible();
  await expect(page.locator('.caption-panel')).toBeVisible();
});

test('phone workspace tools reveal the focused inspector and Close returns to the opener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page);
  const originals = await page.evaluateHandle(() => ({
    video: document.querySelector('video'),
    list: document.querySelector('.caption-list'),
  }));
  await expect(page.locator('.caption-list')).toBeVisible();
  const workbench = page.locator('.editor-workbench');
  const back = page.getByRole('button', { name: 'Back to Home' });
  const tools = [
    { title: 'Review', trigger: page.locator('.stage-rail').getByRole('button', { name: /^Review\b/ }) },
    { title: 'Caption grouping', trigger: page.getByRole('navigation', { name: 'Caption workspace tools' }).getByRole('button', { name: 'Caption grouping' }) },
  ];
  for (const { title, trigger } of tools) {
    await trigger.click();
    const inspector = page.getByRole('complementary', { name: `${title} workspace` });
    const heading = inspector.locator('.inspector-heading');
    await expect(heading).toBeFocused();
    await expectUnobscured(heading);
    if (title === 'Review') {
      const approve = inspector.getByRole('button', { name: 'Approve & next', exact: true });
      await expect(approve).toBeEnabled();
      await expectUnobscured(approve);
    }

    // After entering the tool, moving elsewhere or scrubbing the video must
    // leave the user's newer keyboard and scroll position alone.
    await back.focus();
    const scrolled = await workbench.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before > 1 ? 0 : element.scrollHeight;
      return { before, after: element.scrollTop };
    });
    expect(Math.abs(scrolled.after - scrolled.before)).toBeGreaterThan(1);
    await seek(page, title === 'Review' ? 1400 : 2600);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(back).toBeFocused();
    expect(await workbench.evaluate((element) => element.scrollTop)).toBeCloseTo(scrolled.after, 0);

    await inspector.getByRole('button', { name: 'Close tool' }).click();
    await expect(inspector).toBeHidden();
    await expect(trigger).toBeFocused();
    await expectUnobscured(trigger);
    expect(await originals.evaluate(({ video, list }) =>
      video === document.querySelector('video') && list === document.querySelector('.caption-list'))).toBe(true);
  }
  await originals.dispose();
});
