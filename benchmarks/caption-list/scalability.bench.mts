import fs from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import { prepareFixtures, cleanFixtures, installFixture } from '../../tests/browser/fixtures.mjs';
import { closeOwnedBrowserContext } from '../../tests/browser/owned-browser-routes.mjs';
import { requireHarnessConfig, safeFrontendUrl } from '../../tests/browser/harness-config.mjs';

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

type Probe = { inputs: number[]; longTasks: number[]; openStart: number; openMs: number | null };
declare global { interface Window { __scalabilityBench: Probe } }
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const summarize = (values: number[]) => { const sorted = [...values].sort((a,b)=>a-b); return { count: values.length, medianMs: sorted[Math.floor(sorted.length/2)] ?? null, p95Ms: sorted[Math.ceil(sorted.length*.95)-1] ?? null, maxMs: sorted.at(-1) ?? null }; };
const difference = (before: { metrics: { name: string; value: number }[] }, after: { metrics: { name: string; value: number }[] }) => Object.fromEntries(after.metrics.filter(m => /^(TaskDuration|ScriptDuration|LayoutDuration|RecalcStyleDuration|LayoutCount|RecalcStyleCount)$/.test(m.name)).map(m => [m.name, m.value-(before.metrics.find(x=>x.name===m.name)?.value ?? 0)]));

for (const cpu of [1, 4]) for (const count of [100, 500, 1500, 5000]) test(`${count} captions at ${cpu}x CPU`, async ({ page, context, browser }, info) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const project = state.projects[0];
  project.captions = Array.from({ length: count }, (_, i) => ({ id: `scale-${i}`, startMs: i * 2000, endMs: i * 2000 + 1800,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${i + 1} Khmer caption`, timingSource: 'manual', approved: true }));
  project.transcript = null;
  project.captionAppearance = { ...project.captionAppearance!, highlightMode: 'off' };
  const original = structuredClone(project.captions);
  await page.addInitScript(({ count }) => {
    const probe: Probe = window.__scalabilityBench = { inputs: [], longTasks: [], openStart: 0, openMs: null };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); }).observe({ type: 'longtask' });
    document.addEventListener('click', event => {
      if (!(event.target as Element).closest('button')?.textContent?.includes('Audit landscape') || probe.openStart) return;
      probe.openStart = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector(`[data-caption-id="scale-${count-1}"] textarea`)) return;
        observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { probe.openMs = performance.now()-probe.openStart; }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, true);
    document.addEventListener('input', event => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.closest('.caption-row')) return;
      const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => probe.inputs.push(performance.now()-start)));
    }, true);
  }, { count });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable'); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const samples = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    await page.goto('/');
    await page.evaluate(async () => { const face = new FontFace('Plus Jakarta Sans', 'url("/__interface-font/plus-jakarta-sans.ttf")', { weight: '200 800' }); document.fonts.add(await face.load()); await document.fonts.ready; });
    await page.getByRole('button', { name: /Audit landscape/ }).click();
    await page.waitForFunction(() => window.__scalabilityBench.openMs !== null);
    await expect(page.locator('.caption-row')).toHaveCount(count);
    const edits = [];
    for (const index of [0, Math.floor(count/2), count-1]) {
      const field = page.getByRole('textbox', { name: `Caption ${index+1} text`, exact: true });
      const jumpStart = Date.now(); await field.focus(); await settle(page);
      const jumpMs = Date.now()-jumpStart;
      await field.press('ControlOrMeta+End');
      const offset = await page.evaluate(() => window.__scalabilityBench.inputs.length);
      const before = await cdp.send('Performance.getMetrics');
      for (let i = 0; i < 4; i++) { await page.keyboard.type('x'); await page.waitForFunction(n => window.__scalabilityBench.inputs.length === n, offset+i+1); }
      const after = await cdp.send('Performance.getMetrics');
      await expect(field).toHaveValue(original[index].text+'xxxx');
      edits.push({ index, jumpMs, work: difference(before, after) });
    }
    // Sustained entry: native keyboard events, without waiting for a rendering
    // opportunity between keys. Each event still has its own two-frame sample.
    const rapidOffset = await page.evaluate(() => window.__scalabilityBench.inputs.length);
    await page.keyboard.type('abcdefgh');
    await page.waitForFunction(n => window.__scalabilityBench.inputs.length === n, rapidOffset+8);
    await expect(page.getByRole('textbox', { name: `Caption ${count} text`, exact: true })).toHaveValue(original[count-1].text+'xxxxabcdefgh');
    await page.locator('.panel-head .panel-tool').first().focus();
    const scrollBefore = await cdp.send('Performance.getMetrics');
    const scroll = await page.locator('.caption-list').evaluate(async element => {
      element.scrollTop = Math.max(0, (element.scrollHeight-element.clientHeight)*.45);
      const gaps: number[] = []; let previous = 0;
      await new Promise<void>(resolve => { let frames = 0; function step(time: number) {
        if (previous) gaps.push(time-previous); previous = time;
        element.scrollTop = Math.min(element.scrollHeight-element.clientHeight, element.scrollTop+80);
        if (++frames < 90) requestAnimationFrame(step); else resolve();
      } requestAnimationFrame(step); });
      return { gapsMs: gaps, endPx: element.scrollTop, maximumPx: element.scrollHeight-element.clientHeight };
    });
    const scrollAfter = await cdp.send('Performance.getMetrics');
    // Actual short synthetic video playback exercises the whole long list's
    // clock subscription. It does not claim to decode a three-hour source.
    await page.locator('video').evaluate(async (media: HTMLVideoElement) => { media.currentTime=0; media.muted=true; await media.play(); });
    const playbackBefore = await cdp.send('Performance.getMetrics');
    const playback = await page.evaluate(async () => { const gaps: number[] = []; let last = 0, start = 0; await new Promise<void>(resolve => { function frame(time: number) { start ||= time; if(last) gaps.push(time-last); last=time; if(time-start < 2000) requestAnimationFrame(frame); else resolve(); } requestAnimationFrame(frame); }); return gaps; });
    await page.locator('video').evaluate((media: HTMLVideoElement) => media.pause());
    const playbackAfter = await cdp.send('Performance.getMetrics');
    const probe = await page.evaluate(() => ({ ...window.__scalabilityBench, nodes: document.getElementsByTagName('*').length, rows: document.querySelectorAll('.caption-row').length,
      recoveryBytes: Object.keys(localStorage).filter(k=>k.startsWith('sthang-studio:unfinished-edits:')).reduce((sum,k)=>sum+2*(k.length+(localStorage.getItem(k)?.length||0)),0), recoveryUnavailable: document.body.textContent?.includes('A recovery copy could not be kept') || false }));
    samples.push({ repetition, ...probe, edits, scroll: { ...scroll, work: difference(scrollBefore,scrollAfter) }, playback: { gapsMs: playback, work: difference(playbackBefore,playbackAfter) }, heap: playbackAfter.metrics.filter(m=>/JSHeap|Nodes|LayoutObjects/.test(m.name)) });
    await page.goto('/'); await page.evaluate(()=>localStorage.clear()); project.captions=structuredClone(original);
  }
  const buildIdentity = await page.evaluate(async ()=>(await fetch('/studio-web-identity.json')).json());
  const summary = { count, cpu, input: summarize(samples.flatMap(s=>s.inputs.slice(0,12))), rapidInput: summarize(samples.flatMap(s=>s.inputs.slice(12))), open: summarize(samples.map(s=>s.openMs!)), scroll: summarize(samples.flatMap(s=>s.scroll.gapsMs)), playback: summarize(samples.flatMap(s=>s.playback.gapsMs)) };
  const metrics = { summary, browser: browser.version(), viewport: info.project.use.viewport, buildIdentity, samples,
    limits: ['Three opens,36 separate input events and24 sustained inputs per size/CPU rate. Two requestAnimationFrame callbacks approximate a rendering opportunity, not physical presentation.', 'Synthetic Khmer/mixed captions, mocked local API and a four-second video; no real provider, native render throughput or long-video decode measurement.', 'CDP CPU throttling is a browser stress condition, not a different hardware measurement. Headless frame gaps include scheduling and the scroll driver.', 'Every native caption field remains in the DOM. Heap metrics are samples without forced collection and do not establish retained heap or a leak.'] };
  await fs.writeFile(info.outputPath('metrics.json'), JSON.stringify(metrics,null,2)+'\n', { flag:'wx' });
  console.log(JSON.stringify(summary));
});
