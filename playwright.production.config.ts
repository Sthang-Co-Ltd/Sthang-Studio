import { defineConfig } from '@playwright/test';
import original from './playwright.config';

export default defineConfig({ ...original, webServer: {
  ...(original.webServer as object),
  command: 'node --import tsx tests/browser/owned-production-child.mts',
} });
