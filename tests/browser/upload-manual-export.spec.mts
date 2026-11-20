import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareOwnedStateRoot, requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';
import { cleanupOwnedApiClients, startOwnedApi, stopOwnedApi } from './owned-api-harness.mjs';
import { closeOwnedBrowserContext, installBrowserNetworkGuard } from './owned-browser-routes.mjs';

const harness = requireHarnessConfig();
const test = base.extend<{ studioRoot: string }>({
  studioRoot: async ({ context }, use) => {
    const root = await prepareOwnedStateRoot(harness, 'manual-caption-state-');
    const api = await startOwnedApi(root);
    const closePages = () => {
      for (const page of context.pages()) void page.close().catch(() => {});
    };
    api.child.once('exit', closePages);
    try {
      await installBrowserNetworkGuard(context, harness);
      await context.route('https://**/*', (route) => route.abort());
      // The owned route guard forwards complete responses. Use Studio's
      // polling fallback for job events so an endless SSE response cannot block cleanup.
      await context.addInitScript(() => { (window as any).EventSource = undefined; });
      api.assertAlive();
      await use(root);
    } finally {
      try {
        await cleanupOwnedApiClients(api, [() => closeOwnedBrowserContext(context)]);
      } finally {
        api.child.off('exit', closePages);
        await stopOwnedApi(api);
        await fs.rm(verifyOwnedStateRoot(root, harness), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
});

async function makeClip(root: string) {
  const name = 'Khmer English sample.mp4';
  const file = path.join(root, name);
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file,
  ], { windowsHide: true, timeout: 30_000 });
  // In-memory chooser files keep all binary multipart bytes when the owned
  // browser guard forwards Chrome's request. Path-only attachments are omitted.
  return { name, mimeType: 'video/mp4', buffer: await fs.readFile(file) };
}

async function chooseMedia(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Choose a video or audio file' }).click(),
  ]);
  await picker.setFiles(file);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`fresh library to a saved manual caption and downloaded SRT at ${viewport.width}px`, async ({ page, studioRoot }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await Promise.all([page.waitForResponse('**/api/system/llm-settings'), page.goto('/')]);
    const choose = page.getByRole('button', { name: 'Choose a video or audio file' });
    await expect(choose).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(0);
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
    await expect(page.getByLabel('Search projects')).toBeHidden();
    await page.getByRole('button', { name: 'Create a project' }).click();
    await expect(choose).toBeFocused();

    await chooseMedia(page, { name: 'example.png', mimeType: 'image/png', buffer: Buffer.from('not a video') });
    await expect(page.getByText(/That file type is not supported/)).toBeVisible();
    const clip = await makeClip(studioRoot);
    const [created] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST'),
      chooseMedia(page, clip),
    ]);
    expect(created.status()).toBe(201);
    const project = await created.json();
    const stored = await fs.readFile(path.join(studioRoot, 'uploads', project.media.filename));
    expect(stored.equals(clip.buffer)).toBe(true);

    const video = page.locator('.media-stage video');
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).duration)).toBeCloseTo(4, 1);
    const closeGuide = page.getByRole('button', { name: 'Close guide' });
    await expect(closeGuide).toBeHidden();
    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Quick guide' }).click();
    await closeGuide.click();
    await page.getByRole('button', { name: 'Add caption', exact: true }).click();
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toBeFocused();
    const caption = 'សួស្តី Khmer Studio';
    await field.fill(caption);
    await field.press('Tab');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: /Captions file.*SRT/i }).click();
    const downloadSrt = page.getByRole('button', { name: 'Download SRT', exact: true });
    await expect(downloadSrt).toBeEnabled();
    if (viewport.width === 390) {
      await expect(downloadSrt).toBeInViewport({ ratio: 1 });
      await expect.poll(() => downloadSrt.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        return [rect.top + 2, rect.bottom - 2].every((y) => button.contains(document.elementFromPoint(x, y)));
      })).toBe(true);
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadSrt.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.srt$/i);
    const srt = await fs.readFile((await download.path())!, 'utf8');
    expect(srt.replace(/^\uFEFF/, '').trim().split(/\r?\n/)).toEqual([
      '1', '00:00:00,000 --> 00:00:01,500', caption,
    ]);

    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('button', { name: 'View all projects' }).click();
    await page.getByLabel('Search projects').fill('no matching title');
    await expect(page.getByRole('heading', { name: 'No projects match your search' })).toBeVisible();
    await page.getByRole('button', { name: 'Show all projects' }).click();
    await page.getByRole('button', { name: 'Open Khmer English sample' }).click();
    await expect(field).toHaveValue(caption);
  });
}
