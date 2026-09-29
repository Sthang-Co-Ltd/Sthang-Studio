import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const required of [
  'apps/server/dist/index.js',
  'apps/web/dist/index.html',
  'packages/shared/dist/index.js',
]) {
  assert.ok(fs.existsSync(path.join(sourceRoot, required)), `Missing curated production output: ${required}`);
}
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'esbuild')), false, 'Curated runtime install must not include esbuild');
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'vite')), false, 'Curated runtime install must not include Vite');
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'tsx')), false, 'Curated runtime install must not include tsx');
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'typescript')), false, 'Curated runtime install must not include TypeScript');
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'react')), false, 'Curated server runtime must not install React');
assert.equal(fs.existsSync(path.join(sourceRoot, 'node_modules', 'lucide-react')), false, 'Curated server runtime must not install web-only UI packages');

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const selected = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sthang-macos-runtime-smoke-'));
fs.mkdirSync(path.join(stateRoot, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(stateRoot, 'uploads', 'untrusted.html'), '<script>window.__shouldNeverRun=true</script>\n', 'utf8');
const child = spawn(process.execPath, [path.join(sourceRoot, 'scripts', 'dev.mjs'), '--production'], {
  cwd: sourceRoot,
  env: {
    ...process.env,
    PORT: String(port),
    KCS_OPEN_BROWSER: 'false',
    STHANG_STUDIO_STATE_ROOT: stateRoot,
    STHANG_STUDIO_ENV_FILE: path.join(stateRoot, '.env'),
    STHANG_STUDIO_DISABLE_UPDATE_EXIT: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

function get(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    request.on('error', () => resolve({ status: 0, body: '', headers: {} }));
    request.setTimeout(1000, () => request.destroy());
  });
}

async function waitFor(url, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const result = await get(url);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Curated production runtime did not become ready: ${url}\n${output.slice(-4000)}`);
}

try {
  const health = await waitFor(`http://127.0.0.1:${port}/api/health`, ({ status, body }) => {
    if (status !== 200) return false;
    try { return JSON.parse(body)?.ok === true; } catch { return false; }
  });
  assert.equal(JSON.parse(health.body).ok, true);
  const page = await waitFor(`http://127.0.0.1:${port}/`, ({ status, body }) => status === 200 && /<div id="root"><\/div>/u.test(body));
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy'] || ''), /default-src 'self'/u);
  assert.match(String(page.headers['content-security-policy'] || ''), /script-src 'self'/u);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  const unknownApi = await get(`http://127.0.0.1:${port}/api/definitely-not-a-route`);
  assert.equal(unknownApi.status, 404, 'Unknown API routes must not fall through to the SPA index');
  const untrustedMedia = await get(`http://127.0.0.1:${port}/media/untrusted.html`);
  assert.equal(untrustedMedia.status, 200);
  assert.match(String(untrustedMedia.headers['content-security-policy'] || ''), /^sandbox; default-src 'none'/u);
  assert.equal(untrustedMedia.headers['x-content-type-options'], 'nosniff');
  console.log('Curated macOS production runtime smoke test passed.');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
    }
  });
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
