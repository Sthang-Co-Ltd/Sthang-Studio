import { test, expect, type Page } from '@playwright/test';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';
import { cleanFixtures, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';
import { fetchOwnedRoute } from './owned-browser-routes.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  // Clicking a tool commits the focused caption on blur. Reject that save so
  // these assertions exercise a real unfinished draft, never a saved fixture.
  await page.route('**/api/projects/landscape/captions', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic save remains unavailable' } }));
});
async function rememberEditor(page: Page) {
  await page.getByLabel('Caption 1 text', { exact: true }).fill('Unsaved ខ្មែរ caption');
  await page.evaluate(() => {
    (window as any).__retryEvidence = { video: document.querySelector('video'), list: document.querySelector('.caption-panel'), doc: document.documentElement,
      selected: [...document.querySelectorAll('.caption-row.selected-range')].map((row) => row.getAttribute('data-caption-id')).join(',') };
    const video = document.querySelector('video')!;
    video.currentTime = 1.6; video.playbackRate = 0.5;
  });
}
async function preservedEditor(page: Page) {
  await expect(page.getByLabel('Caption 1 text', { exact: true })).toHaveValue('Unsaved ខ្មែរ caption');
  expect(state.projects[0].captions[0].text).not.toBe('Unsaved ខ្មែរ caption');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(true);
  expect(await page.evaluate(() => {
    const before = (window as any).__retryEvidence;
    return before.doc === document.documentElement && before.video === document.querySelector('video') && before.list === document.querySelector('.caption-panel')
      && before.video.playbackRate === 0.5 && Math.abs(before.video.currentTime - 1.6) < .1
      && before.selected === [...document.querySelectorAll('.caption-row.selected-range')].map((row) => row.getAttribute('data-caption-id')).join(',');
  })).toBe(true);
}
async function metadata(page: Page) {
  const data = await page.evaluate(async () => (await fetch('/studio-workspaces.json')).json());
  expect(data.buildId).toBe(webSourceIdentity(process.cwd()).buildId);
  return data.tools as Record<string, { entry: string; css: string[] }>;
}
const tools = [
  ['Fine timing', 'WaveformEditor', '.editor-timing-dock .timing-waveform-surface'],
  ['Appearance', 'CaptionAppearanceWorkspace', '.caption-appearance-workspace'],
  ['Export', 'ExportWorkspace', '.export-workspace'],
] as const;
for (const [label, name, ready] of tools) test(`${label}: fresh downloads recover twice without saving or remounting the editor`, async ({ page }) => {
  await openProject(page); await rememberEditor(page);
  const asset = (await metadata(page))[name];
  const requests: string[] = [];
  await page.route(`**${asset.entry}*`, (route) => {
    requests.push(route.request().url());
    return requests.length <= 2 ? route.abort() : route.fallback();
  });
  await page.getByRole('button', { name: label, exact: true }).click();
  const error = page.getByRole('alert', { name: `${label} could not load`, exact: true });
  await expect(error).toBeVisible();
  await preservedEditor(page);
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(error).toBeVisible();
  await preservedEditor(page);
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.locator(ready)).toBeVisible();
  await preservedEditor(page);
  expect(new Set(requests).size).toBe(3);
  await page.getByRole('button', { name: 'Close tool', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator(ready)).toBeVisible();
  expect(requests).toHaveLength(3);
  await preservedEditor(page);
});

test('a private dependency failure recovers, and styles keep their canonical order', async ({ page }) => {
  await openProject(page); await rememberEditor(page);
  const asset = (await metadata(page)).WaveformEditor;
  // In a production build the private dependency is inside the checked leaf.
  // Dev has separate native ESM requests and must version the whole private tree.
  const target = asset.entry.startsWith('/assets/') ? asset.entry : '/src/audio/spectrum.ts';
  const requests: string[] = [];
  await page.route(`**${target}*`, (route) => {
    requests.push(route.request().url());
    return requests.length === 1 ? route.abort() : route.fallback();
  });
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  const error = page.getByRole('alert', { name: 'Fine timing could not load' });
  await expect(error).toBeVisible();
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.locator('.editor-timing-dock .timing-waveform-surface')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('studio-retry=');
  await preservedEditor(page);
  const duplicateIds = await page.locator('style[data-vite-dev-id]').evaluateAll((nodes) => {
    const ids = nodes.map((node) => node.getAttribute('data-vite-dev-id'));
    return ids.length - new Set(ids).size;
  });
  expect(duplicateIds).toBe(0);
});

test('a failed stylesheet remains retryable without duplicating or reordering loaded styles', async ({ page }) => {
  await openProject(page); await rememberEditor(page);
  const asset = (await metadata(page)).CaptionAppearanceWorkspace;
  const target = asset.css.at(-1) || '/src/components/caption-appearance.css';
  const requests: string[] = [];
  await page.route(`**${target}*`, (route) => {
    requests.push(route.request().url());
    return requests.length <= 2 ? route.abort() : route.fallback();
  });
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const error = page.getByRole('alert', { name: 'Appearance could not load' });
  let styleOrder: string[] = [];
  for (let i = 0; i < 2; i++) {
    await expect(error).toBeVisible();
    if (i === 1 && asset.css.length) {
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.locator('.export-workspace')).toBeVisible();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await expect(error).toBeVisible();
      styleOrder = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => new URL((link as HTMLLinkElement).href).pathname));
    }
    await error.getByRole('button', { name: 'Retry loading tool' }).click();
    await expect.poll(() => requests.length).toBe(i + 2);
  }
  await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
  expect(new Set(requests).size).toBe(3);
  await preservedEditor(page);
  if (asset.css.length) {
    const paths = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => new URL((link as HTMLLinkElement).href).pathname));
    expect(paths.filter((url) => url === target)).toHaveLength(1);
    expect(paths.filter((url) => asset.css.includes(url))).toEqual(asset.css);
    expect(paths).toEqual(styleOrder);
  }
});

test('a late retry cannot replace the newer workspace or discard its edits', async ({ page }) => {
  await openProject(page); await rememberEditor(page);
  const assets = await metadata(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  await page.route(`**${assets.CaptionAppearanceWorkspace.entry}*`, async (route) => {
    if (++count === 1) return route.abort();
    await gate; await route.fallback();
  });
  try {
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: 'Retry loading tool' }).click();
    await expect.poll(() => count).toBe(2);
    await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
    await expect(page.locator('.editor-timing-dock .timing-waveform-surface')).toBeVisible();
    release();
    await expect(page.locator('.caption-appearance-workspace')).toHaveCount(0);
    await preservedEditor(page);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.locator('.caption-appearance-workspace')).toBeVisible();
    expect(count).toBe(2);
  } finally { release(); }
});

test('unavailable, mismatched and foreign download metadata fail safely and can be retried', async ({ page }) => {
  await openProject(page); await rememberEditor(page);
  const assets = await metadata(page);
  let first = true;
  await page.route(`**${assets.WaveformEditor.entry}*`, (route) => first ? (first = false, route.abort()) : route.fallback());
  let attempts = 0;
  await page.route('**/studio-workspaces.json', async (route) => {
    if (++attempts === 1) return route.fulfill({ status: 503, body: 'Synthetic download failure' });
    const response = await fetchOwnedRoute(route);
    try {
      const data = await response.json();
      if (attempts === 2) data.buildId = '0'.repeat(64);
      else if (attempts === 3) data.tools.WaveformEditor.entry = 'https://invalid.example/tool.js';
      await route.fulfill({ response, json: data });
    } finally { await response.dispose(); }
  });
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  const error = page.getByRole('alert', { name: 'Fine timing could not load' });
  for (let i = 0; i < 3; i++) {
    await expect(error).toBeVisible();
    await error.getByRole('button', { name: 'Retry loading tool' }).click();
    await expect.poll(() => attempts).toBe(i + 1);
    await expect(error).toBeVisible();
    await preservedEditor(page);
  }
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.locator('.editor-timing-dock .timing-waveform-surface')).toBeVisible();
  await preservedEditor(page);
});

test('Compare captions recovers its download with an unfinished caption draft', async ({ page }) => {
  const proposal = { id: 'retry-proposal', projectId: 'landscape', projectTitle: 'Audit landscape',
    createdAt: '2026-01-01', expiresAt: '2099-01-01', startMs: 100, endMs: 1300,
    lockedCaptionsPreserved: 0, unchangedCount: 0, changes: [], passNumber: 1, strategy: 'standard',
    currentCaptions: [], proposedCaptions: [{ id: 'proposal-caption', text: 'Proposed caption', startMs: 100, endMs: 1300 }] };
  state.jobs = [{ id: 'retry-job', type: 'regenerate-range', projectId: 'landscape', projectTitle: 'Audit landscape',
    status: 'completed', stage: 'complete', progress: 100, message: 'Preview ready', canResume: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', proposalId: proposal.id }];
  await page.route('**/regeneration-proposals/retry-proposal', (route) => route.fulfill({ json: proposal }));
  await openProject(page);
  const asset = (await metadata(page)).RegenerationReviewDock;
  const requests: string[] = [];
  await page.route(`**${asset.entry}*`, (route) => {
    requests.push(route.request().url()); return requests.length < 3 ? route.abort() : route.fallback();
  });
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  await page.getByRole('dialog', { name: 'Activity', exact: true }).getByRole('button', { name: 'Open result', exact: true }).click();
  const error = page.getByRole('alert', { name: 'Compare captions could not load' });
  await expect(error).toBeVisible(); await rememberEditor(page);
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect.poll(() => requests.length).toBe(2); await expect(error).toBeVisible();
  await preservedEditor(page);
  await error.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.getByRole('region', { name: 'Live regeneration review', exact: true })).toBeVisible();
  await preservedEditor(page);
  expect(new Set(requests).size).toBe(3);
});

test('playback continues through an explicit tool retry', async ({ page }) => {
  await openProject(page);
  const asset = (await metadata(page)).WaveformEditor;
  let first = true;
  await page.route(`**${asset.entry}*`, (route) => first ? (first = false, route.abort()) : route.fallback());
  await page.getByRole('button', { name: 'Fine timing', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Fine timing could not load' })).toBeVisible();
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    (window as any).__playingVideo = video;
    video.currentTime = .3; video.playbackRate = .25; await video.play();
  });
  await page.getByRole('button', { name: 'Retry loading tool' }).click();
  await expect(page.locator('.editor-timing-dock .timing-waveform-surface')).toBeVisible();
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video === (window as any).__playingVideo && !video.paused && video.playbackRate === .25 && video.currentTime > .3)).toBe(true);
});
