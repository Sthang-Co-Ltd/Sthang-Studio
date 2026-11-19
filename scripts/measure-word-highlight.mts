// npm run build --workspace @kcs/shared
// node --import tsx scripts/measure-word-highlight.mts --project project.json --wav normalized.wav
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compileHighlightPlan, type CaptionProject, type CaptionSegment } from '@kcs/shared';
import type { WordHighlightOutcome } from '../apps/server/src/services/word-highlight-engine.js';
import type { AlignWindowsResult, WindowAttempt, WindowClock } from '../apps/server/src/services/local-timing.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' }, wav: { type: 'string' }, cohort: { type: 'string', default: 'fresh' },
    runs: { type: 'string', default: '1' }, out: { type: 'string' }, 'control-wav': { type: 'boolean' },
    'post-generation': { type: 'boolean' }, 'trace-windows': { type: 'boolean' },
  },
});
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = Number(values.runs);
if (!values.project || !values.wav || !['fresh', 'stored'].includes(values.cohort)
  || !Number.isInteger(runs) || runs < 1) {
  throw new Error('Supply --project <json> --wav <normalized.wav> [--cohort fresh|stored] [--runs N] [--out <dir outside repo>] [--control-wav] [--post-generation] [--trace-windows].');
}

function inRepository(location: string) {
  const relative = path.relative(repo, location);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function realDestination(location: string): Promise<string> {
  try {
    return await fs.realpath(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(await realDestination(path.dirname(location)), path.basename(location));
  }
}

const out = values.out ? await realDestination(path.resolve(values.out)) : undefined;
if (values['trace-windows'] && !out) throw new Error('Window traces require --out.');
const temp = await fs.realpath(os.tmpdir());
if ((out && inRepository(out)) || inRepository(temp)) throw new Error('Measurement artifacts require a directory outside the repository.');
const root = await fs.mkdtemp(path.join(temp, 'sthang-word-highlight-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.NUMBA_CACHE_DIR = path.join(root, 'numba');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { createWordHighlightEngine, mapHighlightWords } = await import('../apps/server/src/services/word-highlight-engine.js');
const { alignWindowsLocally, closeLocalTimingWorker, prepareFullEmission, prepareTimingLocally, LocalTimingUnavailableError } =
  await import('../apps/server/src/services/local-timing.js');
const { makeAudioChunk, waveDurationMs } = await import('../apps/server/src/services/media.js');
const { mediaFingerprint } = await import('../apps/server/src/services/cache.js');

const sourceProject = path.resolve(values.project);
const sourceWav = path.resolve(values.wav);
const hash = (file: string) => new Promise<string>((resolve, reject) => {
  const digest = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => digest.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(digest.digest('hex')));
});
const [inputHash, wavHash] = await Promise.all([hash(sourceProject), hash(sourceWav)]);
const project = JSON.parse(await fs.readFile(sourceProject, 'utf8')) as CaptionProject;
if (!Array.isArray(project.captions) || !project.id || !project.media) throw new Error('Expected a saved project snapshot.');
const scope = createHash('sha256').update(project.id).digest('hex').slice(0, 16);
if (values.cohort === 'fresh') project.captions = project.captions.map(({ wordTiming: _track, ...caption }) => caption);
const ids = project.captions.filter(({ text }) => /[^\s\p{Cf}]/u.test(text)).map(({ id }) => id);
const byId = new Map(project.captions.map((caption) => [caption.id, caption]));
const outputPath = path.join(root, 'normalized.wav');
// makeAudioChunk writes project-scoped ranges alongside the source WAV.
await fs.copyFile(sourceWav, outputPath);
const durationMs = await waveDurationMs(outputPath);
if (!durationMs) throw new Error('Expected a normalized PCM WAV.');
if (out) await fs.mkdir(out, { recursive: true });
const duration = durationMs;
const normalized = {
  outputPath, durationMs, dir: root, fingerprint: mediaFingerprint(project), cacheHit: true, cachedAt: '',
};
const expected = { filename: project.media.filename, size: project.media.size };

function percentile(sorted: number[], fraction: number) {
  const index = (sorted.length - 1) * fraction;
  const floor = Math.floor(index);
  return sorted[floor] + (sorted[Math.ceil(index)] - sorted[floor]) * (index - floor);
}

function distribution(values: number[]) {
  if (!values.length) return { n: 0, median: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) };
}

function finishOutcome(caption: CaptionSegment, outcome: WordHighlightOutcome) {
  const track = outcome.track ?? (outcome.status === 'reused' || outcome.status === 'locked' ? caption.wordTiming : undefined);
  const plan = compileHighlightPlan({ ...caption, wordTiming: track }, 'measured-and-manual');
  const painted = new Set(plan.spans.map(({ startOffset, endOffset }) => `${startOffset}-${endOffset}`));
  const words = (track?.words ?? []).map(({ startOffset, endOffset, startMs, endMs, source, method, issue, members }) => ({
    startOffset, endOffset, startMs, endMs, source, method, issue, groupSize: members?.length ?? 1,
    painted: painted.has(`${startOffset}-${endOffset}`),
  }));
  return {
    id: caption.id, cue: { startMs: caption.startMs, endMs: caption.endMs }, status: outcome.status,
    coverage: plan.coverage, spokenUnits: plan.spokenUnits, paintedUnits: plan.paintedUnits, words,
    variant: outcome.variant, conflicts: outcome.conflicts, diagnostics: outcome.diagnostics, issues: plan.issues.map(({ code }) => code),
  };
}

type Row = ReturnType<typeof finishOutcome>;
function summarize(rows: Row[]) {
  const counts = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map((key) => [key, values.filter((value) => value === key).length]));
  const measured = rows.flatMap(({ words }) => words);
  const groups = measured.filter(({ groupSize, painted }) => groupSize > 1 && painted).map(({ groupSize }) => groupSize);
  const individual = measured.filter(({ groupSize, painted }) => groupSize === 1 && painted).length;
  const none = rows.filter(({ coverage }) => coverage === 'none');
  return {
    checked: rows.length, statuses: counts(rows.map(({ status }) => status)),
    coverage: counts(rows.map(({ coverage }) => coverage)),
    units: { individual, grouped: groups.reduce((total, n) => total + n, 0), plain: rows.reduce((total, row) => total + row.spokenUnits - row.paintedUnits, 0) },
    groupSizes: counts(groups.map(String)), largestGroup: Math.max(0, ...groups),
    noneReasons: counts(none.map(({ issues, status }) => issues.length ? [...new Set(issues)].sort().join(',') : status)),
    variants: counts(rows.map(({ variant }) => variant ?? 'none')),
    mappingFailures: rows.filter(({ diagnostics }) => diagnostics.mappingFailure).length,
    ambiguousOccurrences: measured.filter(({ issue }) => issue === 'ambiguous-occurrence').length,
    untrustedPaints: measured.filter(({ painted, source, issue }) => painted && (source === 'estimated' || issue === 'ambiguous-occurrence')).length,
  };
}

async function persist(label: string, rows: unknown[]) {
  if (out) await fs.writeFile(path.join(out, `${values.cohort}-${label}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
}

type Align = typeof alignWindowsLocally;

async function measurePrepareRoute(implementation: ReturnType<typeof createWordHighlightEngine>) {
  const [{ default: express }, { createWordHighlightHandler }, { createWordHighlightCandidateStore }] = await Promise.all([
    import('express'), import('../apps/server/src/routes/projects.js'),
    import('../apps/server/src/services/word-highlight-candidate-store.js'),
  ]);
  const app = express();
  app.use(express.json());
  app.post('/api/projects/:id/caption-word-timing/prepare', createWordHighlightHandler('prepare', {
    engine: implementation, candidateStore: createWordHighlightCandidateStore(), hasActiveCaptionJobForProject: () => false,
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project.id)}/caption-word-timing/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedMedia: expected }),
    });
    if (!response.ok) throw new Error(`Prepare returned HTTP ${response.status}.`);
    const result = await response.json();
    if (result.ready !== true || result.mediaFingerprint !== normalized.fingerprint || result.durationMs !== durationMs) {
      throw new Error('Prepare returned an unexpected media recipe.');
    }
    return performance.now() - start;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function engine(namespace: string, align: Align = alignWindowsLocally) {
  const targetTimes: number[] = [];
  const windowTraces: unknown[] = [];
  const implementation = createWordHighlightEngine({
    getProject: async () => project, ensureNormalizedAudio: async () => normalized,
    prepareFullEmission: (wav) => prepareFullEmission(wav, namespace),
    alignWindowsLocally: async (wav, _cache, request) => {
      const measured = await align(wav, namespace, request);
      if (values['trace-windows']) {
        const plans = new Map(request.targets.map((target) => [target.id, target]));
        for (const row of measured.targets) {
          const selected = plans.get(row.id)?.variants.find(({ name }) => name === row.attempts.at(-1)?.variant);
          const caption = byId.get(row.id);
          if (!row.words || !selected || !caption) continue;
          const line = selected.lines.findIndex(({ target }) => target);
          const anchors = row.words.filter((word) => word.line === line);
          const mapped = mapHighlightWords(caption, anchors, row.clock ?? measured.clock);
          windowTraces.push({
            id: row.id, variant: selected.name, startMs: selected.startMs, endMs: selected.endMs,
            anchors: anchors.map(({ startFrame, endFrame, peak }) => ({ startFrame, endFrame, peak })),
            spans: mapped.spans.map(({ word }) => word), placeholders: mapped.words,
          });
        }
      }
      return measured;
    },
    clock: () => performance.now(), onTargetMeasured: (_id, ms) => targetTimes.push(ms),
  });
  return {
    async prepare() {
      if (values['post-generation']) return measurePrepareRoute(implementation);
      const at = performance.now();
      await implementation.prepare(project.id, expected);
      return performance.now() - at;
    },
    async measure() {
      targetTimes.length = 0;
      windowTraces.length = 0;
      const at = performance.now();
      const results: WordHighlightOutcome[] = [];
      for (let offset = 0; offset < ids.length; offset += 32) {
        results.push(...(await implementation.candidates(project.id, expected, ids.slice(offset, offset + 32))).results);
      }
      const engineMs = performance.now() - at;
      return { rows: results.map((result) => finishOutcome(byId.get(result.id)!, result)), engineMs, targetMs: distribution(targetTimes), targetSamplesMs: [...targetTimes], windowTraces: [...windowTraces] };
    },
  };
}

const control: Align = async (wav, namespace, request) => {
  const targets: AlignWindowsResult['targets'] = [];
  let lastClock: WindowClock | undefined;
  for (const target of request.targets) {
    const attempts: WindowAttempt[] = [];
    const result: AlignWindowsResult['targets'][number] = { id: target.id, attempts };
    for (const variant of target.variants) {
      if (variant.name === 'target-wide' && !['frames-short', 'no-fit'].includes(attempts.at(-1)?.result ?? '')) continue;
      const chunkPath = path.join(root, 'control.wav');
      try {
        const chunk = await makeAudioChunk(wav, chunkPath, variant.startMs, variant.endMs - variant.startMs);
        if (chunk.durationMs < 100) {
          attempts.push({ variant: variant.name, result: 'frames-short' });
          continue;
        }
        const requested = { ...variant, startMs: 0, endMs: chunk.durationMs + 1 };
        const measured = await alignWindowsLocally(chunk.outputPath, namespace, {
          ...request, audioSource: 'chunk', targets: [{ id: target.id, variants: [{ ...requested, name: variant.name === 'target-wide' ? 'target' : variant.name }] }],
        });
        const candidate = measured.targets[0];
        const clock = { ...measured.clock, sampleOrigin: chunk.directSource ? 0 : Math.round(Math.max(0, Math.round(variant.startMs)) * measured.clock.sampleRate / 1_000) };
        lastClock = clock;
        result.clock = clock;
        attempts.push(...candidate.attempts.map((attempt) => ({ ...attempt, variant: variant.name })));
        if (candidate.words) {
          result.words = candidate.words;
          break;
        }
      } catch (error) {
        if (error instanceof LocalTimingUnavailableError) throw error;
        attempts.push({ variant: variant.name, result: 'error' });
      }
    }
    targets.push(result);
  }
  return {
    clock: lastClock ?? { sampleCount: duration * 16, sampleRate: 16_000, frameCount: 1 }, targets,
  };
};

function compare(slice: Row[], wav: Row[]) {
  const controls = new Map(wav.map((row) => [row.id, row]));
  const paired = [];
  let eligible = 0;
  for (const row of slice) {
    const matching = controls.get(row.id);
    for (const word of row.words) {
      if (word.method !== 'kfa' || word.startMs === null || word.endMs === null) continue;
      eligible += 1;
      if (row.variant !== matching?.variant) continue;
      const other = matching.words.find((entry) => entry.method === 'kfa'
        && entry.startOffset === word.startOffset && entry.endOffset === word.endOffset);
      if (other?.startMs == null || other.endMs == null) continue;
      paired.push({ id: row.id, startOffset: word.startOffset, endOffset: word.endOffset, start: word.startMs - other.startMs, end: word.endMs - other.endMs });
    }
  }
  return { eligible, paired, start: distribution(paired.map(({ start }) => Math.abs(start))), end: distribution(paired.map(({ end }) => Math.abs(end))) };
}

try {
  const observations = [];
  let last: Row[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const namespace = `${scope}-${run}`;
    const current = engine(namespace);
    const cpuSamples: number[] = [];
    let prior = os.cpus().map(({ times }) => times);
    const sampler = setInterval(() => {
      const next = os.cpus().map(({ times }) => times);
      let idle = 0;
      let total = 0;
      for (let index = 0; index < next.length; index += 1) {
        idle += next[index].idle - prior[index].idle;
        for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) {
          total += next[index][key] - prior[index][key];
        }
      }
      prior = next;
      if (total > 0) cpuSamples.push(100 * (1 - idle / total));
    }, 1_000);
    sampler.unref();
    let generationPrepareMs: number | undefined;
    if (values['post-generation']) {
      console.log(JSON.stringify({ phase: 'generation-prepare', run }));
      const started = performance.now();
      if (!await prepareTimingLocally(outputPath, namespace)) throw new Error('Generation did not precompute acoustic evidence.');
      generationPrepareMs = performance.now() - started;
    }
    console.log(JSON.stringify({ phase: 'strict-prepare', run }));
    const prepareMs = await current.prepare();
    console.log(JSON.stringify({ phase: 'candidate-engine', run }));
    const cold = await current.measure();
    const warm = await current.measure();
    clearInterval(sampler);
    await closeLocalTimingWorker();
    last = warm.rows;
    await persist(`cold-${run}`, cold.rows);
    await persist(`warm-${run}`, warm.rows);
    await persist(`target-ms-${run}`, warm.targetSamplesMs);
    if (values['trace-windows']) await persist(`windows-${run}`, warm.windowTraces);
    const measurement = {
      run, generationPrepareMs, diagnosticTrace: values['trace-windows'],
      cpu: { logicalProcessors: prior.length, busyPercent: distribution(cpuSamples) },
      prepareMs, coldEngineMs: cold.engineMs, coldTotalMs: prepareMs + cold.engineMs,
      warmEngineMs: warm.engineMs, targetWarmMs: warm.targetMs, ...summarize(warm.rows),
    };
    observations.push(measurement);
    console.log(JSON.stringify({ cohort: values.cohort, ...measurement }));
  }
  if (values['control-wav']) {
    const measured = await engine(`${scope}-control`, control).measure();
    const { paired, ...deltas } = compare(last, measured.rows);
    await persist('control', measured.rows);
    if (values['trace-windows']) await persist('control-windows', measured.windowTraces);
    await persist('paired', paired);
    console.log(JSON.stringify({
      cohort: values.cohort, control: summarize(measured.rows), controlEngineMs: measured.engineMs,
      ...deltas, paired: paired.length, tails: paired.filter(({ start, end }) => Math.max(Math.abs(start), Math.abs(end)) > 250).length,
    }));
  }
  const [lastProjectHash, lastWavHash] = await Promise.all([hash(sourceProject), hash(sourceWav)]);
  if (lastProjectHash !== inputHash || lastWavHash !== wavHash) throw new Error('The source inputs changed during measurement.');
  console.log(JSON.stringify({
    cohort: values.cohort, checked: ids.length, inputHash, wavHash, node: process.version,
    coldTotalMs: distribution(observations.map(({ coldTotalMs }) => coldTotalMs)),
    warmEngineMs: distribution(observations.map(({ warmEngineMs }) => warmEngineMs)),
  }));
} finally {
  await closeLocalTimingWorker();
  // Only the scratch root created by this process contains generated media/cache.
  if (!inRepository(root) && path.dirname(root) === temp) await fs.rm(root, { recursive: true, force: true, maxRetries: 4 });
}
