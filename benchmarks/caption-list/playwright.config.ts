import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import original from '../../playwright.config';

export default defineConfig({ ...original,
  testDir: '.', testMatch: 'caption-list.bench.mts', timeout: 180_000,
  retries: 0, workers: 1,
  use: { ...original.use, trace: 'off', screenshot: 'off' },
  webServer: { ...original.webServer, cwd: fileURLToPath(new URL('../..', import.meta.url)), command: 'node --import tsx benchmarks/caption-list/owned-production-child.mts' },
});
