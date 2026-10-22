import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CaptionProject, CaptionSegment, TimedToken } from '@kcs/shared';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: npm run benchmark:project-loading -- <new-evidence-directory>');
if (process.platform === 'darwin') throw new Error('Strict credential isolation is not qualified for macOS Keychain.');
const evidence = path.resolve(output);
await fs.mkdir(evidence); // Refuse overwrite; never delete supplied paths.
const scenarios = [
  { name: 'small', projects: 10, captions: 300, rich: false, primary: true },
  { name: 'working', projects: 50, captions: 600, rich: false, primary: true },
  { name: 'large', projects: 100, captions: 1000, rich: false, primary: true },
  { name: 'word-timed', projects: 100, captions: 1000, rich: true, primary: true },
  { name: 'stress', projects: 300, captions: 1000, rich: true, primary: false },
];
const plan = { schemaVersion: 1, createdAt: new Date().toISOString(), repetitions: 7, scenarios,
  gate: { firstListP95Ms: 1000, retainedHeapP95Bytes: 256 * 1024 * 1024,
    decision: 'Consider lazy loading if any primary scenario exceeds either budget; larger stress is reported separately. These are engineering investigation budgets, not a customer SLA.' },
  limits: ['Process-cold store, OS filesystem cache not flushed. Seven samples per scenario.',
    'Synthetic Khmer JSON only, with transcript segments and, in rich cases, word timing and transcript tokens. No media bytes/models/history are loaded.',
    'Measures the actual store first summary call, not whole server startup or HTTP/UI latency. Forced GC estimates retained heap; RSS is diagnostic.',
    'Fresh isolated child per sample; no network/server/listener, real user state, credentials or cloud services. No claimed speedup.'] };
await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-loading-')));
const ownerId = randomUUID();
await fs.writeFile(path.join(temporary, '.benchmark-owner.json'), JSON.stringify({ id: ownerId }));
const sources = ['scripts/benchmark-project-loading.mts', 'benchmarks/project-loading/cold-library-child.mts', 'apps/server/src/services/store.ts',
  'apps/server/src/config.ts', 'apps/server/src/services/prewarm.ts', 'packages/shared/src/index.ts', 'packages/shared/src/project-summary.ts', 'package-lock.json'];
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async (file) => [file, createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex')])));

function corpus(count: number, rich: boolean): Pick<CaptionProject, 'captions' | 'transcript'> {
  const captions: CaptionSegment[] = [], tokens: TimedToken[] = [];
  for (let index = 0; index < count; index++) {
    const startMs = index * 2000;
    const words = ['សួស្តី', 'នេះជាសាកល្បង', `caption-${index}`];
    const text = words.join(' ');
    const caption: CaptionSegment = { id: `cue-${index}`, text, startMs, endMs: startMs + 1800, approved: true, timingSource: 'manual' };
    if (rich) {
      let offset = 0;
      caption.wordTiming = { version: 1, text, words: words.map((word, position) => {
        const from = offset; offset += word.length + 1;
        tokens.push({ id: `token-${index}-${position}`, text: word, startMs: startMs + position * 600, endMs: startMs + (position + 1) * 600,
          spaceBefore: position > 0, timingSource: 'stt', confidence: 1 });
        return { id: `word-${index}-${position}`, startOffset: from, endOffset: from + word.length,
          startMs: startMs + position * 600, endMs: startMs + (position + 1) * 600, source: 'aligned' };
      }) };
    }
    captions.push(caption);
  }
  return { captions, transcript: { language: 'km', fullText: captions.map((item) => item.text).join(' '),
    segments: captions.map(({ wordTiming: _timing, ...item }) => item), ...(rich ? { tokens } : {}) } };
}

type Sample = { importMs: number; firstListMs: number; warmListMs: number; detailMs: number; retainedHeapBytes: number; retainedRssBytes: number; heapAfterBytes: number; rssAfterBytes: number };
function sample(root: string): Promise<Sample> {
  const env = { ...process.env, STHANG_STUDIO_STATE_ROOT: root, STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'),
    STHANG_PROJECT_BENCHMARK_OWNER: ownerId, NODE_OPTIONS: '', LOCALAPPDATA: path.join(root, 'local-app-data'), APPDATA: path.join(root, 'app-data'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), TEMP: root, TMP: root, TMPDIR: root,
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
    STHANG_CONTRIBUTION_ENDPOINT: 'disabled-for-synthetic-benchmark', STHANG_ANALYTICS_ENDPOINT: 'disabled-for-synthetic-benchmark',
    LOCAL_TIMING_PYTHON: path.join(root, 'absent-python.exe') };
  return new Promise((resolve, reject) => {
    const child = fork(path.join(repo, 'benchmarks/project-loading/cold-library-child.mts'), [], { cwd: repo,
      execPath: process.execPath, execArgv: ['--expose-gc', '--import', 'tsx'], env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let message: Sample | { error: string } | undefined;
    const timer = setTimeout(() => child.kill(), 30_000);
    child.once('message', (value) => { message = value as typeof message; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Owned benchmark child could not start.')); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !message || 'error' in message) reject(new Error('Owned benchmark child failed; no performance result accepted.'));
      else resolve(message);
    });
  });
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], maximum: sorted.at(-1) };
};
try {
  const results = [];
  for (const scenario of scenarios) {
    const root = await fs.realpath(await fs.mkdir(path.join(temporary, scenario.name)).then(() => path.join(temporary, scenario.name)));
    const directory = path.join(root, 'data/projects'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(root, '.benchmark-owner.json'), JSON.stringify({ kind: 'synthetic-project-loading', id: ownerId, ...scenario }));
    const contents = corpus(scenario.captions, scenario.rich);
    const files: string[] = [], originalHashes: string[] = []; let totalBytes = 0;
    for (let index = 0; index < scenario.projects; index++) {
      const id = `synthetic-${index}`;
      const project: CaptionProject = { id, title: `Synthetic ខ្មែរ ${index}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', mode: 'phrase',
        media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 5000, url: `/media/${id}.mp4` }, ...contents };
      const bytes = JSON.stringify(project) + '\n'; const file = path.join(directory, `${id}.json`);
      await fs.writeFile(file, bytes); files.push(file); originalHashes.push(createHash('sha256').update(bytes).digest('hex')); totalBytes += Buffer.byteLength(bytes);
    }
    await fs.writeFile(path.join(directory, 'order.json'), JSON.stringify(Array.from({ length: scenario.projects }, (_, index) => `synthetic-${index}`)) + '\n');
    await fs.writeFile(path.join(directory, '.per-project-v1'), 'Sthang Studio per-project storage v1\n');
    const beforeNames = (await fs.readdir(directory)).sort();
    const samples: Sample[] = [];
    for (let repetition = 0; repetition < plan.repetitions; repetition++) samples.push(await sample(root));
    assert.deepEqual((await fs.readdir(directory)).sort(), beforeNames);
    for (let index = 0; index < files.length; index++) assert.equal(createHash('sha256').update(await fs.readFile(files[index])).digest('hex'), originalHashes[index], 'Read-only loading must preserve every synthetic project byte.');
    const firstListMs = stats(samples.map((item) => item.firstListMs)), retainedHeapBytes = stats(samples.map((item) => item.retainedHeapBytes));
    const result = { ...scenario, totalBytes, firstListMs, retainedHeapBytes, warmListMs: stats(samples.map((item) => item.warmListMs)),
      detailMs: stats(samples.map((item) => item.detailMs)), importMs: stats(samples.map((item) => item.importMs)), samples,
      exceedsPrimaryBudget: scenario.primary && (firstListMs.p95 > plan.gate.firstListP95Ms || retainedHeapBytes.p95 > plan.gate.retainedHeapP95Bytes) };
    results.push(result);
    await fs.writeFile(path.join(evidence, `${scenario.name}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ scenario: scenario.name, firstListP95Ms: firstListMs.p95, retainedHeapP95MiB: retainedHeapBytes.p95 / 1024 ** 2, exceedsPrimaryBudget: result.exceedsPrimaryBudget }));
  }
  for (const [file, hash] of Object.entries(sourceSha256)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex'), hash, 'Benchmark source changed during measurement.');
  const report = { plan, completedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()), sourceSha256,
    runtime: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
    results, primaryBudgetExceeded: results.some((item) => item.exceedsPrimaryBudget) };
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
} finally {
  const actual = await fs.realpath(temporary);
  assert.equal(actual, temporary);
  assert.ok(path.dirname(actual) === await fs.realpath(os.tmpdir()) && path.basename(actual).startsWith('studio-project-loading-'));
  assert.equal(JSON.parse(await fs.readFile(path.join(actual, '.benchmark-owner.json'), 'utf8')).id, ownerId);
  await fs.rm(actual, { recursive: true, force: true });
}
