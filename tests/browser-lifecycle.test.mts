import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { addTestNamespace, createHarnessRun, isolatedEnvironment, prepareOwnedStateRoot, stripTestNamespace, type HarnessConfig } from './browser/harness-config.mjs';
import { cleanupOwnedApiClients, startOwnedApi, stopOwnedApi, type OwnedApi } from './browser/owned-api-harness.mjs';
import { closeOwnedBrowserContext, installBrowserNetworkGuard } from './browser/owned-browser-routes.mjs';

const evidenceRoot = process.env.STHANG_BROWSER_EVIDENCE_ROOT || os.tmpdir();
await fs.mkdir(evidenceRoot, { recursive: true });
const suiteRoot = await fs.mkdtemp(path.join(evidenceRoot, 'browser-lifecycle-'));
const outcomes: Array<Record<string, unknown>> = [];
after(async () => {
  const report = path.join(suiteRoot, 'outcomes.json');
  await fs.writeFile(report, `${JSON.stringify(outcomes, null, 2)}\n`);
  console.log(`Browser lifecycle outcomes: ${report}`);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lifecycle gate did not settle: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function listen(server: net.Server, port: number) {
  server.listen({ port, host: '127.0.0.1', exclusive: true });
  await once(server, 'listening');
}
async function close(server: net.Server) {
  if (server instanceof http.Server) server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function assertPortHeld(port: number) {
  const probe = net.createServer();
  try { await assert.rejects(listen(probe, port), { code: 'EADDRINUSE' }); }
  finally { await close(probe); }
}
async function assertPortReleased(port: number) {
  const probe = net.createServer();
  try { await listen(probe, port); assert.equal(probe.listening, true); }
  finally { await close(probe); }
}

test('held context forwarding drains after page closure without losing route ownership', async () => {
  const cfg = await createHarnessRun(suiteRoot);
  const root = await prepareOwnedStateRoot(cfg, 'held-route-');
  const received = deferred();
  const release = deferred();
  const draining = deferred();
  const requests: Array<{ method?: string; url?: string }> = [];
  const phases: string[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    const logical = stripTestNamespace(request.url || '', cfg);
    if (logical === '/api/video-export/controlled/preview') { received.resolve(); await release.promise; }
    response.writeHead(logical ? 200 : 404, { 'content-type': logical === '/' ? 'text/html' : 'application/json' });
    response.end(logical === '/' ? '<!doctype html><title>Owned lifecycle probe</title>' : '{"ok":true}');
  });
  await listen(server, cfg.webPort);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let disposed = 0;
  let forwarded = 0;
  let cleanup: Promise<void> | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, env: isolatedEnvironment(cfg, root) as Record<string, string> });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const originalRoute = context.route.bind(context);
    context.route = async (pattern, handler, options) => originalRoute(pattern, async (route, request) => {
      if (request.url().endsWith('/preview')) {
        forwarded++;
        const originalFetch = route.fetch.bind(route);
        route.fetch = async (options) => {
          const response = await originalFetch(options);
          const originalDispose = response.dispose.bind(response);
          response.dispose = async () => { await originalDispose(); disposed++; phases.push('response-disposed'); };
          return response;
        };
      }
      await handler(route, request); // Real handler failures must fail this test.
    }, options);
    await installBrowserNetworkGuard(context, cfg);
    const page = await context.newPage();
    const second = await context.newPage();
    await page.route('**/api/video-export/**/preview', (route) => route.fallback());
    await page.goto(cfg.webOrigin);
    await page.evaluate(() => { void fetch('/api/video-export/controlled/preview', { method: 'POST', body: '{}' }).catch(() => {}); });
    await bounded(received.promise, 'owned preview request received');
    await page.goto('about:blank');
    const originalUnroute = context.unrouteAll.bind(context);
    context.unrouteAll = async (options) => {
      assert.equal(page.isClosed(), true);
      assert.equal(second.isClosed(), true);
      assert.equal(disposed, 0, 'response remains held until the actual context drain');
      phases.push('closed-pages-before-context-drain');
      draining.resolve();
      await originalUnroute(options);
    };
    context.once('close', () => phases.push('context-closed'));
    cleanup = closeOwnedBrowserContext(context);
    // The response gate is released by a lifecycle event, not a timing sleep.
    await bounded(Promise.race([draining.promise, cleanup.then(() => { throw new Error('Cleanup skipped the context drain.'); })]), 'closed-page drain entered');
    release.resolve();
    await cleanup;
    assert.equal(forwarded, 1);
    assert.equal(disposed, 1);
    assert.deepEqual(phases, ['closed-pages-before-context-drain', 'response-disposed', 'context-closed']);
    assert.deepEqual(requests, [
      { method: 'GET', url: `${cfg.namespace}/` },
      { method: 'POST', url: `${cfg.namespace}/api/video-export/controlled/preview` },
    ], 'no unprefixed native continuation or duplicate preview');
    outcomes.push({ case: 'held-route', forwarded, disposed, phases, requests });
  } finally {
    release.resolve();
    try { if (cleanup) await cleanup; }
    finally { try { if (browser) await browser.close(); } finally { await close(server); } }
  }
});

for (const failureAt of ['context-drain', 'page-drain', 'page-close'] as const) {
  test(`cleanup preserves a real ${failureAt} error and still closes the context`, async () => {
    const failure = new Error(failureAt === 'page-close' ? 'owned page close failed' : 'route.fulfill: Route is already handled!');
    const calls: string[] = [];
    let closed = false;
    const page = {
      close: async () => { calls.push('page-close'); if (failureAt === 'page-close') throw failure; closed = true; },
      isClosed: () => closed,
      unrouteAll: async () => { calls.push('page-drain'); if (failureAt === 'page-drain') throw failure; },
    } as unknown as Page;
    const context = {
      pages: () => [page],
      unrouteAll: async () => { calls.push('context-drain'); if (failureAt === 'context-drain') throw failure; },
      close: async () => { calls.push('context-close'); closed = true; },
    } as unknown as BrowserContext;
    await assert.rejects(closeOwnedBrowserContext(context), (error) => error === failure);
    assert.equal(calls.at(-1), 'context-close');
    if (failureAt === 'page-close') assert.deepEqual(calls, ['page-close', 'context-close'], 'a still-open page must retain its guard');
    else assert.deepEqual(calls, ['page-close', 'context-drain', 'page-drain', 'context-close']);
    outcomes.push({ case: failureAt, error: failure.message, calls });
  });
}

async function ownedApiFixture() {
  const cfg = await createHarnessRun(suiteRoot);
  const root = await prepareOwnedStateRoot(cfg, 'real-api-');
  const sentinel = path.join(root, 'retained-evidence.txt');
  await fs.writeFile(sentinel, 'owned evidence must survive failed cleanup');
  const web = http.createServer(async (request, response) => {
    const logical = stripTestNamespace(request.url || '', cfg);
    if (logical === '/studio-web-identity.json') {
      response.writeHead(200, { 'X-Sthang-Studio-Activation': cfg.marker, 'content-type': 'application/json' }).end(JSON.stringify({ schemaVersion: 1, service: 'sthang-studio-web', buildId: 'a'.repeat(64) }));
    } else if (logical === '/api/health') {
      try {
        const result = await fetch(`${cfg.apiOrigin}${addTestNamespace(logical, cfg)}`, { redirect: 'error' });
        response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
      } catch { response.writeHead(502).end(); }
    } else response.writeHead(404).end();
  });
  await listen(web, cfg.webPort);
  return { cfg, root, sentinel, web };
}
async function assertStopped(handle: OwnedApi, cfg: HarnessConfig) {
  assert.notEqual(handle.child.exitCode ?? handle.child.signalCode, null);
  assert.throws(() => handle.assertAlive());
  await assertPortReleased(cfg.apiPort);
}

test('the real API exits on owner IPC disconnect and releases only its own listener', async () => {
  const { cfg, root, sentinel, web } = await ownedApiFixture();
  let handle: OwnedApi | undefined;
  try {
    handle = await startOwnedApi(root, { config: cfg });
    await assertPortHeld(cfg.apiPort);
    const exited = once(handle.child, 'exit', { signal: AbortSignal.timeout(5000) });
    handle.child.disconnect();
    const result = await exited;
    await assertStopped(handle, cfg);
    assert.equal(web.listening, true, 'the separately owned listener is untouched');
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'owned evidence must survive failed cleanup');
    outcomes.push({ case: 'owner-disconnect', ownerPid: process.pid, ready: handle.ready, exit: result, rebound: true, independentListenerIntact: web.listening });
  } finally { try { if (handle) await stopOwnedApi(handle); } finally { await close(web); } }
});

test('all cleanup steps run and the real API exit is confirmed even when multiple steps throw', async () => {
  const { cfg, root, sentinel, web } = await ownedApiFixture();
  let handle: OwnedApi | undefined;
  try {
    handle = await startOwnedApi(root, { config: cfg });
    await cleanupOwnedApiClients(handle, [async () => {}]);
    handle.assertAlive(); // Successful per-test cleanup must retain the suite API.
    const first = new Error('first editor cleanup failed');
    const second = new Error('second editor cleanup failed');
    const calls: string[] = [];
    await assert.rejects(cleanupOwnedApiClients(handle, [
      async () => { calls.push('first'); throw first; },
      async () => { calls.push('first-close'); },
      async () => { calls.push('second'); throw second; },
      async () => { calls.push('second-close'); },
    ]), (error) => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === first && error.errors[1] === second);
    assert.deepEqual(calls, ['first', 'first-close', 'second', 'second-close']);
    await assertStopped(handle, cfg);
    assert.equal(web.listening, true);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'owned evidence must survive failed cleanup');
    outcomes.push({ case: 'cleanup-errors', ready: handle.ready, calls, exitCode: handle.child.exitCode, signalCode: handle.child.signalCode, rebound: true });
  } finally { try { if (handle) await stopOwnedApi(handle); } finally { await close(web); } }
});
