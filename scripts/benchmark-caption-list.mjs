import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: npm run benchmark:caption-list -- <new-evidence-directory>');
const directory = path.resolve(output);
await fs.mkdir(directory); // No overwrites, recursive creation, or cleanup of supplied paths.
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, ['scripts/run-browser-tests.mjs', '--config', 'benchmarks/caption-list/playwright.config.ts', '--output', path.join(directory, 'browser'), '--workers=1', '--retries=0'], { cwd: repo, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) { process.exitCode = result.status ?? 1; } else {
  async function collect(folder) {
    const all = [];
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) all.push(...await collect(target));
      else if (entry.name === 'metrics.json') all.push(JSON.parse(await fs.readFile(target, 'utf8')));
    }
    return all;
  }
  const metrics = (await collect(path.join(directory, 'browser'))).sort((a, b) => a.count - b.count);
  if (metrics.map((item) => item.count).join(',') !== '100,500,1500,5000') throw new Error('Incomplete benchmark result.');
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: values.length, medianMs: sorted[Math.floor(sorted.length / 2)] ?? null, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, maximumMs: sorted.at(-1) ?? null };
  };
  const summary = metrics.map((item) => ({ captions: item.count, rows: item.samples.map((s) => s.rows), domNodes: item.samples.map((s) => s.domNodes),
    openToSecondRaf: stats(item.samples.map((s) => s.openMs)), inputToSecondRaf: stats(item.samples.flatMap((s) => s.inputs)),
    scrollFrameGaps: stats(item.samples.flatMap((s) => s.scroll.gapsMs)), scrollGapsOver33ms: item.samples.flatMap((s) => s.scroll.gapsMs).filter((ms) => ms > 33.4).length,
    longTasks: stats(item.samples.flatMap((s) => s.longTasks)), longTaskSupported: item.samples.every((s) => s.longTaskSupported) }));
  const assets = {};
  for (const file of ['index.html', 'studio-web-identity.json', ...(await fs.readdir(path.join(repo, 'apps/web/dist/assets'))).map((name) => `assets/${name}`)]) {
    assets[file] = createHash('sha256').update(await fs.readFile(path.join(repo, 'apps/web/dist', file))).digest('hex');
  }
  const benchmarkSources = {};
  for (const file of ['scripts/benchmark-caption-list.mjs', 'scripts/run-browser-tests.mjs', 'benchmarks/caption-list/caption-list.bench.mts',
    'benchmarks/caption-list/owned-production-child.mts', 'benchmarks/caption-list/playwright.config.ts', 'tests/browser/fixtures.mts',
    'tests/browser/harness-config.mts', 'tests/browser/owned-browser-routes.mts']) {
    benchmarkSources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
  }
  const evidence = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo, encoding: 'utf8' }).trim()),
    runtime: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
    productionAssetSha256: assets, benchmarkSourceSha256: benchmarkSources, summary, metrics,
    limits: ['Synthetic caption-list workload with mocked local API and four-second synthetic media; no playback, generation, native rendering, real user projects or provider calls.',
      'Unthrottled headless Chromium on this machine; no cross-device, production installation or customer-performance claim.',
      'Event to second requestAnimationFrame is a rendering opportunity proxy, not hardware presentation latency or React commit duration.',
      'Five opens and fifty input events per size; scroll gaps include the benchmark driver and headless scheduler. No claimed speedup.'] };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
}
