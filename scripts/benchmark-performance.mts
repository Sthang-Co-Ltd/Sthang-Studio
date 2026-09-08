import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { CaptionProject, CaptionSegment } from '../packages/shared/src/index.js';
import { summarizeProject } from '../packages/shared/src/project-summary.js';
import { captionIndices, selectedCaptionRange } from '../apps/web/src/caption-selection.js';
import { buildWaveformPeaks, waveformExtrema, type WaveformPeaks } from '../apps/web/src/audio/peaks.js';
import { atomicJobWrite, createJobPersistence } from '../apps/server/src/services/job-persistence.js';

// Synthetic data only. No server configuration, credentials, live app, models or network.
const output = process.argv[2];
if (!output) throw new Error('Usage: npm run benchmark:performance -- <new-output.json>');
await fs.access(output).then(() => { throw new Error('Refusing to overwrite an existing evidence file.'); }, () => {});
const seed = 731;
let state = seed;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
let sink = 0;
function captions(count: number): CaptionSegment[] {
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}`, startMs: i * 1000, endMs: i * 1000 + 900, text: `ខ្មែរ caption ${i}` }));
}
function stats(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { samplesMs, count: sorted.length, medianMs: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], minMs: sorted[0], maxMs: sorted.at(-1) };
}
function measure(operation: () => number, repetitions = 20) {
  for (let i = 0; i < 3; i += 1) sink += operation();
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i += 1) { const start = performance.now(); sink += operation(); samples.push(performance.now() - start); }
  return stats(samples);
}

const selections = [50, 250, 1000, 5000].map((count) => {
  const cues = captions(count), anchor = cues.at(-2)!.id, end = cues.at(-1)!.id;
  const ids = captionIndices(cues); const a = ids.get(anchor)!, b = ids.get(end)!;
  const expected = selectedCaptionRange(cues, a, b);
  // This measures repeated resolution versus reuse, not React, input latency, or FPS.
  const baseline = measure(() => {
    let total = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      const first = cues.findIndex((cue) => cue.id === anchor), last = cues.findIndex((cue) => cue.id === end);
      total += selectedCaptionRange(cues, first, last).ids.length;
    }
    return total;
  });
  const reuse = measure(() => { let total = 0; for (let tick = 0; tick < 200; tick += 1) total += expected.ids.length; return total; });
  const rebuild = measure(() => captionIndices(cues).size);
  return { count, ticks: 200, baseline, reuse, indexBuild: rebuild };
});

const libraries = [1, 10, 100].map((count) => {
  const projects: CaptionProject[] = Array.from({ length: count }, (_, i) => {
    const cues = captions(1000);
    return { id: `p${i}`, title: `Synthetic ${i}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      media: { filename: 'synthetic.wav', originalName: 'synthetic.wav', size: 1, mimeType: 'audio/wav', url: '/synthetic.wav' },
      captions: cues, transcript: { language: 'km', fullText: cues.map((cue) => cue.text).join(' '), segments: cues }, mode: 'phrase' };
  });
  const summaries = projects.map(summarizeProject);
  return { count, captionsEach: 1000, fullClone: measure(() => structuredClone(projects).length), summaryProjection: measure(() => projects.map(summarizeProject).length),
    fullUtf8Bytes: Buffer.byteLength(JSON.stringify(projects)), summaryUtf8Bytes: Buffer.byteLength(JSON.stringify(summaries)) };
});

const waveforms = [];
for (const seconds of [30, 300]) {
  const sampleRate = 16000, samples = Float32Array.from({ length: seconds * sampleRate }, () => random() * 2 - 1);
  const hash = createHash('sha256').update(Buffer.from(samples.buffer)).digest('hex');
  const buildTimes: number[] = []; let peaks: WaveformPeaks | null = null;
  for (let repeat = 0; repeat < 3; repeat += 1) { const start = performance.now(); peaks = await buildWaveformPeaks(samples); buildTimes.push(performance.now() - start); }
  const width = 901, startSample = 8001, span = sampleRate * 20;
  const ranges = Array.from({ length: width }, (_, x) => ({ from: Math.floor(startSample + x * span / width), to: Math.ceil(startSample + (x + 1) * span / width) }));
  for (const range of ranges) assert.deepEqual(waveformExtrema(samples, peaks, range.from, range.to), waveformExtrema(samples, null, range.from, range.to));
  const draw = (cache: WaveformPeaks | null) => ranges.reduce((total, range) => { const value = waveformExtrema(samples, cache, range.from, range.to); return total + value.max - value.min; }, 0);
  waveforms.push({ seconds, sampleRate, pcmSha256: hash, visibleSeconds: 20, width, peakBytes: peaks!.byteLength,
    peakPreparationWallTime: stats(buildTimes), rawRangeQueries: measure(() => draw(null)), cachedRangeQueries: measure(() => draw(peaks)) });
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-perf-benchmark-'));
let jobsResult: unknown;
try {
  async function run(coalesced: boolean) {
    let now = 0;
    const tasks = new Set<{ at: number; callback(): void }>();
    const scheduler = { schedule(callback: () => void, delay: number) { const task = { at: now + delay, callback }; tasks.add(task); return () => { tasks.delete(task); }; } };
    const jobs = [{ id: 'export', type: 'export-video', status: 'running', progress: 0, payload: { exportCaptions: captions(1000) } }];
    const samplesMs: number[] = []; let bytes = 0, lastWrite = Promise.resolve();
    const write = (contents: string) => {
      lastWrite = (async () => { const start = performance.now(); await atomicJobWrite(path.join(temporary, 'jobs.json'), contents); samplesMs.push(performance.now() - start); bytes += Buffer.byteLength(contents); })();
      return lastWrite;
    };
    const failures: unknown[] = [];
    const persistence = createJobPersistence(() => jobs, write, (error) => failures.push(error), scheduler);
    await persistence.flush();
    for (let i = 1; i <= 50; i += 1) {
      jobs[0].progress = i;
      if (coalesced) persistence.progress(); else await persistence.flush();
      now += 500;
      for (const task of [...tasks]) if (task.at <= now) { tasks.delete(task); task.callback(); }
      await Promise.resolve(); await lastWrite;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    jobs[0].status = 'failed'; await persistence.flush();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, 'jobs.json'), 'utf8')), jobs);
    assert.deepEqual(failures, []);
    assert.equal(tasks.size, 0);
    return { writes: samplesMs.length, utf8BytesWritten: bytes, writeWallTime: stats(samplesMs) };
  }
  jobsResult = { qualification: '50 synthetic progress events at a controlled 500ms cadence; real atomic file writes drained between events. Not an FFmpeg end-to-end benchmark.', baseline: await run(false), coalesced: await run(true) };
} finally { await fs.rm(temporary, { recursive: true, force: true }); }

const script = fileURLToPath(import.meta.url);
const result = { schemaVersion: 1, seed, createdAt: new Date().toISOString(), node: process.version, platform: process.platform,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  measuredSourceSha256: Object.fromEntries(await Promise.all([
    'packages/shared/src/project-summary.ts', 'apps/web/src/caption-selection.ts',
    'apps/web/src/audio/peaks.ts', 'apps/server/src/services/job-persistence.ts',
  ].map(async (file) => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),
  scriptSha256: createHash('sha256').update(await fs.readFile(script)).digest('hex'),
  qualification: 'Synthetic source-helper measurements. No browser, real Gemini/KFA, native render, cold launch or whole-app speedup is measured.',
  selections, libraries, waveforms, jobs: jobsResult, consumedResult: sink };
await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(`Synthetic performance evidence written to ${output}`);
