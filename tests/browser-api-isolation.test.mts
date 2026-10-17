import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { APIResponse, BrowserContext, Route } from '@playwright/test';
import {
  addTestNamespace, createHarnessRun, guardNamespacedRequest, isolatedEnvironment,
  prepareOwnedStateRoot, requireHarnessConfig, safeFrontendUrl, stripTestNamespace, verifyOwnedStateRoot,
  type HarnessConfig,
} from './browser/harness-config.mjs';
import {
  assertOwnedReady, startOwnedApi, stopOwnedApi, verifyOwnedHealth,
  type OwnedApiExpected,
} from './browser/owned-api-harness.mjs';
import {
  continueNativeExportRoute, continueOwnedRoute, fetchOwnedRoute, installBrowserNetworkGuard,
  installNativeExportGuard, ownedNativeExportUrl,
} from './browser/owned-browser-routes.mjs';

// This suite starts controlled HTTP fixtures and one installed Chromium, never Studio.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = process.env.STHANG_BROWSER_EVIDENCE_ROOT
  ? path.resolve(process.env.STHANG_BROWSER_EVIDENCE_ROOT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'studio-browser-isolation-evidence-'));
await fs.mkdir(evidenceRoot, { recursive: true });
const suiteRoot = await fs.mkdtemp(path.join(evidenceRoot, 'isolation-adversarial-'));
const childEntry = path.join(repoRoot, 'tests', 'fixtures', 'browser-owned-api-child.mts');
const liveServers = new Set<http.Server>();
type Handle = Awaited<ReturnType<typeof startOwnedApi>>;
const liveChildren = new Set<Handle>();
const outcomes: Array<Record<string, unknown>> = [];

async function listen(server: http.Server, port = 0) {
  liveServers.add(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}
async function close(server: http.Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  liveServers.delete(server);
}
async function stop(handle: Handle) {
  await stopOwnedApi(handle);
  liveChildren.delete(handle);
}
after(async () => {
  for (const handle of liveChildren) await stop(handle);
  for (const server of liveServers) await close(server);
  const report = path.join(suiteRoot, 'outcomes.json');
  await fs.writeFile(report, `${JSON.stringify({ suiteRoot, outcomes }, null, 2)}\n`);
  console.log(`Isolation adversarial outcomes: ${report}`);
});
async function setup(options: Record<string, unknown> = {}) {
  const config = await createHarnessRun(suiteRoot);
  const root = await prepareOwnedStateRoot(config, 'adversarial-child');
  await fs.writeFile(path.join(root, 'fake-options.json'), JSON.stringify(options));
  return { config, root };
}
async function events(root: string) {
  const contents = await fs.readFile(path.join(root, 'fake-events.ndjson'), 'utf8').catch(() => '');
  return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function expected(handle: Handle, config: HarnessConfig, root: string): OwnedApiExpected {
  assert.ok(handle.child.pid);
  return { pid: handle.child.pid, marker: config.marker, root, port: config.apiPort };
}
async function webFixture(config: HarnessConfig, options: { proxyOrigin?: string; wrongMarker?: boolean; redirectTarget?: string } = {}) {
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    // Rebind tests must reach the new controlled listener, rather than race a
    // pooled health-check socket that the old fixture has just closed.
    response.setHeader('Connection', 'close');
    const logical = stripTestNamespace(request.url || '', config);
    if (!logical) { response.writeHead(404).end(); return; }
    if (logical === '/studio-web-identity.json') {
      response.setHeader('X-Sthang-Studio-Activation', options.wrongMarker ? 'wrong-web-marker' : config.marker);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ schemaVersion: 1, service: 'sthang-studio-web', buildId: 'a'.repeat(64) }));
      return;
    }
    if (options.redirectTarget) { response.writeHead(302, { location: options.redirectTarget }).end(); return; }
    try {
      const result = await fetch(`${options.proxyOrigin || config.apiOrigin}${addTestNamespace(logical, config)}`, { redirect: 'error' });
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), connection: 'close' });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(502).end(); }
  });
  await listen(server, config.webPort);
  return { server, requests };
}
async function start(root: string, config: HarnessConfig) {
  const handle = await startOwnedApi(root, { config, entry: childEntry, timeoutMs: 15_000 });
  liveChildren.add(handle);
  return handle;
}

test('an occupied chosen API port never receives HTTP or profile mutations', async () => {
  const { config, root } = await setup();
  const foreignRequests: string[] = [];
  const occupant = http.createServer((request, response) => {
    foreignRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await listen(occupant, config.apiPort);
  const web = await webFixture(config);
  try {
    await assert.rejects(start(root, config), /occupied|in use|EADDRINUSE|bind|exited|closed|listen/i);
    assert.deepEqual(foreignRequests, []);
    assert.deepEqual(web.requests, []);
    const recorded = await events(root);
    assert.ok(recorded.some((event) => event.type === 'bind-failed' && event.code === 'EADDRINUSE'), 'exercise an actual owned-child bind failure');
    outcomes.push({ case: 'occupied-port', foreignRequests, childEvents: recorded });
  } finally { await close(web.server); await close(occupant); }
});

for (const field of ['wrong-marker', 'wrong-pid', 'wrong-root', 'wrong-port', 'wrong-address']) {
  test(`READY ${field} is rejected before the first HTTP request`, async () => {
    const { config, root } = await setup({ ready: field });
    const web = await webFixture(config);
    try {
      await assert.rejects(start(root, config));
      const recorded = await events(root);
      assert.equal(recorded.filter((event) => event.type === 'ready-sent').length, 1, 'exercise the intended malformed IPC branch');
      assert.equal(recorded.filter((event) => event.type === 'http').length, 0);
      assert.deepEqual(web.requests, []);
      outcomes.push({ case: field, childEvents: recorded, webRequests: web.requests });
    } finally { await close(web.server); }
  });
}

test('a child that exits before READY cannot authorize any HTTP', async () => {
  const { config, root } = await setup({ earlyExit: true });
  const web = await webFixture(config);
  try {
    await assert.rejects(start(root, config), /exited|closed|READY|ready/i);
    const recorded = await events(root);
    assert.equal(recorded.filter((event) => event.type === 'started').length, 1);
    assert.equal(recorded.filter((event) => event.type === 'http').length, 0);
    assert.deepEqual(web.requests, []);
  } finally { await close(web.server); }
});

test('normal owned startup performs health GETs, with no HTTP profile initialization', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  try {
    handle = await start(root, config);
    handle.assertAlive();
    const requests = (await events(root)).filter((event) => event.type === 'http');
    assert.equal(requests.length, 2, 'one direct and one proxied health check');
    assert.ok(requests.every((event) => event.method === 'GET' && stripTestNamespace(String(event.url), config) === '/api/health'));
    assert.equal((await events(root)).filter((event) => event.type === 'profile-mutation').length, 0);
    assert.ok(web.requests.every((request) => request.method === 'GET'));
    assert.ok(web.requests.every((request) => request.url?.startsWith(`${config.namespace}/`)), 'frontend health and identity must be namespaced before HTTP');
    outcomes.push({ case: 'owned-startup', childEvents: await events(root), webRequests: web.requests });
  } finally { if (handle) await stop(handle); await close(web.server); }
});

test('wrong direct health identity stops before proxy HTTP or mutations', async () => {
  const { config, root } = await setup({ health: 'wrong-marker' });
  const web = await webFixture(config);
  try {
    await assert.rejects(start(root, config));
    assert.deepEqual(web.requests, []);
    const recorded = await events(root);
    assert.equal(recorded.filter((event) => event.type === 'http').length, 1, 'the direct identity check must run before rejecting');
    assert.equal(recorded.filter((event) => event.type === 'profile-mutation').length, 0);
  } finally { await close(web.server); }
});

test('direct health redirects are rejected without contacting their target', async () => {
  const redirects: string[] = [];
  const target = http.createServer((request, response) => { redirects.push(`${request.method} ${request.url}`); response.end('{}'); });
  const targetPort = await listen(target);
  const { config, root } = await setup({ health: 'redirect', redirectTarget: `http://127.0.0.1:${targetPort}/api/profile` });
  const web = await webFixture(config);
  try {
    await assert.rejects(start(root, config));
    assert.deepEqual(redirects, []);
    assert.deepEqual(web.requests, []);
    assert.equal((await events(root)).filter((event) => event.type === 'http').length, 1, 'exercise the redirect response without following it');
  } finally { await close(web.server); await close(target); }
});

test('a proxy pointed at the wrong controlled service cannot authorize writes', async () => {
  const foreign: Array<{ method: string | undefined; url: string | undefined }> = [];
  const target = http.createServer((request, response) => {
    foreign.push({ method: request.method, url: request.url });
    response.setHeader('X-Sthang-Studio-Activation', 'different-owner');
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const port = await listen(target);
  const { config, root } = await setup();
  const web = await webFixture(config, { proxyOrigin: `http://127.0.0.1:${port}` });
  try {
    await assert.rejects(start(root, config));
    assert.equal(foreign.length, 1);
    assert.ok(foreign.every((request) => request.method === 'GET' && request.url === addTestNamespace('/api/health', config)));
    assert.equal(foreign.some((request) => request.method === 'PATCH' || request.url === '/api/profile'), false);
    outcomes.push({ case: 'wrong-proxy', foreign });
  } finally { await close(web.server); await close(target); }
});

test('wrong frontend identity cannot complete owned startup', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config, { wrongMarker: true });
  try {
    await assert.rejects(start(root, config));
    assert.ok(web.requests.some((request) => stripTestNamespace(request.url || '', config) === '/studio-web-identity.json'), 'reach and reject the actual frontend identity');
    assert.equal((await events(root)).filter((event) => event.type === 'profile-mutation').length, 0);
  } finally { await close(web.server); }
});

test('child exit after READY invalidates the proof before another health request', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  try {
    handle = await start(root, config);
    const exited = once(handle.child, 'exit');
    handle.child.send({ type: 'fake-exit' });
    await exited;
    assert.throws(() => handle!.assertAlive());
    let httpCalls = 0;
    const fetcher = (async () => { httpCalls++; throw new Error('Unverified HTTP must never run'); }) as typeof fetch;
    await assert.rejects(verifyOwnedHealth(handle.child, expected(handle, config, root), config, fetcher));
    assert.equal(httpCalls, 0);
  } finally { if (handle) await stop(handle); await close(web.server); }
});

test('child exit aborts an in-flight health probe after READY', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  try {
    handle = await start(root, config);
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const heldFetch = ((_: string | URL | Request, options?: RequestInit) => {
      calls++;
      const signal = options?.signal;
      assert.ok(signal);
      entered();
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const pending = verifyOwnedHealth(handle.child, expected(handle, config, root), config, heldFetch);
    const rejected = assert.rejects(pending, /exited|readiness|no longer alive/i);
    await requested;
    const exited = once(handle.child, 'exit');
    handle.child.send({ type: 'fake-exit' });
    await rejected;
    await exited;
    assert.equal(calls, 1, 'exit must abort the held direct probe before any later proxy probe');
    assert.throws(() => handle!.assertAlive());
  } finally { if (handle) await stop(handle); await close(web.server); }
});

test('configuration tampering fails before any HTTP even with a valid prior READY', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  try {
    handle = await start(root, config);
    const identity = expected(handle, config, root);
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error('Mismatched configuration must not contact a service'); }) as typeof fetch;
    for (const changed of [
      { ...config, apiOrigin: 'http://127.0.0.1:1' },
      { ...config, webOrigin: 'http://127.0.0.1:1' },
      { ...config, namespace: '/api' },
      { ...config, apiPort: config.webPort },
      { ...config, marker: '0'.repeat(64) },
    ]) await assert.rejects(verifyOwnedHealth(handle.child, identity, changed, fetcher));
    assert.equal(calls, 0);
    handle.assertAlive();
  } finally { if (handle) await stop(handle); await close(web.server); }
});

test('cleanup stops only the launched child and leaves another controlled listener and root intact', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  const otherRoot = await fs.mkdtemp(path.join(suiteRoot, 'other-owned-fixture-'));
  const sentinel = path.join(otherRoot, 'untouched.txt');
  await fs.writeFile(sentinel, 'independent controlled fixture');
  const foreignRequests: string[] = [];
  const other = http.createServer((request, response) => { foreignRequests.push(`${request.method} ${request.url}`); response.end('independent'); });
  await listen(other);
  let handle: Handle | undefined;
  try {
    handle = await start(root, config);
    await stop(handle);
    assert.notEqual(handle.child.exitCode ?? handle.child.signalCode, null);
    assert.equal(other.listening, true);
    assert.deepEqual(foreignRequests, []);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'independent controlled fixture');
  } finally { if (handle) await stop(handle); await close(web.server); await close(other); }
});

test('nonce namespaces make port reuse unable to reach normal API/profile endpoints', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  let reused: http.Server | undefined;
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  let normalMutations = 0;
  try {
    handle = await start(root, config);
    const closed = new Promise<void>((resolve) => handle!.child.on('message', (message) => {
      if ((message as { type?: string })?.type === 'fake-listener-closed') resolve();
    }));
    handle.child.send({ type: 'fake-close-listener' });
    await closed;
    handle.assertAlive(); // Port reuse protection must also hold before process exit is observed.
    reused = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url?.startsWith('/api/') && request.method !== 'GET') normalMutations++;
      response.writeHead(404).end();
    });
    await listen(reused, config.apiPort);
    for (const endpoint of ['/api/projects', '/api/profile', '/media/source.mp4', '/exports/result.mp4']) {
      const response = await fetch(`${config.apiOrigin}${addTestNamespace(endpoint, config)}`, { method: endpoint.startsWith('/api/') ? 'PATCH' : 'GET', redirect: 'error' });
      assert.equal(response.status, 404);
    }
    assert.equal(normalMutations, 0);
    assert.ok(requests.every((request) => request.url !== '/api/profile' && request.url?.startsWith(config.namespace)));
    outcomes.push({ case: 'port-reuse', normalMutations, requests });
  } finally { if (handle) await stop(handle); if (reused) await close(reused); await close(web.server); }
});

function routeFixture(url: string, method = 'PATCH') {
  const observed = { fetches: [] as Array<{ url: string; maxRedirects?: number }>, fulfilled: [] as number[], disposed: 0, aborted: 0, uncheckedContinues: 0 };
  const route = {
    request: () => ({ url: () => url, method: () => method }),
    fetch: async (options?: { url?: string; maxRedirects?: number }) => {
      const target = options?.url || url;
      observed.fetches.push({ url: target, maxRedirects: options?.maxRedirects });
      // Match the important Playwright transport distinction: omitting its
      // maxRedirects:0 would follow a 307 and preserve this synthetic PATCH.
      const response = await fetch(target, { method, body: method === 'GET' ? undefined : '{}', redirect: options?.maxRedirects === 0 ? 'manual' : 'follow' });
      return {
        status: () => response.status,
        dispose: async () => { observed.disposed++; await response.body?.cancel(); },
      } as unknown as APIResponse;
    },
    fulfill: async ({ response }: { response: APIResponse }) => { observed.fulfilled.push(response.status()); },
    abort: async () => { observed.aborted++; },
    continue: async () => {
      observed.uncheckedContinues++;
      const response = await fetch(url, { method, body: method === 'GET' ? undefined : '{}', redirect: 'follow' });
      await response.body?.cancel();
    },
  } as unknown as Route;
  return { route, observed };
}
async function installedGuard(config: HarnessConfig) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = {
    addInitScript: async () => {}, // The mandatory Chromium case executes the real DOM guard.
    route: async (pattern: string, callback: (route: Route) => Promise<void>) => {
      assert.equal(pattern, '**/*');
      assert.equal(handler, undefined, 'one boundary must cover all frontend network paths');
      handler = callback;
    },
  } as unknown as BrowserContext;
  await installBrowserNetworkGuard(context, config);
  assert.ok(handler);
  return handler;
}

test('frontend port reuse cannot turn explicit fetch/continue or the context guard into normal API mutations', async () => {
  const { config, root } = await setup();
  const web = await webFixture(config);
  let handle: Handle | undefined;
  let foreign: http.Server | undefined;
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  let normalMutations = 0;
  let normalNavigation = 0;
  let phase = 'owned startup';
  try {
    handle = await start(root, config);
    await close(web.server); // Only the owned frontend exits; the API is still alive.
    handle.assertAlive();
    foreign = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url?.startsWith('/api/') && request.method !== 'GET') normalMutations++;
      if (request.url === '/' || request.url?.startsWith('/src/')) normalNavigation++;
      response.writeHead(404).end();
    });
    await listen(foreign, config.webPort);
    const explicitFetch = routeFixture(`${config.webOrigin}/api/profile`);
    phase = 'explicit fetch to rebound frontend';
    const fetched = await fetchOwnedRoute(explicitFetch.route, config);
    assert.equal(fetched.status(), 404);
    await fetched.dispose();
    const explicitContinue = routeFixture(`${config.webOrigin}/api/projects`);
    phase = 'explicit continue to rebound frontend';
    await continueOwnedRoute(explicitContinue.route, config);
    const intercepted = routeFixture(`${config.webOrigin}/api/profile`);
    const contextGuard = await installedGuard(config);
    phase = 'context API forwarding to rebound frontend';
    await contextGuard(intercepted.route);
    const navigation = routeFixture(`${config.webOrigin}/`, 'GET');
    const script = routeFixture(`${config.webOrigin}/src/main.tsx`, 'GET');
    phase = 'context navigation to rebound frontend';
    await contextGuard(navigation.route);
    phase = 'context script forwarding to rebound frontend';
    await contextGuard(script.route);
    phase = 'asserting rebound request evidence';
    assert.equal(requests.length, 5, 'explicit forwards, context API, navigation and scripts must reach the controlled rebound listener');
    assert.equal(normalMutations, 0);
    assert.equal(normalNavigation, 0);
    assert.ok(requests.every((request) => request.url?.startsWith(`${config.namespace}/`)));
    assert.ok(requests.some((request) => request.url === `${config.namespace}/` && request.method === 'GET'));
    assert.ok(requests.some((request) => request.url === `${config.namespace}/src/main.tsx` && request.method === 'GET'));
    for (const { observed } of [explicitFetch, explicitContinue, intercepted, navigation, script]) {
      assert.equal(observed.uncheckedContinues, 0);
      assert.equal(observed.disposed, 1);
      assert.equal(observed.fetches.length, 1);
      assert.equal(observed.fetches[0].maxRedirects, 0);
    }
    assert.deepEqual(explicitContinue.observed.fulfilled, [404]);
    assert.deepEqual(intercepted.observed.fulfilled, [404]);
    assert.equal(navigation.route.request().url(), `${config.webOrigin}/`);
    assert.equal(script.route.request().url(), `${config.webOrigin}/src/main.tsx`);
    outcomes.push({ case: 'frontend-port-reuse', normalMutations, normalNavigation, requests });
  } catch (error) {
    outcomes.push({ case: 'frontend-port-reuse-failed', phase, normalMutations, normalNavigation, requests, error: String(error) });
    throw error;
  } finally { if (handle) await stop(handle); if (foreign) await close(foreign); await close(web.server); }
});

test('explicit forwards and context interception never follow a frontend redirect to normal profile API', async () => {
  const { config } = await setup();
  const targetRequests: string[] = [];
  const target = http.createServer((request, response) => {
    targetRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200).end('{}');
  });
  const targetPort = await listen(target);
  const sourceRequests: string[] = [];
  const source = http.createServer((request, response) => {
    sourceRequests.push(`${request.method} ${request.url}`);
    response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/api/profile` }).end();
  });
  await listen(source, config.webPort);
  try {
    const explicitFetch = routeFixture(`${config.webOrigin}/api/profile`);
    await assert.rejects(fetchOwnedRoute(explicitFetch.route, config));
    const explicitContinue = routeFixture(`${config.webOrigin}/api/profile`);
    await assert.rejects(continueOwnedRoute(explicitContinue.route, config));
    const intercepted = routeFixture(`${config.webOrigin}/api/profile`);
    await assert.rejects((await installedGuard(config))(intercepted.route));
    assert.equal(sourceRequests.length, 3, 'exercise actual redirect responses on all three paths');
    assert.ok(sourceRequests.every((request) => request === `PATCH ${config.namespace}/api/profile`));
    assert.deepEqual(targetRequests, [], 'a 307 must never replay PATCH against its normal API target');
    for (const { observed } of [explicitFetch, explicitContinue, intercepted]) {
      assert.equal(observed.disposed, 1);
      assert.equal(observed.fetches[0].maxRedirects, 0);
      assert.deepEqual(observed.fulfilled, []);
      assert.equal(observed.uncheckedContinues, 0);
    }
    assert.equal(intercepted.observed.aborted, 1);
    outcomes.push({ case: 'frontend-redirect', sourceRequests, targetRequests });
  } finally { await close(source); await close(target); }
});

test('context and explicit forwards reject another controlled origin before transport', async () => {
  const { config } = await setup();
  const requests: string[] = [];
  const foreign = http.createServer((request, response) => { requests.push(`${request.method} ${request.url}`); response.end('{}'); });
  const port = await listen(foreign);
  try {
    const explicitFetch = routeFixture(`http://127.0.0.1:${port}/api/profile`);
    await assert.rejects(fetchOwnedRoute(explicitFetch.route, config));
    const explicitContinue = routeFixture(`http://127.0.0.1:${port}/api/profile`);
    await assert.rejects(continueOwnedRoute(explicitContinue.route, config));
    const intercepted = routeFixture(`http://127.0.0.1:${port}/api/profile`);
    await assert.rejects((await installedGuard(config))(intercepted.route));
    assert.deepEqual(requests, []);
    for (const { observed } of [explicitFetch, explicitContinue, intercepted]) {
      assert.deepEqual(observed.fetches, []);
      assert.deepEqual(observed.fulfilled, []);
      assert.equal(observed.uncheckedContinues, 0);
    }
    assert.equal(intercepted.observed.aborted, 1);
  } finally { await close(foreign); }
});

test('frontend URL boundary preserves query strings and rejects credentials, foreign origins and traversal', async () => {
  const { config } = await setup();
  for (const logical of ['/', '/src/main.tsx', '/api/profile?view=full&x=1', '/media/source.mp4?time=20']) {
    const result = new URL(safeFrontendUrl(`${config.webOrigin}${logical}`, config));
    assert.equal(result.origin, config.webOrigin);
    assert.ok(result.pathname.startsWith(`${config.namespace}/`));
    assert.equal(result.search, new URL(`${config.webOrigin}${logical}`).search);
  }
  for (const unsafe of [`${config.webOrigin}/api/../../api/profile`, `${config.webOrigin}/api/%2e%2e/profile`, `${config.webOrigin}/api/%2f../profile`, `${config.webOrigin}/api\\..\\profile`, `${config.webOrigin}${config.namespace}/api/profile`, config.webOrigin.replace('http://', 'http://synthetic:password@') + '/api/profile', 'https://never.invalid/api/profile', '/api/profile']) {
    assert.throws(() => safeFrontendUrl(unsafe, config), unsafe);
  }
});

test('explicit forwarding rejects redirect status boundaries and disposes every rejected response', async () => {
  const { config } = await setup();
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    let disposed = 0;
    let fetches = 0;
    const route = {
      request: () => ({ url: () => `${config.webOrigin}/api/profile` }),
      fetch: async (options: { url: string; maxRedirects: number }) => {
        fetches++;
        assert.equal(options.url, safeFrontendUrl(`${config.webOrigin}/api/profile`, config));
        assert.equal(options.maxRedirects, 0);
        return { status: () => status, dispose: async () => { disposed++; } } as unknown as APIResponse;
      },
    } as unknown as Route;
    await assert.rejects(fetchOwnedRoute(route, config), /redirect/i, `status ${status}`);
    assert.equal(fetches, 1);
    assert.equal(disposed, 1);
  }
});

test('a mutated frontend configuration cannot reach explicit forwarding transport', async () => {
  const { config } = await setup();
  for (const mutated of [
    { ...config, namespace: '/api' }, { ...config, apiOrigin: config.webOrigin },
    { ...config, webOrigin: config.apiOrigin }, { ...config, marker: '0'.repeat(64) },
    { ...config, apiPort: config.webPort },
  ]) {
    const fixture = routeFixture(`${config.webOrigin}/api/profile`);
    await assert.rejects(fetchOwnedRoute(fixture.route, mutated));
    assert.deepEqual(fixture.observed.fetches, []);
    assert.equal(fixture.observed.uncheckedContinues, 0);
  }
});

test('a namespace guard rejects unprefixed and other-run mutations before delegation', async () => {
  const { config } = await setup();
  const other = await createHarnessRun(suiteRoot);
  const delegated: string[] = [];
  const server = http.createServer(guardNamespacedRequest((request, response) => {
    delegated.push(`${request.method} ${request.url}`);
    response.writeHead(200).end('{}');
  }, config));
  const port = await listen(server);
  try {
    for (const url of ['/api/profile', addTestNamespace('/api/profile', other), '/media/file', '/exports/file']) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'PATCH', redirect: 'error' });
      assert.ok(response.status >= 400);
    }
    assert.deepEqual(delegated, []);
    assert.equal((await fetch(`http://127.0.0.1:${port}${addTestNamespace('/api/profile', config)}`, { method: 'PATCH' })).status, 200);
    assert.deepEqual(delegated, ['PATCH /api/profile']);
  } finally { await close(server); }
});

test('namespaced URLs cannot normalize into an ordinary service mutation path', async () => {
  const { config } = await setup();
  for (const unsafe of ['/api/../api/profile', '/api/../../api/profile', '/api/./profile', '/api/%2e%2e/api/profile', '/api/%2f../profile', '/api\\..\\profile', '//127.0.0.1/api/profile', 'http://127.0.0.1/api/profile']) {
    assert.throws(() => addTestNamespace(unsafe, config), unsafe);
  }
  for (const safe of ['/api/profile', '/api/projects?summary=1', '/media/source.mp4', '/exports/result.mp4']) {
    const namespaced = addTestNamespace(safe, config);
    assert.ok(new URL(namespaced, config.apiOrigin).pathname.startsWith(`${config.namespace}/`));
    assert.equal(stripTestNamespace(namespaced, config), safe);
  }
});

test('missing/outside state and bad ownership markers fail before any server import', async () => {
  const { config, root } = await setup();
  assert.throws(() => requireHarnessConfig({}));
  assert.throws(() => verifyOwnedStateRoot('', config));
  const outside = await fs.mkdtemp(path.join(suiteRoot, 'outside-run-'));
  assert.throws(() => verifyOwnedStateRoot(outside, config));
  const marker = (await fs.readdir(root)).find((name) => /marker|owner|browser/.test(name) && name !== 'fake-options.json');
  assert.ok(marker, 'helper must persist explicit ownership evidence');
  const markerPath = path.join(root, marker);
  const before = await fs.readFile(markerPath);
  await fs.writeFile(markerPath, 'invalid-owned-marker');
  try { assert.throws(() => verifyOwnedStateRoot(root, config)); }
  finally { await fs.writeFile(markerPath, before); }
  assert.equal(verifyOwnedStateRoot(root, config), root);
});

test('isolated environment replaces every vault/default state path and clears cloud access', async () => {
  const { config, root } = await setup();
  const environment = isolatedEnvironment(config, root, {
    ...process.env, LOCALAPPDATA: path.join(suiteRoot, 'foreign-local'), APPDATA: path.join(suiteRoot, 'foreign-roaming'),
    XDG_CONFIG_HOME: path.join(suiteRoot, 'foreign-xdg'), GEMINI_API_KEY: 'synthetic-must-not-inherit',
    STHANG_CONTRIBUTION_ENDPOINT: 'https://never.invalid', STHANG_ANALYTICS_ENDPOINT: 'https://never.invalid',
    STHANG_STUDIO_STATE_ROOT: path.join(suiteRoot, 'foreign-state'),
  });
  const inside = (value: string | undefined) => {
    assert.ok(value && path.isAbsolute(value));
    const relative = path.relative(root, value!);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${value} must be inside the fresh owned root`);
  };
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'STHANG_STUDIO_ENV_FILE', 'LOCAL_TIMING_PYTHON']) inside(environment[key]);
  assert.equal(environment.STHANG_STUDIO_STATE_ROOT, root);
  assert.equal(environment.GEMINI_API_KEY, '');
  for (const name of ['STHANG_CONTRIBUTION_ENDPOINT', 'STHANG_ANALYTICS_ENDPOINT']) {
    assert.ok(environment[name], 'a truthy invalid endpoint must disable public-default fallback');
    assert.throws(() => new URL(environment[name]!));
  }
  assert.equal(await fs.stat(environment.STHANG_STUDIO_ENV_FILE!).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(environment.LOCAL_TIMING_PYTHON!).then(() => true).catch(() => false), false);
  const envConfig = requireHarnessConfig(environment);
  assert.equal(envConfig.marker, config.marker);
  assert.equal(envConfig.apiPort, config.apiPort);
});

test('an existing env file or an escaped vault directory is rejected', async () => {
  const { config, root } = await setup();
  const envFile = path.join(root, 'absent.env');
  await fs.writeFile(envFile, 'SYNTHETIC_MUST_NOT_IMPORT=1');
  assert.throws(() => isolatedEnvironment(config, root), /absent|environment/i);
  await fs.unlink(envFile);
  const other = await fs.mkdtemp(path.join(suiteRoot, 'controlled-vault-outside-'));
  const linkedVault = path.join(root, 'local-app-data');
  // The previous call creates these empty owned directories before rejecting
  // the env file. Remove only this exact empty directory, then insert a junction.
  await fs.rmdir(linkedVault);
  await fs.symlink(other, linkedVault, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => isolatedEnvironment(config, root)); }
  finally { await fs.unlink(linkedVault); }
  assert.deepEqual(await fs.readdir(other), [], 'no vault writes may reach the controlled outside directory');
});

test('run marker corruption fails configuration validation before child launch', async () => {
  const { config, root } = await setup();
  const environment = isolatedEnvironment(config, root);
  const marker = path.join(config.runRoot, '.studio-browser-run.json');
  const original = await fs.readFile(marker);
  await fs.writeFile(marker, JSON.stringify({ type: 'studio-browser-run', marker: '0'.repeat(64) }));
  try { assert.throws(() => requireHarnessConfig(environment)); }
  finally { await fs.writeFile(marker, original); }
  assert.equal(requireHarnessConfig(environment).marker, config.marker);
});

test('READY pure validation rejects malformed identities without an HTTP fallback', async () => {
  const { config, root } = await setup();
  const identity = { pid: process.pid, marker: config.marker, root, port: config.apiPort };
  const good = { type: 'studio-browser-ready', ...identity, address: '127.0.0.1' };
  assert.doesNotThrow(() => assertOwnedReady(good, identity));
  for (const malformed of [null, {}, { ...good, type: 'listening' }, { ...good, pid: process.pid + 1 }, { ...good, root: path.dirname(root) }, { ...good, marker: '' }, { ...good, port: config.apiPort + 1 }, { ...good, address: '0.0.0.0' }]) {
    assert.throws(() => assertOwnedReady(malformed, identity));
  }
});

test('inherited long nested temp paths preserve owned roots without overflowing Linux browser sockets', async () => {
  const caseRoot = await fs.mkdtemp(path.join(suiteRoot, 'nested-temp-'));
  let deep = path.join(caseRoot, 'tmp');
  while (Buffer.byteLength(deep) < 140) deep = path.join(deep, 'nested-temp-parent');
  await fs.mkdir(deep, { recursive: true });
  const keys = ['TEMP', 'TMP', 'TMPDIR'] as const;
  const before = keys.map((key) => process.env[key]);
  const child = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'tests/fixtures/browser-temp-path-child.mts')],
    { cwd: repoRoot, env: { ...process.env, TEMP: deep, TMP: deep, TMPDIR: deep },
      encoding: 'utf8', timeout: 15_000, windowsHide: true })) as {
        config: HarnessConfig; root: string; inheritedTemp: string; evidenceParent: string;
        temp: Record<typeof keys[number], string>; socketPath: string; socketBytes: number;
      };
  const oldSocketPath = path.join(child.evidenceParent, 'studio-browser-owned-XXXXXX',
    'adversarial-childXXXXXX', 'tmp', 'org.chromium.Chromium.XXXXXX', 'SingletonSocket');
  const outcome: Record<string, unknown> = { case: 'long-nested-browser-temp', platform: process.platform,
    inheritedTemp: child.inheritedTemp, evidenceParent: child.evidenceParent,
    ownedRunRoot: child.config.runRoot, socketPath: child.socketPath, socketBytes: child.socketBytes,
    oldSocketBytes: Buffer.byteLength(oldSocketPath), childExited: true, ownedRootRemoved: false };
  outcomes.push(outcome);
  try {
    const config = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(child.config.apiPort),
      STHANG_BROWSER_WEB_PORT: String(child.config.webPort), STHANG_BROWSER_RUN_ROOT: child.config.runRoot,
      STHANG_BROWSER_RUN_MARKER: child.config.marker });
    assert.equal(path.resolve(child.inheritedTemp), path.resolve(deep));
    assert.deepEqual(config, child.config);
    assert.equal(verifyOwnedStateRoot(child.root, config), child.root);
    for (const key of keys) assert.equal(child.temp[key], path.join(child.root, 'tmp'));
    assert.deepEqual(keys.map((key) => process.env[key]), before, 'only the child environment may change');
    outcome.parentEnvironmentUnchanged = true;
    assert.ok(Buffer.byteLength(oldSocketPath) >= 108, 'the fixture must expose the old Unix socket overflow');
    if (process.platform === 'linux') {
      assert.equal(path.dirname(config.runRoot), await fs.realpath('/tmp'));
      assert.ok(child.socketBytes < 108, 'the actual Linux browser socket path must fit sun_path including its terminator');
      assert.equal(path.relative(child.evidenceParent, config.runRoot).startsWith('..'), true);
    } else {
      assert.equal(path.dirname(config.runRoot), await fs.realpath(child.evidenceParent), 'Windows retains its requested owned parent');
    }
    const probes = [http.createServer(), http.createServer()];
    try { await listen(probes[0], config.apiPort); await listen(probes[1], config.webPort); }
    finally { await close(probes[0]); await close(probes[1]); }
    outcome.portsReleased = true;
  } finally {
    // The fixture has exited; verify the exact returned markers again before removal.
    const owned = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(child.config.apiPort),
      STHANG_BROWSER_WEB_PORT: String(child.config.webPort), STHANG_BROWSER_RUN_ROOT: child.config.runRoot,
      STHANG_BROWSER_RUN_MARKER: child.config.marker });
    assert.equal(owned.runRoot, child.config.runRoot);
    verifyOwnedStateRoot(child.root, owned);
    await fs.rm(owned.runRoot, { recursive: true });
    assert.equal(await fs.stat(owned.runRoot).then(() => true, () => false), false);
    outcome.ownedRootRemoved = true;
  }
});

test('installed Chromium downloads native HTTP bytes only from its continuously held namespaced export fixture', { timeout: 60_000 }, async () => {
  const { config, root } = await setup();
  const filename = 'synthetic-captioned.mp4';
  const nativeBytes = Buffer.from([0, 255, 1, 254, 42, 0, 13, 10, 128, 129, 240, 159, 146, 169]);
  const blobBytes = Buffer.from([7, 0, 255, 9, 128, 11]);
  const normalRequests: string[] = [];
  const namespacedExports: string[] = [];
  const apiRequests: string[] = [];
  const frontendRequests: string[] = [];
  const lifecycle: string[] = [];
  const attachmentResponses: Array<{ status: number; disposition: string; length: string; location: string | undefined }> = [];
  const apiServer = http.createServer((request, response) => {
    response.setHeader('Connection', 'close');
    const wire = request.url || '/';
    const logical = stripTestNamespace(wire, config);
    if (!logical) { normalRequests.push(`api ${request.method} ${wire}`); response.writeHead(404).end(); return; }
    if (logical.startsWith('/api/')) apiRequests.push(`${request.method} ${logical}`);
    if (logical.startsWith('/exports/')) namespacedExports.push(`${request.method} ${wire}`);
    if ((request.method === 'GET' || request.method === 'HEAD') && logical === `/exports/${filename}`) {
      response.setHeader('content-type', 'video/mp4');
      response.setHeader('content-disposition', `attachment; filename="${filename}"`);
      response.setHeader('content-length', String(nativeBytes.length));
      response.writeHead(200);
      attachmentResponses.push({
        status: response.statusCode, disposition: String(response.getHeader('content-disposition')),
        length: String(response.getHeader('content-length')),
        location: response.getHeader('location') as string | undefined,
      });
      response.end(request.method === 'HEAD' ? undefined : nativeBytes);
      return;
    }
    response.writeHead(404).end();
  });
  await listen(apiServer, config.apiPort);
  apiServer.once('close', () => lifecycle.push('api-listener-closed'));
  assert.equal((apiServer.address() as AddressInfo).address, '127.0.0.1');
  assert.equal((apiServer.address() as AddressInfo).port, config.apiPort);
  assert.equal(verifyOwnedStateRoot(root, config), root);
  const exportUrl = ownedNativeExportUrl(apiServer, root, config);
  assert.equal(exportUrl, `${config.apiOrigin}${config.namespace}/exports/${filename}`);
  const unbound = http.createServer();
  assert.throws(() => ownedNativeExportUrl(unbound, root, config), /listen|bound|owned|server/i);
  assert.throws(() => ownedNativeExportUrl(apiServer, path.dirname(root), config));
  assert.throws(() => ownedNativeExportUrl(apiServer, root, { ...config, namespace: '/api' }));
  async function assertNativeRejected(url: string, method: string, server = apiServer) {
    const calls = { continued: 0, aborted: 0, fetched: 0 };
    const route = {
      request: () => ({ url: () => url, method: () => method }),
      continue: async () => { calls.continued++; },
      abort: async () => { calls.aborted++; },
      fetch: async () => { calls.fetched++; throw new Error('Native rejection must not use forwarding transport'); },
    } as unknown as Route;
    await assert.rejects(continueNativeExportRoute(route, server, root, config));
    assert.deepEqual(calls, { continued: 0, aborted: 1, fetched: 0 }, `${method} ${url} must fail before raw continuation or HTTP`);
  }
  for (const [url, method] of [
    [exportUrl, 'POST'], [exportUrl, 'PATCH'],
    [`${config.apiOrigin}${config.namespace}/api/profile`, 'GET'],
    [`${exportUrl}?changed=1`, 'GET'],
    [`${config.apiOrigin}/exports/${filename}`, 'GET'],
  ]) await assertNativeRejected(url, method);
  await assertNativeRejected(exportUrl, 'GET', unbound);
  assert.equal(namespacedExports.length, 0, 'rejected capabilities must not contact the attachment handler');
  assert.equal(normalRequests.length, 0);
  assert.equal(apiRequests.length, 0);
  async function assertHeld(phase: string) {
    assert.equal(apiServer.listening, true, `${phase}: the original API fixture must stay bound`);
    assert.equal(ownedNativeExportUrl(apiServer, root, config), exportUrl);
    const contender = http.createServer();
    try {
      const rejected = once(contender, 'error');
      contender.listen(config.apiPort, '127.0.0.1');
      const [error] = await rejected;
      assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE', `${phase}: another listener cannot take the export port`);
      lifecycle.push(`bind-held:${phase}`);
    } finally { if (contender.listening) await close(contender); }
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Owned native download fixture</title>
    <button id="native">Native HTTP binary</button><button id="blob">Native blob</button>
    <script>
      function download(href, filename) {
        const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
      }
      document.querySelector('#native').onclick = () => download(${JSON.stringify(exportUrl)}, ${JSON.stringify(filename)});
      document.querySelector('#blob').onclick = () => download(URL.createObjectURL(new Blob([new Uint8Array(${JSON.stringify([...blobBytes])})], { type: 'application/octet-stream' })), 'guard-native-blob.bin');
    </script>`;
  const frontend = http.createServer((request, response) => {
    response.setHeader('Connection', 'close');
    const wire = request.url || '/';
    const logical = stripTestNamespace(wire, config);
    if (!logical) { normalRequests.push(`frontend ${request.method} ${wire}`); response.writeHead(404).end(); return; }
    frontendRequests.push(`${request.method} ${wire}`);
    if (logical === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return; }
    response.writeHead(404).end();
  });
  await listen(frontend, config.webPort);
  frontend.once('close', () => lifecycle.push('frontend-listener-closed'));
  assert.throws(() => ownedNativeExportUrl(frontend, root, config), /listen|bound|owned|server/i, 'a live server on the wrong port cannot authorize native exports');
  const { chromium } = await import('@playwright/test');
  const executable = path.resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath());
  assert.equal((await fs.stat(executable)).isFile(), true, 'use an already installed browser; never install or download one');
  const downloads = path.join(root, 'downloads');
  await fs.mkdir(downloads, { recursive: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const downloadsSeen: Array<{ filename: string; url: string }> = [];
  const pageExportRoutes: string[] = [];
  const contextExportRoutes: string[] = [];
  const pageErrors: string[] = [];
  let phase = 'proving the API bind before browser launch';
  try {
    await assertHeld('before-browser');
    phase = 'launching isolated Chromium';
    browser = await chromium.launch({ executablePath: executable, headless: true, downloadsPath: downloads, env: isolatedEnvironment(config, root) });
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    await installBrowserNetworkGuard(context, config);
    await installNativeExportGuard(context, apiServer, root, config);
    await context.route('**/exports/**', async (route) => {
      contextExportRoutes.push(route.request().url());
      await route.fallback();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('download', (download) => downloadsSeen.push({ filename: download.suggestedFilename(), url: download.url() }));
    await page.route('**/exports/**', async (route) => {
      pageExportRoutes.push(route.request().url());
      await route.fallback();
    });
    phase = 'navigating to owned fake frontend';
    await page.goto(config.webOrigin);
    async function expectDownload(button: string, expectedFilename: string, bytes: Buffer, expectedUrl: string | 'blob:') {
      const received = page.waitForEvent('download', { timeout: 15_000 });
      await page.locator(button).click();
      const download = await received;
      assert.equal(download.suggestedFilename(), expectedFilename);
      if (expectedUrl === 'blob:') assert.ok(download.url().startsWith('blob:'), 'the existing native Blob path stays unchanged');
      else assert.equal(download.url(), expectedUrl, 'this must exercise a true native HTTP download, without a Blob conversion');
      const saved = await download.path();
      assert.ok(saved);
      const relative = path.relative(downloads, saved);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'download bytes must remain inside the fresh owned download directory');
      assert.deepEqual(await fs.readFile(saved), bytes);
    }
    phase = 'true native HTTP attachment';
    await expectDownload('#native', filename, nativeBytes, exportUrl);
    await assertHeld('after-native-bytes');
    phase = 'unchanged native blob anchor';
    await expectDownload('#blob', 'guard-native-blob.bin', blobBytes, 'blob:');
    assert.deepEqual(pageExportRoutes, [exportUrl], 'the initial cross-origin native navigation must pass the page observer through to the context capability');
    assert.deepEqual(contextExportRoutes, [exportUrl], 'the context observer must pass the exact initial native navigation through to the live-fixture capability');
    assert.deepEqual(pageErrors, []);
    await context.close();
    lifecycle.push('context-closed');
  } catch (error) {
    outcomes.push({ case: 'chromium-native-http-download-failed', phase, error: String(error), downloadsSeen, pageExportRoutes, contextExportRoutes, normalRequests, namespacedExports, apiRequests, frontendRequests, attachmentResponses, lifecycle, pageErrors });
    throw error;
  } finally {
    // The fixed fixture never redirects or proxies. Its API listener stays
    // continuously bound until Chromium is closed. Only the initial exact
    // cross-origin navigation receives raw continuation; the retained failed
    // callback-zero case established that this navigation does enter routing.
    // This is no generic native redirect-rejection guarantee.
    if (browser) { await browser.close(); lifecycle.push('browser-closed'); }
    try {
      await assertHeld('after-browser-close');
      assert.equal(frontend.listening, true, 'close the browser before either owned listener');
    } finally { await close(frontend); await close(apiServer); }
  }
  assert.equal(downloadsSeen.length, 2);
  assert.deepEqual(normalRequests, [], 'no ordinary frontend/API/export request may bypass the browser boundary');
  assert.deepEqual(namespacedExports, [`GET ${config.namespace}/exports/${filename}`], 'exactly one native namespaced GET must reach the continuously held API fixture');
  assert.deepEqual(apiRequests, [], 'the native download must not issue any API/profile request');
  assert.deepEqual(attachmentResponses, [{ status: 200, disposition: `attachment; filename="${filename}"`, length: String(nativeBytes.length), location: undefined }], 'the trusted fixture serves one exact nonredirecting attachment');
  assert.deepEqual(lifecycle, ['bind-held:before-browser', 'bind-held:after-native-bytes', 'context-closed', 'browser-closed', 'bind-held:after-browser-close', 'frontend-listener-closed', 'api-listener-closed']);
  assert.throws(() => ownedNativeExportUrl(apiServer, root, config), /listen|bound|owned|server/i);
  await assertNativeRejected(exportUrl, 'GET');
  outcomes.push({ case: 'chromium-native-http-download', executable, browserVersion: browser!.version(), exportUrl, downloadsSeen, pageExportRoutes, contextExportRoutes, normalRequests, namespacedExports, apiRequests, frontendRequests, attachmentResponses, lifecycle, pageErrors });
});
