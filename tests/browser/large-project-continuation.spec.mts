import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { createCaptionData, serializeCaptionFile } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const COUNT = 5_000;
const RECOVERY_ENTRY_LIMIT_BYTES = 1024 * 1024;
const recoveryPrefix = 'sthang-studio:unfinished-edits:';
let state: FixtureState;

test.beforeEach(async ({ page }) => {
  // Full 5,000-field browser journeys include reload and native focus checks.
  // Latency measurement remains in the separate scalability benchmark.
  test.setTimeout(120_000);
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  const project = state.projects[0];
  project.captions = Array.from({ length: COUNT }, (_, index) => ({
    id: `scale-${index}`,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${index + 1} Khmer caption${index === COUNT - 1 ? ' UNIQUE-5000' : ''}`,
    startMs: index * 2_000,
    endMs: index * 2_000 + 1_800,
    timingSource: 'manual' as const,
    approved: true,
  }));
  // This is a mounted-field/recovery test. The actual media fixture is four
  // seconds long; it does not simulate decoding or seeking through a long video.
  project.transcript = null;
  if (project.captionAppearance) project.captionAppearance.highlightMode = 'off';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
});

const field = (page: Page, index: number) => page.getByRole('textbox', { name: `Caption ${index + 1} text`, exact: true });
const recoveryNotice = (page: Page) => page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
// Keep the accessibility-role assertion, but avoid scanning all 5,000 caption
// rows for a notice that is owned by the small, persistent toast stack.
const saveFailure = (page: Page) => page.locator('.toast-stack').getByRole('alert').filter({ hasText: `Couldn't save changes` });

async function recoveryRecords(page: Page) {
  return page.evaluate((prefix) => Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({ key, bytes: 2 * (key.length + (localStorage.getItem(key)?.length || 0)) })), recoveryPrefix);
}

/** Observe synchronous recovery while the edited native textarea still owns focus.
 * A later blur may trigger a successful save and erase this evidence.
 */
async function expectBoundedFocusedRecovery(page: Page, index: number) {
  await expect(field(page, index)).toBeFocused();
  await expect.poll(async () => (await recoveryRecords(page)).length).toBe(1);
  const [record] = await recoveryRecords(page);
  expect(record.bytes).toBeGreaterThan(0);
  expect(record.bytes).toBeLessThanOrEqual(RECOVERY_ENTRY_LIMIT_BYTES);
  await expect(page.getByText('A recovery copy could not be kept in this browser.', { exact: false })).toHaveCount(0);
  return record.key;
}

async function reopenAfterInterruptedEditing(page: Page) {
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  });
  await page.reload();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);
}

test('5,000 native rows preserve first/middle/last caret and Khmer composition in bounded immediate recovery, then restore on reload', async ({ page }, testInfo) => {
  let failWrites = true;
  await page.route('**/api/projects/landscape/captions', (route) =>
    route.request().method() === 'PUT' && failWrites
      ? route.fulfill({ status: 503, json: { error: 'Synthetic unavailable caption save' } })
      : route.fallback());
  const saved = structuredClone(state.projects[0].captions);
  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);

  const first = field(page, 0);
  // IME cancellation/completion can deliver compositionend with the original
  // value. It must not revoke an approval or enqueue a whole-project save.
  await first.focus();
  await first.evaluate((node: HTMLTextAreaElement) => {
    (window as any).__largeProjectFirstTextarea = node;
    node.setSelectionRange(6, 6);
  });
  await first.dispatchEvent('compositionstart', { data: saved[0].text });
  await first.dispatchEvent('compositionend', { data: saved[0].text });
  await expect(first).toHaveValue(saved[0].text);
  await expect(first).toBeFocused();
  expect(await first.evaluate((node: HTMLTextAreaElement) => [
    (window as any).__largeProjectFirstTextarea === node, node.selectionStart, node.selectionEnd,
  ])).toEqual([true, 6, 6]);
  await expect(page.locator('[data-caption-id="scale-0"] .row-approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(await recoveryRecords(page)).toHaveLength(0);

  // Some IMEs publish the completed text only on compositionend, without a
  // separate input event. The native setter models that browser value update.
  await first.dispatchEvent('compositionstart', { data: 'FIRST caption កម្ពុជា edited' });
  await first.evaluate((node: HTMLTextAreaElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native textarea value setter unavailable');
    setter.call(node, 'FIRST caption កម្ពុជា edited');
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'FIRST caption កម្ពុជា edited' }));
  });
  await expect(first).toHaveValue('FIRST caption កម្ពុជា edited');
  await expect(page.locator('[data-caption-id="scale-0"] .row-approve')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.save-action')).toBeEnabled();

  const firstText = 'FIRST ថ្មី caption កម្ពុជា edited';
  await first.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 6));
  await page.keyboard.insertText('ថ្មី ');
  await expect(first).toHaveValue(firstText);
  expect(await first.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]))
    .toEqual([6 + 'ថ្មី '.length, 6 + 'ថ្មី '.length]);
  const firstRecovery = await expectBoundedFocusedRecovery(page, 0);

  const middle = field(page, Math.floor(COUNT / 2));
  const middleText = 'MIDDLE caption កម្ពុជាថ្មី';
  await middle.fill('MIDDLE caption កម្ពុជា');
  await middle.dispatchEvent('compositionstart', { data: 'ថ្មី' });
  await page.keyboard.insertText('ថ្មី');
  await middle.dispatchEvent('compositionend', { data: 'ថ្មី' });
  await expect(middle).toHaveValue(middleText);
  expect(await middle.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]))
    .toEqual([middleText.length, middleText.length]);
  const middleRecovery = await expectBoundedFocusedRecovery(page, Math.floor(COUNT / 2));
  expect(middleRecovery).not.toBe(firstRecovery);

  const last = field(page, COUNT - 1);
  const lastText = 'LAST caption កម្ពុជា exact!';
  await last.fill('LAST caption កម្ពុជា exact');
  await page.keyboard.insertText('!');
  await expect(last).toHaveValue(lastText);
  const lastRecovery = await expectBoundedFocusedRecovery(page, COUNT - 1);
  expect(lastRecovery).not.toBe(middleRecovery);
  expect(state.projects[0].captions).toEqual(saved);
  await page.screenshot({ path: testInfo.outputPath('desktop-5000-focused-recovery.png') });

  await reopenAfterInterruptedEditing(page);
  await expect(recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await expect(field(page, 0)).toHaveValue(saved[0].text);
  failWrites = false;
  await recoveryNotice(page).getByRole('button', { name: 'Restore draft', exact: true }).click();
  await expect(field(page, 0)).toHaveValue(firstText);
  await expect(field(page, Math.floor(COUNT / 2))).toHaveValue(middleText);
  await expect(field(page, COUNT - 1)).toHaveValue(lastText);
  await expect(field(page, 3400)).toHaveValue(saved[3400].text);
  expect(state.projects[0].captions).toEqual(saved);

  await page.locator('.save-action').click();
  await expect(page.locator('.save-action .save-action-label')).toHaveText('Saved');
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(state.projects[0].captions[0]).toMatchObject({ text: firstText, approved: false });
  expect(state.projects[0].captions[Math.floor(COUNT / 2)]).toMatchObject({ text: middleText, approved: false });
  expect(state.projects[0].captions[COUNT - 1]).toMatchObject({ text: lastText, approved: false });
  expect(state.projects[0].captions[3400]).toEqual(saved[3400]);

  await page.reload();
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(field(page, 0)).toHaveValue(firstText);
  await expect(field(page, Math.floor(COUNT / 2))).toHaveValue(middleText);
  await expect(field(page, COUNT - 1)).toHaveValue(lastText);
  await expect(recoveryNotice(page)).toHaveCount(0);
});

test('5,000 rows retain distant Find, menu and timing changes through failed save and guarded project switching', async ({ page }, testInfo) => {
  let failWrites = true;
  let failedRequests = 0;
  await page.route('**/api/projects/landscape/captions', (route) => {
    if (route.request().method() !== 'PUT' || !failWrites) return route.fallback();
    failedRequests += 1;
    return route.fulfill({ status: 503, json: { error: 'Synthetic unavailable caption save' } });
  });
  // A single real timed token enables Review without pretending this four-second
  // video contains the far-future caption's media. The wording differs from the
  // 5,000-cue draft, so legacy word-timing hydration cannot claim word authority.
  const transcript = state.projects[1].transcript!;
  const reviewToken = transcript.tokens?.[0];
  if (!reviewToken) throw new Error('The Review fixture needs one timed token.');
  state.projects[0].transcript = { ...structuredClone(transcript),
    tokens: [{ ...reviewToken, id: 'large-project-review-anchor', text: 'unrelated review token' }],
    segments: structuredClone(state.projects[0].captions) };
  state.projects[0].captions[0].timingQuality = 'low';
  state.projects[0].captions[COUNT - 1].timingQuality = 'low';
  state.projects[0].captions[COUNT - 1].approved = false;
  const saved = structuredClone(state.projects[0].captions);
  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);

  const deniedSave = page.waitForResponse((response) => response.request().method() === 'PUT'
    && response.url().includes('/api/projects/landscape/captions') && response.status() === 503);
  const editedFirst = 'Keep my Khmer correction កម្ពុជា';
  await field(page, 0).fill(editedFirst);
  await field(page, 1).focus(); // Text blur submits a save; the fixture refuses it.
  expect((await deniedSave).status()).toBe(503);
  await expect(saveFailure(page)).toBeVisible();
  await expect(saveFailure(page)).toContainText('Your edits are still here.');
  expect(failedRequests).toBeGreaterThan(0);
  await expect(field(page, 1)).toBeFocused();
  await expect(page.locator('.workspace')).toHaveClass(/has-save-failure/);
  await expect(page.locator('.workspace')).toHaveClass(/has-persistent-recovery/);
  await expect(page.getByRole('button', { name: 'Download edits', exact: true })).toHaveCount(1);

  await page.keyboard.press('Control+f');
  const findDialog = page.getByRole('dialog', { name: 'Find & Correct Everywhere', exact: true });
  await expect(findDialog).toBeVisible();
  await findDialog.getByLabel('Find', { exact: true }).fill('UNIQUE-5000');
  await expect(findDialog.locator('.find-summary')).toContainText(/^1\s*match in 1 caption\b/);
  await findDialog.getByRole('button', { name: 'Close find and correct' }).click();
  await expect(findDialog).toBeHidden();

  await page.getByRole('button', { name: 'More actions for caption 5000', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Lock text', exact: true }).click();
  await expect(field(page, COUNT - 1)).toHaveAttribute('readonly', '');
  await expect(field(page, 0)).toHaveValue(editedFirst);

  const start = page.getByLabel('Caption 1 start time', { exact: true });
  await start.fill('0.350');
  await field(page, 1).focus(); // Commit timing through the native timestamp field.
  await expect(start).toHaveValue('00:00.350');
  await expect(field(page, 0)).toHaveValue(editedFirst);
  await expect(field(page, 3400)).toHaveValue(saved[3400].text);

  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toHaveCount(0);
  await expect(saveFailure(page)).toBeVisible();
  expect(state.projects[0].captions).toEqual(saved);

  failWrites = false;
  await saveFailure(page).getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('.save-action .save-action-label')).toHaveText('Saved');
  await expect(page.locator('.save-action')).toBeDisabled();
  expect(state.projects[0].captions).toHaveLength(COUNT);
  expect(state.projects[0].captions[0]).toMatchObject({ text: editedFirst, startMs: 350, approved: false });
  expect(state.projects[0].captions[COUNT - 1]).toMatchObject({ text: saved[COUNT - 1].text, textLocked: true });
  expect(state.projects[0].captions[3400]).toEqual(saved[3400]);

  // Review must advance from the first edit to a distant flagged decision without
  // dropping that target or stealing focus from the stable primary action.
  await page.locator('.header-actions').getByRole('button', { name: /^Review/ }).click();
  const review = page.getByRole('complementary', { name: 'Review workspace', exact: true });
  const approveNext = review.getByRole('button', { name: 'Approve & next', exact: true });
  await expect(review).toBeVisible();
  await expect(page.locator('[data-caption-id="scale-0"]')).toHaveClass(/selected-range/);
  await approveNext.click();
  await expect(page.locator('[data-caption-id="scale-0"]')).toHaveCount(0);
  await expect(page.locator('[data-caption-id="scale-4999"]')).toHaveClass(/selected-range/);
  await expect(approveNext).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('desktop-5000-review-target.png') });
  await approveNext.click();
  await expect(page.getByRole('heading', { name: 'All flagged captions reviewed', exact: true })).toBeVisible();
  await page.locator('.save-action').click();
  await expect(page.locator('.save-action .save-action-label')).toHaveText('Saved');
  expect(state.projects[0].captions[0].approved).toBe(true);
  expect(state.projects[0].captions[COUNT - 1].approved).toBe(true);

  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recent projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Audit second/ }).click();
  await expect(page.locator('.caption-row')).toHaveCount(3);
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue(state.projects[1].captions[0].text);
});

for (const focusEntry of ['pointer', 'keyboard'] as const) test('5,000-row mobile quota failure keeps native caption focus and offers an exact Download edits copy (' + focusEntry + ')', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const saved = structuredClone(state.projects[0].captions);
  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);
  await page.evaluate((prefix) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith(prefix)) throw new DOMException('Synthetic browser storage quota exceeded', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  }, recoveryPrefix);

  const last = field(page, COUNT - 1);
  const updated = 'Final caption storage protection កម្ពុជា';
  if (focusEntry === 'pointer') await last.click();
  else {
    await page.getByLabel(`Caption ${COUNT} end time`, { exact: true }).click();
    await page.keyboard.press('Tab');
    await expect(last).toBeFocused();
  }
  const beforeFooter = await last.evaluate((node: HTMLTextAreaElement) => {
    const field = node.getBoundingClientRect();
    const list = node.closest('.caption-list')!.getBoundingClientRect();
    const workbench = node.closest('.editor-workbench')!;
    const port = workbench.getBoundingClientRect();
    const preview = workbench.querySelector('.stage-column')!.getBoundingClientRect();
    return { fieldTop: field.top, fieldBottom: field.bottom, listTop: list.top, listBottom: list.bottom,
      workbenchTop: port.top, workbenchBottom: port.bottom, workbenchScroll: workbench.scrollTop,
      previewBottom: preview.bottom, focused: document.activeElement === node };
  });
  expect(beforeFooter.focused).toBe(true);
  expect(beforeFooter.fieldTop, JSON.stringify(beforeFooter)).toBeGreaterThanOrEqual(Math.max(beforeFooter.listTop, beforeFooter.workbenchTop, beforeFooter.previewBottom) - 1);
  expect(beforeFooter.fieldBottom, JSON.stringify(beforeFooter)).toBeLessThanOrEqual(Math.min(beforeFooter.listBottom, beforeFooter.workbenchBottom) + 1);
  await last.fill(updated);
  await last.evaluate((node: HTMLTextAreaElement) => {
    (window as any).__largeProjectQuotaFocus = node;
    node.setSelectionRange(5, 5);
  });

  const warning = page.locator('.toast-stack .recovery-storage-error');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('A recovery copy could not be kept in this browser.');
  await expect(page.locator('.workspace')).toHaveClass(/has-persistent-recovery/);
  await expect(page.locator('.editor-workbench')).toHaveClass(/caption-list-focused/);
  await expect(page.getByRole('alert').filter({ hasText: "Couldn't save changes" })).toHaveCount(0);
  const downloadAction = warning.getByRole('button', { name: 'Download edits', exact: true });
  await expect(downloadAction).toBeVisible();
  await expect(downloadAction).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download edits', exact: true })).toHaveCount(1);
  expect(await recoveryRecords(page)).toEqual([]);
  expect(await last.evaluate((node: HTMLTextAreaElement) => [
    document.activeElement === node,
    (window as any).__largeProjectQuotaFocus === node,
    node.selectionStart,
    node.selectionEnd,
  ])).toEqual([true, true, 5, 5]);
  let visibilityGeometry: unknown;
  await expect.poll(async () => visibilityGeometry = await last.evaluate((node: HTMLTextAreaElement) => {
    const rect = node.getBoundingClientRect();
    const list = node.closest('.caption-list')!.getBoundingClientRect();
    const workbench = node.closest('.editor-workbench')!;
    const port = workbench.getBoundingClientRect();
    const preview = workbench.querySelector('.stage-column')!.getBoundingClientRect();
    const top = Math.max(0, list.top, port.top, preview.bottom);
    const bottom = Math.min(innerHeight, list.bottom, port.bottom);
    const visible = rect.top >= top - 1 && rect.bottom <= bottom + 1 && [rect.top + 4, rect.bottom - 4].every(y => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
      return hit === node || Boolean(hit && node.contains(hit));
    });
    return { visible, fieldTop: rect.top, fieldBottom: rect.bottom, top, bottom,
      listTop: list.top, listBottom: list.bottom, workbenchTop: port.top, workbenchBottom: port.bottom,
      workbenchScroll: workbench.scrollTop, focused: document.activeElement === node };
  }), { message: 'The recovery footer must keep the already-focused caption visible.' }).toMatchObject({ visible: true })
    .catch(error => { throw new Error(`Focused caption geometry: ${JSON.stringify({ beforeFooter, afterFooter: visibilityGeometry })}`, { cause: error }); });
  await expect(page.locator('.caption-panel .panel-head-copy')).toContainText('Follow paused');
  // The mobile recovery footer is in the layout, with its action reachable by
  // keyboard and pointer without crossing the sticky video or browser edge.
  await expect.poll(() => downloadAction.evaluate((node: HTMLButtonElement) => {
    const rect = node.getBoundingClientRect();
    const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const footer = node.closest('.toast-stack');
    return Boolean(footer && getComputedStyle(footer).position === 'static'
      && rect.width > 0 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth
      && rect.top >= 0 && rect.bottom <= innerHeight && (center === node || node.contains(center)));
  })).toBe(true);

  expect(state.projects[0].captions).toEqual(saved);
  await page.screenshot({ path: testInfo.outputPath('mobile-5000-recovery-download.png') });
  const downloadEvent = page.waitForEvent('download');
  await downloadAction.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('sthang-unfinished-draft.json');
  const payload = JSON.parse(await fs.readFile(await download.path(), 'utf8')) as {
    version: number;
    projectId: string;
    media: { filename: string; size: number };
    capturedAt: string;
    captions: Array<{ id: string; text: string; startMs: number; endMs: number; textLocked: boolean; timingLocked: boolean }>;
    accuracy: { description: string; vocabulary: string };
  };
  expect(payload.version).toBe(1);
  expect(payload.projectId).toBe('landscape');
  expect(payload.media).toEqual({ filename: state.projects[0].media.filename, size: state.projects[0].media.size });
  expect(Number.isFinite(Date.parse(payload.capturedAt))).toBe(true);
  expect(payload.captions).toEqual(saved.map((caption, index) => ({
    id: caption.id, text: index === COUNT - 1 ? updated : caption.text,
    startMs: caption.startMs, endMs: caption.endMs,
    textLocked: false, timingLocked: false,
  })));
  expect(payload.accuracy).toEqual({ description: '', vocabulary: '' });
  // Pointer activation blurs the native field and its ordinary save can finish.
  // The download must still contain the exact draft that was visible beforehand.
  await expect.poll(() => state.projects[0].captions[COUNT - 1].text).toBe(updated);
  expect(state.projects[0].captions).toEqual(saved.map((caption, index) => index === COUNT - 1
    ? { ...caption, text: updated, approved: false } : caption));
});

test('5,000 captions keep their player and fields through Appearance, saving and complete Unicode SRT download', async ({ page }, testInfo) => {
  const revision = 'c'.repeat(64);
  const handoffs: Array<{ action: string; body: any }> = [];
  await page.route('**/api/caption-handoff/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (action === 'export-history') return route.fulfill({ json: [] });
    const project = state.projects[0];
    const media = { filename: project.media.filename, size: project.media.size };
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    handoffs.push({ action, body });
    if (action === 'summary') return route.fulfill({ json: {
      revision, captionCount: project.captions.length, media,
      snapshot: createCaptionData({ captions: project.captions, appearance: project.captionAppearance }),
    } });
    if (action !== 'export' || body?.format !== 'srt') return route.fulfill({ status: 400, json: { error: 'Unexpected fixture export.' } });
    if (body.expectedRevision !== revision || body.expectedMedia?.filename !== media.filename || body.expectedMedia?.size !== media.size) {
      return route.fulfill({ status: 409, json: { error: 'Stale fixture export.' } });
    }
    // Exercise the real serializer over the saved fixture, including the final
    // edited row. This verifies browser handoff and complete text output, not
    // encoding or decoding a multi-hour media file.
    const result = serializeCaptionFile({ captions: project.captions, appearance: project.captionAppearance }, 'srt');
    return route.fulfill({ contentType: result.mimeType,
      headers: { 'Content-Disposition': 'attachment; filename="captions.srt"' }, body: Buffer.from(result.text, 'utf8') });
  });
  const saved = structuredClone(state.projects[0].captions);
  await openProject(page);
  await seek(page, 1200);
  await page.evaluate(() => {
    (window as any).__largeHandoffNodes = ['.media-stage video', '[data-caption-id="scale-0"] textarea',
      '[data-caption-id="scale-2500"] textarea', '[data-caption-id="scale-4999"] textarea']
      .map(selector => ({ selector, node: document.querySelector(selector) }));
  });
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const size = page.getByLabel('Exact size', { exact: true });
  await size.fill('80');
  await size.press('Enter');
  await expect.poll(() => state.projects[0].captionAppearance?.fontSize1080).toBe(80);
  expect(state.projects[0].captions).toEqual(saved);

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: /Captions file/ }).click();
  const lastText = 'Final saved SRT caption កម្ពុជាថ្មី';
  await field(page, COUNT - 1).fill(lastText);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SRT', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('captions.srt');
  const text = await fs.readFile(await download.path(), 'utf8');
  const entries = text.trim().split(/\r?\n\r?\n/);
  expect(entries).toHaveLength(COUNT);
  expect(entries[0]).toContain(saved[0].text);
  expect(entries[2500]).toContain(saved[2500].text);
  expect(entries[COUNT - 1].replace(/\r/g, '')).toBe(`5000\n02:46:38,000 --> 02:46:39,800\n${lastText}`);
  expect(state.projects[0].captions[COUNT - 1]).toMatchObject({ text: lastText, approved: false });
  expect(state.projects[0].captions[2500]).toEqual(saved[2500]);
  expect(handoffs.map(call => call.action)).toEqual(['summary', 'export']);
  expect(handoffs[1].body.captions).toBeUndefined();
  await expect(page.locator('.caption-row')).toHaveCount(COUNT);
  expect(await page.evaluate(() => (window as any).__largeHandoffNodes.every(
    ({ selector, node }: { selector: string; node: Element | null }) => node !== null && node === document.querySelector(selector),
  ))).toBe(true);
  expect(await page.locator('.media-stage video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.2, 1);
  await page.screenshot({ path: testInfo.outputPath('desktop-5000-appearance-srt.png') });
});
