import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { project } from './fixtures.mjs';
import { prepareOwnedStateRoot, requireHarnessConfig, safeFrontendUrl, verifyOwnedStateRoot } from './harness-config.mjs';
import { cleanupOwnedApiClients, startOwnedApi, stopOwnedApi } from './owned-api-harness.mjs';
import { closeOwnedBrowserContext, fetchOwnedRoute, installBrowserNetworkGuard } from './owned-browser-routes.mjs';

const harness = requireHarnessConfig();
const first = 'Field notes';
const second = 'Khmer interview កម្ពុជា';

const test = base.extend<{ studio: { root: string; projects: CaptionProject[] } }>({
  studio: async ({ context }, use) => {
    const root = await prepareOwnedStateRoot(harness, 'project-bin-state-');
    const records = path.join(root, 'data', 'projects');
    const uploads = path.join(root, 'uploads');
    await Promise.all([fs.mkdir(records, { recursive: true }), fs.mkdir(uploads, { recursive: true })]);
    const media = path.join(uploads, 'bin-first.mp4');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'color=0x25354b:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media,
    ], { timeout: 20_000, windowsHide: true });
    const { size } = await fs.stat(media);
    const projects = [project('bin-first'), project('bin-second')];
    projects[0].title = first;
    projects[1].title = second;
    await fs.copyFile(media, path.join(uploads, projects[1].media.filename));
    for (const item of projects) {
      item.media.size = size;
      await fs.writeFile(path.join(records, `${item.id}.json`), JSON.stringify(item));
    }
    await fs.writeFile(path.join(records, 'order.json'), JSON.stringify(projects.map((item) => item.id)));
    await fs.writeFile(path.join(records, '.per-project-v1'), 'fixture\n');
    const server = await startOwnedApi(root);
    try {
      await installBrowserNetworkGuard(context, harness);
      await context.addInitScript(() => {
        for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
        Object.defineProperty(window, 'EventSource', { value: undefined });
      });
      await use({ root, projects });
    } finally {
      await cleanupOwnedApiClients(server, [() => closeOwnedBrowserContext(context)]);
      await stopOwnedApi(server);
      await fs.rm(verifyOwnedStateRoot(root, harness), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});

const more = (page: Page, title: string) => page.getByRole('button', { name: `More actions for ${title}`, exact: true });
const open = (page: Page, title: string) => page.getByRole('button', { name: `Open ${title}`, exact: true });
const entry = (page: Page) => page.getByRole('button', { name: 'Recently deleted', exact: true });
const row = (page: Page, title: string) => page.getByRole('list', { name: 'Deleted projects' }).getByRole('listitem').filter({ hasText: title });
const restore = (item: Locator) => item.getByRole('button', { name: 'Restore', exact: true });
const remove = (item: Locator) => item.getByRole('button', { name: 'Delete now', exact: true });
const renameField = (dialog: Locator) => dialog.getByRole('textbox', { name: 'Project name', exact: true });
const moveAction = (page: Page) => page.getByRole('menuitem', { name: 'Move to Recently deleted' });
const apiUrl = (route: string) => safeFrontendUrl(`${harness.webOrigin}${route}`, harness);

async function library(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(open(page, first)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Refresh projects' })).not.toHaveAttribute('aria-busy', 'true');
}

async function move(page: Page, title: string) {
  await more(page, title).click();
  await moveAction(page).click();
  await expect(open(page, title)).toHaveCount(0);
  await expect(page.getByText(`Moved “${title}” to Recently deleted.`)).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('keyboard More moves a project, hands off focus, and Undo restores it', async ({ page, studio }) => {
  await library(page);
  await more(page, first).press('ArrowDown');
  const rename = page.getByRole('menuitem', { name: 'Rename…', exact: true });
  await expect(rename).toBeFocused();
  await rename.press('End');
  await expect(moveAction(page)).toBeFocused();
  await moveAction(page).press('r');
  await expect(rename).toBeFocused();
  await rename.press('Escape');
  await expect(more(page, first)).toBeFocused();
  await more(page, first).press('ArrowUp');
  await expect(moveAction(page)).toBeFocused();
  await moveAction(page).press('Enter');
  await expect(open(page, first)).toHaveCount(0);
  await expect(open(page, second)).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(open(page, first)).toBeFocused();
  await expect(page.getByText(`Restored “${first}”.`)).toBeVisible();
  const saved = await page.request.get(apiUrl(`/api/projects/${studio.projects[0].id}`), { maxRedirects: 0 });
  expect(saved.status()).toBe(200);
});

test('only the latest move offers Undo, and the offer closes on its own', async ({ page, studio }) => {
  await library(page);
  await move(page, first);
  await move(page, second);
  const offers = page.locator('[data-toast-timer="project-undo"]');
  await expect(offers).toHaveCount(1);
  await expect(offers).toContainText(`Moved “${second}” to Recently deleted.`);
  await page.mouse.move(1, 1);
  await expect(offers).toHaveCount(0, { timeout: 12_000 });
});

test('Recently deleted shows dates, restores, and confirms permanent deletion', async ({ page, studio }) => {
  await library(page);
  await move(page, first);
  await move(page, second);
  await expect(entry(page).locator('.project-bin-count')).toHaveText('2');
  await entry(page).click();
  await expect(page.getByRole('heading', { name: 'Recently deleted' })).toBeFocused();
  await expect(row(page, first).locator('time')).toHaveCount(2);
  await expect(row(page, first)).toContainText('Deleted');
  await expect(row(page, first)).toContainText('Restore until');
  await expect(row(page, first)).toContainText('3 captions');
  await restore(row(page, second)).click();
  await expect(row(page, second)).toHaveCount(0);
  await expect(restore(row(page, first))).toBeFocused();
  await page.getByRole('button', { name: 'Back to All projects' }).click();
  await expect(entry(page)).toBeFocused();
  await expect(open(page, second)).toBeVisible();
  await expect(open(page, first)).toHaveCount(0);
  await entry(page).click();
  await remove(row(page, first)).click();
  const dialog = page.getByRole('alertdialog', { name: `Delete “${first}” now?` });
  await expect(dialog).toContainText('Exported files are kept.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(row(page, first)).toBeVisible();
  await remove(row(page, first)).click();
  await dialog.getByRole('button', { name: 'Delete now', exact: true }).click();
  await expect(row(page, first)).toHaveCount(0);
  await expect(page.getByText(`“${first}” was deleted.`)).toBeVisible();
  await expect(fs.stat(path.join(studio.root, 'uploads', studio.projects[0].media.filename))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Recently deleted is reachable from an empty active collection', async ({ page, studio }) => {
  await library(page);
  await move(page, first);
  await move(page, second);
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeFocused();
  await entry(page).click();
  await expect(row(page, first)).toBeVisible();
  await expect(row(page, second)).toBeVisible();
  await page.getByRole('button', { name: 'Back to All projects' }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(page.getByRole('region', { name: 'Recent projects' })).toHaveCount(0);
  for (const item of studio.projects) {
    const response = await page.request.get(apiUrl(`/api/projects/${item.id}`), { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  }
});

test('a project observed in the bin disappears from a failed active collection refresh', async ({ page, studio }) => {
  await library(page);
  const external = await page.request.post(apiUrl('/api/project-bin'), {
    data: { projectId: studio.projects[0].id }, maxRedirects: 0,
  });
  expect(external.status()).toBe(200);
  await page.route('**/api/projects?summary=1', (route) => route.fulfill({ status: 503, json: { error: 'Fixture refresh failure' } }));
  await page.getByRole('button', { name: 'Refresh projects' }).click();
  await expect(page.getByText(/Last loaded projects are shown/)).toBeVisible();
  await entry(page).click();
  await expect(row(page, first)).toBeVisible();
  await page.getByRole('button', { name: 'Back to All projects' }).click();
  await expect(open(page, first)).toHaveCount(0);
  await expect(open(page, second)).toBeVisible();
});

test('a summary read that started before a move cannot reinsert the binned row', async ({ page, studio }) => {
  await library(page);
  const fetched = deferred();
  const reply = deferred();
  const finished = deferred();
  let reads = 0;
  await page.route('**/api/projects?summary=1', async (route) => {
    const hold = ++reads === 1;
    const response = await fetchOwnedRoute(route);
    try {
      if (hold) {
        expect(await response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: studio.projects[0].id })]));
        fetched.resolve();
        await reply.promise;
      }
      await route.fulfill({ response });
    } finally {
      await response.dispose();
      if (hold) finished.resolve();
    }
  });
  try {
    await page.getByRole('button', { name: 'Refresh projects' }).click();
    await fetched.promise;
    await move(page, first);
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    reply.resolve();
    await finished.promise;
    await expect(page.getByRole('button', { name: 'Refresh projects' })).not.toHaveAttribute('aria-busy', 'true');
    await expect(open(page, first)).toHaveCount(0);
  } finally { reply.resolve(); }
});

test('library rename validates input and deliberately retries a real title conflict', async ({ page, studio }) => {
  await library(page);
  await more(page, first).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename project' });
  const input = renameField(dialog);
  await expect(input).toBeFocused();
  expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, first.length]);
  const titleWrites: unknown[] = [];
  page.on('request', (request) => { if (request.url().endsWith('/title')) titleWrites.push(request.postDataJSON()); });
  for (const invalid of ['   ', '😀'.repeat(121)]) {
    await input.fill(invalid);
    await input.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('1 to 120 characters');
  }
  expect(titleWrites).toEqual([]);
  const external = await page.request.put(apiUrl(`/api/projects/${studio.projects[0].id}/title`), {
    data: { expectedTitle: first, title: 'Changed elsewhere' }, maxRedirects: 0,
  });
  expect(external.status()).toBe(200);
  await input.fill('  Edited   field notes  ');
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('This project was renamed to “Changed elsewhere” elsewhere. Save again to use your name, or Cancel to keep theirs.');
  await expect(input).toHaveValue('  Edited   field notes  ');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(open(page, 'Edited field notes')).toBeVisible();
  await expect(more(page, 'Edited field notes')).toBeFocused();
  expect(titleWrites).toEqual([
    { title: 'Edited field notes', expectedTitle: first },
    { title: 'Edited field notes', expectedTitle: 'Changed elsewhere' },
  ]);
});

test('editor rename leaves a real caption draft unsaved and preserves Escape and Find', async ({ page, studio }) => {
  await library(page);
  await open(page, first).click();
  const caption = page.getByLabel('Caption 1 text', { exact: true });
  const details = page.getByRole('button', { name: 'Project details', exact: true });
  const panel = page.getByRole('dialog', { name: 'Project details', exact: true });
  const rename = panel.getByRole('button', { name: 'Rename', exact: true });
  await caption.fill('Draft kept across rename');
  const pendingSave = deferred();
  await page.route('**/api/projects/*/captions', async (route) => {
    await pendingSave.promise;
    await route.abort();
  });
  try {
    await details.click();
    await rename.click();
    await renameField(panel).fill('Discard me');
    await renameField(panel).press('Escape');
    await expect(rename).toBeFocused();
    await rename.click();
    await renameField(panel).fill('Editor name');
    await renameField(panel).press('Enter');
    await expect(rename).toBeFocused();
    await expect(page.locator('.project-title strong')).toHaveText('Editor name');
    await expect(caption).toHaveValue('Draft kept across rename');
    const saved = await page.request.get(apiUrl(`/api/projects/${studio.projects[0].id}`), { maxRedirects: 0 });
    expect(saved.status()).toBe(200);
    const record = await saved.json() as CaptionProject;
    expect(record.title).toBe('Editor name');
    expect(record.captions[0].text).toBe(studio.projects[0].captions[0].text);
    expect(record.updatedAt).toBe(studio.projects[0].updatedAt);
    await rename.press('Escape');
    await expect(details).toBeFocused();
    await expect(details).toHaveAttribute('data-tooltip', /^Editor name\n/);
    await details.click();
    await rename.click();
    await renameField(panel).press('Control+f');
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Correct everywhere', exact: true })).toBeVisible();
  } finally { pendingSave.resolve(); }
});

test('removal state and rejected restores refresh the bin before actions return', async ({ page, studio }) => {
  await library(page);
  await move(page, first);
  await move(page, second);
  let reads = 0;
  let unfinishedRemoval = false;
  await page.route('**/api/project-bin', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await fetchOwnedRoute(route);
    try {
      reads++;
      const { items } = await response.json();
      await route.fulfill({ response, json: { items: items.map((item: { id: string }) =>
        unfinishedRemoval || item.id === studio.projects[1].id ? { ...item, purging: true } : item) } });
    } finally { await response.dispose(); }
  });
  await entry(page).click();
  const purging = row(page, second);
  await expect(purging).toContainText("Removing… If this doesn't clear, review storage.");
  await expect(purging.getByRole('button', { name: 'Review storage' })).toBeVisible();
  await expect(restore(purging)).toHaveCount(0);
  await expect(remove(purging)).toHaveCount(0);

  const id = studio.projects[0].id;
  const binList = await page.request.get(apiUrl('/api/project-bin'), { maxRedirects: 0 });
  expect(binList.status()).toBe(200);
  const old = (await binList.json()).items.find((item: { id: string }) => item.id === id);
  expect((await page.request.post(apiUrl(`/api/project-bin/${id}/restore`), { data: { instanceId: old.instanceId }, maxRedirects: 0 })).status()).toBe(200);
  const rebin = await page.request.post(apiUrl('/api/project-bin'), { data: { projectId: id }, maxRedirects: 0 });
  expect(rebin.status()).toBe(200);
  const current = await rebin.json();
  expect(current.instanceId).not.toBe(old.instanceId);
  const readsBeforeConflict = reads;
  await restore(row(page, first)).click();
  await expect(page.getByText('This item changed. The list has been updated.')).toBeVisible();
  expect(reads).toBeGreaterThan(readsBeforeConflict);
  await expect(restore(row(page, first))).toHaveAttribute('data-bin-restore', current.instanceId);

  await page.route(`**/api/project-bin/${id}/restore`, (route) => route.fulfill({ status: 409, json: { code: 'expired' } }));
  const readsBeforeExpiry = reads;
  await restore(row(page, first)).click();
  await expect(page.getByText('This project can no longer be restored.')).toBeVisible();
  expect(reads).toBeGreaterThan(readsBeforeExpiry);
  await expect(restore(row(page, first))).toHaveCount(0);

  await page.route(`**/api/project-bin/${id}`, (route) => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({ instanceId: current.instanceId });
    unfinishedRemoval = true;
    return route.fulfill({ status: 500, json: { code: 'purge_incomplete' } });
  });
  await remove(row(page, first)).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete now' }).click();
  await expect(page.getByText('Studio could not finish removing this project. It will try again automatically.')).toBeVisible();
  await expect(row(page, first)).toContainText('Removing…');
  await expect(remove(row(page, first))).toHaveCount(0);
});

for (const width of [1440, 390]) test(`project bin and rename fit the viewport at ${width}px`, async ({ page, studio }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await library(page);
  const noOverflow = async (selector: string) => {
    expect(await page.evaluate((css) => {
      const bounds = [...document.querySelectorAll(css)].map((node) => node.getBoundingClientRect());
      return bounds.length > 0 && bounds.every((rect) => rect.left >= 0 && rect.right <= innerWidth)
        && document.documentElement.scrollWidth <= innerWidth;
    }, selector)).toBe(true);
  };
  const screenshot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${width}.png`), animations: 'disabled' });
  await more(page, first).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await noOverflow('.project-library-row, .project-library-more, .project-library-menu');
  if (width === 390) expect((await more(page, first).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await screenshot('all-projects');
  await moveAction(page).click();
  await expect(open(page, first)).toHaveCount(0);
  await entry(page).click();
  const item = row(page, first);
  await expect(restore(item)).toBeEnabled();
  await noOverflow('.project-bin-row, .project-bin-actions button');
  if (width === 390) {
    expect((await restore(item).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await remove(item).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await screenshot('recently-deleted');
  await remove(item).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await noOverflow('.studio-confirm-dialog');
  await screenshot('delete-now');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await page.getByRole('button', { name: 'Back to All projects' }).click();
  await open(page, second).click();
  await page.getByRole('button', { name: 'Project details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Project details', exact: true });
  await details.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(renameField(details)).toBeFocused();
  await noOverflow('.project-name-dialog, .project-rename-form');
  await screenshot('editor-rename');
  await expect(details.getByText(studio.projects[1].media.originalName)).toBeVisible();
});
