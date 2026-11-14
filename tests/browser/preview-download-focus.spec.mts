import { test as base, expect, type Download, type Locator, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, serializeCaptionFile, type SharedCaptionFileFormat } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
let state: FixtureState;
const revision = 'a'.repeat(64);
const stage = (page: Page) => page.getByRole('region', { name: 'Media preview', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry preview', exact: true });
const output = (page: Page) => page.getByRole('button', { name: /Captions file/ });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
test.beforeEach(async ({ page }) => {
  state = await installFixture(page); state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
async function remember(page: Page) {
  await page.evaluate(() => { document.querySelector('video')?.pause(); (window as any).__previewDownloadNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
}
async function unchanged(page: Page, before: string) {
  expect(JSON.stringify({ projects: state.projects, jobs: state.jobs })).toBe(before);
  expect(await page.evaluate(() => (window as any).__previewDownloadNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
}
async function visibleFocus(target: Locator) {
  await expect.poll(() => target.evaluate((node) => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    const hits = [top + 3, top + height / 2, bottom - 3].map((y) => {
      const hit = document.elementFromPoint(left + width / 2, y);
      return { y, own: hit === node || (hit !== null && node.contains(hit)), tag: hit?.tagName, class: hit?.getAttribute('class') };
    });
    return { focused: document.activeElement === node, inViewport: width > 0 && height > 0 && left >= 0 && top >= 0 && right <= innerWidth + 1 && bottom <= innerHeight + 1,
      uncovered: hits.every((hit) => hit.own), rect: { left, top, right, bottom, width, height }, hits };
  })).toMatchObject({ focused: true, inViewport: true, uncovered: true });
}
async function activate(page: Page, target: Locator) { await target.focus(); await page.keyboard.press('Enter'); }
async function textOf(download: Download) {
  const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

for (const width of [1440, 390]) test(`manual caption-preview retries keep a stable target through failure and success at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); state.previewError = 'Synthetic caption preview failure';
  await openProject(page);
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
  await remember(page); await expect(retry(page)).toBeEnabled();
  const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
  const time = await page.locator('video').evaluate((node: HTMLVideoElement) => node.currentTime);
  let held: ReturnType<typeof deferred> | null = null;
  state.previewHold = async () => { const captured = held; await captured?.promise; };
  const requests = () => state.requests.filter((request) => request.path.endsWith('/preview'));
  for (const succeeds of [false, true]) {
    const gate = deferred(); held = gate;
    state.previewError = succeeds ? '' : 'Synthetic caption preview failure';
    const initial = requests().length;
    try {
      await activate(page, retry(page)); await visibleFocus(stage(page));
      await expect(retry(page)).toHaveCount(0); await expect.poll(() => requests().length).toBe(initial + 1);
      await page.keyboard.press('r'); await page.keyboard.press('Space'); await page.keyboard.press('Alt+ArrowRight');
      expect(await page.locator('video').evaluate((node: HTMLVideoElement) => ({ paused: node.paused, time: node.currentTime }))).toEqual({ paused: true, time });
      await expect(page.getByLabel('Fine timing start', { exact: true })).toHaveValue('00:00.200');
      if (!succeeds) await page.screenshot({ path: info.outputPath(`caption-preview-retry-focus-${width}.png`), animations: 'disabled' });
      const newer = page.getByLabel('Caption 1 text', { exact: true });
      if (succeeds && width === 390) await newer.focus();
      gate.release();
      if (succeeds) { await expect(page.locator('.native-caption-image')).toBeVisible(); await expect(retry(page)).toHaveCount(0); }
      else await expect(retry(page)).toBeEnabled();
      if (succeeds && width === 390) await expect(newer).toBeFocused();
      else await visibleFocus(stage(page));
      await unchanged(page, before);
    } finally { gate.release(); held = null; }
  }
});

for (const width of [1440, 390]) for (const format of ['srt', 'vtt'] as const) {
  test(`native ${format.toUpperCase()} download keeps its caption-output target and newer focus at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    let attempt: { succeeds: boolean; gate: ReturnType<typeof deferred> } | null = null;
    const exports: any[] = [];
    await page.route('**/api/caption-handoff/**', async (route) => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      const current = state.projects[0];
      if (action === 'export-history') return route.fulfill({ json: [] });
      if (action === 'summary') return route.fulfill({ json: { revision, captionCount: current.captions.length,
        snapshot: createCaptionData({ captions: hydrateCaptionWordTimings(current).captions, appearance: current.captionAppearance, durationMs: 4000 }),
        media: { filename: current.media.filename, size: current.media.size } } });
      if (action !== 'export') throw new Error('The focused synthetic download test admits no import or restore.');
      const body = route.request().postDataJSON(); exports.push(body);
      expect(body).toMatchObject({ format, expectedRevision: revision, expectedMedia: { filename: current.media.filename, size: current.media.size } });
      const captured = attempt; if (!captured) throw new Error('No owned export response was prepared.');
      await captured.gate.promise;
      if (!captured.succeeds) return route.fulfill({ status: 503, json: { error: 'Synthetic caption download failure' } });
      const file = serializeCaptionFile({ captions: current.captions, appearance: current.captionAppearance }, format as SharedCaptionFileFormat);
      await route.fulfill({ contentType: file.mimeType, headers: { 'Content-Disposition': `attachment; filename="captions${file.extension}"` }, body: Buffer.from(file.text, 'utf8') });
    });
    await openProject(page); await page.getByRole('button', { name: 'Export', exact: true }).click(); await output(page).click();
    await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('capcut-desktop');
    await remember(page); const before = JSON.stringify({ projects: state.projects, jobs: state.jobs });
    if (format === 'vtt') { await page.locator('.handoff-advanced > summary').click(); await page.getByRole('button', { name: /^WebVTT/ }).click(); }
    const action = () => page.getByRole('button', { name: format === 'srt' ? 'Download SRT' : 'Download VTT', exact: true });
    for (const succeeds of [false, true]) {
      const gate = deferred(); attempt = { succeeds, gate };
      try {
        await activate(page, action()); await visibleFocus(output(page));
        await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
        await expect.poll(() => exports.length).toBe(succeeds ? 2 : 1);
        await expect(page.getByLabel('Caption destination', { exact: true })).toBeDisabled();
        // A second native activation now belongs to the persistent output control.
        await page.keyboard.press('Enter'); expect(exports).toHaveLength(succeeds ? 2 : 1);
        if (!succeeds) await page.screenshot({ path: info.outputPath(`caption-${format}-download-focus-${width}.png`), animations: 'disabled' });
        const newer = page.getByLabel('Caption 1 text', { exact: true });
        if (succeeds && width === 390) await newer.focus();
        const downloaded = succeeds ? page.waitForEvent('download') : null;
        gate.release();
        if (downloaded) {
          const file = await downloaded; expect(file.suggestedFilename()).toBe(`captions.${format}`);
          expect(await textOf(file)).toContain('កម្ពុជា CapCut');
          await expect(page.locator('.handoff-action-status')).toHaveText(`${format === 'srt' ? 'SRT' : 'WebVTT'} download started.`);
        } else await expect(page.locator('.handoff-action-error')).toContainText('The export was not started.');
        await expect(action()).toBeEnabled();
        await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('capcut-desktop');
        if (format === 'vtt') await expect(page.getByRole('button', { name: /^WebVTT/ })).toHaveAttribute('aria-pressed', 'true');
        if (succeeds && width === 390) await expect(newer).toBeFocused(); else await visibleFocus(output(page));
        await unchanged(page, before);
      } finally { gate.release(); }
    }
    expect(exports).toHaveLength(2);
  });
}
