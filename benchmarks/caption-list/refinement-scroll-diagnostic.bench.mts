import fs from 'node:fs/promises';
import { performance as nodePerformance } from 'node:perf_hooks';
import { test as base, expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import type { CaptionSegment } from '@kcs/shared';
import { cleanFixtures, installFixture, prepareFixtures } from '../../tests/browser/fixtures.mjs';
import { closeOwnedBrowserContext } from '../../tests/browser/owned-browser-routes.mjs';
import { requireHarnessConfig, safeFrontendUrl } from '../../tests/browser/harness-config.mjs';

/** Diagnostic only. This test changes no product source, renderer or CSS, and keeps
 * every native input mounted. Profiles perturb timing and are not a new baseline. */
const COUNT = 5000;
const CPU_THROTTLE = 4;
const REPEATS = 2;
const SCROLL_FRAMES = 36;
const EDIT_INDEX = 2250;

type LongTask = { startMs: number; durationMs: number };
type SaveEvent = { kind: 'request' | 'response' | 'error'; atMs: number; status?: number };
interface PageProbe {
  openStartMs: number | null;
  openDoneMs: number | null;
  longTasks: LongTask[];
  droppedLongTasks: number;
  saveEvents: SaveEvent[];
  nativeFields?: HTMLTextAreaElement[];
}
declare global { interface Window { __refinementScrollDiagnostic: PageProbe } }

type MetricResponse = { metrics: { name: string; value: number }[] };
type CpuNode = { id: number; callFrame: { functionName: string; url: string }; children?: number[] };
type CpuProfile = { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number };
type TimedPhase = { startMs: number; endMs: number; gapsMs?: number[] };
type ScrollPhase = TimedPhase & {
  firstRafDelayMs: number;
  frameTimesMs: number[];
  gapsMs: number[];
  scrollStartPx: number;
  scrollEndPx: number;
  maximumPx: number;
};
type CaptionWrite = {
  captions: CaptionSegment[];
  expectedMedia: { filename: string; size: number };
  expectedUpdatedAt: string;
  source?: string;
};
type SaveControl = {
  gate: ReturnType<typeof deferred>;
  submitted: ReturnType<typeof deferred>;
  receivedAtNodeMs: number | null;
  releasedAtNodeMs: number | null;
  fulfilledAtNodeMs: number | null;
  bytes: number;
  error: string | null;
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const round = (value: number) => Math.round(value * 1000) / 1000;
const stats = (values: number[]) => {
  const ordered = [...values].sort((left, right) => left - right);
  return { count: values.length, medianMs: ordered[Math.floor(ordered.length / 2)] ?? null,
    p95Ms: ordered[Math.ceil(ordered.length * .95) - 1] ?? null, maxMs: ordered.at(-1) ?? null };
};
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

function metricDifference(before: MetricResponse, after: MetricResponse) {
  const old = new Map(before.metrics.map(({ name, value }) => [name, value]));
  return Object.fromEntries(after.metrics
    .filter(({ name }) => /^(TaskDuration|ScriptDuration|LayoutDuration|RecalcStyleDuration|LayoutCount|RecalcStyleCount)$/.test(name))
    .map(({ name, value }) => [name.endsWith('Duration') ? `${name}Ms` : name,
      round((value - (old.get(name) ?? 0)) * (name.endsWith('Duration') ? 1000 : 1))]));
}

function summarizeCpu(profile: CpuProfile) {
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const weight = new Map<number, { selfUs: number; inclusiveUs: number }>();
  const get = (id: number) => {
    let item = weight.get(id);
    if (!item) { item = { selfUs: 0, inclusiveUs: 0 }; weight.set(id, item); }
    return item;
  };
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index++) {
    const delta = Math.max(0, deltas[index] ?? 0);
    const leaf = samples[index];
    get(leaf).selfUs += delta;
    let cursor: number | undefined = leaf;
    const visited = new Set<number>();
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      get(cursor).inclusiveUs += delta;
      cursor = parent.get(cursor);
    }
  }
  const entries = [...weight].map(([id, durations]) => ({
    name: nodeById.get(id)?.callFrame.functionName || '(anonymous)',
    source: nodeById.get(id)?.callFrame.url.includes('/assets/') ? 'production-js' : 'browser-or-runtime',
    selfMs: round(durations.selfUs / 1000), inclusiveMs: round(durations.inclusiveUs / 1000),
  }));
  const top = (name: 'selfMs' | 'inclusiveMs', elements: typeof entries) =>
    [...elements].sort((a, b) => b[name] - a[name]).slice(0, 12);
  return { wallMs: round((profile.endTime - profile.startTime) / 1000),
    sampledMs: round(deltas.reduce((sum, delta) => sum + Math.max(0, delta), 0) / 1000),
    sampleCount: samples.length, missingTimeDeltas: Math.max(0, samples.length - deltas.length),
    topSelf: top('selfMs', entries), topInclusive: top('inclusiveMs', entries),
    topAppSelf: top('selfMs', entries.filter((entry) => entry.source === 'production-js')) };
}

async function timedProfile<T extends TimedPhase>(
  page: Page, cdp: CDPSession, info: TestInfo, name: string, action: () => Promise<T>,
) {
  const before = await cdp.send('Performance.getMetrics') as MetricResponse;
  await cdp.send('Profiler.start');
  let measured!: T;
  let profile!: CpuProfile;
  try { measured = await action(); }
  finally { profile = (await cdp.send('Profiler.stop')).profile as CpuProfile; }
  const after = await cdp.send('Performance.getMetrics') as MetricResponse;
  await fs.writeFile(info.outputPath(`${name}.cpuprofile`), JSON.stringify(profile), { flag: 'wx' });
  // The browser may deliver the longtask entry on a subsequent task/frame.
  await settle(page);
  const longTasks = await page.evaluate(({ from, to }) => {
    const probe = window.__refinementScrollDiagnostic;
    return probe.longTasks.filter((task) => task.startMs < to && task.startMs + task.durationMs >= from);
  }, { from: measured.startMs, to: measured.endMs });
  return { ...measured, frameGaps: measured.gapsMs ? stats(measured.gapsMs) : null,
    work: metricDifference(before, after), cpu: summarizeCpu(profile), profileFile: `${name}.cpuprofile`,
    longTasks, longTaskSummary: stats(longTasks.map(({ durationMs }) => durationMs)) };
}

async function resetScroll(page: Page) {
  await page.locator('.caption-list').evaluate((element) => { element.scrollTop = 0; });
  await settle(page);
}
async function scrollAtFortyFivePercent(page: Page): Promise<ScrollPhase> {
  return page.locator('.caption-list').evaluate(async (element, frames) => {
    const maximumPx = element.scrollHeight - element.clientHeight;
    const startMs = performance.now();
    element.scrollTop = maximumPx * .45;
    const scrollStartPx = element.scrollTop;
    const frameTimesMs: number[] = [];
    await new Promise<void>((resolve) => {
      const step = (atMs: number) => {
        frameTimesMs.push(atMs);
        element.scrollTop = Math.min(maximumPx, element.scrollTop + 80);
        if (frameTimesMs.length < frames) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return { startMs, endMs: performance.now(), firstRafDelayMs: frameTimesMs[0] - startMs,
      frameTimesMs, gapsMs: frameTimesMs.slice(1).map((at, index) => at - frameTimesMs[index]),
      scrollStartPx, scrollEndPx: element.scrollTop, maximumPx };
  }, SCROLL_FRAMES);
}

const test = base.extend({ context: async ({ context }, use) => {
  try { await use(context); } finally { await closeOwnedBrowserContext(context); }
} });
test.beforeAll(prepareFixtures);
test.afterAll(cleanFixtures);
test.beforeAll(async () => {
  const harness = requireHarnessConfig();
  for (const path of ['/', '/studio-web-identity.json', '/api/health']) {
    expect((await fetch(harness.webOrigin + path, { redirect: 'error' })).status).toBe(404);
  }
  const identity = await fetch(safeFrontendUrl(`${harness.webOrigin}/studio-web-identity.json`, harness), { redirect: 'error' });
  expect(identity.headers.get('X-Sthang-Studio-Activation')).toBe(harness.marker);
});

test('5000 captions at 4x: isolate cold jump, warm scroll and pending versus acknowledged save', async ({ page, context, browser }, info) => {
  const state = await installFixture(page);
  state.profile.preferences.autosaveDelayMs = 60_000;
  const original = structuredClone(state.projects[0]);
  original.transcript = null;
  original.captionAppearance = { ...original.captionAppearance!, highlightMode: 'off' };
  original.captions = Array.from({ length: COUNT }, (_, index) => ({
    id: `scale-${index}`, startMs: index * 2000, endMs: index * 2000 + 1800,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${index + 1} Khmer caption`,
    timingSource: 'manual' as const, approved: true,
  }));
  state.projects[0] = structuredClone(original);
  const controls: Array<ReturnType<typeof deferred>> = [];
  let holding: SaveControl | null = null;
  let unexpectedWrites = 0;
  let saveRevision = 0;
  await page.route('**/api/projects/landscape/captions', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const control = holding;
    if (!control) { unexpectedWrites++; return route.fulfill({ status: 409, json: { error: 'Unexpected diagnostic write' } }); }
    holding = null;
    control.receivedAtNodeMs = nodePerformance.now();
    const body = route.request().postDataJSON() as CaptionWrite;
    control.bytes = Buffer.byteLength(route.request().postData() ?? '', 'utf8');
    const current = state.projects[0];
    if (body.captions.length !== COUNT || body.expectedUpdatedAt !== current.updatedAt ||
      body.expectedMedia.filename !== current.media.filename || body.expectedMedia.size !== current.media.size ||
      body.captions[EDIT_INDEX].id !== `scale-${EDIT_INDEX}` || !body.captions[EDIT_INDEX].text.endsWith(' diagnostic')) {
      control.error = 'Submitted snapshot/source/revision did not match the active 5000-caption edit';
    }
    control.submitted.release();
    await control.gate.promise;
    if (control.error) return route.fulfill({ status: 409, json: { error: control.error } });
    const saved = { ...structuredClone(current), captions: structuredClone(body.captions),
      updatedAt: new Date(Date.UTC(2026, 10, 15, 0, 0, ++saveRevision)).toISOString() };
    state.projects[0] = saved;
    await route.fulfill({ json: { project: saved, correctionsCreated: 0 } });
    control.fulfilledAtNodeMs = nodePerformance.now();
  });

  await page.addInitScript(({ count }) => {
    const probe: PageProbe = { openStartMs: null, openDoneMs: null, longTasks: [], droppedLongTasks: 0, saveEvents: [] };
    window.__refinementScrollDiagnostic = probe;
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (probe.longTasks.length < 2048) probe.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          else probe.droppedLongTasks++;
        }
      }).observe({ type: 'longtask', buffered: true });
    }
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const address = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const isCaptionWrite = address.includes('/api/projects/landscape/captions') && method === 'PUT';
      if (isCaptionWrite) probe.saveEvents.push({ kind: 'request', atMs: performance.now() });
      try {
        const response = await originalFetch(input, init);
        if (isCaptionWrite) probe.saveEvents.push({ kind: 'response', atMs: performance.now(), status: response.status });
        return response;
      } catch (error) {
        if (isCaptionWrite) probe.saveEvents.push({ kind: 'error', atMs: performance.now() });
        throw error;
      }
    };
    document.addEventListener('click', (event) => {
      if (probe.openStartMs !== null || !(event.target instanceof Element)
        || !event.target.closest('button')?.textContent?.includes('Audit landscape')) return;
      probe.openStartMs = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector(`[data-caption-id="scale-${count - 1}"] textarea`)) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { probe.openDoneMs = performance.now(); }));
      });
      observer.observe(document.body, { subtree: true, childList: true });
    }, true);
  }, { count: COUNT });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  const samples = [];
  try {
    for (let repetition = 0; repetition < REPEATS; repetition++) {
      state.projects[0] = structuredClone(original);
      await page.goto('/');
      await page.evaluate(async () => {
        const font = new FontFace('Plus Jakarta Sans', 'url("/__interface-font/plus-jakarta-sans.ttf")', { weight: '200 800' });
        document.fonts.add(await font.load());
        await document.fonts.ready;
      });
      const opening = await timedProfile(page, cdp, info, `open-${repetition}`, async () => {
        await page.getByRole('button', { name: /Audit landscape/ }).click();
        await page.waitForFunction(() => window.__refinementScrollDiagnostic.openDoneMs !== null);
        return page.evaluate(() => ({ startMs: window.__refinementScrollDiagnostic.openStartMs!,
          endMs: window.__refinementScrollDiagnostic.openDoneMs! }));
      });
      await expect(page.locator('.caption-row')).toHaveCount(COUNT);
      await expect(page.locator('.caption-row textarea')).toHaveCount(COUNT);
      const counts = await page.evaluate(() => {
        window.__refinementScrollDiagnostic.nativeFields = [0, 2250, 4999].map((index) =>
          document.querySelector<HTMLTextAreaElement>(`[data-caption-id="scale-${index}"] textarea`)!);
        return { domNodes: document.getElementsByTagName('*').length,
          rows: document.querySelectorAll('.caption-row').length,
          nativeTextareas: document.querySelectorAll('.caption-row textarea').length,
          nativeTimestampInputs: document.querySelectorAll('.caption-row .time-stack input').length };
      });
      expect(counts).toMatchObject({ rows: COUNT, nativeTextareas: COUNT, nativeTimestampInputs: COUNT * 2 });

      // The first 45% jump is the original benchmark's suspicious cold scroll.
      await resetScroll(page);
      const coldJump = await timedProfile(page, cdp, info, `cold-jump-${repetition}`, () => scrollAtFortyFivePercent(page));
      await resetScroll(page);
      const steady = await timedProfile(page, cdp, info, `steady-${repetition}`, () => scrollAtFortyFivePercent(page));

      const gate = deferred(); controls.push(gate);
      const submitted = deferred();
      const control: SaveControl = { gate, submitted, receivedAtNodeMs: null, releasedAtNodeMs: null,
        fulfilledAtNodeMs: null, bytes: 0, error: null };
      holding = control;
      const editBeganAtMs = await page.evaluate(() => performance.now());
      const text = `${original.captions[EDIT_INDEX].text} diagnostic`;
      const field = page.getByRole('textbox', { name: `Caption ${EDIT_INDEX + 1} text`, exact: true });
      await field.fill(text);
      await page.locator('.panel-head .panel-tool').first().focus(); // Blur -> an immediate guarded text save.
      await expect.poll(() => control.receivedAtNodeMs, { timeout: 30_000 }).not.toBeNull();
      expect(control.error).toBeNull();
      await resetScroll(page);
      const pendingSave = await timedProfile(page, cdp, info, `pending-save-${repetition}`, () => scrollAtFortyFivePercent(page));
      expect(control.fulfilledAtNodeMs, 'PUT must remain unacknowledged during the pending-scroll sample').toBeNull();
      const saveAcknowledgement = await timedProfile(page, cdp, info, `save-ack-${repetition}`, async () => {
        const startMs = await page.evaluate(() => performance.now());
        control.releasedAtNodeMs = nodePerformance.now();
        gate.release();
        // Avoid resolving a global role locator across 15,000 native fields
        // inside the measured interval. Observe the first header match and the
        // retained field directly; ordinary assertions otherwise dominate ACK.
        await page.waitForFunction((expectedText) => {
          const edited = window.__refinementScrollDiagnostic.nativeFields?.[1];
          return document.querySelector('.save-action-label')?.textContent?.trim() === 'Saved'
            && edited?.isConnected && edited.value === expectedText;
        }, text, { timeout: 30_000 });
        await settle(page);
        return { startMs, endMs: await page.evaluate(() => performance.now()) };
      });
      expect(control.fulfilledAtNodeMs).not.toBeNull();
      const saveAcknowledgedAtMs = saveAcknowledgement.endMs;
      await resetScroll(page);
      const acknowledgedSave = await timedProfile(page, cdp, info, `acknowledged-save-${repetition}`, () => scrollAtFortyFivePercent(page));
      const snapshot = await page.evaluate(() => {
        const probe = window.__refinementScrollDiagnostic;
        return { saveEvents: probe.saveEvents, droppedLongTasks: probe.droppedLongTasks,
          nativeFieldsUnchanged: probe.nativeFields?.every((element) => element.isConnected &&
            document.querySelector(`[data-caption-id="${element.closest('.caption-row')?.getAttribute('data-caption-id')}"] textarea`) === element) ?? false,
          nativeTextareas: document.querySelectorAll('.caption-row textarea').length,
          rows: document.querySelectorAll('.caption-row').length };
      });
      expect(snapshot).toMatchObject({ rows: COUNT, nativeTextareas: COUNT, nativeFieldsUnchanged: true });
      expect(snapshot.saveEvents.filter((event) => event.kind === 'request')).toHaveLength(1);
      expect(snapshot.saveEvents.filter((event) => event.kind === 'response' && event.status === 200)).toHaveLength(1);
      expect(unexpectedWrites).toBe(0);
      samples.push({ repetition, opening: { ...opening, elapsedMs: round(opening.endMs - opening.startMs) }, counts,
        coldJump, steady, pendingSave, saveAcknowledgement, acknowledgedSave,
        save: { editBeganAtMs, saveAcknowledgedAtMs, routeReceivedAtNodeMs: control.receivedAtNodeMs,
          routeReleasedAtNodeMs: control.releasedAtNodeMs, routeFulfilledAtNodeMs: control.fulfilledAtNodeMs,
          payloadBytes: control.bytes, events: snapshot.saveEvents },
        droppedLongTasks: snapshot.droppedLongTasks });
    }
    const identity = await page.evaluate(async () => (await fetch('/studio-web-identity.json')).json());
    const results = { schemaVersion: 2, kind: 'native-caption-scroll-and-save-attribution-diagnostic',
      count: COUNT, cpuThrottlingRate: CPU_THROTTLE, repetitions: REPEATS, framesPerScroll: SCROLL_FRAMES,
      browser: browser.version(), viewport: info.project.use.viewport, buildIdentity: identity, samples,
      acknowledgementObservation: 'First matching header save status plus the retained native field; no global role-locator assertion inside the measured interval.',
      limitations: [
        'CPU sampling at 2ms and CDP metrics perturb performance. These figures cannot be compared as unprofiled before/after speedups.',
        'Cold jump, warm jump and save phases are ordered within each repetition; order, browser raster cache, and the focus/blur path remain possible confounders.',
        'The observed save is a synthetic PUT with a held network acknowledgement. An unacknowledged request may have different work from a real local persistence operation.',
        'Longtask entries and CPU profiler samples are main-thread observations, not attribution of raster/compositor work. CDP counters cover the enclosing action windows.',
        'The short synthetic video and 5000 repeated Khmer/mixed captions do not measure real long-media decode, native export, physical display latency or a different PC.',
        'All rows and native fields remain mounted. This diagnostic modifies no product code, CSS, render semantics or browser settings beyond scoped CPU profiling.',
      ] };
    await fs.writeFile(info.outputPath('refinement-scroll-metrics.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ diagnostic: results.kind, count: COUNT, cpu: CPU_THROTTLE,
      samples: samples.map(({ repetition, opening, coldJump, steady, pendingSave, acknowledgedSave }) => ({
        repetition, openMs: opening.elapsedMs,
        coldJumpMaxGapMs: coldJump.frameGaps?.maxMs, steadyMaxGapMs: steady.frameGaps?.maxMs,
        pendingMaxGapMs: pendingSave.frameGaps?.maxMs, acknowledgedMaxGapMs: acknowledgedSave.frameGaps?.maxMs,
      })) }));
  } finally {
    for (const gate of controls) gate.release();
    await cdp.send('Profiler.disable').catch(() => {});
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  }
});
