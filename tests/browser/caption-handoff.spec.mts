import { test, expect, type Download, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings, parseCaptionData, serializeCaptionFile, type CaptionProject, type CaptionSegment, type SharedCaptionFileFormat } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let handoffCalls: Array<{ action: string; body: any }>;
const revision = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const current = () => state.projects[0];
const snapshot = () => createCaptionData({ captions: hydrateCaptionWordTimings(current()).captions, appearance: current().captionAppearance, durationMs: 4000 });

test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  handoffCalls = [];
  await page.route('**/api/caption-handoff/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    handoffCalls.push({ action, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (action === 'summary') return json({ revision, captionCount: current().captions.length, snapshot: snapshot(), media: { filename: current().media.filename, size: current().media.size } });
    if (body.expectedRevision !== revision || body.expectedMedia.filename !== current().media.filename || body.expectedMedia.size !== current().media.size) return json({ error: 'Stale fixture handoff.' }, 409);
    if (action === 'export') {
      const result = serializeCaptionFile({ captions: current().captions, appearance: current().captionAppearance }, body.format as SharedCaptionFileFormat);
      return route.fulfill({ status: 200, contentType: result.mimeType, headers: { 'Content-Disposition': `attachment; filename="captions${result.extension}"` }, body: Buffer.from(result.text, 'utf8') });
    }
    const candidate = parseCaptionData(body.data);
    if (action === 'restore-preview') return json({ revision, candidateDigest: digest, candidate, warnings: ['Fixture preview: captions only.'] });
    if (action === 'restore') {
      if (body.confirmed !== true || body.expectedCandidateDigest !== digest) return json({ error: 'Confirmation does not match the candidate.' }, 428);
      current().captions = candidate.captions.map((cue, index) => ({ ...cue, id: `restored-${index}`, approved: false,
        ...(cue.wordTiming ? { wordTiming: { ...cue.wordTiming, words: cue.wordTiming.words.map((word, wordIndex) => ({ ...word, id: `restored-${index}-word-${wordIndex}` })) } } : {}),
      })) as CaptionSegment[];
      current().transcriptNeedsSync = true;
      return json(current());
    }
    return json({ error: 'Unknown handoff fixture route' }, 404);
  });
});

async function openHandoff(page: Page) {
  await openProject(page);
  await page.getByRole('button', { name: /^Export$/ }).click();
  await page.getByRole('button', { name: /Captions file/ }).click();
  await expect(page.getByLabel('Caption destination', { exact: true })).toHaveValue('capcut-desktop');
}
async function downloadedText(download: Download) {
  const stream = await download.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}
async function openAdvanced(page: Page) {
  const details = page.locator('.handoff-advanced');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator('summary').click();
}
function importFile() {
  return { name: 'sample.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createCaptionData({
    captions: [{ id: 'not-exported', text: 'Restored ខ្មែរ captions', startMs: 400, endMs: 1700, approved: true }],
    appearance: { textColor: '#FF0000' }, durationMs: 4000,
  }))) };
}

test('CapCut Desktop starts with SRT and downloads the actual Unicode file after saving', async ({ page }) => {
  await openHandoff(page);
  await expect(page.locator('.handoff-destination-guide')).toContainText('Captions → Add Captions');
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Edited ខ្មែរ caption');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe('captions.srt');
  expect(await downloadedText(downloaded)).toContain('Edited ខ្មែរ caption');
  expect(current().captions[0].text).toBe('Edited ខ្មែរ caption');
  expect(handoffCalls.map((call) => call.action)).toEqual(['summary', 'export']);
  expect(handoffCalls[1].body).toMatchObject({ format: 'srt', expectedRevision: revision, expectedMedia: { filename: 'landscape.mp4', size: 5000 } });
  expect(handoffCalls[1].body.captions).toBeUndefined();
});

test('mobile guidance explains the supported external sync route without starting an upload', async ({ page }) => {
  await openHandoff(page);
  await page.getByLabel('Caption destination', { exact: true }).selectOption('capcut-mobile');
  const guide = page.locator('.handoff-destination-guide');
  await expect(guide).toContainText('does not provide direct subtitle-file import');
  await expect(guide).toContainText('cloud sync');
  await expect(guide).toContainText('CapCut, not Studio');
  expect(handoffCalls).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
});

test('VTT exports escaped cue text and destination changes reset advanced selection', async ({ page }) => {
  current().captions[0].text = 'ខ្មែរ <b>literal</b> & text';
  await openHandoff(page);
  await openAdvanced(page);
  await page.getByRole('button', { name: /^WebVTT/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download VTT', exact: true }).click();
  const text = await downloadedText(await pending);
  expect(text).toMatch(/^WEBVTT\r\n/);
  expect(text).toContain('ខ្មែរ &lt;b&gt;literal&lt;/b&gt; &amp; text');
  await page.getByLabel('Caption destination', { exact: true }).selectOption('premiere');
  await expect(page.getByRole('button', { name: 'Download VTT', exact: true })).toHaveCount(0);
});

test('word exports stay blocked when a caption has no usable word timings', async ({ page }) => {
  await openHandoff(page);
  await openAdvanced(page);
  await expect(page.getByRole('button', { name: /^One word per caption \(SRT\)/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^One word per caption \(VTT\)/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Review word timing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Word timing', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(handoffCalls).toHaveLength(0);
});

test('failed save stops the file export before a handoff request is sent', async ({ page }) => {
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 500, json: { error: 'Synthetic save failed' } }));
  await openHandoff(page);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unsaved wording');
  await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
  await expect(page.locator('.handoff-action-error')).toBeVisible();
  expect(handoffCalls).toHaveLength(0);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Unsaved wording');
});

test('an edit made during file preparation prevents a stale download', async ({ page }) => {
  let release!: () => void;
  let started = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.route('**/api/caption-handoff/landscape/export', async (route) => {
    started = true;
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/x-subrip', headers: { 'Content-Disposition': 'attachment; filename="old.srt"' }, body: 'Old snapshot' });
  });
  try {
    await openHandoff(page);
    await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByLabel('Caption 1 text', { exact: true }).fill('Newer edit while downloading');
    release();
    await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeEnabled();
    expect(downloads).toHaveLength(0);
    await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Newer edit while downloading');
  } finally { release?.(); }
});

test('caption data is previewed before restore, and Keep current performs no mutation', async ({ page }) => {
  const before = structuredClone(current().captions);
  await openHandoff(page);
  await openAdvanced(page);
  await page.locator('.handoff-restore input[type=file]').setInputFiles(importFile());
  await expect(page.getByRole('heading', { name: 'Review caption data' })).toBeVisible();
  await expect(page.locator('.caption-restore-samples')).toContainText('Restored ខ្មែរ captions');
  expect(current().captions).toEqual(before);
  await page.getByRole('button', { name: 'Keep current captions', exact: true }).click();
  await expect(page.getByLabel('Caption destination', { exact: true })).toBeVisible();
  expect(handoffCalls.some((call) => call.action === 'restore')).toBe(false);
  expect(current().captions).toEqual(before);
});

test('confirmed restore applies exactly the previewed data and keeps the project appearance', async ({ page }) => {
  const appearance = structuredClone(current().captionAppearance);
  await openHandoff(page);
  await openAdvanced(page);
  await page.locator('.handoff-restore input[type=file]').setInputFiles(importFile());
  await page.getByRole('button', { name: 'Replace captions', exact: true }).click();
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Restored ខ្មែរ captions');
  expect(current().captionAppearance).toEqual(appearance);
  expect(current().captions[0].approved).toBe(false);
  expect(handoffCalls.find((call) => call.action === 'restore')?.body).toMatchObject({ expectedCandidateDigest: digest, confirmed: true, expectedRevision: revision });
  expect(state.requests.filter((request) => request.path.endsWith('/captions'))).toHaveLength(0);
});

test('a text edit after import preview disables replacement and keeps the newer wording', async ({ page }) => {
  await openHandoff(page);
  await openAdvanced(page);
  await page.locator('.handoff-restore input[type=file]').setInputFiles(importFile());
  await expect(page.getByRole('button', { name: 'Replace captions', exact: true })).toBeEnabled();
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Keep this newer edit');
  await expect(page.getByRole('button', { name: 'Replace captions', exact: true })).toBeDisabled();
  await expect(page.locator('.caption-restore-review')).toContainText('project changed');
  expect(handoffCalls.some((call) => call.action === 'restore')).toBe(false);
});

test('malformed caption data fails without a false success preview', async ({ page }) => {
  await page.route('**/api/caption-handoff/landscape/restore-preview', (route) => route.fulfill({ status: 400, json: { error: 'Unsupported caption data version.' } }));
  await openHandoff(page);
  await openAdvanced(page);
  await page.locator('.handoff-restore input[type=file]').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.locator('.handoff-restore input[type=file]')).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Review caption data' })).toHaveCount(0);
  await expect(page.locator('.handoff-action-status')).toHaveCount(0);
  expect(handoffCalls.some((call) => call.action === 'restore')).toBe(false);
});

test('Final Cut guidance warns about overlapping captions without silently retiming them', async ({ page }) => {
  current().captions[0].endMs = 2000;
  await openHandoff(page);
  await page.getByLabel('Caption destination', { exact: true }).selectOption('final-cut');
  await expect(page.locator('.handoff-overlap-warning')).toContainText('Final Cut Pro');
  expect(current().captions[0].endMs).toBe(2000);
});

test('desktop and mobile export guidance remain readable with labeled touch controls', async ({ page }) => {
  state.native = true;
  await openHandoff(page);
  await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.readyState >= 2)).toBe(true);
  await expect(page.getByRole('button', { name: 'Download SRT', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/caption-handoff-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Caption destination', { exact: true }).selectOption('capcut-mobile');
  await page.getByRole('button', { name: 'Download SRT', exact: true }).scrollIntoViewIfNeeded();
  const heights = await page.locator('.caption-handoff-panel button:visible,.caption-handoff-panel select:visible').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  expect(heights.every((height) => height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/caption-handoff-mobile.png', fullPage: true });
});
