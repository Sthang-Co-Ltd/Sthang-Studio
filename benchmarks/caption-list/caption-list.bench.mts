import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { prepareFixtures, cleanFixtures, installFixture } from '../../tests/browser/fixtures.mjs';
import { requireHarnessConfig, safeFrontendUrl } from '../../tests/browser/harness-config.mjs';

test.beforeAll(prepareFixtures);
test.beforeAll(async () => {
  const harness = requireHarnessConfig();
  for (const pathname of ['/', '/studio-web-identity.json', '/api/health', '/__studio_browser_foreign/api/health']) {
    const response = await fetch(harness.webOrigin + pathname, { redirect: 'error' });
    expect(response.status, 'Unnamespaced/foreign requests must not reach the production frontend').toBe(404);
  }
  const response = await fetch(safeFrontendUrl(harness.webOrigin + '/studio-web-identity.json', harness), { redirect: 'error' });
  expect(response.headers.get('X-Sthang-Studio-Activation')).toBe(harness.marker);
});
test.afterAll(cleanFixtures);

type Probe = { openStart: number; openMs: number | null; inputs: number[]; longTasks: number[] };
declare global { interface Window { __captionBench: Probe } }

for (const count of [100, 500, 1500, 5000]) test(`${count} synthetic Khmer captions`, async ({ page, browser }, testInfo) => {
  const state = await installFixture(page);
  const project = state.projects[0];
  project.captions = Array.from({ length: count }, (_, index) => ({
    id: `bench-${index}`, startMs: index * 2000, endMs: index * 2000 + 1800,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${index + 1} Khmer caption`, timingSource: 'manual', approved: true,
  }));
  project.transcript = null;
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'off' };
  const originalCaptions = structuredClone(project.captions);
  await page.addInitScript(({ count }) => {
    const probe: Probe = window.__captionBench = { openStart: 0, openMs: null, inputs: [], longTasks: [] };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    document.addEventListener('click', (event) => {
      if (!(event.target as Element).closest('button')?.textContent?.includes('Audit landscape') || probe.openStart) return;
      probe.openStart = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector(`[data-caption-id="bench-${count - 1}"] textarea`)) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { probe.openMs = performance.now() - probe.openStart; }));
      });
      observer.observe(document.body, { subtree: true, childList: true });
    }, true);
    document.addEventListener('input', (event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.closest('.caption-row')) return;
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => probe.inputs.push(performance.now() - start)));
    }, true);
  }, { count });

  const samples = [];
  for (let repetition = 0; repetition < 5; repetition++) {
    await page.goto('/');
    await page.evaluate(async () => {
      const face = new FontFace('Plus Jakarta Sans', 'url("/__interface-font/plus-jakarta-sans.ttf")', { weight: '200 800', style: 'normal' });
      document.fonts.add(await face.load()); await document.fonts.ready;
    });
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await page.waitForFunction(() => window.__captionBench.openMs !== null);
    await expect(page.locator('.caption-row')).toHaveCount(count);
    const textarea = page.getByRole('textbox', { name: 'Caption 1 text', exact: true });
    await textarea.click();
    await textarea.press('ControlOrMeta+End');
    for (let key = 0; key < 10; key++) {
      await page.keyboard.type('x');
      await page.waitForFunction((expected) => window.__captionBench.inputs.length === expected, key + 1, { polling: 'raf' });
    }
    await expect(textarea).toHaveValue(project.captions[0].text + 'x'.repeat(10));
    const scroll = await page.locator('.caption-list').evaluate(async (element) => {
      element.scrollTop = 0;
      const gaps: number[] = []; let previous = 0;
      await new Promise<void>((resolve) => {
        function step(time: number) {
          if (previous) gaps.push(time - previous);
          previous = time;
          element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 160);
          if (gaps.length < 120) requestAnimationFrame(step); else resolve();
        }
        requestAnimationFrame(step);
      });
      return { gapsMs: gaps, distancePx: element.scrollTop, maximumPx: element.scrollHeight - element.clientHeight };
    });
    const sample = await page.evaluate(() => ({ ...window.__captionBench, domNodes: document.getElementsByTagName('*').length,
      rows: document.querySelectorAll('.caption-row').length, longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') }));
    expect(sample.inputs).toHaveLength(10);
    expect(scroll.distancePx).toBeGreaterThan(0);
    samples.push({ repetition, ...sample, scroll });
    // New document on each repetition; fixture writes stay in synthetic memory.
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    project.captions = structuredClone(originalCaptions);
  }
  const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
  const mutations = [...new Set(state.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path}`))];
  const metrics = { count, repetitions: 5, browser: browser.version(), viewport: testInfo.project.use.viewport,
    buildIdentity: identity, syntheticRequests: mutations, samples };
  await fs.writeFile(testInfo.outputPath('metrics.json'), JSON.stringify(metrics, null, 2), { flag: 'wx' });
  await testInfo.attach('caption-list-metrics', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(mutations.filter((request) => !['PUT /api/projects/landscape/captions', 'POST /api/video-export/landscape/preview'].includes(request)),
    'Only synthetic caption saves and mock preview reads are permitted').toEqual([]);
});
