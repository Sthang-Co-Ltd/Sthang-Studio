import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function findChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (!localAppData) return undefined;
  const playwrightDir = path.join(localAppData, 'ms-playwright');
  const candidates = [
    path.join(playwrightDir, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(playwrightDir, 'chromium-1208', 'chrome-win64', 'chrome.exe'),
    path.join(playwrightDir, 'chromium_headless_shell-1223', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join(playwrightDir, 'chromium_headless_shell-1208', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = findChromiumExecutable();

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1000 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort',
    cwd: './apps/web',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
