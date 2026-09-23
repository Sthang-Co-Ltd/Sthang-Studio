import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('Timed out waiting for watcher state.')); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

test('source watcher ignores dependency/build/runtime churn but restarts for server source', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-source-watch-'));
  const serverDir = path.join(fixture, 'apps', 'server');
  const srcDir = path.join(serverDir, 'src');
  const dependencyDir = path.join(fixture, 'node_modules', 'fake-dependency');
  const sharedDistDir = path.join(fixture, 'packages', 'shared', 'dist');
  const dataDir = path.join(fixture, 'data');
  await Promise.all([
    fs.mkdir(srcDir, { recursive: true }),
    fs.mkdir(dependencyDir, { recursive: true }),
    fs.mkdir(sharedDistDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(srcDir, 'local.mjs'), 'export const local = 1;\n');
  await fs.writeFile(path.join(dependencyDir, 'index.mjs'), 'export const dependency = 1;\n');
  await fs.writeFile(path.join(sharedDistDir, 'index.mjs'), 'export const shared = 1;\n');
  await fs.writeFile(path.join(srcDir, 'index.mjs'), [
    "import './local.mjs';",
    "import '../../../node_modules/fake-dependency/index.mjs';",
    "import '../../../packages/shared/dist/index.mjs';",
    "console.log(`WATCH_START ${process.pid}`);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [
    tsx,
    'watch',
    '--exclude', '../../node_modules/**',
    '--exclude', '../../packages/shared/dist/**',
    'src/index.mjs',
  ], {
    cwd: serverDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  t.after(async () => {
    stopTree(child);
    await fs.rm(fixture, { recursive: true, force: true });
  });

  let starts = 0;
  let output = '';
  const collect = (chunk) => {
    output += chunk.toString();
    starts = (output.match(/WATCH_START /g) || []).length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  await waitFor(() => starts === 1);

  await fs.writeFile(path.join(dependencyDir, 'index.mjs'), 'export const dependency = 2;\n');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(starts, 1, 'node_modules dependency changes must not restart the backend');

  await fs.writeFile(path.join(sharedDistDir, 'index.mjs'), 'export const shared = 2;\n');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(starts, 1, 'generated shared build output must not restart the backend');

  await fs.writeFile(path.join(dataDir, 'runtime.json'), '{"value":1}\n');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(starts, 1, 'runtime state changes must not restart the backend');

  await fs.writeFile(path.join(srcDir, 'local.mjs'), 'export const local = 2;\n');
  await waitFor(() => starts === 2);
  assert.equal(starts, 2, 'server source changes must still restart the backend');

  await fs.writeFile(path.join(srcDir, 'local.mjs'), 'export const local = 3;\n');
  await waitFor(() => starts === 3);
});
