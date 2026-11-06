import { test, expect, type Page } from '@playwright/test';
import { cleanFixtures, fixtureMedia, installFixture, prepareFixtures } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let uploads = 0;
let hold: Promise<void> | undefined;
test.beforeEach(async ({ page }) => {
  const state = await installFixture(page);
  state.projects = [];
  uploads = 0;
  hold = undefined;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads++;
    await hold;
    await route.fulfill({ status: 503, json: { error: 'Synthetic upload failed. Choose the file again.' } });
  });
  await page.goto('/');
  await expect(dropzone(page)).toBeEnabled();
});

const dropzone = (page: Page) => page.getByRole('button', { name: 'Choose a video or audio file', exact: true });
const input = (page: Page) => page.locator('.empty-stage input[type=file]');
const validation = (page: Page) => page.locator('.upload-validation');
const video = () => ({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
const transfer = (page: Page, files: Array<{ name: string; type: string }>) => page.evaluateHandle((items) => {
  const data = new DataTransfer();
  for (const item of items) data.items.add(new File(['Synthetic candidate; decoding is not under test.'], item.name, { type: item.type }));
  return data;
}, files);

test('nested file dragging stays highlighted until the real exit and document cleanup', async ({ page }) => {
  const data = await transfer(page, [{ name: 'synthetic.mp4', type: 'video/mp4' }]);
  try {
    const zone = dropzone(page);
    const label = zone.locator('strong');
    await zone.dispatchEvent('dragenter', { dataTransfer: data });
    await expect(zone).toHaveClass(/\bdrag\b/);
    await expect(label).toHaveText('Drop to import');
    // Some browsers omit relatedTarget when entering a child from the body.
    await page.evaluate(() => document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, clientX: 200, clientY: 200 })));
    await expect(zone).toHaveClass(/\bdrag\b/);
    await label.dispatchEvent('dragenter', { dataTransfer: data });
    await label.dispatchEvent('dragleave', { dataTransfer: data });
    await expect(zone).toHaveClass(/\bdrag\b/);
    await label.dispatchEvent('dragenter', { dataTransfer: data });
    const helper = await zone.locator('span').elementHandle();
    await label.dispatchEvent('dragleave', { dataTransfer: data, relatedTarget: helper });
    await expect(zone).toHaveClass(/\bdrag\b/);
    const outside = await page.locator('body').elementHandle();
    await zone.dispatchEvent('dragleave', { dataTransfer: data, relatedTarget: outside });
    await expect(zone).not.toHaveClass(/\bdrag\b/);
    await zone.dispatchEvent('dragenter', { dataTransfer: data });
    await page.evaluate((dataTransfer) => document.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true })), data);
    await expect(zone).not.toHaveClass(/\bdrag\b/);
    await zone.dispatchEvent('dragenter', { dataTransfer: data });
    await page.evaluate(() => document.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await expect(zone).not.toHaveClass(/\bdrag\b/);
    await zone.dispatchEvent('dragenter', { dataTransfer: data });
    await page.evaluate(() => document.documentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, clientX: 0, clientY: 0 })));
    await expect(zone).not.toHaveClass(/\bdrag\b/);
    expect(uploads).toBe(0);
  } finally { await data.dispose(); }
});

test('multiple files and recognizable non-media report one local validation message without uploading', async ({ page }) => {
  const multiple = await transfer(page, [{ name: 'one.mp4', type: 'video/mp4' }, { name: 'two.wav', type: 'audio/wav' }]);
  const document = await transfer(page, [{ name: 'notes.pdf', type: 'application/pdf' }]);
  try {
    await dropzone(page).dispatchEvent('drop', { dataTransfer: multiple });
    await expect(validation(page)).toHaveText('Choose one video or audio file at a time.');
    await expect(validation(page)).toHaveAttribute('role', 'status');
    await expect(dropzone(page)).toHaveAttribute('aria-describedby', await validation(page).getAttribute('id') as string);
    expect(uploads).toBe(0);
    await dropzone(page).dispatchEvent('drop', { dataTransfer: document });
    await expect(validation(page)).toHaveText('That file type is not supported here. Choose a video or audio file.');
    await input(page).setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: Buffer.from('Synthetic image selection') });
    expect(uploads).toBe(0);
    await expect(page.locator('.toast.error')).toHaveCount(0);
    await input(page).setInputFiles(video());
    await expect.poll(() => uploads).toBe(1);
    await expect(validation(page)).toBeEmpty();
  } finally { await multiple.dispose(); await document.dispose(); }
});

test('the file input clears before submission so the same file can retry after a failure', async ({ page }) => {
  await input(page).setInputFiles(video());
  await expect.poll(() => uploads).toBe(1);
  expect(await input(page).inputValue()).toBe('');
  await expect(dropzone(page)).toBeEnabled();
  await expect(page.locator('.toast.error')).toContainText('Synthetic upload failed');
  await input(page).setInputFiles(video());
  await expect.poll(() => uploads).toBe(2);
  expect(await input(page).inputValue()).toBe('');
});

test('busy upload rejects further drop and input admission until the request settles', async ({ page }) => {
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const data = await transfer(page, [{ name: 'other.mp4', type: 'video/mp4' }]);
  try {
    await input(page).setInputFiles(video());
    await expect.poll(() => uploads).toBe(1);
    await expect(dropzone(page)).toBeDisabled();
    await expect(input(page)).toBeDisabled();
    await dropzone(page).dispatchEvent('dragenter', { dataTransfer: data });
    await dropzone(page).dispatchEvent('drop', { dataTransfer: data });
    await input(page).evaluate((node: HTMLInputElement) => {
      const files = new DataTransfer(); files.items.add(new File(['Synthetic'], 'another.wav', { type: 'audio/wav' }));
      node.files = files.files; node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(dropzone(page)).not.toHaveClass(/\bdrag\b/);
    expect(uploads).toBe(1);
    release();
    await expect(dropzone(page)).toBeEnabled();
    await input(page).setInputFiles(video());
    await expect.poll(() => uploads).toBe(2);
  } finally { release(); hold = undefined; await data.dispose(); }
});

test('media hints and ambiguous containers remain candidates for the existing importer', async ({ page }) => {
  for (const file of [
    { name: 'recording.MOV', mimeType: '', buffer: Buffer.from('Synthetic container') },
    { name: 'transport.ts', mimeType: 'text/plain', buffer: Buffer.from('Synthetic transport stream') },
    { name: 'recording.unfamiliar', mimeType: 'application/octet-stream', buffer: Buffer.from('Synthetic unknown container') },
  ]) {
    const before = uploads;
    await input(page).setInputFiles(file);
    await expect.poll(() => uploads).toBe(before + 1);
    await expect(dropzone(page)).toBeEnabled();
    await expect(validation(page)).toBeEmpty();
  }
});

test('keyboard activation retains the file picker workflow', async ({ page }) => {
  for (const key of ['Enter', 'Space']) {
    const before = uploads;
    await dropzone(page).focus();
    const chosen = page.waitForEvent('filechooser');
    await dropzone(page).press(key);
    await (await chosen).setFiles(video());
    await expect.poll(() => uploads).toBe(before + 1);
    await expect(dropzone(page)).toBeEnabled();
  }
});

for (const width of [1440, 390]) test(`drop feedback fits at ${width}px and respects reduced motion`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const data = await transfer(page, [{ name: 'synthetic.mp4', type: 'video/mp4' }]);
  try {
    await dropzone(page).dispatchEvent('dragenter', { dataTransfer: data });
    await expect(dropzone(page).locator('strong')).toHaveText('Drop to import');
    expect(await dropzone(page).evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('heading', { name: 'Accurate Khmer captions, ready for CapCut.', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`drop-${width}.png`) });
  } finally { await data.dispose(); }
});
