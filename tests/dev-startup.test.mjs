import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const launcherUrl = new URL('../scripts/dev.mjs', import.meta.url);
const source = fs.readFileSync(launcherUrl, 'utf8');
const root = path.resolve(path.dirname(fileURLToPath(launcherUrl)), '..');
const healthy = { status: 200, body: JSON.stringify({ ok: true, llm: { configured: false }, timing: { configured: false } }) };
const waiting = { status: 503, body: '{}' };

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for the synthetic launcher');
    await delay(5);
  }
}

/** Execute the actual launcher, not a copied startup algorithm. OS process/browser
 * operations and port preflight are doubled; readiness uses real Node HTTP sockets
 * on an ephemeral loopback port. No app state, real services or cloud calls are used.
 * VM modules are test-only, enabled by npm run test:startup.
 */
async function fixture(t, { platform = 'win32', openBrowser = true, registeredBrowser = true, browserStatus = 0, timeout = 2000, sourceWatch = false, onSpawn } = {}) {
  const state = {
    backend: { ...waiting }, web: { status: 200, body: '<html>Studio fixture</html>' },
    calls: [], children: [], commands: [], logs: [], exits: [], proxyStatus: [], connectionErrors: [], refuse: false,
  };
  const timers = new Set();
  const sockets = new Set();
  const pulses = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/backend/api/jobs/events') {
      const status = state.backend.status === 200 && JSON.parse(state.backend.body).ok === true ? 200 : 503;
      res.writeHead(status); res.end('data: []\n\n');
      return;
    }
    const reply = req.url.startsWith('/backend/') ? state.backend : state.web;
    if (reply.mode === 'silent') return;
    res.writeHead(reply.status);
    if (reply.mode === 'drip') {
      res.write('{');
      const pulse = setInterval(() => res.write(' '), 5);
      pulses.add(pulse);
      res.once('close', () => { clearInterval(pulse); pulses.delete(pulse); });
    } else if (reply.mode === 'truncated') {
      res.write('{');
      res.destroy();
    } else res.end(reply.body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const processDouble = new EventEmitter();
  Object.assign(processDouble, {
    platform, execPath: process.execPath, argv: ['node', 'scripts/dev.mjs', ...(sourceWatch ? ['--source-watch'] : [])], env: { KCS_OPEN_BROWSER: openBrowser ? 'true' : 'false' },
    exit: (code) => state.exits.push(code),
  });
  const modules = {
    './runtime-workspaces.mjs': { ensureRuntimeWorkspaceLinks: async () => {} },
    'node:path': { default: path },
    'node:url': { fileURLToPath },
    'node:net': { default: { createServer() {
      const listener = new EventEmitter();
      listener.listen = (_port, host) => { assert.equal(host, '127.0.0.1'); queueMicrotask(() => listener.emit('listening')); };
      listener.close = (callback) => callback();
      return listener;
    } } },
    'node:http': { default: { get(url, options, callback) {
      const target = new URL(url);
      assert.equal(target.hostname, '127.0.0.1');
      assert.ok(['8787', '5188'].includes(target.port));
      const service = target.port === '8787' ? 'backend' : 'web';
      state.calls.push(service);
      const request = http.get(state.refuse && service === 'backend'
        ? 'http://127.0.0.1:0/' : `${origin}/${service}${target.pathname}`, options, callback);
      request.on('error', (error) => state.connectionErrors.push(error.code));
      return request;
    } } },
    'node:child_process': {
      spawn(_node, args, options) {
        assert.equal(options.shell, false);
        const child = new EventEmitter();
        const isServer = args.includes('src/index.ts');
        Object.assign(child, {
          name: isServer ? 'server' : 'web', args: [...args], pid: 100 + state.children.length, killed: false,
          kill() { child.killed = true; return true; },
        });
        state.children.push(child);
        if (child.name === 'web') {
          // An old browser tab may ask for job events as soon as Vite starts.
          http.get(`${origin}/backend/api/jobs/events`, { agent: false }, (res) => {
            state.proxyStatus.push(res.statusCode); res.resume();
          }).on('error', () => state.proxyStatus.push(0));
        }
        if (onSpawn) queueMicrotask(() => onSpawn(child, state));
        return child;
      },
      spawnSync(command, args) {
        state.commands.push([command, args]);
        if (command === 'reg.exe') return { status: registeredBrowser ? 0 : 1, stdout: 'ProgId REG_SZ SyntheticBrowser' };
        if (command === 'taskkill.exe') state.children.find((child) => child.pid === Number(args[1])).killed = true;
        const browser = command === 'powershell.exe' || command === '/usr/bin/open';
        return { status: browser ? browserStatus : 0, stdout: '' };
      },
    },
  };
  const context = vm.createContext({
    process: processDouble, Buffer, AbortController,
    console: Object.fromEntries(['log', 'warn', 'error'].map((level) => [level, (...args) => state.logs.push(args.join(' '))])),
    setTimeout(callback, ms) {
      const wait = ms === 30_000 ? timeout : ms === 1200 ? 80 : ms === 250 ? 5 : ms === 150 ? 1 : ms;
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, wait);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  const module = new vm.SourceTextModule(source, {
    context, identifier: launcherUrl.href, initializeImportMeta: (meta) => { meta.url = launcherUrl.href; },
  });
  await module.link((name) => {
    assert.ok(modules[name], `Unexpected launcher import: ${name}`);
    return new vm.SyntheticModule(Object.keys(modules[name]), function () {
      for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
    }, { context });
  });
  const done = module.evaluate();
  t.after(async () => {
    processDouble.emit('SIGTERM');
    await done;
    for (const timer of timers) clearTimeout(timer);
    for (const pulse of pulses) clearInterval(pulse);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Drain close/error callbacks before clearing any retry they scheduled.
    await delay(0);
    for (const timer of timers) clearTimeout(timer);
  });
  return {
    state, done, sockets, timers,
    stop: (signal) => processDouble.emit(signal),
    names: () => state.children.map((child) => child.name),
    browsers: () => state.commands.filter(([command]) => command === 'powershell.exe' || command === '/usr/bin/open'),
  };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: source-watch uses the scoped tsx watcher while the installed launcher stays stable`, async (t) => {
    const f = await fixture(t, { platform, openBrowser: false, sourceWatch: true, onSpawn: (child, state) => {
      if (child.name === 'server') state.backend = { ...healthy };
    }});
    await f.done;
    const server = f.state.children.find((child) => child.name === 'server');
    const web = f.state.children.find((child) => child.name === 'web');
    assert.ok(server && web);
    assert.deepEqual(server.args, [
      path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'watch',
      '--exclude', '../../node_modules/**',
      '--exclude', '../../packages/shared/dist/**',
      'src/index.ts',
    ]);
    assert.equal(server.args.includes('--watch'), false);
    assert.equal(web.args.includes('--watch'), false);
  });
}

for (const platform of ['win32', 'darwin']) {
  for (const openBrowser of [true, false]) {
    test(`${platform}, browser=${openBrowser}: backend health gates Vite and Vite readiness gates browser opening`, async (t) => {
      const f = await fixture(t, { platform, openBrowser });
      f.state.web = { ...waiting };
      await until(() => f.state.calls.includes('backend'));
      assert.deepEqual(f.names(), ['server']);
      assert.equal(f.browsers().length, 0);
      f.state.backend = { ...healthy };
      await until(() => f.names().includes('web'));
      assert.equal(f.browsers().length, 0);
      f.state.web = { status: 200, body: '<html>ready</html>' };
      await f.done;
      await until(() => f.state.proxyStatus.length === 1);
      assert.deepEqual(f.state.proxyStatus, [200], 'existing tab can request jobs immediately');
      assert.equal(f.browsers().length, openBrowser ? 1 : 0);
      assert.deepEqual(f.state.exits, []);
      if (openBrowser) assert.equal(f.browsers()[0][0], platform === 'win32' ? 'powershell.exe' : '/usr/bin/open');
      assert.equal(f.timers.size, 0, 'successful readiness leaves no polling timers');
    });
  }
}

test('Linux/manual startup uses the same backend gate without opening a browser', async (t) => {
  const f = await fixture(t, { platform: 'linux' });
  await until(() => f.state.calls.length > 0);
  assert.deepEqual(f.names(), ['server']);
  f.state.backend = { ...healthy };
  await f.done;
  assert.equal(f.browsers().length, 0);
  assert.match(f.state.logs.join('\n'), /is ready\. Open http:\/\/127\.0\.0\.1:5188/);
});

test('connection refusal is retried before Vite starts, not hidden by suppressing proxy logs', async (t) => {
  const f = await fixture(t);
  f.state.refuse = true;
  await until(() => f.state.connectionErrors.includes('ECONNREFUSED'));
  assert.deepEqual(f.names(), ['server']);
  f.state.refuse = false;
  f.state.backend = { ...healthy };
  await f.done;
  assert.deepEqual(f.names(), ['server', 'web']);
});

test('HTTP errors, redirects, invalid/oversized/incomplete health JSON and ok:false cannot unlock Vite', async (t) => {
  const f = await fixture(t);
  for (const reply of [
    { status: 204, body: '' }, { status: 302, body: '' }, { status: 404, body: '{}' }, { status: 500, body: '{}' },
    { status: 200, body: 'not json' }, { status: 200, body: 'null' }, { status: 200, body: '{"ok":false}' },
    { status: 200, body: '{"ok":"true"}' }, { status: 200, body: '{"ok":true,"padding":"' + 'x'.repeat(65_536) + '"}' },
    { status: 200, mode: 'truncated' },
  ]) {
    f.state.backend = reply;
    const count = f.state.calls.length;
    await until(() => f.state.calls.length > count + 1);
    assert.deepEqual(f.names(), ['server']);
  }
  // API keys and local timing can be unset: service readiness is not setup completeness.
  f.state.backend = { ...healthy };
  await f.done;
  assert.deepEqual(f.names(), ['server', 'web']);
});

for (const mode of ['silent', 'drip']) {
  test(`backend ${mode} response is bounded and frees sockets, without starting Vite`, async (t) => {
    const f = await fixture(t, { timeout: 220 });
    f.state.backend = { status: 200, mode };
    await f.done;
    await until(() => f.state.exits.length === 1 && f.sockets.size === 0);
    assert.deepEqual(f.names(), ['server']);
    assert.deepEqual(f.state.exits, [1]);
    assert.equal(f.state.children[0].killed, true);
    assert.equal(f.browsers().length, 0);
    assert.match(f.state.logs.join('\n'), /backend did not become ready/);
    const requests = f.state.calls.length;
    await delay(25);
    assert.equal(f.state.calls.length, requests, 'no retry survives the overall deadline');
    assert.equal(f.timers.size, 0);
  });
}

test('a timed-out web app stops both children and never announces readiness', async (t) => {
  const f = await fixture(t, { timeout: 220, platform: 'darwin' });
  f.state.backend = { ...healthy };
  f.state.web = { status: 200, mode: 'silent' };
  await f.done;
  await until(() => f.state.exits.length === 1 && f.sockets.size === 0);
  assert.deepEqual(f.names(), ['server', 'web']);
  assert.ok(f.state.children.every((child) => child.killed));
  assert.deepEqual(f.state.exits, [1]);
  assert.equal(f.browsers().length, 0);
  assert.match(f.state.logs.join('\n'), /web app did not become ready/);
  assert.doesNotMatch(f.state.logs.join('\n'), /Studio is ready/);
});

for (const [platform, signal] of [['win32', 'SIGINT'], ['darwin', 'SIGTERM']]) {
  test(`${platform}: ${signal} during readiness prevents subsequent Vite/browser launch`, async (t) => {
    const f = await fixture(t, { platform });
    f.state.backend = { status: 200, mode: 'silent' };
    await until(() => f.sockets.size > 0);
    f.stop(signal);
    f.state.backend = { ...healthy };
    await f.done;
    await until(() => f.state.exits.length === 1 && f.sockets.size === 0);
    assert.deepEqual(f.names(), ['server']);
    assert.equal(f.browsers().length, 0);
    assert.deepEqual(f.state.exits, [0]);
    assert.equal(f.timers.size, 0);
  });
}

for (const code of [1, 42]) {
  test(`backend exit ${code} during startup is preserved with no Vite launch`, async (t) => {
    const f = await fixture(t, { onSpawn: (child) => child.emit('exit', code, null) });
    await f.done;
    await until(() => f.state.exits.length === 1);
    assert.deepEqual(f.state.exits, [code]);
    assert.deepEqual(f.names(), ['server']);
    assert.equal(f.browsers().length, 0);
  });
}

for (const name of ['server', 'web']) {
  test(`${name} spawn error cancels startup and stops only this launcher's children`, async (t) => {
    const f = await fixture(t, { onSpawn: (child) => { if (child.name === name) child.emit('error', new Error('Synthetic spawn failure')); } });
    f.state.backend = { ...healthy };
    await f.done;
    await until(() => f.state.exits.length === 1);
    assert.deepEqual(f.state.exits, [1]);
    assert.deepEqual(f.names(), name === 'server' ? ['server'] : ['server', 'web']);
    assert.ok(f.state.children.every((child) => child.killed));
    assert.equal(f.browsers().length, 0);
  });
}

test('backend exit while waiting for Vite cancels web readiness and browser opening', async (t) => {
  const f = await fixture(t);
  f.state.backend = { ...healthy };
  f.state.web = { status: 200, mode: 'silent' };
  await until(() => f.state.calls.includes('web'));
  f.state.children[0].emit('exit', 2, null);
  await f.done;
  await until(() => f.state.exits.length === 1);
  assert.deepEqual(f.state.exits, [2]);
  assert.ok(f.state.children.every((child) => child.killed));
  assert.equal(f.browsers().length, 0);
});

test('Windows with no browser association keeps the manual URL and never assumes Chrome', async (t) => {
  const f = await fixture(t, { registeredBrowser: false });
  f.state.backend = { ...healthy };
  await f.done;
  assert.equal(f.browsers().length, 0);
  assert.match(f.state.logs.join('\n'), /Windows has no registered browser/);
  assert.match(f.state.logs.join('\n'), /http:\/\/127\.0\.0\.1:5188\/ manually/);
});

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: default-browser failure preserves running services and prints manual recovery`, async (t) => {
    const f = await fixture(t, { platform, browserStatus: 1 });
    f.state.backend = { ...healthy };
    await f.done;
    assert.equal(f.browsers().length, 1);
    assert.deepEqual(f.state.exits, []);
    assert.match(f.state.logs.join('\n'), /Could not open a browser automatically/);
  });
}
