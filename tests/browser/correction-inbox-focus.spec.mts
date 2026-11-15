import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { CorrectionEvent } from '../../packages/shared/src/index.js';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
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
  const dialog = page.getByRole('dialog', { name: 'Correction Inbox', exact: true });
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
  await dialog.getByRole('button', { name: 'History (3)', exact: true }).click();
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
      target = dialog.getByRole('button', { name: 'History (3)', exact: true });
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
