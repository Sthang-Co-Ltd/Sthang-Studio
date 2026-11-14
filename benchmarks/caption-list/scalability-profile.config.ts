import { defineConfig } from '@playwright/test';
import original from './playwright.config';

// One isolated production profile after the full, unchanged scalability baseline.
export default defineConfig({ ...original, testMatch: 'scalability-profile.bench.mts', timeout: 600_000 });
