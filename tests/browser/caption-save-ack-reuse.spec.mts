import { test as base, expect, type Page } from '@playwright/test';
import type { CaptionProject, CaptionSegment } from '@kcs/shared';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.setTimeout(75_000);

const LARGE_COUNT = 1_000;
const row = (page: Page, index: number) => page.locator(`.caption-list .caption-row[data-caption-id="ack-${index}"]`);
const field = (page: Page, index: number) => row(page, index).locator('textarea');
const saveLabel = (page: Page) => page.locator('.save-action .save-action-label');

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function prepare(page: Page, count: number, wordHighlight = false) {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  // Only native caption fields are under test; the owned source video lasts 4s.
  const project = state.projects[0];
  project.transcript = null;
  if (project.captionAppearance) project.captionAppearance.highlightMode = wordHighlight ? 'word' : 'off';
  project.captions = Array.from({ length: count }, (_, index): CaptionSegment => ({
    id: `ack-${index}`, startMs: 200 + index * 1_000, endMs: 800 + index * 1_000,
    text: index === 1 && wordHighlight ? 'Word' : `កម្ពុជា caption ${index + 1}`,
    approved: false, timingSource: 'manual', timingQuality: 'medium',
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return state;
}

type CaptionWrite = {
  captions: CaptionSegment[];
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt?: string;
  source?: string;
};

/** Persist the submitted snapshot, then hold its first HTTP acknowledgement. */
async function holdFirstSave(
  page: Page,
  state: FixtureState,
  responseFor?: (committed: CaptionProject) => CaptionProject,
) {
  const gate = deferred();
  const started = deferred();
  const finished = deferred();
  const writes: CaptionWrite[] = [];
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const request = route.request();
    const body = request.postDataJSON() as CaptionWrite;
    writes.push(structuredClone(body));
    const current = state.projects[0];
    if (body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size
      || body.expectedUpdatedAt !== current.updatedAt) {
      return route.fulfill({ status: 409, json: { error: 'Synthetic caption revision changed', code: 'CAPTION_REVISION_CHANGED' } });
    }
    const committed: CaptionProject = {
      ...structuredClone(current), captions: structuredClone(body.captions),
      updatedAt: new Date(Date.UTC(2026, 10, 15, 0, 0, writes.length)).toISOString(),
    };
    state.projects[0] = committed;
    const first = writes.length === 1;
    if (first) { started.release(); await gate.promise; }
    try {
      // The wire response is freshly serialized independently of the submitted
      // draft. There can be no cross-process object identity to inherit.
      return await route.fulfill({ json: { project: structuredClone(responseFor?.(committed) ?? committed), correctionsCreated: 0 } });
    } catch (error) {
      if (!page.isClosed() && request.failure()?.errorText !== 'net::ERR_ABORTED') throw error;
    } finally { if (first) finished.release(); }
  });
  return { gate, started, finished, writes };
}

async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function observeRowWork(page: Page) {
  await page.evaluate(() => {
    const target = window as any;
    const hooks = target.__STHANG_TEST_HOOKS__;
    if (!hooks) throw new Error('Development caption hooks are unavailable.');
    target.__ackWork = { rowRenders: 0, listBuilds: 0 };
    hooks.onCaptionRowRender = () => { target.__ackWork.rowRenders++; };
    hooks.onCaptionListBuild = () => { target.__ackWork.listBuilds++; };
  });
}

test('an exact owned 1,000-caption save ACK preserves native rows and avoids a full-list rerender', async ({ page }) => {
  const state = await prepare(page, LARGE_COUNT);
  const held = await holdFirstSave(page, state);
  try {
    await openProject(page);
    await expect(page.locator('.caption-list .caption-row')).toHaveCount(LARGE_COUNT);
    await observeRowWork(page);

    const edited = 'កម្ពុជា ACK should retain every unchanged caption';
    await field(page, 0).fill(edited);
    await field(page, 1).focus(); // Blur submits the exact text-edit snapshot.
    await held.started.promise;
    expect(held.writes).toHaveLength(1);
    expect(held.writes[0].source).toBe('text-edit');
    expect(held.writes[0].captions).toHaveLength(LARGE_COUNT);
    expect(held.writes[0].captions[0].text).toBe(edited);

    // Native field/caret/selection and viewport state are captured before ACK.
    // No broad role/accessible-tree locator is evaluated in the measured interval.
    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.caption-list')!;
      const field0 = document.querySelector<HTMLTextAreaElement>('[data-caption-id="ack-0"] textarea')!;
      const field1 = document.querySelector<HTMLTextAreaElement>('[data-caption-id="ack-1"] textarea')!;
      field1.setSelectionRange(3, 3);
      list.scrollTop = 220;
      (window as any).__ackNodes = {
        video: document.querySelector('video'), list, field0, field1,
        active: document.activeElement,
        selection: [...document.querySelectorAll('.caption-row.selected-range')].map((node) => node.getAttribute('data-caption-id')),
        scrollTop: list.scrollTop,
      };
    });
    await settleFrames(page); // Let pending-save and focus effects finish first.
    await page.evaluate(() => { (window as any).__ackWork = { rowRenders: 0, listBuilds: 0 }; });
    held.gate.release();
    await held.finished.promise;
    await expect(saveLabel(page)).toHaveText('Saved');
    await expect(page.locator('.save-action')).toHaveAttribute('aria-disabled', 'true');
    await settleFrames(page);
    const result = await page.evaluate(() => {
      const saved = (window as any).__ackNodes;
      const field0 = document.querySelector<HTMLTextAreaElement>('[data-caption-id="ack-0"] textarea');
      const field1 = document.querySelector<HTMLTextAreaElement>('[data-caption-id="ack-1"] textarea');
      const list = document.querySelector<HTMLElement>('.caption-list')!;
      return {
        ...((window as any).__ackWork as { rowRenders: number; listBuilds: number }),
        sameVideo: document.querySelector('video') === saved.video,
        sameList: list === saved.list,
        sameFields: field0 === saved.field0 && field1 === saved.field1,
        focus: document.activeElement === saved.active && document.activeElement === field1,
        caret: field1 ? [field1.selectionStart, field1.selectionEnd] : [],
        selection: [...document.querySelectorAll('.caption-row.selected-range')].map((node) => node.getAttribute('data-caption-id')),
        priorSelection: saved.selection,
        scrollShift: list.scrollTop - saved.scrollTop,
        edited: field0?.value,
      };
    });
    expect(result.rowRenders).toBeLessThanOrEqual(4);
    expect(result.listBuilds).toBe(0);
    expect(result).toMatchObject({ sameVideo: true, sameList: true, sameFields: true,
      focus: true, caret: [3, 3], edited, selection: result.priorSelection });
    expect(Math.abs(result.scrollShift)).toBeLessThanOrEqual(1);
    expect(state.projects[0].captions[0].text).toBe(edited);
    expect(state.projects[0].captions).toHaveLength(LARGE_COUNT);
  } finally { held.gate.release(); }
});

test('a canonical save ACK still adopts changed wording, edges, locks and word timing', async ({ page }) => {
  const state = await prepare(page, 24, true);
  const canonical = 'Server canonical ខ្មែរ wording';
  const wordTiming: NonNullable<CaptionSegment['wordTiming']> = {
    version: 1, text: 'Word', words: [{ id: 'server-word', startOffset: 0, endOffset: 4,
      startMs: 1_250, endMs: 1_600, source: 'manual' }],
  };
  const held = await holdFirstSave(page, state, (committed) => {
    const response = structuredClone(committed);
    response.captions[0] = { ...response.captions[0], text: canonical, startMs: 260, endMs: 850,
      approved: true, textLocked: true, timingLocked: true };
    response.captions[1] = { ...response.captions[1], wordTiming };
    state.projects[0] = structuredClone(response); // Server committed its canonical representation.
    return response;
  });
  try {
    await openProject(page);
    await expect(page.locator('.caption-list .caption-row')).toHaveCount(24);
    await field(page, 0).fill('Local wording before canonical save');
    await field(page, 1).focus(); // Owns selection and preserves the next field.
    await held.started.promise;
    await expect(row(page, 1).locator('.caption-text-cell button')).toHaveCount(1);
    held.gate.release();
    await held.finished.promise;
    await expect(saveLabel(page)).toHaveText('Saved');
    await expect(field(page, 0)).toHaveValue(canonical);
    await expect(field(page, 0)).toHaveAttribute('readonly', '');
    await expect(row(page, 0).locator('.row-approve')).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, 0).locator('.time-stack input').first()).toHaveValue('00:00.260');
    await expect(row(page, 0).locator('.time-stack input').first()).toBeDisabled();
    await expect(row(page, 1).locator('.caption-text-cell button')).toHaveCount(0);
    expect(state.projects[0].captions[1].wordTiming).toEqual(wordTiming);
    await expect(field(page, 1)).toHaveValue('Word');
  } finally { held.gate.release(); }
});

test('newer typing remains dirty across an older ACK, then saves its own revision', async ({ page }) => {
  const state = await prepare(page, 24);
  const held = await holdFirstSave(page, state);
  try {
    await openProject(page);
    const first = 'First committed Khmer កម្ពុជា';
    const newer = 'Newer uncommitted Khmer ខ្មែរ';
    await field(page, 0).fill(first);
    await field(page, 1).focus();
    await held.started.promise;
    await field(page, 1).fill(newer); // A newer draft while first PUT is held.
    await expect(field(page, 1)).toBeFocused();
    held.gate.release();
    await held.finished.promise;
    await expect(field(page, 0)).toHaveValue(first);
    await expect(field(page, 1)).toHaveValue(newer);
    await expect(saveLabel(page)).toHaveText('Save');
    expect(state.projects[0].captions[0].text).toBe(first);
    expect(state.projects[0].captions[1].text).not.toBe(newer);

    await field(page, 1).blur(); // The later draft submits its own full snapshot.
    await expect.poll(() => held.writes.length).toBe(2);
    await expect(saveLabel(page)).toHaveText('Saved');
    expect(held.writes[1].captions[0].text).toBe(first);
    expect(held.writes[1].captions[1].text).toBe(newer);
    expect(state.projects[0].captions[1].text).toBe(newer);
  } finally { held.gate.release(); }
});

for (const mismatch of ['source', 'project'] as const) {
  test(`an ACK belonging to another ${mismatch} cannot replace this editor's draft`, async ({ page }) => {
    const state = await prepare(page, 24);
    const held = await holdFirstSave(page, state, (committed) => mismatch === 'project'
      ? { ...structuredClone(committed), id: 'foreign-project' }
      : { ...structuredClone(committed), media: { ...committed.media, filename: 'foreign-media.mp4' } });
    try {
      await openProject(page);
      const savedText = 'Current project caption ကម្ពុជា';
      await field(page, 0).fill(savedText);
      await field(page, 1).focus();
      await held.started.promise;
      await page.evaluate(() => {
        (window as any).__ackForeignNodes = [document.querySelector('video'), document.querySelector('.caption-list'),
          document.querySelector('[data-caption-id="ack-0"] textarea')];
      });
      held.gate.release();
      await held.finished.promise;
      await expect(field(page, 0)).toHaveValue(savedText);
      await expect(page.locator('.media-stage video')).toHaveAttribute('src', '/media/landscape.mp4');
      await expect(page.locator('.caption-list .caption-row')).toHaveCount(24);
      expect(await page.evaluate(() => {
        const nodes = (window as any).__ackForeignNodes;
        return nodes[0] === document.querySelector('video') && nodes[1] === document.querySelector('.caption-list')
          && nodes[2] === document.querySelector('[data-caption-id="ack-0"] textarea');
      })).toBe(true);
      await expect(saveLabel(page)).not.toHaveText('Saved');
    } finally { held.gate.release(); }
  });
}
