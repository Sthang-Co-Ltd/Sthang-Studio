import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeWorkspaceLinks } from './runtime-workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const sourceWatch = process.argv?.includes('--source-watch') ?? false;

await ensureRuntimeWorkspaceLinks(root);

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function windowsPortOwner(port) {
  if (process.platform !== 'win32') return '';
  const command = `$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\"; Write-Output (\"PID \"+$c.OwningProcess+\" · \"+$p.Name+\" · \"+$p.CommandLine)}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  return result.stdout?.trim() || '';
}

for (const [port, label] of [[8787, 'backend'], [5188, 'web app']]) {
  if (!(await portAvailable(port))) {
    console.error(`\nERROR: Port ${port} is already in use, so the ${label} cannot start.`);
    const owner = windowsPortOwner(port);
    if (owner) console.error(`Owner: ${owner}`);
    if (process.platform === 'win32') {
      console.error('Close the older Sthang Studio terminal. If needed, run taskkill /PID <PID> /T /F.\n');
    } else if (process.platform === 'darwin') {
      console.error(`Close the older Sthang Studio terminal. If needed, run lsof -nP -iTCP:${port} -sTCP:LISTEN to find the process.\n`);
    } else {
      console.error('Close the older Sthang Studio terminal, then stop the process that owns this port.\n');
    }
    process.exit(1);
  }
}

console.log('Preparing shared caption package...');
const sharedBuild = spawnSync(node, [tsc, '-p', path.join(root, 'packages', 'shared', 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (sharedBuild.status !== 0) process.exit(sharedBuild.status ?? 1);

const children = [];
let stopping = false;
const startup = new AbortController();
function terminateChildTree(child) {
  if (!child?.pid || child.killed) return;
  if (process.platform === 'win32') {
    // Node and Vite can spawn descendants. Kill the whole tree so closing the
    // launcher never leaves a stale server holding ports 8787/5188.
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  startup.abort();
  for (const child of children) terminateChildTree(child);
  setTimeout(() => process.exit(code), 150);
}
function launch(name, args, cwd) {
  const child = spawn(node, args, { cwd, stdio: 'inherit', shell: false, env: process.env });
  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      if (name === 'server' && code === 42 && !signal) {
        console.log('Studio is closing to apply a verified update.');
        shutdown(42);
        return;
      }
      console.error(`[${name}] stopped unexpectedly${signal ? ` (${signal})` : ` with exit code ${code}`}.`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** A bounded local readiness probe, not a fixed startup sleep. HTTP errors,
 * incomplete responses and a backend that reports ok:false are not readiness.
 * Keep all timers/sockets cancellable so shutdown can never launch the next service.
 */
function urlReady(url, { health = false, signal, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let retryTimer;
    let requestTimer;
    let request;
    let response;
    const clearAttempt = () => {
      clearTimeout(requestTimer);
      response?.destroy();
      request?.destroy();
      response = undefined;
      request = undefined;
    };
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      signal?.removeEventListener('abort', abort);
      clearAttempt();
      resolve(ready);
    };
    const abort = () => finish(false);
    // This deadline also bounds a server that accepts TCP but never finishes HTTP.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    const attempt = () => {
      if (settled) return;
      let completed = false;
      const complete = (ready) => {
        if (completed || settled) return;
        completed = true;
        clearAttempt();
        if (ready) finish(true);
        else retryTimer = setTimeout(attempt, 250);
      };
      request = http.get(url, { agent: false }, (incoming) => {
        if (completed || settled) { incoming.destroy(); return; }
        response = incoming;
        incoming.on('error', () => complete(false));
        incoming.on('aborted', () => complete(false));
        if (incoming.statusCode !== 200) { complete(false); return; }
        let bytes = 0;
        const chunks = [];
        incoming.on('data', (chunk) => {
          if (!health) return;
          bytes += chunk.length;
          if (bytes > 64 * 1024) { complete(false); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (!health) { complete(true); return; }
          try { complete(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ok === true); }
          catch { complete(false); }
        });
      });
      request.on('error', () => complete(false));
      // A real per-attempt deadline, including body reads (not merely socket inactivity).
      requestTimer = setTimeout(() => complete(false), 1200);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else attempt();
  });
}

function windowsUserHttpChoiceAvailable() {
  const result = spawnSync('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && /\bProgId\b\s+REG_SZ\s+\S+/i.test(result.stdout || '');
}

function openWindowsBrowser(url) {
  if (!windowsUserHttpChoiceAvailable()) {
    console.warn(`Sthang Studio is ready. Windows has no registered browser for web links. Open ${url} manually.`);
    return;
  }

  console.log(`Sthang Studio is ready. Opening ${url} in your default browser...`);
  const escapedUrl = url.replaceAll("'", "''");
  const command = `Start-Process -FilePath '${escapedUrl}'`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });

  if (result.status !== 0) {
    console.warn(`Could not open a browser automatically. Open ${url} in your preferred browser.`);
  }
}

function openMacBrowser(url) {
  console.log(`Sthang Studio is ready. Opening ${url} in your default browser...`);
  const result = spawnSync('/usr/bin/open', [url], { stdio: 'ignore' });
  if (result.status !== 0) {
    console.warn(`Could not open a browser automatically. Open ${url} in your preferred browser.`);
  }
}

async function startServices() {
  console.log('Starting backend on http://localhost:8787');
  // Installed launchers call this script without --source-watch so long-running
  // caption jobs stay stable. `npm run dev` opts into a source watcher so backend
  // TypeScript changes cannot leave Vite and the API on different code.
  //
  // Use tsx's cross-platform watcher rather than Node's native --watch import graph.
  // Native watch follows imported node_modules, so package-manager/AV timestamp
  // churn can restart the API mid-job. Generated shared/dist output is also
  // excluded because normal tests/builds rewrite it. Shared source changes require
  // a deliberate rebuild/relaunch; arbitrary build output is never restart authority.
  const serverArgs = !sourceWatch
    ? ['--import', 'tsx', 'src/index.ts']
    : [
      tsx,
      'watch',
      '--exclude', '../../node_modules/**',
      '--exclude', '../../packages/shared/dist/**',
      'src/index.ts',
    ];
  if (sourceWatch) console.log('Source backend watch: server source only (dependencies/build output ignored).');
  launch('server', serverArgs, path.join(root, 'apps', 'server'));
  console.log('Waiting for the local backend to be ready...');
  const backendReady = await urlReady('http://127.0.0.1:8787/api/health', { health: true, signal: startup.signal });
  if (stopping) return;
  if (!backendReady) {
    console.error('ERROR: The local backend did not become ready within 30 seconds. The web app was not started. Close this window, check the error above, and try launching Studio again.');
    shutdown(1);
    return;
  }

  // Gate Vite itself, not just browser opening: an existing tab may reconnect to
  // /api/jobs/events as soon as Vite listens. This also applies to manual/no-browser launches.
  console.log('Starting web app on http://localhost:5188');
  launch('web', [vite, '--host', '127.0.0.1'], path.join(root, 'apps', 'web'));
  const webReady = await urlReady('http://127.0.0.1:5188/', { signal: startup.signal });
  if (stopping) return;
  if (!webReady) {
    console.error('ERROR: The web app did not become ready within 30 seconds. Studio is stopping its local services. Close this window, check the error above, and try launching Studio again.');
    shutdown(1);
    return;
  }

  const url = 'http://127.0.0.1:5188/';
  if (process.env.KCS_OPEN_BROWSER !== 'false' && process.platform === 'win32') openWindowsBrowser(url);
  else if (process.env.KCS_OPEN_BROWSER !== 'false' && process.platform === 'darwin') openMacBrowser(url);
  else console.log(`Sthang Studio is ready. Open ${url} in your preferred browser.`);
}

await startServices().catch(() => {
  if (stopping) return;
  console.error('ERROR: Studio could not finish startup. Close this window, check the error above, and try launching Studio again.');
  shutdown(1);
});
