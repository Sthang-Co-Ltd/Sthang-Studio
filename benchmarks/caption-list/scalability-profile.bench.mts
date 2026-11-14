import fs from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import { prepareFixtures, cleanFixtures, installFixture } from '../../tests/browser/fixtures.mjs';
import { closeOwnedBrowserContext } from '../../tests/browser/owned-browser-routes.mjs';
import { requireHarnessConfig, safeFrontendUrl } from '../../tests/browser/harness-config.mjs';

// A diagnostic only. It deliberately keeps all 5,000 native caption fields in the
// real production App. Do not use these sampling costs as user-facing latency.
const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeAll(async () => {
  const harness = requireHarnessConfig();
  for (const pathname of ['/', '/studio-web-identity.json', '/api/health', '/__studio_browser_foreign/api/health']) {
    expect((await fetch(harness.webOrigin + pathname, { redirect: 'error' })).status).toBe(404);
  }
  const response = await fetch(safeFrontendUrl(harness.webOrigin + '/studio-web-identity.json', harness), { redirect: 'error' });
  expect(response.headers.get('X-Sthang-Studio-Activation')).toBe(harness.marker);
});

interface InputSample { captionId: string; secondRafMs: number; trusted: boolean }
interface Probe { inputs: InputSample[]; longTasks: number[]; openStart: number; openMs: number | null }
interface StyleSnapshot { rule: CSSStyleRule; selector: string }
declare global { interface Window { __scalabilityProfile: Probe; __scalabilityProfileStyles?: StyleSnapshot[] } }
interface Metric { name: string; value: number }
interface PerformanceMetrics { metrics: Metric[] }
interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }
interface CpuProfile { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }

const round = (value: number) => Math.round(value * 1000) / 1000;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1] ?? 0), maxMs: round(sorted.at(-1) ?? 0) };
};
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

function performanceDelta(before: PerformanceMetrics, after: PerformanceMetrics) {
  const previous = new Map(before.metrics.map(({ name, value }) => [name, value]));
  const current = new Map(after.metrics.map(({ name, value }) => [name, value]));
  const durations = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
  const counts = ['LayoutCount', 'RecalcStyleCount'];
  const delta: Record<string, number | null> = {};
  for (const name of [...durations, ...counts]) {
    const a = current.get(name), b = previous.get(name);
    delta[durations.includes(name) ? `${name}Ms` : name] = a === undefined || b === undefined ? null : round((a - b) * (durations.includes(name) ? 1000 : 1));
  }
  return delta;
}

function summarizeCpuProfile(profile: CpuProfile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const totals = new Map<number, { id: number; functionName: string; url: string; line: number; column: number; selfUs: number; inclusiveUs: number }>();
  const get = (id: number) => {
    let value = totals.get(id);
    if (!value) {
      const frame = nodes.get(id)?.callFrame;
      value = { id, functionName: frame?.functionName || '(anonymous)', url: frame?.url || '', line: (frame?.lineNumber ?? -1) + 1,
        column: (frame?.columnNumber ?? -1) + 1, selfUs: 0, inclusiveUs: 0 };
      totals.set(id, value);
    }
    return value;
  };
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  let sampledUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const us = Math.max(0, deltas[i] || 0);
    sampledUs += us;
    get(samples[i]).selfUs += us;
    const visited = new Set<number>();
    let id: number | undefined = samples[i];
    while (id !== undefined && !visited.has(id)) {
      visited.add(id);
      get(id).inclusiveUs += us;
      id = parents.get(id);
    }
  }
  const entries = [...totals.values()].map(({ selfUs, inclusiveUs, ...frame }) => ({
    ...frame, selfMs: round(selfUs / 1000), inclusiveMs: round(inclusiveUs / 1000),
  }));
  const top = (metric: 'selfMs' | 'inclusiveMs', items = entries) => [...items].sort((a, b) => b[metric] - a[metric]).slice(0, 15);
  const app = entries.filter((entry) => entry.url.includes('/assets/'));
  return { wallMs: round((profile.endTime - profile.startTime) / 1000), sampledMs: round(sampledUs / 1000),
    sampleCount: samples.length, nodeCount: profile.nodes.length, missingTimeDeltaCount: Math.max(0, samples.length - deltas.length),
    topSelf: top('selfMs'), topInclusive: top('inclusiveMs'), topAppSelf: top('selfMs', app), topAppInclusive: top('inclusiveMs', app) };
}

test('5000 mixed Khmer captions: six native inputs and a short scroll at 4x CPU', async ({ page, context, browser }, info) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const project = state.projects[0];
  const count = 5000;
  project.captions = Array.from({ length: count }, (_, i) => ({ id: `scale-${i}`, startMs: i * 2000, endMs: i * 2000 + 1800,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${i + 1} Khmer caption`, timingSource: 'manual' as const, approved: true }));
  project.transcript = null;
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'off' };
  const original = structuredClone(project.captions);
  await page.addInitScript(({ count }) => {
    const probe: Probe = window.__scalabilityProfile = { inputs: [], longTasks: [], openStart: 0, openMs: null };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    document.addEventListener('click', (event) => {
      if (!(event.target as Element).closest('button')?.textContent?.includes('Audit landscape') || probe.openStart) return;
      probe.openStart = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector(`[data-caption-id="scale-${count - 1}"] textarea`)) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { probe.openMs = performance.now() - probe.openStart; }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, true);
    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      const captionId = target.closest('.caption-row')?.getAttribute('data-caption-id');
      if (!captionId) return;
      const start = performance.now(), trusted = event.isTrusted;
      requestAnimationFrame(() => requestAnimationFrame(() => probe.inputs.push({ captionId, trusted, secondRafMs: performance.now() - start })));
    }, true);
  }, { count });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    await page.goto('/');
    await page.evaluate(async () => {
      const face = new FontFace('Plus Jakarta Sans', 'url("/__interface-font/plus-jakarta-sans.ttf")', { weight: '200 800' });
      document.fonts.add(await face.load()); await document.fonts.ready;
    });
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await page.waitForFunction(() => window.__scalabilityProfile.openMs !== null);
    await expect(page.locator('.caption-row')).toHaveCount(count);

    const profileInputPair = async (index: number, label: string) => {
      const field = page.getByRole('textbox', { name: `Caption ${index + 1} text`, exact: true });
      await field.focus();
      await field.press('ControlOrMeta+End');
      await settle(page);
      const beforeText = await field.inputValue();
      const offset = await page.evaluate(() => window.__scalabilityProfile.inputs.length);
      await cdp.send('Profiler.start');
      const before = await cdp.send('Performance.getMetrics');
      for (let i = 0; i < 2; i++) {
        await page.keyboard.type('x');
        await page.waitForFunction((expected) => window.__scalabilityProfile.inputs.length >= expected, offset + i + 1, { polling: 'raf' });
      }
      const after = await cdp.send('Performance.getMetrics');
      const { profile } = await cdp.send('Profiler.stop');
      const rawProfile = profile as CpuProfile;
      const profileFile = `cpu-${label}.cpuprofile`;
      await fs.writeFile(info.outputPath(profileFile), JSON.stringify(rawProfile), { flag: 'wx' });
      const inputs = await page.evaluate((start) => window.__scalabilityProfile.inputs.slice(start), offset);
      expect(inputs).toHaveLength(2);
      expect(inputs.every((sample) => sample.captionId === `scale-${index}` && sample.trusted)).toBe(true);
      await expect(field).toHaveValue(beforeText + 'xx');
      return { index, profileFile, inputs, inputToSecondRaf: stats(inputs.map((item) => item.secondRafMs)),
        work: performanceDelta(before, after), cpu: summarizeCpuProfile(rawProfile) };
    };
    const edits = [];
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      const measurement = await profileInputPair(index, `input-${index}`);
      expect(original[index].text + 'xx').toBe(await page.getByRole('textbox', { name: `Caption ${index + 1} text`, exact: true }).inputValue());
      edits.push(measurement);
    }

    await page.locator('.panel-head .panel-tool').first().focus();
    await page.locator('.caption-list').evaluate((element) => {
      element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) * .45);
    });
    await settle(page);
    await cdp.send('Profiler.start');
    const beforeScroll = await cdp.send('Performance.getMetrics');
    const scroll = await page.locator('.caption-list').evaluate(async (element) => {
      const gapsMs: number[] = []; let previous = 0;
      await new Promise<void>((resolve) => {
        let frames = 0;
        function frame(time: number) {
          if (previous) gapsMs.push(time - previous);
          previous = time;
          element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 80);
          if (++frames < 45) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      });
      return { gapsMs, endPx: element.scrollTop, maximumPx: element.scrollHeight - element.clientHeight };
    });
    const afterScroll = await cdp.send('Performance.getMetrics');
    const { profile } = await cdp.send('Profiler.stop');
    const scrollProfile = profile as CpuProfile;
    const scrollProfileFile = 'cpu-scroll.cpuprofile';
    await fs.writeFile(info.outputPath(scrollProfileFile), JSON.stringify(scrollProfile), { flag: 'wx' });

    // These are deliberately nonmatching CSS selectors applied to the already loaded
    // production stylesheet rules *in this page only*. The first intervention
    // isolates :has(.caption-list:focus-within); the second masks every remaining
    // :has selector, including rules inside @media and other grouping rules.
    // No production code, asset, or native row changes; a new page restores
    // the original CSS. A faster sample alone
    // cannot justify shipping either rule removal without behavior review.
    const styleExperiments = [];
    for (const stage of ['focus-within-has', 'remaining-has'] as const) {
      const disabled = await page.evaluate((which) => {
        if (!window.__scalabilityProfileStyles) {
          const collected: StyleSnapshot[] = [];
          const visit = (rules: CSSRuleList) => {
            for (const rule of Array.from(rules)) {
              if (rule instanceof CSSStyleRule && rule.selectorText.includes(':has(')) {
                collected.push({ rule, selector: rule.selectorText });
              } else if (rule instanceof CSSGroupingRule) visit(rule.cssRules);
            }
          };
          for (const sheet of Array.from(document.styleSheets)) {
            try { visit(sheet.cssRules); } catch { /* Third-party inaccessible sheets are not modified. */ }
          }
          window.__scalabilityProfileStyles = collected;
        }
        const matching = window.__scalabilityProfileStyles.filter(({ selector }) => which === 'focus-within-has'
          ? selector.includes('.caption-list:focus-within') : selector.includes(':has('));
        const changed: string[] = [];
        const failed: string[] = [];
        for (const { rule, selector } of matching) {
          if (rule.selectorText !== selector) continue;
          try { rule.selectorText = ':not(*)'; } catch { /* Report CSSOM mutation failures explicitly. */ }
          if (rule.selectorText === ':not(*)') changed.push(selector);
          else failed.push(selector);
        }
        return { stage: which, totalHasRules: window.__scalabilityProfileStyles.length, matched: matching.length,
          disabled: changed.length, failed: failed.length, selectors: changed };
      }, stage);
      expect(disabled.failed, `CSSOM rejected ${stage} probe`).toBe(0);
      expect(disabled.disabled, `No production selector disabled for ${stage}`).toBeGreaterThan(0);
      await settle(page);
      const measured = await profileInputPair(Math.floor(count / 2), `css-${stage}`);
      await expect(page.locator('.caption-row')).toHaveCount(count);
      styleExperiments.push({ ...disabled, measured });
    }
    const probe = await page.evaluate(() => ({ ...window.__scalabilityProfile,
      nodes: document.getElementsByTagName('*').length, rows: document.querySelectorAll('.caption-row').length }));
    expect(probe.rows).toBe(count);
    const buildIdentity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
    const results = { schemaVersion: 1, kind: 'diagnostic-only-native-field-production-profile', cpuThrottlingRate: 4,
      count, browser: browser.version(), viewport: info.project.use.viewport, buildIdentity,
      limits: ['CDP 1 ms sampled CPU profiles change runtime cost; sampled self/inclusive time is approximate and includes headless/test scheduling.',
        'Performance durations and counts cover the measured browser window; CPU profiler commands and test-driver synchronization can affect results.',
        'This is one synthetic 5,000-caption fixture with a short media file and mocked local API, not a real multi-hour export, long-video decode, device FPS promise, or a causal attribution.',
        'All native rows remain mounted. CSS experiments only mask selected :has rules through CSSOM after the baseline, may change scrolling/UI behavior and are not release candidates.',
        'The second CSS phase includes the first mask, so it measures incremental effects; stylesheet-rule edits and CPU sampling both perturb the browser.'],
      openMs: probe.openMs, domNodes: probe.nodes, rows: probe.rows, longTasks: stats(probe.longTasks),
      edits, styleExperiments, scroll: { profileFile: scrollProfileFile, frameGaps: stats(scroll.gapsMs), gapsOver33ms: scroll.gapsMs.filter((ms) => ms > 33.4).length,
        ...scroll, work: performanceDelta(beforeScroll, afterScroll), cpu: summarizeCpuProfile(scrollProfile) } };
    await fs.writeFile(info.outputPath('metrics.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ openMs: results.openMs, rows: results.rows, domNodes: results.domNodes,
      edits: edits.map(({ index, inputToSecondRaf, work, cpu }) => ({ index, inputToSecondRaf, work,
        cpu: { sampledMs: cpu.sampledMs, topAppSelf: cpu.topAppSelf.slice(0, 5) } })),
      styleExperiments: styleExperiments.map(({ stage, disabled, measured }) => ({ stage, disabled,
        inputToSecondRaf: measured.inputToSecondRaf, work: measured.work })),
      scroll: { frameGaps: results.scroll.frameGaps, gapsOver33ms: results.scroll.gapsOver33ms,
        work: results.scroll.work, cpu: { sampledMs: results.scroll.cpu.sampledMs, topAppSelf: results.scroll.cpu.topAppSelf.slice(0, 5) } } }));
  } finally {
    await cdp.send('Profiler.disable').catch(() => {});
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  }
});
