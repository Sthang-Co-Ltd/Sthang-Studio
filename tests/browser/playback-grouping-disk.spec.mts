import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionProject } from '@kcs/shared';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root = '';
let projectFile = '';
let serializedProjectFile = '';
let queuedSnapshotProjectFile = '';
let mixedSaveProjectFile = '';
let navigationProjectFile = '';
let server: ChildProcess | null = null;
let serverOutput = '';

function caption(text: string) {
  return {
    id: 'c1',
    startMs: 200,
    endMs: 1200,
    text,
    textLocked: false,
    timingLocked: false,
    approved: false,
  };
}

async function waitForServer() {
  // Cold tsx startup on Windows was measured at 10.3 seconds locally. The old
  // six-second readiness gate failed before these history assertions could run.
  // Bound startup separately; do not extend or weaken any interaction assertion.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`Disk-backed test server exited early (${server.exitCode}).\n${serverOutput}`);
    try {
      const response = await fetch('http://127.0.0.1:8787/api/projects?summary=1', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for disk-backed test server.\n${serverOutput}`);
}

test.beforeAll(async () => {
  // The hook also creates several disk fixtures and a real media sample before
  // starting the server. Give that bounded cold-start path room beyond the
  // suite's normal 30s interaction budget without relaxing any test assertion.
  test.setTimeout(90_000);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-playback-disk-browser-'));
  const uploads = path.join(root, 'uploads');
  const projects = path.join(root, 'data', 'projects');
  const history = path.join(root, 'data', 'history', 'disk-history');
  const serializedHistory = path.join(root, 'data', 'history', 'disk-history-serialized');
  const queuedSnapshotHistory = path.join(root, 'data', 'history', 'disk-history-queued-snapshot');
  const mixedSaveHistory = path.join(root, 'data', 'history', 'disk-history-mixed-saves');
  const navigationHistory = path.join(root, 'data', 'history', 'disk-history-navigation-clean');
  await Promise.all([
    fs.mkdir(uploads, { recursive: true }),
    fs.mkdir(projects, { recursive: true }),
    fs.mkdir(history, { recursive: true }),
    fs.mkdir(serializedHistory, { recursive: true }),
    fs.mkdir(queuedSnapshotHistory, { recursive: true }),
    fs.mkdir(mixedSaveHistory, { recursive: true }),
    fs.mkdir(navigationHistory, { recursive: true }),
  ]);

  const media = path.join(uploads, 'disk-history.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=0x204060:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media,
  ], { timeout: 30_000, windowsHide: true });
  const mediaStat = await fs.stat(media);
  const now = '2026-01-01T00:00:00.000Z';
  const current: CaptionProject = {
    id: 'disk-history',
    title: 'Disk History Race',
    createdAt: now,
    updatedAt: now,
    media: {
      filename: 'disk-history.mp4',
      originalName: 'disk-history.mp4',
      mimeType: 'video/mp4',
      size: mediaStat.size,
      url: '/media/disk-history.mp4',
    },
    mode: 'phrase',
    transcript: null,
    transcriptionContext: { description: '', vocabulary: [] },
    captions: [caption('CURRENT BEFORE RESTORE')],
    engineVersion: '0.7.10',
  };
  const restored: CaptionProject = {
    ...structuredClone(current),
    updatedAt: '2025-12-31T23:59:00.000Z',
    captions: [caption('HISTORY STATE')],
  };
  const serializedCurrent: CaptionProject = {
    ...structuredClone(current),
    id: 'disk-history-serialized',
    title: 'Serialized Save Ack Race',
    media: {
      ...current.media,
      filename: 'disk-history-serialized.mp4',
      originalName: 'disk-history-serialized.mp4',
      url: '/media/disk-history-serialized.mp4',
    },
    captions: [caption('CURRENT BEFORE SERIALIZED RESTORE')],
  };
  const serializedRestored: CaptionProject = {
    ...structuredClone(serializedCurrent),
    updatedAt: '2025-12-31T23:58:00.000Z',
    captions: [caption('SERIALIZED HISTORY STATE')],
  };
  const queuedSnapshotCurrent: CaptionProject = {
    ...structuredClone(current),
    id: 'disk-history-queued-snapshot',
    title: 'Queued Snapshot Authority',
    media: {
      ...current.media,
      filename: 'disk-history-queued-snapshot.mp4',
      originalName: 'disk-history-queued-snapshot.mp4',
      url: '/media/disk-history-queued-snapshot.mp4',
    },
    captions: [caption('BEFORE QUEUED RESTORE')],
  };
  const queuedSnapshotRestored: CaptionProject = {
    ...structuredClone(queuedSnapshotCurrent),
    updatedAt: '2025-12-31T23:57:00.000Z',
    captions: [caption('QUEUED HISTORY SNAPSHOT')],
  };
  const mixedSaveCurrent: CaptionProject = {
    ...structuredClone(current),
    id: 'disk-history-mixed-saves',
    title: 'Mixed Save Authority',
    media: {
      ...current.media,
      filename: 'disk-history-mixed-saves.mp4',
      originalName: 'disk-history-mixed-saves.mp4',
      url: '/media/disk-history-mixed-saves.mp4',
    },
    captions: [caption('BEFORE MIXED RESTORE')],
  };
  const mixedSaveRestored: CaptionProject = {
    ...structuredClone(mixedSaveCurrent),
    updatedAt: '2025-12-31T23:56:00.000Z',
    captions: [caption('MIXED HISTORY SNAPSHOT')],
  };
  const navigationCurrent: CaptionProject = {
    ...structuredClone(current),
    id: 'disk-history-navigation-clean',
    title: 'Navigation Clean Save Authority',
    media: {
      ...current.media,
      filename: 'disk-history-navigation-clean.mp4',
      originalName: 'disk-history-navigation-clean.mp4',
      url: '/media/disk-history-navigation-clean.mp4',
    },
    captions: [caption('BEFORE NAVIGATION RESTORE')],
  };
  const navigationRestored: CaptionProject = {
    ...structuredClone(navigationCurrent),
    updatedAt: '2025-12-31T23:55:00.000Z',
    captions: [caption('NAVIGATION HISTORY SNAPSHOT')],
  };
  projectFile = path.join(projects, `${current.id}.json`);
  serializedProjectFile = path.join(projects, `${serializedCurrent.id}.json`);
  queuedSnapshotProjectFile = path.join(projects, `${queuedSnapshotCurrent.id}.json`);
  mixedSaveProjectFile = path.join(projects, `${mixedSaveCurrent.id}.json`);
  navigationProjectFile = path.join(projects, `${navigationCurrent.id}.json`);
  await Promise.all([
    fs.copyFile(media, path.join(uploads, serializedCurrent.media.filename)),
    fs.copyFile(media, path.join(uploads, queuedSnapshotCurrent.media.filename)),
    fs.copyFile(media, path.join(uploads, mixedSaveCurrent.media.filename)),
    fs.copyFile(media, path.join(uploads, navigationCurrent.media.filename)),
  ]);
  await Promise.all([
    fs.writeFile(projectFile, `${JSON.stringify(current)}\n`, 'utf8'),
    fs.writeFile(serializedProjectFile, `${JSON.stringify(serializedCurrent)}\n`, 'utf8'),
    fs.writeFile(queuedSnapshotProjectFile, `${JSON.stringify(queuedSnapshotCurrent)}\n`, 'utf8'),
    fs.writeFile(mixedSaveProjectFile, `${JSON.stringify(mixedSaveCurrent)}\n`, 'utf8'),
    fs.writeFile(navigationProjectFile, `${JSON.stringify(navigationCurrent)}\n`, 'utf8'),
    fs.writeFile(path.join(projects, 'order.json'), JSON.stringify([
      current.id,
      serializedCurrent.id,
      queuedSnapshotCurrent.id,
      mixedSaveCurrent.id,
      navigationCurrent.id,
    ]), 'utf8'),
    fs.writeFile(path.join(projects, '.per-project-v1'), 'fixture\n', 'utf8'),
  ]);

  const historyEntry = {
    id: 'history-old',
    projectId: current.id,
    createdAt: '2025-12-31T23:59:00.000Z',
    label: 'Disk-backed restore point',
    source: 'manual-save',
    captionCount: 1,
    approvedCount: 0,
    textLockedCount: 0,
    timingLockedCount: 0,
    fingerprint: 'disk-history-fixture',
    snapshot: restored,
  };
  const historyIndex = [{
    id: historyEntry.id,
    projectId: historyEntry.projectId,
    createdAt: historyEntry.createdAt,
    label: historyEntry.label,
    source: historyEntry.source,
    captionCount: historyEntry.captionCount,
    approvedCount: historyEntry.approvedCount,
    textLockedCount: historyEntry.textLockedCount,
    timingLockedCount: historyEntry.timingLockedCount,
    fingerprint: historyEntry.fingerprint,
    media: { filename: current.media.filename, size: current.media.size },
  }];
  await Promise.all([
    fs.writeFile(path.join(history, `${historyEntry.id}.json`), JSON.stringify(historyEntry), 'utf8'),
    fs.writeFile(path.join(history, 'index.json'), JSON.stringify(historyIndex), 'utf8'),
  ]);

  const serializedHistoryEntry = {
    ...historyEntry,
    id: 'history-serialized',
    projectId: serializedCurrent.id,
    createdAt: '2025-12-31T23:58:00.000Z',
    label: 'Serialized restore point',
    fingerprint: 'disk-history-serialized-fixture',
    snapshot: serializedRestored,
  };
  const serializedHistoryIndex = [{
    id: serializedHistoryEntry.id,
    projectId: serializedHistoryEntry.projectId,
    createdAt: serializedHistoryEntry.createdAt,
    label: serializedHistoryEntry.label,
    source: serializedHistoryEntry.source,
    captionCount: serializedHistoryEntry.captionCount,
    approvedCount: serializedHistoryEntry.approvedCount,
    textLockedCount: serializedHistoryEntry.textLockedCount,
    timingLockedCount: serializedHistoryEntry.timingLockedCount,
    fingerprint: serializedHistoryEntry.fingerprint,
    media: { filename: serializedCurrent.media.filename, size: serializedCurrent.media.size },
  }];
  await Promise.all([
    fs.writeFile(path.join(serializedHistory, `${serializedHistoryEntry.id}.json`), JSON.stringify(serializedHistoryEntry), 'utf8'),
    fs.writeFile(path.join(serializedHistory, 'index.json'), JSON.stringify(serializedHistoryIndex), 'utf8'),
  ]);

  const queuedSnapshotHistoryEntry = {
    ...historyEntry,
    id: 'history-queued-snapshot',
    projectId: queuedSnapshotCurrent.id,
    createdAt: '2025-12-31T23:57:00.000Z',
    label: 'Queued snapshot restore point',
    fingerprint: 'disk-history-queued-snapshot-fixture',
    snapshot: queuedSnapshotRestored,
  };
  const queuedSnapshotHistoryIndex = [{
    id: queuedSnapshotHistoryEntry.id,
    projectId: queuedSnapshotHistoryEntry.projectId,
    createdAt: queuedSnapshotHistoryEntry.createdAt,
    label: queuedSnapshotHistoryEntry.label,
    source: queuedSnapshotHistoryEntry.source,
    captionCount: queuedSnapshotHistoryEntry.captionCount,
    approvedCount: queuedSnapshotHistoryEntry.approvedCount,
    textLockedCount: queuedSnapshotHistoryEntry.textLockedCount,
    timingLockedCount: queuedSnapshotHistoryEntry.timingLockedCount,
    fingerprint: queuedSnapshotHistoryEntry.fingerprint,
    media: { filename: queuedSnapshotCurrent.media.filename, size: queuedSnapshotCurrent.media.size },
  }];
  await Promise.all([
    fs.writeFile(path.join(queuedSnapshotHistory, `${queuedSnapshotHistoryEntry.id}.json`), JSON.stringify(queuedSnapshotHistoryEntry), 'utf8'),
    fs.writeFile(path.join(queuedSnapshotHistory, 'index.json'), JSON.stringify(queuedSnapshotHistoryIndex), 'utf8'),
  ]);

  const mixedSaveHistoryEntry = {
    ...historyEntry,
    id: 'history-mixed-saves',
    projectId: mixedSaveCurrent.id,
    createdAt: '2025-12-31T23:56:00.000Z',
    label: 'Mixed save restore point',
    fingerprint: 'disk-history-mixed-saves-fixture',
    snapshot: mixedSaveRestored,
  };
  const mixedSaveHistoryIndex = [{
    id: mixedSaveHistoryEntry.id,
    projectId: mixedSaveHistoryEntry.projectId,
    createdAt: mixedSaveHistoryEntry.createdAt,
    label: mixedSaveHistoryEntry.label,
    source: mixedSaveHistoryEntry.source,
    captionCount: mixedSaveHistoryEntry.captionCount,
    approvedCount: mixedSaveHistoryEntry.approvedCount,
    textLockedCount: mixedSaveHistoryEntry.textLockedCount,
    timingLockedCount: mixedSaveHistoryEntry.timingLockedCount,
    fingerprint: mixedSaveHistoryEntry.fingerprint,
    media: { filename: mixedSaveCurrent.media.filename, size: mixedSaveCurrent.media.size },
  }];
  await Promise.all([
    fs.writeFile(path.join(mixedSaveHistory, `${mixedSaveHistoryEntry.id}.json`), JSON.stringify(mixedSaveHistoryEntry), 'utf8'),
    fs.writeFile(path.join(mixedSaveHistory, 'index.json'), JSON.stringify(mixedSaveHistoryIndex), 'utf8'),
  ]);

  const navigationHistoryEntry = {
    ...historyEntry,
    id: 'history-navigation-clean',
    projectId: navigationCurrent.id,
    createdAt: '2025-12-31T23:55:00.000Z',
    label: 'Navigation restore point',
    fingerprint: 'disk-history-navigation-clean-fixture',
    snapshot: navigationRestored,
  };
  const navigationHistoryIndex = [{
    id: navigationHistoryEntry.id,
    projectId: navigationHistoryEntry.projectId,
    createdAt: navigationHistoryEntry.createdAt,
    label: navigationHistoryEntry.label,
    source: navigationHistoryEntry.source,
    captionCount: navigationHistoryEntry.captionCount,
    approvedCount: navigationHistoryEntry.approvedCount,
    textLockedCount: navigationHistoryEntry.textLockedCount,
    timingLockedCount: navigationHistoryEntry.timingLockedCount,
    fingerprint: navigationHistoryEntry.fingerprint,
    media: { filename: navigationCurrent.media.filename, size: navigationCurrent.media.size },
  }];
  await Promise.all([
    fs.writeFile(path.join(navigationHistory, `${navigationHistoryEntry.id}.json`), JSON.stringify(navigationHistoryEntry), 'utf8'),
    fs.writeFile(path.join(navigationHistory, 'index.json'), JSON.stringify(navigationHistoryIndex), 'utf8'),
  ]);

  server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: '8787',
      WEB_ORIGIN: 'http://127.0.0.1:5199',
      STHANG_STUDIO_STATE_ROOT: root,
      STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'),
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      STHANG_CONTRIBUTION_ENDPOINT: '',
      STHANG_ANALYTICS_ENDPOINT: '',
      LOCAL_TIMING_PYTHON: path.join(root, 'missing-python.exe'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  server.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitForServer();
  const profileResponse = await fetch('http://127.0.0.1:8787/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferences: { autosaveDelayMs: 60_000, privacyUpgradeNoticeVersion: '0.8' } }),
  });
  if (!profileResponse.ok) throw new Error(`Could not prepare disk-backed browser profile: ${profileResponse.status}`);
});

test.afterAll(async () => {
  if (server && server.exitCode == null) {
    server.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      server!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('disk-backed History restore cannot falsely mark a newer saved edit as saved', async ({ page }) => {
  // This test deliberately holds a real disk-backed restore while exercising a
  // second edit. On a cold Windows release-validation machine the real server and
  // filesystem path can consume most of Playwright's default 30s test budget.
  // Keep the interaction assertions unchanged and bound only the overall case.
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({
    json: {
      provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
      secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
    },
  }));

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  let restoreRequested = false;
  await page.route('**/api/projects/disk-history/history/history-old/restore', async (route) => {
    restoreRequested = true;
    await restoreGate;
    await route.continue();
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Disk History Race/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history.mp4');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('CURRENT BEFORE RESTORE');

    await field.fill('ACKNOWLEDGED BEFORE RESTORE');
    const firstSave = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history/captions') && response.request().method() === 'PUT');
    await page.keyboard.press('Control+s');
    expect((await firstSave).status()).toBe(200);
    await expect(page.locator('.project-title')).toContainText('saved');
    let disk = JSON.parse(await fs.readFile(projectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('ACKNOWLEDGED BEFORE RESTORE');

    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.locator('.history-list article').filter({ hasText: 'Disk-backed restore point' })
      .getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);
    await field.fill('LATEST VISIBLE EDIT');

    const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history/history/history-old/restore'));
    releaseRestore();
    expect((await restoreResponse).status()).toBe(200);
    await expect(field).toHaveValue('LATEST VISIBLE EDIT');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    disk = JSON.parse(await fs.readFile(projectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('HISTORY STATE');

    const secondSave = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history/captions') && response.request().method() === 'PUT');
    await page.keyboard.press('Control+s');
    expect((await secondSave).status()).toBe(200);
    await expect(page.locator('.project-title')).toContainText('saved');
    disk = JSON.parse(await fs.readFile(projectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('LATEST VISIBLE EDIT');
  } finally {
    releaseRestore();
  }
});

test('disk-backed History restore serializes a later save until the restore response is reconciled', async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
    const originalFetch = window.fetch.bind(window);
    (window as any).__serializedCaptionSaveFetchStarts = 0;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/disk-history-serialized/captions')) {
        (window as any).__serializedCaptionSaveFetchStarts += 1;
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({
    json: {
      provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
      secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
    },
  }));

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  let restoreRequested = false;
  await page.route('**/api/projects/disk-history-serialized/history/history-serialized/restore', async (route) => {
    restoreRequested = true;
    await restoreGate;
    await route.continue();
  });

  let releaseSaveToServer!: () => void;
  const saveServerGate = new Promise<void>((resolve) => { releaseSaveToServer = resolve; });
  let releaseSaveAcknowledgement!: () => void;
  const saveAcknowledgementGate = new Promise<void>((resolve) => { releaseSaveAcknowledgement = resolve; });
  let saveRequestStarted = false;
  let savePersisted = false;
  await page.route('**/api/projects/disk-history-serialized/captions', async (route) => {
    saveRequestStarted = true;
    await saveServerGate;
    const response = await route.fetch();
    const body = await response.body();
    savePersisted = true;
    await saveAcknowledgementGate;
    await route.fulfill({ response, body });
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Serialized Save Ack Race/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history-serialized.mp4');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('CURRENT BEFORE SERIALIZED RESTORE');

    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);

    await field.fill('NEWER EDIT QUEUED BEHIND RESTORE');
    await page.keyboard.press('Control+s');
    expect(await page.evaluate(() => (window as any).__serializedCaptionSaveFetchStarts)).toBe(0);
    expect(saveRequestStarted).toBe(false);
    let disk = JSON.parse(await fs.readFile(serializedProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('CURRENT BEFORE SERIALIZED RESTORE');

    const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-serialized/history/history-serialized/restore'));
    releaseRestore();
    expect((await restoreResponse).status()).toBe(200);
    await expect.poll(() => saveRequestStarted).toBe(true);
    expect(await page.evaluate(() => (window as any).__serializedCaptionSaveFetchStarts)).toBe(1);
    await expect(field).toHaveValue('NEWER EDIT QUEUED BEHIND RESTORE');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    disk = JSON.parse(await fs.readFile(serializedProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('SERIALIZED HISTORY STATE');

    releaseSaveToServer();
    await expect.poll(() => savePersisted).toBe(true);
    disk = JSON.parse(await fs.readFile(serializedProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('NEWER EDIT QUEUED BEHIND RESTORE');
    await expect(field).toHaveValue('NEWER EDIT QUEUED BEHIND RESTORE');
    await expect(page.locator('.project-title')).toContainText('autosave pending');

    const saveResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-serialized/captions') && response.request().method() === 'PUT');
    releaseSaveAcknowledgement();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.locator('.project-title')).toContainText('saved');
    disk = JSON.parse(await fs.readFile(serializedProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('NEWER EDIT QUEUED BEHIND RESTORE');
  } finally {
    releaseRestore();
    releaseSaveToServer();
    releaseSaveAcknowledgement();
  }
});

test('clean Ctrl+S queued behind History restore cannot write its pre-restore snapshot', async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({
    json: {
      provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
      secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
    },
  }));

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  let restoreRequested = false;
  await page.route('**/api/projects/disk-history-queued-snapshot/history/history-queued-snapshot/restore', async (route) => {
    restoreRequested = true;
    await restoreGate;
    await route.continue();
  });

  const saveBodies: any[] = [];
  await page.route('**/api/projects/disk-history-queued-snapshot/captions', async (route) => {
    const body = route.request().postDataJSON();
    saveBodies.push(body);
    const response = await route.fetch();
    const responseBody = await response.body();
    await route.fulfill({ response, body: responseBody });
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Queued Snapshot Authority/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history-queued-snapshot.mp4');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('BEFORE QUEUED RESTORE');
    await expect(page.locator('.project-title')).toContainText('saved');

    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);

    // No caption edit: Ctrl+S may be coalesced/no-op rather than entering the queue.
    await field.focus();
    await page.keyboard.press('Control+s');
    expect(saveBodies).toHaveLength(0);

    const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-queued-snapshot/history/history-queued-snapshot/restore'));
    releaseRestore();
    expect((await restoreResponse).status()).toBe(200);

    await expect(field).toHaveValue('QUEUED HISTORY SNAPSHOT');
    await expect(page.locator('.project-title')).toContainText('saved');
    let disk = JSON.parse(await fs.readFile(queuedSnapshotProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('QUEUED HISTORY SNAPSHOT');

    // A later genuine edit still persists and may become clean after its acknowledgement.
    await field.fill('LATER GENUINE EDIT');
    const genuineSave = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-queued-snapshot/captions')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON().captions?.[0]?.text === 'LATER GENUINE EDIT');
    await page.keyboard.press('Control+s');
    expect((await genuineSave).status()).toBe(200);
    // If the earlier clean Ctrl+S was not coalesced, it must have carried the
    // authoritative restored captions rather than the pre-restore snapshot.
    for (const redundantBody of saveBodies.slice(0, -1)) {
      expect(redundantBody.captions[0].text).toBe('QUEUED HISTORY SNAPSHOT');
    }
    expect(saveBodies.at(-1)?.captions[0]?.text).toBe('LATER GENUINE EDIT');
    await expect(field).toHaveValue('LATER GENUINE EDIT');
    await expect(page.locator('.project-title')).toContainText('saved');
    disk = JSON.parse(await fs.readFile(queuedSnapshotProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('LATER GENUINE EDIT');
  } finally {
    releaseRestore();
  }
});

test('clean then dirty queued saves cannot mark a later unsaved edit as saved', async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({
    json: {
      provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
      secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
    },
  }));

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  let restoreRequested = false;
  await page.route('**/api/projects/disk-history-mixed-saves/history/history-mixed-saves/restore', async (route) => {
    restoreRequested = true;
    await restoreGate;
    await route.continue();
  });

  let releaseFirstSaveToServer!: () => void;
  const firstSaveServerGate = new Promise<void>((resolve) => { releaseFirstSaveToServer = resolve; });
  let releaseFirstSaveAcknowledgement!: () => void;
  const firstSaveAcknowledgementGate = new Promise<void>((resolve) => { releaseFirstSaveAcknowledgement = resolve; });
  let firstSaveStarted = false;
  let firstSavePersisted = false;
  const saveBodies: any[] = [];
  await page.route('**/api/projects/disk-history-mixed-saves/captions', async (route) => {
    const body = route.request().postDataJSON();
    saveBodies.push(body);
    if (saveBodies.length === 1) {
      firstSaveStarted = true;
      await firstSaveServerGate;
      const response = await route.fetch();
      const responseBody = await response.body();
      firstSavePersisted = true;
      await firstSaveAcknowledgementGate;
      await route.fulfill({ response, body: responseBody });
      return;
    }
    const response = await route.fetch();
    const responseBody = await response.body();
    await route.fulfill({ response, body: responseBody });
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Mixed Save Authority/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history-mixed-saves.mp4');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('BEFORE MIXED RESTORE');
    await expect(page.locator('.project-title')).toContainText('saved');

    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);

    // S1 is redundant and should not become queued persistence work.
    await field.focus();
    await page.keyboard.press('Control+s');
    expect(saveBodies).toHaveLength(0);

    // S2 is a genuine dirty save and must retain exactly FIRST NEW EDIT.
    await field.fill('FIRST NEW EDIT');
    await page.keyboard.press('Control+s');
    expect(saveBodies).toHaveLength(0);

    // This edit is deliberately not requested for saving yet.
    await field.fill('LATEST USER EDIT');
    await expect(page.locator('.project-title')).toContainText('autosave pending');

    const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-mixed-saves/history/history-mixed-saves/restore'));
    releaseRestore();
    expect((await restoreResponse).status()).toBe(200);
    await expect.poll(() => firstSaveStarted).toBe(true);
    expect(saveBodies).toHaveLength(1);
    expect(saveBodies[0].captions[0].text).toBe('FIRST NEW EDIT');
    await expect(field).toHaveValue('LATEST USER EDIT');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    let disk = JSON.parse(await fs.readFile(mixedSaveProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('MIXED HISTORY SNAPSHOT');

    releaseFirstSaveToServer();
    await expect.poll(() => firstSavePersisted).toBe(true);
    disk = JSON.parse(await fs.readFile(mixedSaveProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('FIRST NEW EDIT');
    await expect(field).toHaveValue('LATEST USER EDIT');
    await expect(page.locator('.project-title')).toContainText('autosave pending');

    const firstSaveResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-mixed-saves/captions')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON().captions?.[0]?.text === 'FIRST NEW EDIT');
    releaseFirstSaveAcknowledgement();
    expect((await firstSaveResponse).status()).toBe(200);
    await expect(field).toHaveValue('LATEST USER EDIT');
    await expect(page.locator('.project-title')).toContainText('autosave pending');
    disk = JSON.parse(await fs.readFile(mixedSaveProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('FIRST NEW EDIT');

    // A later normal save is the first operation authorized to persist LATEST USER EDIT.
    const latestSave = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-mixed-saves/captions')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON().captions?.[0]?.text === 'LATEST USER EDIT');
    await page.keyboard.press('Control+s');
    expect((await latestSave).status()).toBe(200);
    expect(saveBodies.at(-1)?.captions[0]?.text).toBe('LATEST USER EDIT');
    await expect(field).toHaveValue('LATEST USER EDIT');
    await expect(page.locator('.project-title')).toContainText('saved');
    disk = JSON.parse(await fs.readFile(mixedSaveProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('LATEST USER EDIT');
  } finally {
    releaseRestore();
    releaseFirstSaveToServer();
    releaseFirstSaveAcknowledgement();
  }
});

test('clean Ctrl+S cannot reverse a committed restore after leaving the editor session', async ({ page }) => {
  await page.addInitScript(() => {
    for (const key of ['sthang:first-run-dismissed:v1', 'sthang:project-guide-seen:v1', 'kcs:profile-migrated:v1']) localStorage.setItem(key, '1');
    (window as any).EventSource = undefined;
  });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({
    json: {
      provider: 'gemini', configured: true, keySource: 'none', maskedKey: null, model: 'synthetic', fallbackModel: '',
      secureStorageAvailable: false, secureStorageLabel: 'Test', environmentFallbackAvailable: false, canForgetSecureKey: false, updatedAt: null,
    },
  }));

  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  let restoreRequested = false;
  await page.route('**/api/projects/disk-history-navigation-clean/history/history-navigation-clean/restore', async (route) => {
    restoreRequested = true;
    await restoreGate;
    await route.continue();
  });

  const oldProjectSaveBodies: any[] = [];
  await page.route('**/api/projects/disk-history-navigation-clean/captions', async (route) => {
    oldProjectSaveBodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    const responseBody = await response.body();
    await route.fulfill({ response, body: responseBody });
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Navigation Clean Save Authority/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history-navigation-clean.mp4');
    const field = page.getByLabel('Caption 1 text', { exact: true });
    await expect(field).toHaveValue('BEFORE NAVIGATION RESTORE');

    await page.getByLabel('Open project tools', { exact: true }).click();
    await page.getByRole('menuitem', { name: /History/ }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);

    await field.focus();
    await page.keyboard.press('Control+s');
    expect(oldProjectSaveBodies).toHaveLength(0);

    // Leave the old editor session while its already-submitted restore is still held.
    await page.getByLabel('Back to projects', { exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByRole('button', { name: /Serialized Save Ack Race/ })).toBeVisible();
    await page.locator('.history-modal .modal-head button').evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('.history-modal')).toHaveCount(0);
    await page.getByRole('button', { name: /Serialized Save Ack Race/ }).click();
    await expect(page.locator('video')).toHaveAttribute('src', '/media/disk-history-serialized.mp4');
    const otherField = page.getByLabel('Caption 1 text', { exact: true });
    await otherField.fill('OTHER PROJECT BARRIER EDIT');
    const barrierSave = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-serialized/captions')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON().captions?.[0]?.text === 'OTHER PROJECT BARRIER EDIT');
    await page.keyboard.press('Control+s');

    const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/api/projects/disk-history-navigation-clean/history/history-navigation-clean/restore'));
    releaseRestore();
    expect((await restoreResponse).status()).toBe(200);
    expect((await barrierSave).status()).toBe(200);

    // Waiting for the later new-project save proves all earlier queued work settled.
    expect(oldProjectSaveBodies).toHaveLength(0);
    let disk = JSON.parse(await fs.readFile(navigationProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('NAVIGATION HISTORY SNAPSHOT');
    await expect(page.locator('.project-title strong')).toHaveText('Serialized Save Ack Race');
    await expect(otherField).toHaveValue('OTHER PROJECT BARRIER EDIT');

    await page.getByLabel('Back to projects', { exact: true }).click();
    await page.getByRole('button', { name: /Navigation Clean Save Authority/ }).click();
    const reopenedField = page.getByLabel('Caption 1 text', { exact: true });
    await expect(reopenedField).toHaveValue('NAVIGATION HISTORY SNAPSHOT');
    await expect(page.locator('.project-title')).toContainText('saved');
    disk = JSON.parse(await fs.readFile(navigationProjectFile, 'utf8')) as CaptionProject;
    expect(disk.captions[0].text).toBe('NAVIGATION HISTORY SNAPSHOT');
  } finally {
    releaseRestore();
  }
});
