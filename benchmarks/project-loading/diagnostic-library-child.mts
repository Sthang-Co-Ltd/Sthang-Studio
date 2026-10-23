import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance, PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';
import { installProjectLoadingObserver, type ProjectLoadingEvent } from '../../apps/server/src/services/project-loading-observer.js';

const entryAtMs = performance.now();
process.send?.({ kind: 'entry', pid: process.pid, parentPid: process.ppid, entryAtMs });
const phases: ProjectLoadingEvent[] = [];
const gcEvents: Array<{ startedAtMs: number; durationMs: number; kind: number; flags: number }> = [];
const stages: Array<Record<string, unknown> & { name: string; startedAtMs: number; endedAtMs: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const event of list.getEntries()) {
    const detail = (event as unknown as { detail: { kind: number; flags: number } }).detail;
    gcEvents.push({ startedAtMs: event.startTime, durationMs: event.duration, kind: detail.kind, flags: detail.flags });
  }
});
observer.observe({ entryTypes: ['gc'] });
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
let removeObserver: (() => void) | undefined;
let activeStage = 'ownership';
function startStage(name: string) {
  activeStage = name;
  delay.reset();
  return { name, cpu: process.cpuUsage(), resources: process.resourceUsage(), utilization: performance.eventLoopUtilization(), startedAtMs: performance.now() };
}
function endStage(start: ReturnType<typeof startStage>) {
  const endedAtMs = performance.now();
  const resources = process.resourceUsage();
  stages.push({ name: start.name, startedAtMs: start.startedAtMs, endedAtMs, wallMs: endedAtMs - start.startedAtMs,
    cpuMicros: process.cpuUsage(start.cpu), eventLoopUtilization: performance.eventLoopUtilization(start.utilization),
    eventLoopDelay: { samples: delay.count, minimumMs: delay.count ? delay.min / 1e6 : null,
      maximumMs: delay.count ? delay.max / 1e6 : null, meanMs: delay.count ? delay.mean / 1e6 : null },
    resources: { minorPageFaults: resources.minorPageFault - start.resources.minorPageFault,
      majorPageFaults: resources.majorPageFault - start.resources.majorPageFault,
      voluntaryContextSwitches: resources.voluntaryContextSwitches - start.resources.voluntaryContextSwitches,
      involuntaryContextSwitches: resources.involuntaryContextSwitches - start.resources.involuntaryContextSwitches,
      fileSystemReads: resources.fsRead - start.resources.fsRead, fileSystemWrites: resources.fsWrite - start.resources.fsWrite,
      maximumRssKiB: resources.maxRSS } });
}

try {
  const root = await fs.realpath(process.env.STHANG_STUDIO_STATE_ROOT || '');
  const owner = JSON.parse(await fs.readFile(path.join(root, '.benchmark-owner.json'), 'utf8'));
  assert.equal(owner.id, process.env.STHANG_PROJECT_BENCHMARK_OWNER);
  assert.equal(owner.kind, 'synthetic-project-loading');
  assert.equal(owner.diagnostic, true);
  assert.equal(process.env.STHANG_STUDIO_ENV_FILE, path.join(root, 'absent.env'));
  assert.equal(await fs.stat(process.env.STHANG_STUDIO_ENV_FILE!).then(() => true, () => false), false);
  globalThis.fetch = async () => { throw new Error('Network is disabled in project-loading diagnostics.'); };
  removeObserver = installProjectLoadingObserver((event) => phases.push(event));
  let stage = startStage('import');
  const { store } = await import('../../apps/server/src/services/store.js');
  endStage(stage);
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert.ok(gc, 'Diagnostic child requires --expose-gc.');
  stage = startStage('forced-gc-before'); gc(); endStage(stage);
  const before = process.memoryUsage();
  stage = startStage('first-list');
  let summaries: Awaited<ReturnType<typeof store.listSummaries>> | null = await store.listSummaries();
  endStage(stage);
  activeStage = 'summary-assertions';
  assert.equal(summaries.length, owner.projects);
  assert.ok(summaries.every((item) => item.captionCount === owner.captions && !('captions' in item) && !('transcript' in item)));
  const orderedIds = summaries.map((item) => item.id);
  assert.equal(orderedIds[0], 'synthetic-0');
  summaries = null;
  stage = startStage('forced-gc-after'); gc(); endStage(stage);
  const retained = process.memoryUsage();
  stage = startStage('warm-list');
  assert.deepEqual((await store.listSummaries()).map((item) => item.id), orderedIds);
  endStage(stage);
  stage = startStage('detail');
  const detail = await store.get(orderedIds.at(-1)!);
  endStage(stage);
  activeStage = 'detachment-assertions';
  assert.equal(detail?.captions.length, owner.captions);
  assert.equal(detail?.captions[0].text, 'សួស្តី នេះជាសាកល្បង caption-0');
  detail!.captions[0].text = 'detached synthetic edit';
  assert.equal((await store.get(detail!.id))!.captions[0].text, 'សួស្តី នេះជាសាកល្បង caption-0');
  // Flush queued observer deliveries after all measured windows; no sleep or
  // event-loop warmup is inserted before first-list.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.send?.({ kind: 'result', status: 'completed', pid: process.pid, parentPid: process.ppid, entryAtMs,
    stages, phases, gcEvents, memory: { before, retained, retainedHeapBytes: retained.heapUsed - before.heapUsed,
      retainedRssBytes: retained.rss - before.rss },
    normalization: { state: 'not-applicable', reason: 'Accepted per-project JSON is shape-validated and published without normalization; legacy migration is not exercised.' } });
} catch (error) {
  const classes = new Set(['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);
  const candidate = error as { name?: unknown; code?: unknown } | null;
  const errorClass = typeof candidate?.name === 'string' && classes.has(candidate.name) ? candidate.name : 'unclassified';
  const errorCode = typeof candidate?.code === 'string' && codes.has(candidate.code) ? candidate.code : 'unclassified';
  process.send?.({ kind: 'result', status: 'failed', pid: process.pid, parentPid: process.ppid, entryAtMs,
    failedStage: activeStage, stages, phases, gcEvents, errorClass, errorCode,
    error: 'Isolated diagnostic failed ownership, loading, or invariant checks; no result accepted.' });
  process.exitCode = 1;
} finally {
  removeObserver?.();
  observer.disconnect();
  delay.disable();
}
