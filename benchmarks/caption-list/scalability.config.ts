import { defineConfig } from '@playwright/test';
import original from './playwright.config';

export default defineConfig({ ...original, testMatch: 'scalability.bench.mts', timeout: 600_000 });
