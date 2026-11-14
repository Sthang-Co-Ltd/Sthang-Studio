import { test as base, expect, type Page, type Route } from '@playwright/test';
import fs from 'node:fs/promises';
import { cleanFixtures, fixtureMedia, installFixture, prepareFixtures, project, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { UPLOAD_RECOVERY_PREFIX } from '../../apps/web/src/upload-recovery.js';

const test = base.extend({ context: async ({ context }, use) => { try { await use(context); } finally { await closeOwnedBrowserContext(context); } } });
test.beforeAll(prepareFixtures); test.afterAll(cleanFixtures);
const zone = (page: Page) => page.getByRole('button', { name: 'Choose a video or audio file', exact: true });
const input = (page: Page) => page.locator('.empty-stage input[type=file]');
const recovery = (page: Page) => page.locator('.upload-recovery');
const video = () => ({ name: 'restart-original.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
const token = (index: number) => `upload_${index.toString(16).padStart(32, '0')}`;
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function attempt(route: Route) {
  const bytes = route.request().postDataBuffer()!; expect(bytes.includes(fixtureMedia())).toBe(true);
  return multipartMetadata(route);
}
function multipartMetadata(route: Route) {
  const bytes = route.request().postDataBuffer(); expect(bytes).not.toBeNull();
  const body = bytes!.toString('latin1');
  const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`).exec(body)?.[1] || '';
  return { id: field('creationAttemptId'), title: field('title'), modified: field('lastModified') };
}
interface UploadFileWitness {
  id: string; title: string; modified: string;
  file: { name: string; type: string; size: number; lastModified: number };
  bytes: number[];
}
type WitnessWindow = Window & { __studioUploadFileWitnesses?: Array<Promise<UploadFileWitness>> };
async function installFileWitness(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    const witnesses: Array<Promise<UploadFileWitness>> = [];
    (window as WitnessWindow).__studioUploadFileWitnesses = witnesses;
    window.fetch = function (this: unknown, ...args: Parameters<typeof window.fetch>) {
      const [input, options] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.origin === location.origin && url.pathname.endsWith('/api/projects')
        && method.toUpperCase() === 'POST' && options?.body instanceof FormData) {
        const form = options.body;
        const media = form.get('media');
        if (media instanceof File) {
          const metadata = { id: String(form.get('creationAttemptId') ?? ''), title: String(form.get('title') ?? ''),
            modified: String(form.get('lastModified') ?? ''),
            file: { name: media.name, type: media.type, size: media.size, lastModified: media.lastModified } };
          // Chromium's multipart inspection omits filesystem-backed file bytes.
          // Witness the actual submitted File while dispatching the original
          // fetch immediately with its exact arguments and original FormData.
          const witness = media.arrayBuffer().then((buffer) => ({ ...metadata, bytes: Array.from(new Uint8Array(buffer)) }));
          witnesses.push(witness);
          void witness.catch(() => {}); // The route awaits and asserts this same promise.
        }
      }
      return Reflect.apply(originalFetch, this, args);
    };
  });
}
async function nextFileWitness(page: Page) {
  return page.evaluate(async () => {
    const witness = (window as WitnessWindow).__studioUploadFileWitnesses?.shift();
    if (!witness) throw new Error('The outgoing upload had no original File witness.');
    return await witness;
  });
}
function savedProject(id: string) { return { ...project(id), title: 'Recovered original upload', captions: [], transcript: null }; }
async function records(page: Page) {
  return page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => JSON.parse(localStorage.getItem(key)!)), UPLOAD_RECOVERY_PREFIX);
}
async function opened(page: Page) { await expect(page.locator('.media-stage video')).toBeVisible(); await expect(page.locator('.empty-stage')).toHaveCount(0); }
async function chooseOriginal(page: Page, file: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose original file', exact: true }).click();
  await (await chooser).setFiles(file);
}
async function showEarlier(page: Page, id: string) {
  const details = page.locator('.upload-earlier-recoveries');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await page.getByLabel('Earlier upload reminder', { exact: true }).selectOption(id);
}

for (const width of [1440, 390]) test(`lost upload acknowledgement survives ${width === 390 ? 'a new page' : 'reload and another project'} without automatic transfer at ${width}px`, async ({ page, context }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  let state = await installFixture(page); state.projects = [project('second')];
  let uploads = 0; let uploadedId = '';
  const handleUpload = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads++; uploadedId = attempt(route).id; state.projects.unshift(savedProject(uploadedId)); await route.abort('failed');
  };
  await page.route('**/api/projects', handleUpload);
  await page.goto('/'); await expect(zone(page)).toBeEnabled(); await input(page).setInputFiles(video());
  await expect(recovery(page)).toContainText('Saved upload found');
  expect(uploads).toBe(1); expect((await records(page)).map((record) => record.id)).toEqual([uploadedId]);
  if (width === 390) {
    const next = await context.newPage(); await next.setViewportSize({ width, height: 1000 });
    await next.emulateMedia({ reducedMotion: 'reduce' });
    const saved = state.projects; state = await installFixture(next); state.projects = saved;
    await next.route('**/api/projects', handleUpload); await next.goto('/'); await page.close(); page = next;
  } else { state.requests.length = 0; await page.reload(); }
  await expect(recovery(page)).toContainText('An earlier upload needs checking.');
  await expect(page.getByRole('button', { name: 'Choose original file', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry this upload', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open saved project', exact: true })).toHaveCount(0);
  expect(uploads).toBe(1);
  expect(state.requests.filter((request) => request.path === `/api/projects/${uploadedId}`)).toEqual([]);
  if (width === 1440) {
    await page.getByRole('region', { name: 'Recent projects', exact: true }).getByRole('button', { name: /Audit second/ }).click();
    await opened(page); expect((await records(page)).map((record) => record.id)).toEqual([uploadedId]);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(recovery(page)).toContainText('An earlier upload needs checking.');
  }
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  const check = page.getByRole('button', { name: 'Check saved upload', exact: true });
  await check.focus(); await check.press('Enter');
  await expect(recovery(page)).toContainText('Saved upload found'); await expect(check).toBeFocused();
  await recovery(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await recovery(page).getByRole('button').all()) {
    const box = (await button.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width === 390) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath(`upload-restored-${width}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Open saved project', exact: true }).click(); await opened(page);
  await expect.poll(async () => (await records(page)).length).toBe(0);
  expect(uploads).toBe(1); expect(state.projects.filter((item) => item.id === uploadedId)).toHaveLength(1);
});

test('restored retry requires matching original file details and a separate explicit Retry at390px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await installFixture(page); state.projects = [];
  await installFileWitness(page);
  const file = info.outputPath('restart-original.mp4'); await fs.writeFile(file, fixtureMedia());
  const modified = new Date('2026-01-01T00:00:00.000Z'); await fs.utimes(file, modified, modified);
  const attempts: ReturnType<typeof attempt>[] = []; const gate = deferred(); let finished = false;
  const submittedFiles: UploadFileWitness['file'][] = [];
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const received = multipartMetadata(route);
    const witnessed = await nextFileWitness(page);
    expect(Buffer.from(witnessed.bytes)).toEqual(fixtureMedia());
    expect(witnessed.file).toEqual({ name: 'restart-original.mp4', type: 'video/mp4', size: fixtureMedia().length, lastModified: modified.getTime() });
    expect({ id: witnessed.id, title: witnessed.title, modified: witnessed.modified }).toEqual(received);
    expect(received.id).toMatch(/^upload_[a-f0-9]{32}$/);
    expect(received.title).toBe('restart-original');
    expect(received.modified).toBe(String(witnessed.file.lastModified));
    submittedFiles.push(witnessed.file); attempts.push(received);
    if (attempts.length === 1) return route.abort('failed');
    try { await gate.promise; const saved = savedProject(received.id); state.projects = [saved]; await route.fulfill({ status: 201, json: saved }); }
    finally { finished = true; }
  });
  try {
    await page.goto('/'); await expect(zone(page)).toBeEnabled(); await input(page).setInputFiles(file);
    await expect(recovery(page)).toContainText('Upload result unconfirmed'); await page.reload();
    await expect(recovery(page)).toContainText('An earlier upload needs checking.');
    await page.getByRole('button', { name: 'Check saved upload', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved upload', exact: true })).toBeEnabled();
    await chooseOriginal(page, { ...video(), name: 'different.mp4' });
    await expect(page.locator('.upload-validation')).toContainText('does not match this upload reminder');
    expect(attempts).toHaveLength(1); await expect(page.getByRole('button', { name: 'Retry this upload', exact: true })).toHaveCount(0);
    await chooseOriginal(page, file);
    await expect(page.locator('.upload-reselection-feedback')).toContainText('File details match.');
    await expect(zone(page)).toBeFocused(); expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry this upload', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2); expect(attempts[1]).toEqual(attempts[0]);
    expect(submittedFiles[1]).toEqual(submittedFiles[0]);
    await zone(page).press('Enter'); await zone(page).press('Space'); expect(attempts).toHaveLength(2);
    gate.release(); await opened(page); await expect.poll(async () => (await records(page)).length).toBe(0);
  } finally { gate.release(); if (attempts.length > 1) await expect.poll(() => finished).toBe(true); }
});

test('unavailable browser storage explains the restart limit while the live File and pending-close protection work', async ({ page }) => {
  const state = await installFixture(page); state.projects = [];
  await page.addInitScript((prefix) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key.startsWith(prefix)) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return set.call(this, key, value); };
  }, UPLOAD_RECOVERY_PREFIX);
  const gate = deferred(); const attempts: ReturnType<typeof attempt>[] = []; let firstFinished = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const received = attempt(route); attempts.push(received);
    if (attempts.length === 1) { try { await gate.promise; await route.abort('failed'); } finally { firstFinished = true; } return; }
    const saved = savedProject(received.id); state.projects = [saved]; await route.fulfill({ status: 201, json: saved });
  });
  try {
    await page.goto('/'); await expect(zone(page)).toBeEnabled(); await input(page).setInputFiles(video());
    await expect.poll(() => attempts.length).toBe(1);
    await expect(page.locator('.upload-storage-feedback')).toContainText('could not be kept for restart');
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    gate.release(); await expect(recovery(page)).toContainText('Upload result unconfirmed');
    expect(await records(page)).toEqual([]);
    await page.getByRole('button', { name: 'Retry this upload', exact: true }).click(); await opened(page);
    expect(attempts[1]).toEqual(attempts[0]); expect(await records(page)).toEqual([]);
  } finally { gate.release(); if (attempts.length) await expect.poll(() => firstFinished).toBe(true); }
});

test('another tab can remove an old reminder while a newer choice survives the held old check', async ({ page, context }) => {
  const state = await installFixture(page); state.projects = [];
  const now = Date.now();
  const metadata = (index: number) => ({ version: 1, id: token(index), name: `original-${index}.mp4`, size: fixtureMedia().length, type: 'video/mp4', lastModified: 1767225600000, capturedAt: now + index });
  const older = metadata(1); const selected = metadata(2); const newer = metadata(3);
  await page.addInitScript(({ prefix, records }) => { for (const record of records) localStorage.setItem(prefix + record.id, JSON.stringify(record)); }, { prefix: UPLOAD_RECOVERY_PREFIX, records: [older, selected] });
  const gate = deferred(); let reads = 0; let finished = false; let uploads = 0;
  await page.route(`**/api/projects/${selected.id}`, async (route) => {
    reads++; try { await gate.promise; await route.fulfill({ json: savedProject(selected.id) }); } finally { finished = true; }
  });
  await page.route('**/api/projects', async (route) => { if (route.request().method() === 'POST') uploads++; return route.fallback(); });
  try {
    await page.goto('/'); await expect(recovery(page)).toContainText(selected.name);
    await page.getByRole('button', { name: 'Check saved upload', exact: true }).click(); await expect.poll(() => reads).toBe(1);
    const other = await context.newPage(); await installFixture(other); await other.goto('/');
    await other.evaluate(({ prefix, removed, added }) => { localStorage.removeItem(prefix + removed); localStorage.setItem(prefix + added.id, JSON.stringify(added)); }, { prefix: UPLOAD_RECOVERY_PREFIX, removed: selected.id, added: newer });
    await expect(recovery(page)).toHaveCount(0); await expect(zone(page)).toBeFocused();
    await showEarlier(page, newer.id); await expect(recovery(page)).toContainText(newer.name);
    const focus = page.getByLabel('Earlier upload reminder', { exact: true }); await focus.focus();
    gate.release(); await expect.poll(() => finished).toBe(true);
    await expect(recovery(page)).toContainText(newer.name); await expect(recovery(page)).not.toContainText('Saved upload found'); await expect(focus).toBeFocused();
    await expect(page.getByRole('button', { name: 'Open saved project', exact: true })).toHaveCount(0);
    expect((await records(page)).map((record) => record.id).sort()).toEqual([older.id, newer.id].sort());
    await page.getByRole('button', { name: 'Forget this upload reminder', exact: true }).click();
    expect((await records(page)).map((record) => record.id)).toEqual([older.id]);
    expect(uploads).toBe(0); await expect(page.locator('.media-stage video')).toHaveCount(0);
  } finally { gate.release(); if (reads) await expect.poll(() => finished).toBe(true); }
});
