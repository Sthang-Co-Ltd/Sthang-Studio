import { expect, test as base, type Page } from '@playwright/test';
import { createCaptionData, hydrateCaptionWordTimings } from '@kcs/shared';
import { translate } from '../../apps/web/src/i18n/translate.js';
import type { MessageKey, MessageParams } from '../../apps/web/src/i18n/types.js';
import { UPLOAD_RECOVERY_PREFIX } from '../../apps/web/src/upload-recovery.js';
import { cleanFixtures, fixtureMedia, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { requireHarnessConfig } from './harness-config.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => {
    try { await use(context); } finally { await closeOwnedBrowserContext(context); }
  },
});

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

async function fixture(page: Page) {
  const errors: string[] = [];
  const withoutUrls = (message: string) => message.replace(/\b(?:https?|wss?):\/\/[^\s'"]+/g, '[url]');
  page.on('pageerror', (error) => errors.push(withoutUrls(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(withoutUrls(message.text()));
  });
  const state = await installFixture(page);
  // Match the other language specs' local HMR handshake and optional GET fixtures.
  const viteHost = new URL(requireHarnessConfig().webOrigin).host;
  await page.routeWebSocket((url) => url.protocol === 'ws:' && url.host === viteHost && url.pathname === '/', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
  });
  await page.route('**/api/updates', (route) => route.fulfill({ json: { status: 'unconfigured', currentVersion: 'test' } }));
  await page.route('**/api/project-bin', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/media-preview/*', (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source');
    if (route.request().method() !== 'GET' || !state.projects.some((project) =>
      url.pathname === '/api/media-preview/' + project.id && source === project.media.filename)) return route.fallback();
    return route.fulfill({ json: { source, state: 'original', videoCodec: 'h264', progress: 0 } });
  });
  state.profile.preferences.interfaceLanguage = 'km';
  state.profile.preferences.autosaveDelayMs = 60_000;
  return { state, errors };
}

const km = (key: MessageKey, params?: MessageParams) => translate('km', key, params);

async function tool(page: Page, key: MessageKey) {
  await page.locator('[data-project-tools-trigger]').click();
  await page.getByRole('menu', { name: km('editor.tools.menu') }).getByText(km(key), { exact: true }).click();
}

test('Khmer localizes the media dialogs and confirmation copy', async ({ page }) => {
  const { errors } = await fixture(page);
  await page.route('**/api/projects/landscape/media-replacements', (route) => route.fulfill({ json: [] }));
  await openProject(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  const chooser = page.waitForEvent('filechooser');
  await tool(page, 'editor.tools.replace');
  await (await chooser).setFiles({ name: 'alternate.mp4', mimeType: 'video/mp4', buffer: fixtureMedia() });
  const dialog = page.getByRole('dialog', { name: km('dialogs.media.replaceTitle'), exact: true });
  await expect(dialog).toContainText(km('dialogs.media.replaceDescription'));
  await expect(dialog.locator('.replacement-files bdi').last()).toHaveText('alternate.mp4');
  await dialog.getByRole('radio', { name: new RegExp(`^${km('dialogs.media.reset')}`) }).check();
  await dialog.getByRole('button', { name: km('dialogs.media.continue'), exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: km('dialogs.resetMedia.title'), exact: true });
  await expect(confirmation).toContainText(km('dialogs.resetMedia.message', { filename: 'alternate.mp4' }));
  await confirmation.getByRole('button', { name: km('dialogs.resetMedia.cancel'), exact: true }).click();
  await dialog.getByRole('button', { name: km('common.cancel'), exact: true }).click();

  await tool(page, 'editor.tools.undoReplace');
  const backups = page.getByRole('dialog', { name: km('dialogs.media.undoTitle'), exact: true });
  await expect(backups.getByText(km('dialogs.media.noBackups'))).toBeVisible();
  expect(errors).toEqual([]);
});

test('Khmer grouping preview compares the same passage on a phone', async ({ page }, info) => {
  const { errors } = await fixture(page);
  await page.route('**/resegment/preview', route => route.fulfill({ json: {
    startMs: 0, endMs: 3000, digest: 'sample',
    current: [{ startMs: 200, endMs: 1800, text: 'ថ្ងៃនេះយើងទៅសាលាជាមួយគ្នា។' }],
    proposed: [{ startMs: 200, endMs: 900, text: 'ថ្ងៃនេះយើងទៅសាលា' }, { startMs: 900, endMs: 1800, text: 'ជាមួយគ្នា។' }],
  } }));
  await page.setViewportSize({ width: 320, height: 900 });
  await openProject(page);
  await page.getByRole('button', { name: km('grouping.title'), exact: true }).click();
  const toggle = page.getByRole('button', { name: km('grouping.preview') });
  await toggle.press('Enter');
  const panel = page.locator('.grouping-preview');
  await expect(panel.getByRole('heading')).toHaveText([km('grouping.current'), km('grouping.proposed')]);
  await toggle.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('khmer-grouping-320.png') });
  expect(errors).toEqual([]);
});

test('Khmer localizes project and upload storage notices', async ({ page }) => {
  const { errors } = await fixture(page);
  await page.route('**/api/system/project-storage*', (route) => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    localStorage.setItem('phase-c-storage-fixture', '1');
    Storage.prototype.key = () => { throw new Error('Synthetic recovery inventory failure'); };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  await expect(page.locator('.upload-storage-feedback')).toHaveText(km('notices.upload.recoveryUnavailable'));
  await expect(page.getByText(km('notices.storage.checkFailed'), { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a saved Khmer profile localizes a restored upload reminder on a cold load without a mirror', async ({ page }) => {
  const { errors } = await fixture(page);
  await page.addInitScript(({ prefix, mirror }) => {
    localStorage.removeItem(mirror);
    const id = 'upload_' + 'a'.repeat(32);
    localStorage.setItem(prefix + id, JSON.stringify({
      version: 1, id, name: 'original.mp4', size: 100, type: 'video/mp4', lastModified: 1, capturedAt: Date.now(),
    }));
  }, { prefix: UPLOAD_RECOVERY_PREFIX, mirror: 'sthang:interface-language:v1' });
  let releaseProfile!: () => void;
  const profileGate = new Promise<void>((resolve) => { releaseProfile = resolve; });
  await page.route('**/api/profile', async (route) => {
    await profileGate;
    await route.fallback();
  });
  const reminder = page.locator('.upload-recovery > div:first-child > p').first();
  try {
    await page.goto('/');
    await expect(reminder).toHaveText(translate('en', 'home.upload.earlierNeedsCheck'));
  } finally {
    releaseProfile();
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  await expect(reminder).toHaveText(km('home.upload.earlierNeedsCheck'));
  expect(errors).toEqual([]);
});

test('cross-tab upload reminder removal uses the language selected after mount', async ({ page, context }) => {
  const { state, errors } = await fixture(page);
  state.profile.preferences.interfaceLanguage = 'en';
  await page.route('**/api/projects', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { code: 'PROJECT_CREATE_NOT_APPLIED', error: 'Synthetic upload rejected.' } })
    : route.fallback());
  await page.goto('/');
  await expect(page.locator('.dropzone')).toBeEnabled();
  await page.locator('.empty-stage input[type="file"]').setInputFiles({
    name: 'original.mp4', mimeType: 'video/mp4', buffer: fixtureMedia(),
  });
  await expect(page.locator('.upload-recovery')).toContainText('Synthetic upload rejected.');
  await page.locator('.home-tools .interface-language-switch').getByRole('button', { name: 'ខ្មែរ', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'km');
  const other = await context.newPage();
  try {
    await fixture(other);
    await other.goto('/');
    const removed = await other.evaluate((prefix) => {
      const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
      if (key) localStorage.removeItem(key);
      return Boolean(key);
    }, UPLOAD_RECOVERY_PREFIX);
    expect(removed).toBe(true);
    await expect(page.locator('.upload-storage-feedback')).toHaveText(km('home.upload.reminderRemoved'));
    await page.locator('.home-tools .interface-language-switch').getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.locator('.upload-storage-feedback')).toHaveText(translate('en', 'home.upload.reminderRemoved'));
  } finally {
    await other.close();
  }
  expect(errors.filter((error) => !error.includes('409'))).toEqual([]);
});

test('Khmer localizes the unfinished-edit dialog and clipboard recovery', async ({ page }) => {
  const { state, errors } = await fixture(page);
  state.profile.correctionEvents = [{
    id: 'phase-c-correction', projectId: 'landscape', projectTitle: state.projects[0].title, captionId: 'c1',
    startMs: 200, endMs: 1000, originalText: 'Old កម្ពុជា', correctedText: 'New កម្ពុជា', suggestionKind: 'alias',
    suggestedVocabularyLine: 'New | Old', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
  }];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } } });
    document.execCommand = () => false;
  });
  await openProject(page);
  await tool(page, 'editor.tools.corrections');
  const inbox = page.getByRole('dialog', { name: km('inbox.title'), exact: true });
  await inbox.getByRole('button', { name: km('workspace.copyReport'), exact: true }).click();
  await expect(inbox.getByRole('alert')).toHaveText(km('dialogs.copyReport.failed'));
  await expect(inbox.getByRole('textbox', { name: km('dialogs.copyReport.manualLabel', { label: km('workspace.copyReport') }) })).toBeVisible();
  await inbox.getByRole('button', { name: km('inbox.close'), exact: true }).click();

  const caption = page.getByLabel(translate('km', 'editor.row.text', { number: 1 }), { exact: true });
  await caption.fill('Unfinished test caption');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) =>
    key.startsWith('sthang-studio:unfinished-edits:') && localStorage.getItem(key)?.includes('Unfinished test caption')))).toBe(true);
  page.once('dialog', (dialog) => void dialog.accept());
  await openProject(page);
  const recovery = page.getByRole('region', { name: km('dialogs.draft.label'), exact: true });
  await expect(recovery.getByText(km('dialogs.draft.title'), { exact: true })).toBeVisible();
  await recovery.getByRole('button', { name: km('dialogs.discardDraft.confirm'), exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: km('dialogs.discardDraft.title'), exact: true });
  await expect(confirm).toContainText(km('dialogs.discardDraft.message'));
  await confirm.getByRole('button', { name: km('dialogs.discardDraft.cancel'), exact: true }).click();
  expect(errors).toEqual([]);
});

test('Khmer opens the timing workspace and localizes browser media errors', async ({ page }) => {
  const { errors } = await fixture(page);
  await openProject(page);
  await page.getByRole('button', { name: km('workspace.fineTiming'), exact: true }).click();
  await expect(page.getByRole('button', { name: km('timing.waveform.moveEarlier'), exact: true })).toBeVisible();
  await page.locator('video').evaluate((element) => {
    Object.defineProperty(element, 'error', { configurable: true, value: { code: 2 } });
    element.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('.source-media-status')).toContainText(km('notices.playback.network'));
  expect(errors).toEqual([]);
});

test('Khmer marks the server warning and localizes the transfer error', async ({ page }) => {
  const { state, errors } = await fixture(page);
  const project = state.projects[0];
  const snapshot = createCaptionData({
    captions: hydrateCaptionWordTimings(project).captions, appearance: project.captionAppearance, durationMs: 4000,
  });
  await page.route('**/api/caption-handoff/landscape/summary', (route) => route.fulfill({
    json: { revision: 'a'.repeat(64), snapshot, captionCount: project.captions.length, media: project.media },
  }));
  await page.route('**/api/caption-handoff/landscape/export-history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/caption-handoff/landscape/export', (route) => route.fulfill({ body: '' }));
  await page.route('**/api/caption-handoff/landscape/restore-preview', (route) => route.fulfill({
    json: { revision: 'a'.repeat(64), candidate: snapshot, candidateDigest: 'b'.repeat(64), warnings: ['Synthetic server warning.'] },
  }));
  await openProject(page);
  await page.locator('[data-stage="export"]').click();
  await page.locator('.export-mode-switch button').nth(1).click();
  await page.locator('.handoff-download-primary').click();
  await expect(page.getByRole('alert').filter({ hasText: km('notices.transfer.emptyFile') })).toBeVisible();
  await page.locator('.handoff-advanced summary').click();
  await page.locator('.handoff-restore input[type="file"]').setInputFiles({
    name: 'demo.sthang-captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await expect(page.locator('.caption-restore-warning[data-server-text]')).toHaveText('Synthetic server warning.');
  expect(errors).toEqual([]);
});
