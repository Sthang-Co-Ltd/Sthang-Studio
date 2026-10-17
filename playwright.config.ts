import { defineConfig } from '@playwright/test';
import { requireHarnessConfig, verifyOwnedStateRoot } from './tests/browser/harness-config.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const harness = requireHarnessConfig();
if (process.env.STHANG_STUDIO_ACTIVATION_ID !== harness.marker) throw new Error('Browser frontend activation marker is missing.');
const webRoot = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', harness);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readyLine = new RegExp(`(?:^|\\n)STUDIO_BROWSER_WEB_READY \\{"marker":"${harness.marker}","pid":(?<sthang_browser_web_pid>[1-9][0-9]*),"root":${escapeRegex(JSON.stringify(webRoot))},"address":"127\\.0\\.0\\.1","port":${harness.webPort}\\}\\r?\\n`);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8000 },
  reporter: 'list',
  use: {
    baseURL: harness.webOrigin,
    browserName: 'chromium',
    serviceWorkers: 'block',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node --import tsx tests/browser/owned-vite-child.mts',
    wait: { stdout: readyLine },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
