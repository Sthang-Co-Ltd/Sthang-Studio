import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

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
    console.error('Close the older Sthang Studio terminal. If needed, run taskkill /PID <PID> /T /F.\n');
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

console.log('Starting backend on http://localhost:8787');
// This is an end-user runtime, not a source-code development session.
// Keep the backend stable during long transcription jobs.
launch('server', ['--import', 'tsx', 'src/index.ts'], path.join(root, 'apps', 'server'));
console.log('Starting web app on http://localhost:5188');
launch('web', [vite, '--host', '127.0.0.1'], path.join(root, 'apps', 'web'));

function urlReady(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) {
          resolve(true);
          return;
        }
        schedule();
      });
      request.setTimeout(1200, () => request.destroy());
      request.on('error', schedule);
    };
    const schedule = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(attempt, 250);
    };
    attempt();
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

if (process.platform === 'win32' && process.env.KCS_OPEN_BROWSER !== 'false') {
  void Promise.all([
    urlReady('http://127.0.0.1:8787/api/health'),
    urlReady('http://127.0.0.1:5188/'),
  ]).then(([backendReady, webReady]) => {
    if (!backendReady || !webReady || stopping) return;
    openWindowsBrowser('http://127.0.0.1:5188/');
  });
}
