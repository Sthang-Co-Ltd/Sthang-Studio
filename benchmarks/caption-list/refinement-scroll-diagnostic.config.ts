import { defineConfig } from '@playwright/test';
import original from './playwright.config';

// Separate evidence from the frozen production scalability comparisons.
export default defineConfig({ ...original, testMatch: 'refinement-scroll-diagnostic.bench.mts', timeout: 600_000 });
