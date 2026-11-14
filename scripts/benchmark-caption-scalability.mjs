import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: node scripts/benchmark-caption-scalability.mjs <new-evidence-directory> (build first)');
const directory = path.resolve(output);
await fs.mkdir(directory); // Evidence is never overwritten or recursively deleted.
const hash = async file => createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
const startedAt = new Date().toISOString();
const sourceFiles = ['scripts/benchmark-caption-scalability.mjs', 'playwright.config.ts', 'benchmarks/caption-list/scalability.bench.mts', 'benchmarks/caption-list/scalability.config.ts', 'benchmarks/caption-list/playwright.config.ts',
  'benchmarks/caption-list/owned-production-child.mts', 'scripts/run-browser-tests.mjs', 'tests/browser/fixtures.mts', 'tests/browser/harness-config.mts', 'tests/browser/owned-browser-routes.mts'];
const benchmarkSources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await hash(file)])));
const assetFiles = ['index.html', 'studio-web-identity.json', ...(await fs.readdir(path.join(repo,'apps/web/dist/assets'))).map(file=>`assets/${file}`)];
const assets = Object.fromEntries(await Promise.all(assetFiles.map(async file=>[file,await hash(`apps/web/dist/${file}`)])));
const result = spawnSync(process.execPath, ['scripts/run-browser-tests.mjs', '--config', 'benchmarks/caption-list/scalability.config.ts', '--output', path.join(directory,'browser'), '--workers=1', '--retries=0'], { cwd: repo, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
  async function collect(folder) {
    const all = [];
    for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
      const target=path.join(folder,entry.name);
      if(entry.isDirectory()) all.push(...await collect(target));
      else if(entry.name==='metrics.json') all.push(JSON.parse(await fs.readFile(target,'utf8')));
    }
    return all;
  }
  const metrics=(await collect(path.join(directory,'browser'))).sort((a,b)=>a.summary.cpu-b.summary.cpu||a.summary.count-b.summary.count);
  if(metrics.map(m=>`${m.summary.cpu}:${m.summary.count}`).join(',')!=='1:100,1:500,1:1500,1:5000,4:100,4:500,4:1500,4:5000') throw new Error('Incomplete scalability evidence.');
  for(const file of sourceFiles) if(await hash(file)!==benchmarkSources[file]) throw new Error(`Benchmark changed during measurement: ${file}`);
  for(const file of assetFiles) if(await hash(`apps/web/dist/${file}`)!==assets[file]) throw new Error(`Production asset changed during measurement: ${file}`);
  const report={schemaVersion:1,startedAt,completedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
    runtime:{node:process.version,platform:process.platform,release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem()},
    benchmarkSourceSha256:benchmarkSources,productionAssetSha256:assets,summary:metrics.map(m=>m.summary),metrics};
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report.summary,null,2));
}
