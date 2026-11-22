import { test as base, expect, type Dialog, type Locator, type Page, type Route } from '@playwright/test';
import { hydrateCaptionWordTimings, type CaptionProject, type CaptionSegment, type TranscriptionContext } from '@kcs/shared';
import { createUnfinishedEditRecoveryStore, type RecoveryEntry } from '../../apps/web/src/unfinished-edit-recovery.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, seek, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

const prefix = 'sthang-studio:unfinished-edits:';
const notice = (page: Page) => page.getByRole('region', { name: 'Unfinished edit recovery', exact: true });
const caption = (page: Page) => page.getByLabel('Caption 1 text', { exact: true });
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
interface CaptionWrite {
  captions: CaptionSegment[];
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt?: string;
  recoveryExpectedUpdatedAt?: string;
  recordCorrections?: boolean;
}
interface ContextWrite {
  transcriptionContext: TranscriptionContext;
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt?: string;
}
interface Fixture {
  state: FixtureState;
  original: CaptionProject;
  captions: CaptionWrite[];
  contexts: ContextWrite[];
  revision: number;
  next?: { gate: ReturnType<typeof deferred>; started: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred>; reply: 'ok' | '503' | 'abort' };
}
async function routes(page: Page, f: Fixture) {
  const revision = () => new Date(Date.UTC(2026, 10, 14, 12, 0, ++f.revision)).toISOString();
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as CaptionWrite;
    f.captions.push(structuredClone(body));
    f.state.requests.push({ path: '/api/projects/landscape/captions', method: 'PUT', body });
    const current = f.state.projects[0];
    if (body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size) {
      return route.fulfill({ status: 409, json: { error: 'The synthetic source changed.', code: 'MEDIA_CHANGED' } });
    }
    if (body.expectedUpdatedAt !== current.updatedAt || body.recoveryExpectedUpdatedAt !== undefined && body.recoveryExpectedUpdatedAt !== current.updatedAt) {
      return route.fulfill({ status: 409, json: { error: 'The synthetic captions changed.', code: 'CAPTION_REVISION_CHANGED' } });
    }
    // Commit before ACK: a lost response must not be confused with a rejected write.
    const saved = { ...structuredClone(current), captions: structuredClone(body.captions), updatedAt: revision() };
    f.state.projects[0] = saved;
    const held = f.next; f.next = undefined;
    held?.started.release();
    if (held) await held.gate.promise;
    try {
      if (held?.reply === '503') return await route.fulfill({ status: 503, json: { error: 'Synthetic response lost after commit' } });
      if (held?.reply === 'abort') return await route.abort('failed');
      return await route.fulfill({ json: { project: saved, correctionsCreated: 0 } });
    } catch (error) {
      if (!page.isClosed() && route.request().failure()?.errorText !== 'net::ERR_ABORTED') throw error;
    } finally { held?.finished.release(); }
  });
  await page.route('**/api/projects/landscape/context', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as ContextWrite;
    f.contexts.push(structuredClone(body));
    f.state.requests.push({ path: '/api/projects/landscape/context', method: 'PUT', body });
    const current = f.state.projects[0];
    if (body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size || body.expectedUpdatedAt !== current.updatedAt) {
      return route.fulfill({ status: 409, json: { error: 'The synthetic Accuracy context changed.', code: 'CONTEXT_REVISION_CHANGED' } });
    }
    f.state.projects[0] = { ...structuredClone(current), transcriptionContext: structuredClone(body.transcriptionContext), updatedAt: revision() };
    return route.fulfill({ json: f.state.projects[0] });
  });
}
async function fixture(page: Page): Promise<Fixture> {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  state.profile.preferences.autoPlayNextReview = false;
  state.profile.preferences.autoLoopReview = false;
  state.projects[0] = hydrateCaptionWordTimings(state.projects[0]);
  state.projects[0].captions[0].approved = true;
  state.projects[0].captions[2].approved = true;
  state.projects[0].transcriptionContext = { description: 'Saved synthetic topic', vocabulary: ['SavedBrand'] };
  const f: Fixture = { state, original: structuredClone(state.projects[0]), captions: [], contexts: [], revision: 0 };
  await routes(page, f);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return f;
}
function holdNext(f: Fixture, reply: 'ok' | '503' | 'abort' = 'ok') {
  const held = { gate: deferred(), started: deferred(), finished: deferred(), reply };
  f.next = held; return held;
}
async function copies(page: Page): Promise<RecoveryEntry[]> {
  return page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => {
    const raw = localStorage.getItem(key)!; return { key, raw, draft: JSON.parse(raw) };
  }), prefix);
}
async function capturedCaption(page: Page, text: string) {
  await expect(caption(page)).toBeFocused();
  // Inspect editable payload, not a substring also present in its saved basis.
  await expect.poll(async () => (await copies(page)).some((entry) => entry.draft.captions?.[0].text === text)).toBe(true);
}
async function unloadGuard(page: Page) {
  return page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
}
async function settled(page: Page) {
  await expect(page.locator('.save-action-label')).toHaveText('Saved');
  await expect(page.locator('.save-action')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => unloadGuard(page)).toBe(false);
}
async function reloadAndReopen(page: Page) {
  const accept = async (dialog: Dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.getByRole('button', { name: /Audit landscape/ }).click();
  await expect(caption(page)).toBeVisible();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
}
async function restore(page: Page) {
  const button = notice(page).getByRole('button', { name: 'Restore draft', exact: true });
  await button.focus(); await button.press('Enter');
}
async function download(page: Page) {
  const started = page.waitForEvent('download');
  await notice(page).getByRole('button', { name: 'Download draft', exact: true }).click();
  const stream = await (await started).createReadStream();
  if (!stream) throw new Error('The owned recovery download was unavailable.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function seed(source: CaptionProject, owner: string, text: string, savedAt = Date.now() - 1000, field: 'captions' | 'accuracy' = 'captions') {
  const items = new Map<string, string>();
  const storage = { get length() { return items.size; }, key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, raw: string) => { items.set(key, raw); }, removeItem: (key: string) => { items.delete(key); } };
  const store = createUnfinishedEditRecoveryStore(() => storage, owner, () => savedAt);
  const result = store.write({ project: source, ...(field === 'captions'
    ? { captions: source.captions.map((cue, index) => index ? cue : { ...cue, text }) }
    : { accuracy: { description: text, vocabulary: 'ExactBrand | ខ្មែរ\n' } }) });
  expect(result.status).toBe('saved'); expect(result.entry).toBeDefined();
  return result.entry!;
}
async function insert(page: Page, entries: RecoveryEntry[]) {
  await page.evaluate((entries) => {
    for (const entry of entries) {
      localStorage.setItem(entry.key, entry.raw);
      window.dispatchEvent(new StorageEvent('storage', { key: entry.key, oldValue: null, newValue: entry.raw, storageArea: localStorage, url: location.href }));
    }
  }, entries);
}
async function exact(page: Page, entry: RecoveryEntry) {
  expect(await page.evaluate(({ key }) => localStorage.getItem(key), entry)).toBe(entry.raw);
}
async function rememberEditor(page: Page) {
  await seek(page, 1200);
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video')!; video.playbackRate = 0.75;
    (window as any).__captionRecoveryNodes = [video, document.querySelector('.caption-list')];
  });
}
async function sameEditor(page: Page) {
  expect(await page.evaluate(() => (window as any).__captionRecoveryNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  const media = await page.locator('video').evaluate((video: HTMLVideoElement) => ({ time: video.currentTime, rate: video.playbackRate, paused: video.paused }));
  expect(media.time).toBeCloseTo(1.2, 1); expect(media.rate).toBe(0.75); expect(media.paused).toBe(true);
}
async function reachable(control: Locator, width: number) {
  await expect.poll(() => control.evaluate((node, mobile) => {
    const rect = node.getBoundingClientRect();
    const points = [[rect.left + 4, rect.top + 4], [rect.right - 4, rect.top + 4],
      [rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 4, rect.bottom - 4], [rect.right - 4, rect.bottom - 4]];
    return rect.width > 0 && rect.height >= (mobile ? 44 : 1) && rect.left >= 0 && rect.right <= innerWidth + 1
      && rect.top >= 0 && rect.bottom <= innerHeight + 1 && points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y); return hit === node || Boolean(hit && node.contains(hit));
      });
  }, width === 390)).toBe(true);
}
function noUnrequestedWork(f: Fixture) {
  expect(f.state.profile.correctionEvents).toEqual([]);
  expect(f.state.requests.filter((request) => request.method === 'POST' && /(?:\/jobs|\/transcribe|\/regenerate|\/caption-word-timing|\/contribution)/.test(request.path))).toEqual([]);
}
async function heldRead(page: Page, snapshot: CaptionProject) {
  const gate = deferred(), started = deferred(), finished = deferred();
  let request: import('@playwright/test').Request | undefined;
  let once = false;
  const handler = async (route: Route) => {
    if (once || route.request().method() !== 'GET') return route.fallback();
    once = true; request = route.request(); started.release(); await gate.promise;
    try { await route.fulfill({ json: snapshot }); }
    catch (error) { if (!page.isClosed() && request.failure()?.errorText !== 'net::ERR_ABORTED') throw error; }
    finally { finished.release(); }
  };
  await page.route('**/api/projects/landscape', handler);
  return { started: started.promise, release: gate.release, finished: finished.promise, request: () => request };
}
async function accuracy(page: Page) {
  if (await page.getByRole('button', { name: 'Accuracy', exact: true }).getAttribute('aria-pressed') !== 'true') await page.getByRole('button', { name: 'Accuracy', exact: true }).click();
  return { description: page.getByLabel('What is this video about?', { exact: true }), vocabulary: page.getByLabel('Key terms', { exact: true }) };
}

for (const width of [1440, 390]) test('a pending caption save protects a return to its old wording through ACK, restart and explicit recovery at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page); await openProject(page);
  const baseline = f.original.captions[0].text;
  const submitted = 'Intermediate wording submitted before returning to the saved Khmer text';
  const held = holdNext(f);
  try {
    await caption(page).fill(submitted); await page.keyboard.press('Control+s'); await held.started.promise;
    await caption(page).fill(baseline); await capturedCaption(page, baseline);
    expect(f.captions).toHaveLength(1); expect(await unloadGuard(page)).toBe(true);
    held.gate.release(); await held.finished.promise;
    await expect(page.locator('.save-action')).not.toHaveAttribute('aria-busy', 'true');
    await expect(caption(page)).toHaveValue(baseline);
    expect(f.state.projects[0].captions[0].text).toBe(submitted);
    await reloadAndReopen(page);
    await expect(caption(page)).toHaveValue(submitted);
    const offered = (await copies(page)).filter((entry) => entry.draft.captions?.[0].text === baseline);
    expect(offered).toHaveLength(1);
    await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
    expect(f.captions).toHaveLength(1);
    const foreign = seed(f.state.projects[0], 'another-tab', 'Keep this separate unfinished correction', offered[0].draft.savedAt - 1000);
    await insert(page, [foreign]);
    await rememberEditor(page);
    await restore(page); await expect(caption(page)).toHaveValue(baseline);
    await sameEditor(page);
    await caption(page).focus();
    await expect(caption(page)).toBeFocused();
    await reachable(caption(page), width);
    await page.screenshot({ path: info.outputPath('caption-baseline-restored-' + width + '.png'), animations: 'disabled' });
    expect(f.captions).toHaveLength(1);
    await page.keyboard.press('Control+s');
    await expect.poll(() => f.captions.length).toBe(2); await settled(page);
    expect(f.captions[1].recordCorrections).toBe(false);
    expect(f.captions[1].recoveryExpectedUpdatedAt).toBeDefined();
    expect(f.captions.map((write) => write.captions[0].text)).toEqual([submitted, baseline]);
    expect(f.state.projects[0].captions.slice(1)).toEqual(f.original.captions.slice(1));
    await expect.poll(async () => (await copies(page)).map((entry) => entry.key)).toEqual([foreign.key]);
    await exact(page, foreign); await sameEditor(page); noUnrequestedWork(f);
  } finally { held.gate.release(); }
});

for (const [width, reply] of [[1440, '503'], [390, 'abort']] as const) test('a committed caption write with a lost ACK retains the final baseline for comparison after ' + (width === 1440 ? 'a new page' : 'reload') + ' at ' + width + 'px', async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page); await openProject(page);
  const baseline = f.original.captions[0].text;
  const held = holdNext(f, reply);
  try {
    await caption(page).fill('Committed intermediate text with an unconfirmed response');
    await page.keyboard.press('Control+s'); await held.started.promise;
    await caption(page).fill(baseline); await capturedCaption(page, baseline);
    held.gate.release(); await held.finished.promise;
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't save changes" })).toBeVisible();
    await capturedCaption(page, baseline);
    expect(await unloadGuard(page)).toBe(true);
    if (width === 1440) {
      const reopened = await context.newPage();
      const state = await installFixture(reopened);
      state.projects = f.state.projects; state.profile = f.state.profile; f.state = state;
      await routes(reopened, f); await reopened.emulateMedia({ reducedMotion: 'reduce' });
      await reopened.setViewportSize({ width, height: 900 }); await openProject(reopened);
      page = reopened;
    } else await reloadAndReopen(page);
    await expect(caption(page)).toHaveValue('Committed intermediate text with an unconfirmed response');
    await expect(notice(page)).toContainText('saved project has changed');
    await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
    const retained = (await copies(page)).find((entry) => entry.draft.captions?.[0].text === baseline)!;
    expect(retained).toBeDefined();
    const downloaded = await download(page);
    expect(downloaded.captions[0].text).toBe(baseline);
    expect(downloaded.basis).toEqual(retained.draft.basis);
    await exact(page, retained);
    expect(f.captions).toHaveLength(1); expect(f.contexts).toEqual([]);
    noUnrequestedWork(f);
  } finally { held.gate.release(); }
});

for (const width of [1440, 390]) test('older matching recovery remains reachable without discarding a newer different-media draft at ' + width + 'px', async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page); await page.goto('/');
  const older = seed(f.original, 'older-tab', 'Older recoverable Khmer correction ខ្មែរ', Date.now() - 2000);
  const replaced = { ...f.original, media: { ...f.original.media, filename: 'previous-source.mp4', url: '/media/previous-source.mp4' } };
  const newer = seed(replaced, 'newer-tab', 'Newer source draft must stay private in the selector', Date.now() - 1000);
  await insert(page, [older, newer]); await openProject(page); await rememberEditor(page);
  await expect(notice(page)).toContainText('different media');
  await notice(page).getByText('Preview draft', { exact: true }).click();
  const select = notice(page).getByRole('combobox', { name: 'Recovery draft', exact: true });
  await select.focus(); await reachable(select, width);
  expect(await select.locator('option').allTextContents()).toHaveLength(2);
  expect((await select.locator('option').allTextContents()).join(' ')).not.toContain('Newer source draft');
  await select.press('End'); await expect(select).toHaveValue(older.key); await expect(select).toBeFocused();
  await expect(notice(page)).toContainText('local draft is available');
  await expect(notice(page)).toContainText('Older recoverable Khmer correction');
  await exact(page, older); await exact(page, newer);
  // A bounded recovery footer scrolls its native keyboard target into view;
  // exercise that real path rather than requiring every action at once.
  for (const name of ['Restore draft', 'Download draft', 'Discard draft']) {
    await page.keyboard.press('Tab');
    const action = notice(page).getByRole('button', { name, exact: true });
    await expect(action).toBeFocused();
    await reachable(action, width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('recovery-copy-choice-' + width + '.png'), animations: 'disabled' });
  await restore(page); await expect(caption(page)).toHaveValue(older.draft.captions![0].text);
  expect(f.captions).toEqual([]); expect(f.contexts).toEqual([]);
  await exact(page, newer); await sameEditor(page);
  await page.keyboard.press('Control+s'); await settled(page);
  expect(f.captions).toHaveLength(1); await exact(page, newer);
  expect((await copies(page)).some((entry) => entry.key === older.key)).toBe(false);
  noUnrequestedWork(f);
});

for (const width of [1440, 390]) test('choosing another recovery copy cancels the held first Restore and retains keyboard ownership at ' + width + 'px', async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page); await page.goto('/');
  const older = seed(f.original, 'older-tab', 'Deliberately chosen older recovery', Date.now() - 2000);
  const newer = seed(f.original, 'newer-tab', 'First recovery must not land late', Date.now() - 1000);
  await insert(page, [older, newer]); await openProject(page); await rememberEditor(page);
  await notice(page).getByText('Preview draft', { exact: true }).click();
  const held = await heldRead(page, structuredClone(f.state.projects[0]));
  try {
    await restore(page); await held.started;
    const select = notice(page).getByRole('combobox', { name: 'Recovery draft', exact: true });
    await expect(select).toBeEnabled(); await select.focus(); await select.press('End');
    await expect(select).toHaveValue(older.key); await expect(select).toBeFocused();
    await expect.poll(() => held.request()?.failure()?.errorText).toBe('net::ERR_ABORTED');
    await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
    await expect(notice(page).getByRole('button', { name: 'Cancel check', exact: true })).toHaveCount(0);
    held.release(); await held.finished;
    await expect(select).toBeFocused(); await expect(caption(page)).toHaveValue(f.original.captions[0].text);
    await exact(page, older); await exact(page, newer); await sameEditor(page);
    expect(f.captions).toEqual([]); expect(f.contexts).toEqual([]);
    await expect(page.getByRole('alert').filter({ hasText: 'Could not check the saved project' })).toHaveCount(0);
    await restore(page); await expect(caption(page)).toHaveValue(older.draft.captions![0].text);
    await exact(page, newer); noUnrequestedWork(f);
  } finally { held.release(); }
});

test('Accuracy-only recovery omits caption evidence and preserves unrelated newer saved captions through Restore and Save', async ({ page }) => {
  const f = await fixture(page); await page.goto('/');
  const entry = seed(f.original, 'accuracy-tab', '  Recovered Accuracy topic ខ្មែរ\n', Date.now() - 1000, 'accuracy');
  expect(entry.draft.version).toBe(3); expect(Object.keys(entry.draft.basis)).toEqual(['context']);
  expect(entry.raw).not.toContain(f.original.captions[0].text);
  f.state.projects[0] = { ...f.state.projects[0], captions: f.state.projects[0].captions.map((cue, index) => index ? cue : { ...cue, approved: false, timingLocked: true }), updatedAt: '2026-11-14T13:00:00.000Z' };
  const savedCaptions = structuredClone(f.state.projects[0].captions);
  await insert(page, [entry]); await openProject(page); await rememberEditor(page);
  await expect(notice(page).getByRole('button', { name: 'Restore draft', exact: true })).toBeEnabled();
  await restore(page);
  const fields = await accuracy(page);
  await expect(fields.description).toHaveValue(entry.draft.accuracy!.description);
  await expect(fields.vocabulary).toHaveValue(entry.draft.accuracy!.vocabulary);
  expect(f.contexts).toEqual([]); expect(f.captions).toEqual([]);
  await fields.description.focus(); await page.keyboard.press('Control+s'); await settled(page);
  expect(f.contexts).toHaveLength(1); expect(f.captions).toEqual([]);
  expect(f.state.projects[0].captions).toEqual(savedCaptions);
  expect(f.state.projects[0].transcriptionContext).toEqual({ description: entry.draft.accuracy!.description.trim(), vocabulary: ['ExactBrand | ខ្មែរ'] });
  await sameEditor(page); noUnrequestedWork(f);
});

test('caption-only recovery preserves newer saved Accuracy rather than copying or overwriting it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const f = await fixture(page); await page.goto('/');
  const entry = seed(f.original, 'caption-tab', 'Recovered caption after an unrelated Accuracy save');
  expect(entry.draft.version).toBe(3); expect(Object.keys(entry.draft.basis)).toEqual(['captions']);
  expect(entry.raw).not.toContain('Saved synthetic topic'); expect(entry.draft.accuracy).toBeUndefined();
  const context = { description: 'Newer canonical topic', vocabulary: ['NewBrand', 'ពាក្យថ្មី'] };
  f.state.projects[0] = { ...f.state.projects[0], transcriptionContext: context, updatedAt: '2026-11-14T13:00:00.000Z' };
  await insert(page, [entry]); await openProject(page); await rememberEditor(page);
  await restore(page); await expect(caption(page)).toHaveValue(entry.draft.captions![0].text);
  await page.keyboard.press('Control+s'); await settled(page);
  expect(f.captions).toHaveLength(1); expect(f.contexts).toEqual([]);
  expect(f.state.projects[0].transcriptionContext).toEqual(context);
  const fields = await accuracy(page);
  await expect(fields.description).toHaveValue(context.description); await expect(fields.vocabulary).toHaveValue(context.vocabulary.join('\n'));
  await sameEditor(page); noUnrequestedWork(f);
});

test('a field-specific Restore still yields to newer raw Accuracy typing during its canonical check', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const f = await fixture(page); await page.goto('/');
  const entry = seed(f.original, 'accuracy-tab', 'Earlier Accuracy recovery', Date.now() - 1000, 'accuracy');
  await insert(page, [entry]); await openProject(page); await accuracy(page); await rememberEditor(page);
  const held = await heldRead(page, structuredClone(f.state.projects[0]));
  try {
    await restore(page); await held.started;
    const field = page.getByLabel('What is this video about?', { exact: true });
    const newer = '  Newer raw Khmer context ខ្មែរ\n\n';
    await field.fill(newer); await expect(field).toBeFocused();
    held.release(); await held.finished;
    await expect(page.getByText('Newer edits are still here. Save them before restoring this draft.', { exact: true })).toBeVisible();
    await expect(field).toHaveValue(newer); await expect(field).toBeFocused();
    await exact(page, entry);
    await expect.poll(async () => (await copies(page)).some((copy) => copy.draft.accuracy?.description === newer)).toBe(true);
    expect(f.contexts).toEqual([]); expect(f.captions).toEqual([]);
    expect(f.state.projects[0].transcriptionContext).toEqual(f.original.transcriptionContext);
    await sameEditor(page); noUnrequestedWork(f);
  } finally { held.release(); }
});
