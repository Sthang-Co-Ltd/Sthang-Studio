import { test as base, expect } from '@playwright/test';
import { cleanFixtures, installFixture, openProject, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';
import { markFixtureCaption } from './word-highlight-routes.mjs';
import type { CaptionSegment } from '../../packages/shared/src/index.js';

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);

for (const mode of ['off', 'word'] as const) {
  test(`caption edits compute highlight coverage only when the look is on (${mode})`, async ({ page }) => {
    const state = await installFixture(page);
    state.profile.preferences.autosaveDelayMs = 60_000;
    const project = state.projects[0];
    project.captionAppearance = { ...project.captionAppearance!, highlightMode: mode };
    await page.addInitScript(() => {
      const target = window as typeof window & {
        highlightCoverageScans: number[];
        __STHANG_TEST_HOOKS__?: { onWordHighlightCoverage?: (count: number) => void };
      };
      target.highlightCoverageScans = [];
      target.__STHANG_TEST_HOOKS__ = { ...target.__STHANG_TEST_HOOKS__,
        onWordHighlightCoverage: (count) => target.highlightCoverageScans.push(count) };
    });
    const scans = () => page.evaluate(() =>
      (window as typeof window & { highlightCoverageScans: number[] }).highlightCoverageScans);

    await openProject(page);
    const captionCount = project.captions.length;
    await expect(page.locator('.caption-row')).toHaveCount(captionCount);
    const initial = await scans();
    expect(initial.includes(captionCount)).toBe(mode === 'word');

    const field = page.getByLabel('Caption 1 text', { exact: true });
    await field.fill('A changed caption កម្ពុជា');
    await expect(field).toHaveValue('A changed caption កម្ពុជា');
    await expect(page.locator('.save-action')).toBeEnabled();
    const afterEdit = (await scans()).slice(initial.length);
    if (mode === 'off') expect(afterEdit).toEqual([]);
    else expect(afterEdit).toContain(captionCount);
  });
}

test('one edit with highlighting on keeps the other marked captions and compiles one plan', async ({ page }) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const project = state.projects[0];
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'word' };
  project.captions = project.captions.map(markFixtureCaption);
  const count = project.captions.length;
  const editedId = project.captions[0].id;

  type Probe = { current: readonly CaptionSegment[]; before: readonly CaptionSegment[]; computed: string[] };
  await page.addInitScript(() => {
    const target = window as typeof window & {
      coverageProbe: Probe;
      __STHANG_TEST_HOOKS__?: {
        onWordHighlightCoverage?: (count: number, captions: readonly CaptionSegment[]) => void;
        onWordHighlightCoveragePlan?: (id: string) => void;
      };
    };
    const probe = target.coverageProbe = { current: [], before: [], computed: [] };
    target.__STHANG_TEST_HOOKS__ = {
      ...target.__STHANG_TEST_HOOKS__,
      onWordHighlightCoverage: (_count, captions) => { probe.current = captions; },
      onWordHighlightCoveragePlan: (id) => probe.computed.push(id),
    };
  });

  await openProject(page);
  await expect(page.locator('.caption-row')).toHaveCount(count);
  const field = page.getByLabel('Caption 1 text', { exact: true });
  await field.focus();
  const baseline = await page.evaluate(() => {
    const probe = (window as typeof window & { coverageProbe: Probe }).coverageProbe;
    probe.before = probe.current;
    probe.computed = [];
    return probe.before.map(({ wordTiming }) => wordTiming?.evidence);
  });
  expect(baseline).toEqual(Array(count).fill(2));

  await field.fill('A changed caption ???????');
  await expect(page.locator('.save-action')).toBeEnabled();
  const result = await page.evaluate(() => {
    const { before, current, computed } = (window as typeof window & { coverageProbe: Probe }).coverageProbe;
    return { reused: current.filter((caption, index) => caption === before[index]).length, computed };
  });
  expect(result).toEqual({ reused: count - 1, computed: [editedId] });
});
