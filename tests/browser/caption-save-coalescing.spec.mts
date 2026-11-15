import { test as base, expect, type Download, type Page } from '@playwright/test';
import { createCaptionData, serializeCaptionFile, type CaptionSegment } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
test.setTimeout(60_000);

function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
interface CaptionWrite {
  captions: CaptionSegment[];
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt?: string;
  source?: string;
  recordCorrections?: boolean;
}
interface Fixture {
  state: FixtureState;
  writes: CaptionWrite[];
  handoff: string[];
  gate: ReturnType<typeof deferred>;
  started: ReturnType<typeof deferred>;
  finished: ReturnType<typeof deferred>;
  revision: number;
}

async function fixture(page: Page, loseFirstAck = false): Promise<Fixture> {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  // This is a large caption workflow fixture, not a media-duration benchmark.
  // SRT validates the persisted transcript duration, which is absent here.
  state.projects[0].transcript = null;
  state.projects[0].captions = Array.from({ length: 500 }, (_, index) => ({
    id: `save-${index}`, text: `កម្ពុជា caption ${index + 1}`, startMs: 200 + index * 1000, endMs: 900 + index * 1000,
    approved: false, timingSource: 'manual', timingQuality: 'medium',
  }));
  const f: Fixture = { state, writes: [], handoff: [], gate: deferred(), started: deferred(), finished: deferred(), revision: 0 };
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as CaptionWrite;
    f.writes.push(structuredClone(body));
    const current = state.projects[0];
    if (body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size
      || body.expectedUpdatedAt !== current.updatedAt) {
      return route.fulfill({ status: 409, json: { error: 'The synthetic saved captions changed.', code: 'CAPTION_REVISION_CHANGED' } });
    }
    // The server can commit while its response is still delayed or lost.
    const saved = { ...structuredClone(current), captions: structuredClone(body.captions),
      updatedAt: new Date(Date.UTC(2026, 10, 14, 12, 0, ++f.revision)).toISOString() };
    state.projects[0] = saved;
    const first = f.writes.length === 1;
    if (first) { f.started.release(); await f.gate.promise; }
    try {
      if (first && loseFirstAck) return await route.fulfill({ status: 503, json: { error: 'Synthetic response lost after commit' } });
      return await route.fulfill({ json: { project: saved, correctionsCreated: 0 } });
    } catch (error) {
      if (!page.isClosed() && route.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error;
    } finally { if (first) f.finished.release(); }
  });
  await page.route('**/api/caption-handoff/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (action === 'export-history') return route.fulfill({ json: [] });
    f.handoff.push(action);
    const current = state.projects[0]; const revision = 'a'.repeat(64);
    if (action === 'summary') return route.fulfill({ json: { revision, captionCount: current.captions.length,
      media: { filename: current.media.filename, size: current.media.size }, snapshot: createCaptionData({ captions: current.captions }) } });
    const body = route.request().postDataJSON();
    if (body.expectedRevision !== revision || body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size) {
      return route.fulfill({ status: 409, json: { error: 'Stale synthetic handoff.' } });
    }
    if (action !== 'export' || body.format !== 'srt') return route.fulfill({ status: 400, json: { error: 'Unexpected synthetic handoff.' } });
    const result = serializeCaptionFile({ captions: current.captions }, 'srt');
    return route.fulfill({ contentType: result.mimeType, headers: { 'Content-Disposition': 'attachment; filename="captions.srt"' }, body: Buffer.from(result.text, 'utf8') });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return f;
}

async function handoffAfterBlur(page: Page, f: Fixture, text: string) {
  await openProject(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await f.started.promise;
  await page.getByRole('button', { name: /Captions file/ }).click();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
}
async function downloadedText(download: Download) {
  const stream = await download.createReadStream(); const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

for (const width of [1440, 390]) test(`500-caption blur and export share their pending save at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const f = await fixture(page); const edited = 'Edited ខ្មែរ before immediate export';
  try {
    await handoffAfterBlur(page, f, edited);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeVisible();
    expect(f.handoff).toEqual([]); expect(f.writes).toHaveLength(1);
    f.gate.release();
    const result = await download;
    expect(result.suggestedFilename()).toBe('captions.srt');
    const text = await downloadedText(result);
    expect(text).toContain(edited); expect(text).toContain('កម្ពុជា caption 500');
    expect(f.writes).toHaveLength(1); expect(f.revision).toBe(1);
    expect(f.writes[0]).toMatchObject({ source: 'text-edit', recordCorrections: true });
    expect(f.writes[0].captions).toHaveLength(500);
    expect(f.handoff).toEqual(['summary', 'export']);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(edited);
  } finally { f.gate.release(); }
});

test('a newer caption draft keeps its own queued save and export uses that acknowledgement', async ({ page }) => {
  const f = await fixture(page);
  const first = 'First edited ខ្មែរ caption'; const second = 'Newer second ខ្មែរ caption';
  try {
    await handoffAfterBlur(page, f, first);
    await page.getByLabel('Caption 2 text', { exact: true }).fill(second);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(1); expect(f.handoff).toEqual([]);
    f.gate.release();
    const text = await downloadedText(await download);
    expect(text).toContain(first); expect(text).toContain(second);
    expect(f.writes).toHaveLength(2); expect(f.revision).toBe(2);
    expect(f.writes[0].captions[1].text).toBe('កម្ពុជា caption 2');
    expect(f.writes[1].captions[0].text).toBe(first); expect(f.writes[1].captions[1].text).toBe(second);
    expect(f.writes.every((write) => write.source === 'text-edit' && write.recordCorrections === true)).toBe(true);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(first);
    await expect(page.getByLabel('Caption 2 text', { exact: true })).toHaveValue(second);
    expect(f.handoff).toEqual(['summary', 'export']);
  } finally { f.gate.release(); }
});

test('a shared lost acknowledgement keeps the exact recovery draft and never retries export blindly', async ({ page }) => {
  const f = await fixture(page, true); const edited = 'Unconfirmed ខ្មែរ saved response';
  const downloads: Download[] = []; page.on('download', (download) => downloads.push(download));
  try {
    await handoffAfterBlur(page, f, edited);
    await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeVisible();
    f.gate.release(); await f.finished.promise;
    await expect(page.locator('.handoff-action-error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
    expect(f.writes).toHaveLength(1); expect(f.revision).toBe(1);
    expect(f.handoff).toEqual([]); expect(downloads).toEqual([]);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(edited);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter((key) => key.startsWith('sthang-studio:unfinished-edits:'))
      .some((key) => JSON.parse(localStorage.getItem(key)!).captions?.[0]?.text === 'Unconfirmed ខ្មែរ saved response'))).toBe(true);
  } finally { f.gate.release(); }
});
