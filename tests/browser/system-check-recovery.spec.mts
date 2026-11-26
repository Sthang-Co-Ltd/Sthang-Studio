import { test as base, expect, type Page } from '@playwright/test';
import type { SystemDoctorReport } from '@kcs/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { cleanFixtures, installFixture, prepareFixtures } from './fixtures.mjs';
import { closeOwnedBrowserContext } from './owned-browser-routes.mjs';

const test = base.extend({
  context: async ({ context }, use) => { await use(context); await closeOwnedBrowserContext(context); },
});
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function report(detail: string, generatedAt = '2026-01-01T00:00:00.000Z'): SystemDoctorReport {
  return { generatedAt, engineVersion: 'synthetic', overall: 'ok',
    checks: [{ id: 'synthetic-check', label: 'Synthetic media tools', status: 'ok', detail }],
    environment: { platform: 'Synthetic Windows', node: 'test', appRoot: 'Synthetic app', apiPort: 1, webOrigin: 'http://127.0.0.1' } };
}
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const run = (page: Page) => settings(page).locator('.doctor-intro button');
async function showSystemCheck(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('button', { name: 'System check', exact: true }).click();
  await expect(settings(page).locator('#system-check-status')).toBeAttached();
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('System check shows platform setup and retry guidance from the doctor report', async ({ page }) => {
  // Execute the service against synthetic probe and storage dependencies so both
  // platform branches are exercised without inspecting or modifying real state.
  const source = readFileSync(new URL('../../apps/server/src/services/doctor.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const dependencies: Record<string, unknown> = {
    'node:fs/promises': { mkdir: async () => {}, writeFile: async () => {}, rm: async () => {} },
    'node:path': path,
    '../config.js': { rootDir: 'synthetic', config: {
      ffmpegPath: 'synthetic', ffprobePath: 'synthetic', localTimingPython: 'synthetic',
      uploadDir: 'synthetic', cacheDir: 'synthetic', dataFile: 'synthetic', historyDir: 'synthetic',
      proposalDir: 'synthetic', jobsFile: 'synthetic', port: 1, webOrigin: 'http://127.0.0.1',
    } },
    './media.js': { runCommand: async () => { throw new Error('Synthetic runtime unavailable'); } },
    './llm-settings.js': { resolveGeminiSettings: async () => ({ configured: false, secureStorageAvailable: true, secureStorageLabel: 'Synthetic storage' }) },
    './caption-preview.js': {},
    './store.js': { store: { storageStatus: async () => ({ unreadableProjectCount: 0, missingProjectCount: 0, duplicateProjectCount: 0, loadedProjectCount: 0, readableProjectCount: 0 }) } },
  };
  let doctorReport: SystemDoctorReport;
  await page.route('**/api/system/doctor', (route) => route.fulfill({ json: doctorReport }));
  await page.goto('/');
  await showSystemCheck(page);
  for (const [platform, copy] of [
    ['win32', 'Run Install Sthang Studio.bat again from your download, or run setup-local-timing-windows.bat in the Studio folder. Then run the System check again.'],
    ['darwin', 'In the Studio folder, run bash ./setup-local-timing-macos.sh. Then run the System check again.'],
  ]) {
    const service = {} as { runSystemDoctor(): Promise<SystemDoctorReport> };
    runInNewContext(compiled, {
      exports: service,
      require(id: string) {
        if (!(id in dependencies)) throw new Error('Unmocked doctor dependency: ' + id);
        return dependencies[id];
      },
      process: { platform, arch: 'synthetic', pid: 1, version: 'synthetic' },
    });
    doctorReport = await service.runSystemDoctor();
    expect(doctorReport.checks.find((item) => item.id === 'python')?.fix).toBe(copy);
    await run(page).click();
    await expect(settings(page).getByText(copy, { exact: true })).toBeVisible();
  }
});

for (const width of [1440, 390]) test(`initial system checks announce progress, guard repeated activation and retain focus at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const pending = deferred(); let reads = 0;
  await page.route('**/api/system/doctor', async (route) => {
    reads++; await pending.promise;
    return route.fulfill({ json: report('Initial synthetic report') });
  });
  try {
    await page.goto('/'); await showSystemCheck(page);
    const dialog = settings(page); const button = run(page);
    await expect(dialog.getByText('No report yet', { exact: true })).toBeVisible();
    await button.focus();
    await button.evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
    await expect.poll(() => reads).toBe(1);
    await expect(button).toHaveText('Running checks…');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeFocused();
    await expect(dialog.locator('#system-check-status')).toHaveText('Checking system…');
    await expect(dialog.locator('#system-check-status')).toHaveAttribute('role', 'status');
    await expect(dialog.locator('#system-check-status')).toHaveAttribute('aria-atomic', 'true');
    await expect(button).toHaveAttribute('aria-describedby', 'system-check-status');
    await expect(dialog.getByText('No report yet', { exact: true })).toHaveCount(0);
    await button.press('Enter'); expect(reads).toBe(1);
    if (width === 390) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`system-check-pending-${width}.png`) });
    pending.release();
    await expect(dialog.locator('#system-check-status')).toHaveText('System check complete.');
    await expect(dialog.locator('.doctor-summary strong')).toHaveText('System checks passed');
    await expect(dialog.locator('.doctor-checks')).toContainText('Initial synthetic report');
    await expect(button).toHaveText('Run checks');
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeFocused(); expect(reads).toBe(1);
  } finally { pending.release(); }
});

for (const width of [1440, 390]) test(`failed refresh keeps a clearly last-loaded report and offers a local focused retry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const refresh = deferred(); const retry = deferred(); let reads = 0;
  await page.route('**/api/system/doctor', async (route) => {
    const read = ++reads;
    if (read === 2) { await refresh.promise; return route.fulfill({ status: 503, json: { error: 'Synthetic system check unavailable' } }); }
    if (read === 3) await retry.promise;
    return route.fulfill({ json: report(read === 1 ? 'Original synthetic report' : 'Retry synthetic report', read === 1 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z') });
  });
  try {
    await page.goto('/'); await showSystemCheck(page); await run(page).click();
    const dialog = settings(page); const button = run(page);
    await expect(dialog.locator('.doctor-summary strong')).toHaveText('System checks passed');
    await button.focus(); await button.press('Enter');
    await expect(dialog.locator('#system-check-status')).toContainText('The last loaded report remains below.');
    await expect(dialog.locator('.doctor-summary strong')).toHaveText('Last loaded report · System checks passed');
    await expect(dialog.locator('.doctor-checks')).toContainText('Original synthetic report');
    refresh.release();
    await expect(dialog.locator('#system-check-error')).toHaveAttribute('role', 'alert');
    await expect(dialog.locator('#system-check-error')).toContainText('Synthetic system check unavailable');
    await expect(dialog.locator('#system-check-error')).toContainText('The last loaded report is shown.');
    await expect(button).toHaveText('Retry system check');
    await expect(button).toHaveAttribute('aria-describedby', 'system-check-status system-check-error');
    await expect(button).toBeFocused();
    await expect(dialog.locator('.doctor-summary strong')).toHaveText('Last loaded report · System checks passed');
    await button.scrollIntoViewIfNeeded();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`system-check-failure-${width}.png`) });
    await button.press('Enter');
    await expect.poll(() => reads).toBe(3);
    await expect(dialog.locator('#system-check-error')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    const newerFocus = dialog.getByRole('button', { name: 'System check', exact: true });
    await newerFocus.focus(); retry.release();
    await expect(dialog.locator('#system-check-status')).toHaveText('System check complete.');
    await expect(dialog.locator('.doctor-summary strong')).toHaveText('System checks passed');
    await expect(dialog.locator('.doctor-checks')).toContainText('Retry synthetic report');
    await expect(newerFocus).toBeFocused(); expect(reads).toBe(3);
  } finally { refresh.release(); retry.release(); }
});

test('closing and reopening Settings retains the pending system check and never reopens itself on completion', async ({ page }) => {
  const pending = deferred(); let reads = 0;
  await page.route('**/api/system/doctor', async (route) => {
    reads++; await pending.promise; return route.fulfill({ json: report('Report completed while closed') });
  });
  try {
    await page.goto('/'); await showSystemCheck(page); await run(page).click();
    await expect.poll(() => reads).toBe(1);
    await settings(page).getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(settings(page)).toBeHidden();
    await showSystemCheck(page);
    await expect(run(page)).toHaveText('Running checks…');
    await expect(run(page)).toHaveAttribute('aria-disabled', 'true'); expect(reads).toBe(1);
    await settings(page).getByRole('button', { name: 'Close settings', exact: true }).click();
    const response = page.waitForResponse('**/api/system/doctor');
    pending.release(); await response; await rendered(page);
    await expect(settings(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await showSystemCheck(page);
    await expect(settings(page).locator('.doctor-checks')).toContainText('Report completed while closed');
    await expect(run(page)).toHaveText('Run checks'); expect(reads).toBe(1);
  } finally { pending.release(); }
});

for (const outcome of ['success', 'failure'] as const) test(`an AI settings save invalidates a delayed system check ${outcome} without republishing its report or error`, async ({ page }) => {
  const obsolete = deferred(); let reads = 0;
  const llm = { provider: 'gemini', configured: true, keySource: 'secure-store', maskedKey: null, model: 'synthetic-original', fallbackModel: '', secureStorageAvailable: true, secureStorageLabel: 'Synthetic storage', environmentFallbackAvailable: false, canForgetSecureKey: true, updatedAt: null };
  await page.route('**/api/system/llm-settings', (route) => route.fulfill({ json: route.request().method() === 'PUT' ? { ...llm, model: 'synthetic-updated' } : llm }));
  await page.route('**/api/system/llm-settings/test', (route) => route.fulfill({ json: { ok: true, level: 'success', provider: 'gemini', model: 'synthetic-updated', latencyMs: 1, message: 'Synthetic connection checked.' } }));
  await page.route('**/api/system/doctor', async (route) => {
    const read = ++reads;
    if (read === 2) {
      await obsolete.promise;
      return route.fulfill(outcome === 'failure' ? { status: 503, json: { error: 'Obsolete synthetic check failure' } } : { json: report('Obsolete synthetic report') });
    }
    return route.fulfill({ json: report(read === 1 ? 'Report before AI settings change' : 'Report after AI settings change') });
  });
  try {
    await page.goto('/'); await showSystemCheck(page); await run(page).click();
    const dialog = settings(page);
    await expect(dialog.locator('.doctor-checks')).toContainText('Report before AI settings change');
    await run(page).click(); await expect.poll(() => reads).toBe(2);
    await dialog.getByRole('button', { name: 'AI connection', exact: true }).click();
    await dialog.getByLabel('Primary model', { exact: true }).fill('synthetic-updated');
    await dialog.getByRole('button', { name: 'Test & save', exact: true }).click();
    await expect(dialog.getByText('AI settings saved securely on this computer. No restart needed.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'System check', exact: true }).click();
    await expect(dialog.getByText('No report yet', { exact: true })).toBeVisible();
    await expect(dialog.locator('.doctor-summary, #system-check-error')).toHaveCount(0);
    const response = page.waitForResponse('**/api/system/doctor');
    obsolete.release(); await response; await rendered(page);
    await expect(dialog.locator('.doctor-summary, #system-check-error')).toHaveCount(0);
    await expect(page.getByText('Obsolete synthetic check failure', { exact: false })).toHaveCount(0);
    await expect(run(page)).not.toHaveAttribute('aria-disabled', 'true');
    await run(page).click();
    await expect(dialog.locator('.doctor-checks')).toContainText('Report after AI settings change');
    await expect(dialog.locator('#system-check-status')).toHaveText('System check complete.'); expect(reads).toBe(3);
  } finally { obsolete.release(); }
});
