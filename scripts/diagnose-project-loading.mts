import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { CaptionProject, CaptionSegment } from '@kcs/shared';
import type { ProjectLoadingEvent } from '../apps/server/src/services/project-loading-observer.js';
import { captureProjectLoadingSourceBinding, verifyProjectLoadingSourceBinding } from './project-loading-source-binding.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['scripts/diagnose-project-loading.mts', 'benchmarks/project-loading/diagnostic-library-child.mts',
  'scripts/benchmark-project-loading.mts', 'benchmarks/project-loading/cold-library-child.mts'];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const stats = (samples: number[]) => {
  assert.ok(samples.length && samples.every(Number.isFinite));
  const ordered = [...samples].sort((a, b) => a - b);
  return { samples, median: ordered[Math.floor(ordered.length / 2)], p95: ordered[Math.ceil(ordered.length * .95) - 1], maximum: ordered.at(-1)! };
};
// Concurrent file-read spans overlap. Their sum is not elapsed I/O time.
function unionMs(events: ProjectLoadingEvent[]) {
  const ranges = events.map((event) => [event.startedAtMs, event.startedAtMs + event.durationMs]).sort((a, b) => a[0] - b[0]);
  let total = 0, left = 0, right = 0;
  for (const [start, end] of ranges) {
    if (start > right) { total += right - left; left = start; right = end; }
    else right = Math.max(right, end);
  }
  return total + right - left;
}
// Exact non-rich corpus expression from the unchanged clean benchmark. The
// independent clean-generator comparison below rejects fixture drift.
function corpus(count: number): Pick<CaptionProject, 'captions' | 'transcript'> {
  const captions: CaptionSegment[] = [];
  for (let index = 0; index < count; index++) {
    const startMs = index * 2000;
    const words = ['សួស្តី', 'នេះជាសាកល្បង', `caption-${index}`];
    const text = words.join(' ');
    const caption: CaptionSegment = { id: `cue-${index}`, text, startMs, endMs: startMs + 1800, approved: true, timingSource: 'manual' };
    captions.push(caption);
  }
  return { captions, transcript: { language: 'km', fullText: captions.map((item) => item.text).join(' '),
    segments: captions.map(({ wordTiming: _timing, ...item }) => item) } };
}
function projectBytes(index: number, contents: ReturnType<typeof corpus>) {
  const id = `synthetic-${index}`;
  const project: CaptionProject = { id, title: `Synthetic ខ្មែរ ${index}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', mode: 'phrase',
    media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 5000, url: `/media/${id}.mp4` }, ...contents };
  return JSON.stringify(project) + '\n';
}
async function validateCleanFixture(scenarios: Array<{ projects: number; captions: number; totalBytes: number }>) {
  const cleanSource = await fs.readFile(path.join(repo, 'scripts/benchmark-project-loading.mts'), 'utf8');
  const fixtureStart = cleanSource.indexOf('function corpus('), fixtureEnd = cleanSource.indexOf('\ntype Sample =', fixtureStart);
  const projectStart = cleanSource.indexOf('      const id = `synthetic-${index}`;');
  const projectEnd = cleanSource.indexOf(' const file = path.join(directory, `${id}.json`);', projectStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart && projectStart >= 0 && projectEnd > projectStart, 'Clean fixture boundaries changed.');
  const fixtureSource = cleanSource.slice(fixtureStart, fixtureEnd);
  const projectSource = cleanSource.slice(projectStart, projectEnd);
  const { transformWithOxc } = await import('vite');
  const code = (await transformWithOxc(fixtureSource + '\nfunction projectBytes(index, contents) {\n' + projectSource + '\nreturn bytes; }',
    'clean-project-loading-fixture.ts')).code;
  // Only the two bound, pure clean-generator source slices are evaluated. The
  // benchmark's entry point, process spawning, and cleanup never execute here.
  const clean = new Function(code + '\nreturn { corpus, projectBytes };')() as { corpus: (count: number, rich: boolean) => ReturnType<typeof corpus>; projectBytes: typeof projectBytes };
  for (const scenario of scenarios) {
    const contents = corpus(scenario.captions), expected = clean.corpus(scenario.captions, false);
    assert.deepEqual(contents, expected, 'Diagnostic corpus must match the unchanged clean generator.');
    let bytes = 0;
    for (let index = 0; index < scenario.projects; index++) {
      const actual = projectBytes(index, contents);
      assert.equal(actual, clean.projectBytes(index, expected), 'Diagnostic project bytes must match the unchanged clean generator.');
      bytes += Buffer.byteLength(actual);
    }
    assert.equal(bytes, scenario.totalBytes);
  }
  return { cleanCorpusSourceSha256: hash(fixtureSource), cleanProjectSourceSha256: hash(projectSource), exactCleanFixtureEquality: true };
}
const scenarios = [{ name: 'small-control', projects: 10, captions: 300, totalBytes: 1195850 },
  { name: 'working', projects: 50, captions: 600, totalBytes: 11999450 }];
interface Stage { name: string; startedAtMs: number; endedAtMs: number; wallMs: number }
interface Result {
  kind: 'result'; status: 'completed' | 'failed'; pid: number; parentPid: number; entryAtMs: number;
  stages: Stage[]; phases: ProjectLoadingEvent[]; gcEvents: Array<{ startedAtMs: number; durationMs: number; kind: number; flags: number }>;
  memory?: { retainedHeapBytes: number }; failedStage?: string;
}
function summarize(sample: Result) {
  const first = sample.stages.find((stage) => stage.name === 'first-list');
  if (!first) return null;
  const events = sample.phases.filter((event) => event.startedAtMs >= first.startedAtMs && event.startedAtMs + event.durationMs <= first.endedAtMs);
  const phaseNames = ['directory-create', 'metadata', 'directory', 'file-read', 'parse', 'shape-validation', 'scan', 'publication', 'summary'] as const;
  const phases = Object.fromEntries(phaseNames.map((phase) => {
    const selected = events.filter((event) => event.phase === phase);
    return [phase, { count: selected.length, sumMs: selected.reduce((sum, event) => sum + event.durationMs, 0),
      unionMs: unionMs(selected), maximumMs: Math.max(0, ...selected.map((event) => event.durationMs)) }];
  }));
  // Union handles nested scan/read/parse/validation and concurrent reads without
  // double counting; it also covers the order read outside scan. GC overlaps
  // these spans and is never added to accounted/residual totals.
  const accountedMs = unionMs(events);
  return { firstListMs: first.wallMs, phases, accountedMs, residualMs: first.wallMs - accountedMs,
    gcEvents: sample.gcEvents.filter((event) => event.startedAtMs >= first.startedAtMs && event.startedAtMs < first.endedAtMs) };
}

if (process.argv[2] === '--self-test' && process.argv.length === 3) {
  assert.deepEqual(stats([4639.2182, 53.2546, 51.2528, 54.9081, 57.3308, 52.0799, 47.9155]),
    { samples: [4639.2182, 53.2546, 51.2528, 54.9081, 57.3308, 52.0799, 47.9155], median: 53.2546, p95: 4639.2182, maximum: 4639.2182 });
  assert.equal(unionMs([{ phase: 'file-read', startedAtMs: 10, durationMs: 20 }, { phase: 'file-read', startedAtMs: 20, durationMs: 20 }]), 30);
  assert.equal(unionMs([]), 0);
  const observerModule = await import('../apps/server/src/services/project-loading-observer.js');
  assert.equal(observerModule.beginProjectLoadingPhase('summary'), undefined);
  const remove = observerModule.installProjectLoadingObserver(() => { throw new Error('Test observer failure'); });
  observerModule.endProjectLoadingPhase(observerModule.beginProjectLoadingPhase('summary'));
  remove(); assert.equal(observerModule.beginProjectLoadingPhase('summary'), undefined);
  const fixtureEquality = await validateCleanFixture(scenarios);
  console.log(JSON.stringify({ methodSelfTest: 'passed', fixtureEquality, runtimeOrPerformanceEvidence: false }));
} else {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error('Usage: node --import tsx scripts/diagnose-project-loading.mts <new-evidence-directory>');
  if (process.platform === 'darwin') throw new Error('Strict credential isolation is not qualified for macOS Keychain.');
  const evidence = path.resolve(output);
  await fs.mkdir(evidence); // Never overwrite prior evidence or delete supplied paths.
  const plan = { schemaVersion: 1, evidenceClass: 'diagnostic-instrumented', createdAt: new Date().toISOString(),
    repetitions: 7, maximumProcessColdSamples: 14, serial: true, scenarios,
    referenceGate: { firstListP95Ms: 1000, retainedHeapP95Bytes: 256 * 1024 * 1024, percentile: 'unchanged nearest-rank; n7 p95 equals maximum',
      qualification: 'Diagnostic observations do not supersede the clean 35-sample benchmark or its exceeded gate.' },
    limits: ['Process-cold store; OS filesystem cache unflushed. No sleeps, retries, resampling, or outlier removal.',
      'Fixed order: seven small controls, then seven working samples. Matches the original first two scenarios; excludes later large/word-timed/stress cases.',
      'Opt-in phase callbacks, clocks, GC observer, and event-loop monitoring perturb this run and retained heap; never claim clean qualification or speedup.',
      'Filesystem wall spans include scheduling, decoding, and contention; they do not identify physical disk, antivirus, or a specific external cause.',
      'Overlapping read durations and nested scan phases cannot be added. Union and sum are both retained; residual is not a named cause.',
      'GC events overlap phase timing. Resource counters may be unsupported/zero on Windows; zero does not prove no I/O or page faults.',
      'Event-loop delay may have no samples in short stages. CPU/utilization are supporting process evidence, not a causal attribution.',
      'Process launch/import, forced GC, first list, warm list, and detail are separate. This is not whole-server/HTTP/UI/customer latency.',
      'Synthetic Khmer JSON only, no media/model/history loads, no server or provider requests. No customer state or credentials are read.',
      'Bindings capture local sources, executed shared JS, lockfile, and Node executable at endpoints; external installed dependency bytes and restored-between-captures edits remain unverified.'] };
  await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  const bindingOptions = { entries };
  const sourceBinding = await captureProjectLoadingSourceBinding(repo, bindingOptions);
  const identity = { repositoryRoot: repo, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()),
    nodeExecutableSha256: hash(await fs.readFile(process.execPath)) };
  await fs.writeFile(path.join(evidence, 'source-binding-before.json'), JSON.stringify({ identity, sourceBinding }, null, 2) + '\n', { flag: 'wx' });
  const fixtureEquality = await validateCleanFixture(scenarios);
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-loading-diagnostic-')));
  const ownerId = randomUUID();
  await fs.writeFile(path.join(temporary, '.benchmark-owner.json'), JSON.stringify({ id: ownerId }));
  const results: unknown[] = [];
  try {
    for (const scenario of scenarios) {
      const root = path.join(temporary, scenario.name), directory = path.join(root, 'data/projects');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(root, '.benchmark-owner.json'), JSON.stringify({ kind: 'synthetic-project-loading', id: ownerId, diagnostic: true, ...scenario }));
      const fixtureHashes: Record<string, string> = {};
      const contents = corpus(scenario.captions); let totalBytes = 0;
      for (let index = 0; index < scenario.projects; index++) {
        const bytes = projectBytes(index, contents), name = `synthetic-${index}.json`;
        await fs.writeFile(path.join(directory, name), bytes); fixtureHashes[name] = hash(bytes); totalBytes += Buffer.byteLength(bytes);
      }
      assert.equal(totalBytes, scenario.totalBytes);
      for (const [name, bytes] of [['order.json', JSON.stringify(Array.from({ length: scenario.projects }, (_, index) => `synthetic-${index}`)) + '\n'],
        ['.per-project-v1', 'Sthang Studio per-project storage v1\n']]) {
        await fs.writeFile(path.join(directory, name), bytes); fixtureHashes[name] = hash(bytes);
      }
      await fs.writeFile(path.join(evidence, `${scenario.name}-fixture.json`), JSON.stringify({ scenario, totalBytes, fixtureHashes,
        ...fixtureEquality }, null, 2) + '\n', { flag: 'wx' });
      const samples: Array<Result & { parent: Record<string, unknown>; summary: ReturnType<typeof summarize> }> = [];
      for (let repetition = 0; repetition < plan.repetitions; repetition++) {
        const env = { ...process.env, STHANG_STUDIO_STATE_ROOT: root, STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'),
          STHANG_PROJECT_BENCHMARK_OWNER: ownerId, NODE_OPTIONS: '', LOCALAPPDATA: path.join(root, 'local-app-data'), APPDATA: path.join(root, 'app-data'),
          XDG_CONFIG_HOME: path.join(root, 'xdg-config'), TEMP: root, TMP: root, TMPDIR: root,
          GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
          STHANG_CONTRIBUTION_ENDPOINT: 'disabled-for-synthetic-benchmark', STHANG_ANALYTICS_ENDPOINT: 'disabled-for-synthetic-benchmark', LOCAL_TIMING_PYTHON: path.join(root, 'absent-python.exe') };
        const startedAtMs = performance.now();
        const sample = await new Promise<Result & { parent: Record<string, unknown>; summary: ReturnType<typeof summarize> }>((resolve) => {
          const child = fork(path.join(repo, 'benchmarks/project-loading/diagnostic-library-child.mts'), [], { cwd: repo, execPath: process.execPath,
            execArgv: ['--expose-gc', '--import', 'tsx'], env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
          let entry: Record<string, unknown> | undefined, result: Result | undefined, timedOut = false;
          const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
          child.on('message', (value: unknown) => {
            const message = value as Result | { kind: 'entry' };
            if (message.kind === 'entry') entry = { ...message, parentForkToEntryMessageMs: performance.now() - startedAtMs };
            if (message.kind === 'result') result = message;
          });
          child.once('error', () => { /* Final sanitized disposition is retained on close. */ });
          child.once('close', (code, signal) => {
            clearTimeout(timer);
            const actual = result ?? { kind: 'result' as const, status: 'failed' as const, pid: child.pid ?? -1, parentPid: process.pid,
              entryAtMs: -1, stages: [], phases: [], gcEvents: [], failedStage: timedOut ? 'child-timeout' : 'child-start-or-exit' };
            if (code !== 0) actual.status = 'failed';
            resolve({ ...actual, parent: { repetition: repetition + 1, entry, exitCode: code, signal, timedOut,
              forkToCloseMs: performance.now() - startedAtMs, measuredChildPid: child.pid }, summary: summarize(actual) });
          });
        });
        samples.push(sample);
        await fs.writeFile(path.join(evidence, `${scenario.name}-${repetition + 1}.json`), JSON.stringify(sample, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ scenario: scenario.name, repetition: repetition + 1, status: sample.status,
          firstListMs: sample.summary?.firstListMs ?? null }));
        assert.equal(sample.status, 'completed', 'Diagnostic child failed; retained partial evidence, no retry.');
        assert.equal(sample.pid, sample.parent.measuredChildPid, 'Result must come from the owned child.');
        assert.equal(sample.parentPid, process.pid);
        for (const [phase, expectedCount] of Object.entries({ 'directory-create': 1, metadata: 1, directory: 1, 'file-read': scenario.projects + 1, parse: scenario.projects + 1,
          'shape-validation': scenario.projects, scan: 1, publication: 1, summary: 1 })) {
          const actual = sample.phases.filter((event) => event.phase === phase && event.startedAtMs >= sample.stages.find((stage) => stage.name === 'first-list')!.startedAtMs
            && event.startedAtMs + event.durationMs <= sample.stages.find((stage) => stage.name === 'first-list')!.endedAtMs).length;
          assert.equal(actual, expectedCount, 'Every first-list measurement boundary must be observed.');
        }
      }
      assert.deepEqual((await fs.readdir(directory)).sort(), Object.keys(fixtureHashes).sort());
      for (const [name, expected] of Object.entries(fixtureHashes)) assert.equal(hash(await fs.readFile(path.join(directory, name))), expected, 'Synthetic fixture changed.');
      const result = { scenario, totalBytes, samples, firstListMs: stats(samples.map((item) => item.summary!.firstListMs)),
        retainedHeapBytes: stats(samples.map((item) => item.memory!.retainedHeapBytes)), invariantChecks: 'passed' };
      results.push(result);
      await fs.writeFile(path.join(evidence, `${scenario.name}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    await verifyProjectLoadingSourceBinding(repo, sourceBinding, bindingOptions);
    assert.equal(hash(await fs.readFile(process.execPath)), identity.nodeExecutableSha256);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), identity.head);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim(), identity.tree);
    await fs.writeFile(path.join(evidence, 'source-binding-after.json'), JSON.stringify({ identity, sourceBinding, endpointsVerifiedEqual: true }, null, 2) + '\n', { flag: 'wx' });
    const report = { plan, completedAt: new Date().toISOString(), identity, sourceBinding,
      runtime: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch,
        cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), coordinatorPid: process.pid },
      results, cause: 'unresolved; diagnostic observations require primary interpretation', qualification: 'not-clean-benchmark-evidence' };
    await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } catch {
    await fs.writeFile(path.join(evidence, 'incomplete.json'), JSON.stringify({ status: 'incomplete', completedScenarios: results.length,
      cause: 'unresolved', error: 'Diagnostic run stopped after failure. All completed sample files retained; no retry or replacement.' }, null, 2) + '\n', { flag: 'wx' });
    throw new Error('Project-loading diagnostics incomplete; inspect retained sanitized evidence.');
  } finally {
    const actual = await fs.realpath(temporary);
    assert.equal(actual, temporary);
    assert.ok(path.dirname(actual) === await fs.realpath(os.tmpdir()) && path.basename(actual).startsWith('studio-loading-diagnostic-'));
    assert.equal(JSON.parse(await fs.readFile(path.join(actual, '.benchmark-owner.json'), 'utf8')).id, ownerId);
    await fs.rm(actual, { recursive: true, force: true });
  }
}
