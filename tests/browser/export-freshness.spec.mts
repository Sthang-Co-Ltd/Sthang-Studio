import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exportContentBasis, type ExportEvidence, type ProcessingJob } from '../../packages/shared/src/index.js';
import { cleanFixtures, fixtureExportUrl, installFixture, openProject, prepareFixtures, type FixtureState } from './fixtures.mjs';

test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
let state: FixtureState;
let entries: ExportEvidence[];
test.beforeEach(async ({ page }) => {
  state = await installFixture(page);
  entries = ['srt', 'video'].map((format) => ({ version: 1, format, preparedAt: '2026-01-01T00:00:00Z', fingerprint: createHash('sha256').update(exportContentBasis(state.projects[0], format as any)).digest('hex') })) as ExportEvidence[];
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: entries }));
});

test('receipts match, become stale on edits, survive reload, and differ by format', async ({ page }, info) => {
  await openProject(page);
  await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await page.getByLabel('Caption 1 text', { exact: true }).fill('New Khmer wording ខ្មែរ');
  await expect(history.getByText(/Changed since export/)).toHaveCount(2);
  await expect(history.locator('summary')).toContainText('2 need updating');
  await page.screenshot({ path: info.outputPath('freshness-desktop.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.projects[0].captions[0].text).toBe('New Khmer wording ខ្មែរ');
  await page.reload(); await page.getByRole('button', { name: /Audit landscape/ }).click();
  await page.getByRole('button', { name: /^Export$/ }).click();
  await page.locator('.export-history summary').click();
  await expect(page.locator('.export-history').getByText(/Changed since export/)).toHaveCount(2);
});

test('unavailable history is unknown, retryable and does not block rendering', async ({ page }) => {
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic history unavailable' } }));
  await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history).toContainText('Freshness is unknown');
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
  await page.route('**/api/caption-handoff/*/export-history', (route) => route.fulfill({ json: [] }));
  await history.getByRole('button', { name: 'Retry export history' }).click();
  await expect(history).toContainText('Earlier exports have unknown freshness');
});

test('caption-only freshness ignores an appearance edit while video freshness changes', async ({ page }, info) => {
  state.projects[0].captionAppearance!.textColor = '#FF0000';
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await expect(history.getByText(/Changed since export/)).toHaveCount(1);
  expect(await history.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('freshness-mobile.png') });
});

test('a delayed history response cannot publish into a different project', async ({ page }) => {
  let enter!: () => void; let release!: () => void; let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/caption-handoff/*/export-history', async (route) => {
    if (route.request().url().includes('/landscape/')) {
      enter(); await gate;
      await route.fulfill({ json: entries }).catch(() => {});
      finish();
    } else await route.fulfill({ json: [] });
  });
  try {
    await openProject(page); await page.getByRole('button', { name: /^Export$/ }).click(); await entered;
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    await page.getByRole('button', { name: /^Export$/ }).click();
    const history = page.locator('.export-history'); await history.locator('summary').click();
    await expect(history).toContainText('No recorded exports');
    release(); await finished;
    await expect(history.locator('li')).toHaveCount(0);
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  } finally { release(); }
});

test('Activity identifies exact old render content and keeps legacy video downloads available', async ({ page }) => {
  const resultExport = { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000, width: 640, height: 360,
    frameRate: 25, videoCodec: 'h264' as const, encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt: '2026-01-01T00:00:02Z' };
  const base: ProcessingJob = { id: 'receipt', type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape', status: 'completed',
    stage: 'complete', progress: 100, message: 'Ready', canResume: false, createdAt: resultExport.createdAt, updatedAt: resultExport.createdAt, resultExport };
  state.jobs = [{ ...base, exportContentFingerprint: entries.find((entry) => entry.format === 'video')!.fingerprint }, { ...base, id: 'legacy' }];
  state.projects[0].captions[0].text = 'New content after render';
  await openProject(page); await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  const activity = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(activity).toContainText('this video contains earlier content');
  await expect(activity).toContainText('this earlier export has no receipt');
  await expect(activity.getByRole('button', { name: 'Download video', exact: true })).toHaveCount(2);
});

async function editAppearanceSize(page: Page, size: number) {
  if (await page.getByRole('button', { name: 'Edit appearance', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Edit appearance', exact: true }).click();
  } else await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByLabel('Khmer font', { exact: true })).toBeEnabled();
  await page.getByLabel(/^Size /).fill(String(size));
}

async function openActivity(page: Page) {
  await page.getByLabel('Open project tools', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Processing jobs/ }).click();
  return page.getByRole('dialog', { name: 'Activity', exact: true });
}

function completedVideo(fingerprint: string, id = 'appearance-receipt'): ProcessingJob {
  const createdAt = '2026-01-01T00:00:02Z';
  return { id, type: 'export-video', projectId: 'landscape', projectTitle: 'Audit landscape', status: 'completed',
    stage: 'complete', progress: 100, message: 'Ready', canResume: false, createdAt, updatedAt: createdAt,
    exportContentFingerprint: fingerprint,
    resultExport: { filename: 'synthetic-captioned.mp4', url: fixtureExportUrl(), sizeBytes: 12000, width: 640, height: 360,
      frameRate: 25, videoCodec: 'h264', encoder: 'libx264', audioCodec: null, durationMs: 4000, createdAt } };
}

async function installCompletedRenders(page: Page) {
  await page.route('**/api/video-export/*/jobs', async (route) => {
    const body = route.request().postDataJSON();
    // Synthetic completion retains the admission's actual UI-selected snapshot.
    // This checks comparison wiring, not native rendering or receipt persistence.
    const snapshot = structuredClone({ ...state.projects[0], captionAppearance: body.appearance });
    const fingerprint = createHash('sha256').update(exportContentBasis(snapshot, 'video')).digest('hex');
    const job = { ...completedVideo(fingerprint, `appearance-render-${state.jobs.length}`), status: 'queued', stage: 'queued', progress: 0, message: 'Queued' } as ProcessingJob;
    state.jobs = [job, ...state.jobs];
    await route.fulfill({ status: 202, json: { ...job, lastUsedSettingsSaved: true } });
  });
}

async function renderVideo(page: Page) {
  const count = state.jobs.length;
  await page.getByRole('button', { name: 'Render captioned video', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Render anyway', exact: true }).click();
  await expect.poll(() => state.jobs.length).toBe(count + 1);
  await expect(page.getByRole('button', { name: 'Export already running', exact: true })).toBeVisible();
  const job = state.jobs[0];
  state.jobs[0] = { ...job, status: 'completed', stage: 'complete', progress: 100, message: 'Ready' };
  entries = [...entries.filter((entry) => entry.format !== 'video'), { version: 1, format: 'video', fingerprint: job.exportContentFingerprint!, preparedAt: job.createdAt }];
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeEnabled();
}

test('actual appearance A to B to A compares both Export and Activity against the saved look', async ({ page }) => {
  await installCompletedRenders(page);
  const originalSize = state.projects[0].captionAppearance!.fontSize1080;
  await openProject(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await renderVideo(page); // A
  await editAppearanceSize(page, 90); // B, through the real Appearance control
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  const activity = await openActivity(page); // Direct entry: do not visit Export first.
  await expect(activity.getByText(/this video contains earlier content/)).toHaveCount(1);
  await activity.getByRole('button', { name: 'Close Activity' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const history = page.locator('.export-history');
  await history.locator('summary').click();
  await expect(history.getByText(/Changed since export/)).toHaveCount(1);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await renderVideo(page); // B
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(2);
  await openActivity(page);
  await expect(activity.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await expect(activity.getByText(/this video contains earlier content/)).toHaveCount(1);
  await activity.getByRole('button', { name: 'Close Activity' }).click();
  await editAppearanceSize(page, originalSize); // A again
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(originalSize);
  await openActivity(page);
  await expect(activity.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await expect(activity.getByText(/this video contains earlier content/)).toHaveCount(1);
  // The original A receipt matches again; B is the stale job.
  await expect(activity.locator('.job-list article').nth(0)).toContainText('this video contains earlier content');
  await expect(activity.locator('.job-list article').nth(1)).toContainText('Matches open project content.');
  await activity.getByRole('button', { name: 'Close Activity' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.locator('.export-history summary').click();
  await expect(page.locator('.export-history').getByText(/Changed since export/)).toHaveCount(1);
});

test('actual appearance edit remains unknown during its save and after failure in Export and direct Activity', async ({ page }) => {
  state.jobs = [completedVideo(entries.find((entry) => entry.format === 'video')!.fingerprint)];
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/video-export/*/appearance', async (route) => {
    started(); await gate;
    await route.fulfill({ status: 500, json: { error: 'Synthetic appearance save failure' } });
  });
  try {
    await openProject(page); await editAppearanceSize(page, 90);
    const activity = await openActivity(page);
    await entered;
    await expect(activity.getByText('Matches open project content.', { exact: true })).toHaveCount(0);
    await expect(activity).toContainText(/Checking export content|Freshness unknown/);
    release();
    await expect(activity).toContainText('Freshness unknown');
    await expect(activity.getByText(/Changed since export/)).toHaveCount(0);
    await activity.getByRole('button', { name: 'Close Activity' }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const history = page.locator('.export-history'); await history.locator('summary').click();
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
    await expect(history.getByText(/Freshness unknown/)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeDisabled();
  } finally { release(); }
});

test('appearance reconciliation preserves unsaved caption edits and plain-format comparisons', async ({ page }) => {
  state.profile.preferences.autosaveDelayMs = 60_000;
  const savedText = state.projects[0].captions[0].text;
  await openProject(page); await editAppearanceSize(page, 90);
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/projects/landscape', async (route) => {
    const snapshot = structuredClone(state.projects[0]);
    entered(); await gate; await route.fulfill({ json: snapshot });
  });
  try {
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await started;
    const history = page.locator('.export-history'); await history.locator('summary').click();
    const input = page.getByLabel('Caption 1 text', { exact: true });
    await input.fill('Unfinished caption ខ្មែរ');
    release();
    await expect(history.getByText(/Changed since export/)).toHaveCount(2);
    await expect(input).toHaveValue('Unfinished caption ខ្មែរ');
    expect(state.projects[0].captions[0].text).toBe(savedText);
  } finally { release(); }
});

test('failed appearance reads stay unknown and retry compares the actual edited look', async ({ page }) => {
  await openProject(page); await editAppearanceSize(page, 90);
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  let fail = true;
  await page.route('**/api/projects/landscape', (route) => route.fulfill(fail
    ? { status: 503, json: { error: 'Synthetic saved appearance unavailable' } }
    : { json: state.projects[0] }));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(1);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  fail = false;
  await page.getByRole('button', { name: 'Retry appearance load', exact: true }).click();
  await expect(history.getByText(/Changed since export/)).toHaveCount(1);
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(0);
});

test('a delayed appearance response cannot supply a different project or media comparison', async ({ page }) => {
  await openProject(page); await editAppearanceSize(page, 90);
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  let entered!: () => void; let release!: () => void; let finished!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const complete = new Promise<void>((resolve) => { finished = resolve; });
  await page.route('**/api/projects/landscape', async (route) => {
    const snapshot = structuredClone(state.projects[0]);
    entered(); await gate;
    await route.fulfill({ json: snapshot }).catch(() => {}); finished();
  });
  try {
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await started;
    await page.locator('.export-history summary').click();
    await expect(page.locator('.export-history').getByText(/Freshness unknown/)).toHaveCount(1);
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await page.getByRole('button', { name: /Audit second/ }).click();
    const secondReceipt = { version: 1, format: 'video', preparedAt: '2026-01-01T00:00:00Z',
      fingerprint: createHash('sha256').update(exportContentBasis(state.projects[1], 'video')).digest('hex') } as const;
    entries = [secondReceipt];
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const history = page.locator('.export-history'); await history.locator('summary').click();
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
    release(); await complete;
    await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
    await expect(page.locator('.project-title strong')).toHaveText('Audit second');
  } finally { release(); }
});

test('a same-project response for replaced media leaves styled freshness unknown', async ({ page }) => {
  await openProject(page); await editAppearanceSize(page, 90);
  await expect.poll(() => state.projects[0].captionAppearance!.fontSize1080).toBe(90);
  const replacement = structuredClone(state.projects[0]);
  replacement.media = { ...replacement.media, filename: 'replacement.mp4', size: replacement.media.size + 1 };
  await page.route('**/api/projects/landscape', (route) => route.fulfill({ json: replacement }));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const history = page.locator('.export-history'); await history.locator('summary').click();
  await expect(history.getByText(/Freshness unknown/)).toHaveCount(1);
  await expect(history.getByText('Matches open project content.', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Render captioned video', exact: true })).toBeDisabled();
});
