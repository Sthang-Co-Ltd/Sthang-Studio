import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { CorrectionEvent } from '../../packages/shared/src/index.js';
import { cleanFixtures, createSyntheticWav, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
type Action = 'remember-global' | 'add-project' | 'ignore';
type Decision = { id: string; action: Action };

const correction = (index: number): CorrectionEvent => ({
  id: `correction-${index}`, projectId: 'landscape', projectTitle: 'Audit landscape', captionId: 'c1',
  startMs: index * 100, endMs: index * 100 + 500,
  originalText: `កម្ពុជា original ${index}`, correctedText: `កម្ពុជា corrected ${index}`,
  suggestionKind: 'review', suggestedVocabularyLine: `Term ${index}`, status: 'pending',
  createdAt: `2026-01-0${4 - index}T00:00:00.000Z`,
});
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.correctionEvents = [1, 2, 3].map(correction);
  state.profile.preferences.autosaveDelayMs = 60_000;
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function acknowledge({ id, action }: Decision) {
  const event = state.profile.correctionEvents.find((item) => item.id === id)!;
  const status: CorrectionEvent['status'] = action === 'remember-global' ? 'remembered-global' : action === 'add-project' ? 'added-project' : 'ignored';
  state.profile = {
    ...state.profile,
    correctionEvents: state.profile.correctionEvents.map((item) => item.id === id ? { ...item, status, decidedAt: '2026-02-01T00:00:00.000Z' } : item),
    defaultVocabulary: action === 'remember-global' ? [...state.profile.defaultVocabulary, event.suggestedVocabularyLine] : state.profile.defaultVocabulary,
  };
  const project = action === 'add-project' ? state.projects.find((item) => item.id === event.projectId)! : null;
  if (project) {
    project.transcriptionContext = {
      description: project.transcriptionContext?.description || '',
      vocabulary: [...(project.transcriptionContext?.vocabulary || []), event.suggestedVocabularyLine],
    };
    project.updatedAt = '2026-02-01T00:00:00.000Z';
  }
  return { profile: state.profile, project };
}
async function mockActions(page: Page, options: { hold?: Promise<void>; fail?: () => boolean } = {}) {
  const decisions: Decision[] = [];
  await page.route('**/api/profile/corrections/*/action', async (route) => {
    expect(route.request().method()).toBe('POST');
    const decision = { id: new URL(route.request().url()).pathname.split('/').at(-2)!, action: route.request().postDataJSON().action as Action };
    decisions.push(decision);
    if (options.hold) await options.hold;
    if (options.fail?.()) return route.fulfill({ status: 503, json: { error: 'Synthetic correction memory failure' } });
    await route.fulfill({ json: acknowledge(decision) });
  });
  return decisions;
}
async function openInbox(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Correction inbox/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Correction inbox', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
const card = (dialog: Locator, index: number) => dialog.getByRole('article').filter({ hasText: `កម្ពុជា corrected ${index}` });
async function activate(button: Locator) { await button.focus(); await button.press('Enter'); }
async function expectCardHeadingVisible(target: Locator) {
  await expect.poll(() => target.locator('.correction-meta').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.top >= 0 && rect.bottom <= innerHeight && (hit === node || (hit !== null && node.contains(hit)));
  })).toBe(true);
}

for (const width of [1440, 390]) test(`Pending decisions continue to the next, previous and empty inbox targets at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const decisions = await mockActions(page);
  const captions = structuredClone(state.projects[0].captions);
  await openProject(page);
  await page.evaluate(() => { (window as any).__correctionNodes = [document.querySelector('video'), document.querySelector('.caption-list')]; });
  const dialog = await openInbox(page);
  await activate(card(dialog, 2).getByRole('button', { name: 'Remember for all projects', exact: true }));
  await expect(card(dialog, 2)).toHaveCount(0);
  await expect(card(dialog, 3)).toBeFocused();
  await expectCardHeadingVisible(card(dialog, 3));
  await page.screenshot({ path: info.outputPath(`correction-next-focus-${width}.png`), animations: 'disabled' });
  await activate(card(dialog, 3).getByRole('button', { name: 'Remember for this project', exact: true }));
  await expect(card(dialog, 3)).toHaveCount(0);
  await expect(card(dialog, 1)).toBeFocused();
  await activate(card(dialog, 1).getByRole('button', { name: 'Ignore', exact: true }));
  await expect(dialog.getByRole('article')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Pending (0)', exact: true })).toBeFocused();
  await expect(dialog.getByText('Inbox clear', { exact: true })).toBeVisible();
  expect(decisions).toEqual([
    { id: 'correction-2', action: 'remember-global' },
    { id: 'correction-3', action: 'add-project' },
    { id: 'correction-1', action: 'ignore' },
  ]);
  expect(state.profile.defaultVocabulary).toEqual(['Term 2']);
  expect(state.projects[0].transcriptionContext?.vocabulary).toContain('Term 3');
  expect(state.projects[0].captions).toEqual(captions);
  expect(await page.evaluate(() => (window as any).__correctionNodes.every((node: Element, index: number) => node === document.querySelector(index ? '.caption-list' : 'video')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
});

test('History keeps the resolved correction focused and Tab continues within that card', async ({ page }) => {
  await mockActions(page);
  await openProject(page);
  const dialog = await openInbox(page);
  await dialog.getByRole('button', { name: 'Resolved (3)', exact: true }).click();
  const current = card(dialog, 2);
  await activate(current.getByRole('button', { name: 'Ignore', exact: true }));
  await expect(current).toContainText('ignored');
  await expect(current).toBeFocused();
  await expect(dialog.getByRole('article')).toHaveCount(3);
  await page.keyboard.press('Tab');
  await expect(current.getByRole('button', { name: 'Review audio', exact: true })).toBeFocused();
});

test('a failed decision restores its action, prevents duplicate requests and permits retry', async ({ page }) => {
  const gate = deferred();
  let fail = true;
  const decisions = await mockActions(page, { hold: gate.promise, fail: () => fail });
  try {
    await openProject(page);
    const dialog = await openInbox(page);
    const current = card(dialog, 2);
    const ignore = current.getByRole('button', { name: 'Ignore', exact: true });
    await ignore.evaluate((button: HTMLButtonElement) => { button.focus(); button.click(); button.click(); });
    await expect(current).toBeFocused();
    await expect(ignore).toBeDisabled();
    await expect.poll(() => decisions.length).toBe(1);
    gate.release();
    await expect(ignore).toBeEnabled();
    await expect(ignore).toBeFocused();
    await expect(current).toHaveClass(/status-pending/);
    expect(decisions).toHaveLength(1);
    fail = false;
    await ignore.press('Enter');
    await expect(current).toHaveCount(0);
    await expect(card(dialog, 3)).toBeFocused();
    expect(decisions).toHaveLength(2);
  } finally { gate.release(); }
});

for (const laterAction of ['focus', 'filter', 'close and reopen'] as const) test(`a delayed decision yields to newer ${laterAction}`, async ({ page }) => {
  const gate = deferred();
  const decisions = await mockActions(page, { hold: gate.promise });
  try {
    await openProject(page);
    let dialog = await openInbox(page);
    await activate(card(dialog, 1).getByRole('button', { name: 'Ignore', exact: true }));
    await expect(card(dialog, 1)).toBeFocused();
    await expect.poll(() => decisions.length).toBe(1);
    let target: Locator;
    if (laterAction === 'focus') {
      target = card(dialog, 3).getByRole('button', { name: 'Review audio', exact: true });
      await target.focus();
    } else if (laterAction === 'filter') {
      target = dialog.getByRole('button', { name: 'Resolved (3)', exact: true });
      await target.click();
    } else {
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      dialog = await openInbox(page);
      target = dialog.getByRole('button', { name: 'Close correction inbox', exact: true });
      await expect(target).toBeFocused();
    }
    gate.release();
    await expect(dialog.getByRole('button', { name: 'Pending (2)', exact: true })).toBeVisible();
    await expect(card(dialog, 3).getByRole('button', { name: 'Ignore', exact: true })).toBeEnabled();
    await expect(target).toBeFocused();
    expect(decisions).toHaveLength(1);
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  } finally { gate.release(); }
});

for (const width of [390, 1440]) test(`returning to correction history keeps a failed read retryable and plays its recorded excerpt at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const project = state.projects[1];
  const wav = createSyntheticWav(170, 220, 8000);
  project.media = { ...project.media, originalName: 'Interview.wav', filename: 'interview.wav', mimeType: 'audio/wav', url: '/media/interview.wav' };
  project.captions = Array.from({ length: 84 }, (_, index) => ({
    ...project.captions[0], id: `interview-${index + 1}`, text: `កម្ពុជា · Interview ${index + 1}`,
    startMs: index * 2000, endMs: index * 2000 + 1800,
  }));
  state.profile.correctionEvents = Array.from({ length: 38 }, (_, index) => ({
    ...correction(1), id: `event-${index}`, projectId: project.id, projectTitle: project.title,
    captionId: 'interview-61', correctedText: `កម្ពុជា · Correction ${index}`,
    startMs: 120000, endMs: 120500, status: 'ignored', createdAt: new Date(1760000000000 - index * 2000).toISOString(),
  }));
  await page.route('**/media/interview.wav', (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body: wav });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wav.length}` }, body: wav.subarray(start, end + 1) });
  });
  let fail = true;
  await page.route('**/api/projects/' + project.id, (route) => fail && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, json: { error: 'The saved project could not be read.' } }) : route.fallback());
  await page.goto('/');
  await page.getByRole('button', { name: 'Correction inbox', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Correction inbox' });
  await expect(dialog.getByRole('button', { name: 'Resolved (38)' })).toHaveAttribute('aria-pressed', 'true');
  const card = dialog.getByRole('article').filter({ has: page.getByText('កម្ពុជា · Correction 17', { exact: true }) });
  const listen = card.getByRole('button', { name: 'Review audio' });
  await activate(listen);
  await expect(card.getByRole('alert')).toContainText('The saved project could not be read.');
  await expect(listen).toBeFocused();
  await page.screenshot({ path: info.outputPath('history-read-retry.png'), animations: 'disabled' });
  fail = false;
  const selected = page.getByRole('group', { name: 'Caption 61', exact: true });
  const player = page.locator('.media-stage audio');
  for (const alreadyOpen of [false, true]) {
    if (alreadyOpen) {
      await openInbox(page);
      await player.evaluate((element: HTMLAudioElement) => { element.currentTime = 5; });
    }
    await activate(listen);
    await expect(dialog).toBeHidden();
    await expect(selected).toBeFocused();
    await expect(selected).toHaveClass(/selected-range/);
    await expect.poll(() => selected.evaluate((row) => {
      const text = row.querySelector('textarea')!.getBoundingClientRect();
      const hit = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2);
      return row.contains(hit);
    })).toBe(true);
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.paused && Math.abs(element.currentTime - 120.6) < 0.05)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('focused-correction.png'), animations: 'disabled' });
});

test('closing Correction inbox withdraws a pending request to open another project', async ({ page }) => {
  state.profile.correctionEvents[0].projectId = state.projects[1].id;
  await openProject(page);
  const gate = deferred();
  let requested = false;
  await page.route('**/api/projects/' + state.projects[1].id, async (route) => {
    requested = true;
    await gate.promise;
    await route.fallback().catch(() => {});
  });
  try {
    const dialog = await openInbox(page);
    await activate(card(dialog, 1).getByRole('button', { name: 'Review audio' }));
    await expect.poll(() => requested).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    gate.release();
    await expect(page.getByLabel('Open project tools', { exact: true })).toBeFocused();
    await expect(page.locator('.media-stage video')).toHaveAttribute('src', /landscape/);
  } finally { gate.release(); }
});

test('a correction beyond the current source explains why no excerpt can play', async ({ page }) => {
  const event = state.profile.correctionEvents[0];
  Object.assign(event, { captionId: 'removed-caption', startMs: 120000, endMs: 120500 });
  await openProject(page);
  const dialog = await openInbox(page);
  await activate(card(dialog, 1).getByRole('button', { name: 'Review audio' }));
  await expect(dialog).toBeHidden();
  await expect(page.getByText('The correction starts beyond the end of the current media. Its recorded audio is unavailable.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Media preview' })).toBeFocused();
  expect(await page.locator('.media-stage video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});
