import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarnessRun, isolatedEnvironment, prepareOwnedStateRoot } from '../tests/browser/harness-config.mts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Resolve installed browser locations before redirecting credential-store paths.
const browserEnv = {};
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) browserEnv.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = path.resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
if (process.env.PLAYWRIGHT_BROWSERS_PATH) browserEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH === '0' ? '0' : path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
else if (process.platform === 'win32') browserEnv.PLAYWRIGHT_BROWSERS_PATH = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
else if (process.platform === 'linux') browserEnv.PLAYWRIGHT_BROWSERS_PATH = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
const cfg = await createHarnessRun(process.env.STHANG_BROWSER_EVIDENCE_ROOT || os.tmpdir());
const runnerRoot = await prepareOwnedStateRoot(cfg, 'runner-');
const env = { ...isolatedEnvironment(cfg, runnerRoot), ...browserEnv };
console.log(`Owned browser run: ${JSON.stringify({ root: cfg.runRoot, apiPort: cfg.apiPort, webPort: cfg.webPort })}`);
async function run(args) {
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: 'inherit', windowsHide: true });
  const forwardInterrupt = () => child.kill();
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardInterrupt);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => { process.off('SIGINT', forwardInterrupt); process.off('SIGTERM', forwardInterrupt); resolve(code ?? 1); });
  });
}
const guards = await run(['--import', 'tsx', '--test', 'tests/browser-api-isolation.test.mts']);
let result = guards;
if (guards === 0) result = await run(['--import', 'tsx', 'node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)]);
await fs.writeFile(path.join(cfg.runRoot, 'run-result.json'), JSON.stringify({ exitCode: result, apiPort: cfg.apiPort, webPort: cfg.webPort }));
process.exitCode = result;
