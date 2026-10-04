import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateWithRollback,
  buildStudioStartSpec,
  isInside,
  recoverInterruptedActivation,
  resolveActiveSourceRoot,
  samePath,
  updatePlatformForRuntime,
  writeJsonAtomic,
  urlReady,
} from '../scripts/update-runtime.mjs';
import {
  isLegacyBrokerPreparation,
  shouldUseRuntimeOnlyTypecheck,
  typecheckProjectArgs,
} from '../scripts/typecheck.mjs';
import { ensureRuntimeWorkspaceLinks } from '../scripts/runtime-workspaces.mjs';

test('Windows stable broker launches from cwd across command-sensitive install paths', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-start-command-'));
  const cases = [
    'ordinary',
    'Desktop Code Script',
    'Desktop Code & Script',
    'Desktop (Code) Script',
  ];
  try {
    for (const name of cases) {
      const installRoot = path.join(root, name);
      await fs.mkdir(installRoot, { recursive: true });
      await fs.writeFile(path.join(installRoot, 'run-windows.bat'), [
        '@echo off',
        'if "%STHANG_STUDIO_UPDATE_ACTIVATION%"=="1" (echo MODE=activation) else (echo MODE=previous)',
        'exit /b 0',
        '',
      ].join('\r\n'));

      for (const [activation, expectedMode] of [[true, 'activation'], [false, 'previous']]) {
        const spec = buildStudioStartSpec(installRoot, activation);
        const result = spawnSync(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(result.status, 0, `${name} (${expectedMode}): ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`MODE=${expectedMode}`));
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('macOS broker launch spec stays anchored to the stable manual bootstrap', () => {
  const installRoot = path.resolve('/tmp/Sthang Studio');
  const spec = buildStudioStartSpec(installRoot, true, 'darwin');
  assert.equal(spec.command, '/bin/bash');
  assert.deepEqual(spec.args, [path.join(installRoot, 'app', 'run-macos.sh')]);
  assert.equal(spec.cwd, path.join(installRoot, 'app'));
  assert.equal(spec.env.STHANG_STUDIO_STATE_ROOT, installRoot);
  assert.equal(spec.env.STHANG_STUDIO_UPDATE_ACTIVATION, '1');
});

test('macOS broker marks its selected child so the stable baseline cannot recurse into the broker', async () => {
  const source = await fs.readFile(path.resolve('scripts/update-runtime.mjs'), 'utf8');
  const launcher = await fs.readFile(path.resolve('run-macos.sh'), 'utf8');
  assert.match(source, /STHANG_STUDIO_BROKER_CHILD: '1'/);
  assert.match(launcher, /STHANG_STUDIO_BROKER_CHILD:-.*!= "1"/);
  assert.match(launcher, /unset STHANG_STUDIO_BROKER_CHILD/);
});

test('update platform identity is exact for Windows x64 and Apple Silicon only', () => {
  assert.equal(updatePlatformForRuntime('win32', 'x64'), 'windows-x64');
  assert.equal(updatePlatformForRuntime('darwin', 'arm64'), 'macos-arm64');
  assert.equal(updatePlatformForRuntime('darwin', 'x64'), '');
  assert.equal(updatePlatformForRuntime('linux', 'arm64'), '');
});

test('macOS active-version resolution validates immutable marker and falls back to the stable app when unset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-macos-active-'));
  try {
    const baseline = path.join(root, 'app');
    await fs.mkdir(baseline, { recursive: true });
    assert.deepEqual(await resolveActiveSourceRoot(root, 'macos-arm64'), {
      sourceRoot: baseline,
      activeVersion: '',
    });

    const version = '0.85.6';
    const digest = 'd'.repeat(64);
    const target = path.join(root, 'versions', version);
    for (const relative of [
      'apps/server/dist',
      'apps/web/dist',
      'packages/shared/dist',
    ]) await fs.mkdir(path.join(target, ...relative.split('/')), { recursive: true });
    await fs.writeFile(path.join(target, 'run-macos.sh'), '#!/usr/bin/env bash\n');
    await fs.writeFile(path.join(target, 'apps/server/dist/index.js'), 'server');
    await fs.writeFile(path.join(target, 'apps/web/dist/index.html'), '<div id="root"></div>');
    await fs.writeFile(path.join(target, 'packages/shared/dist/index.js'), 'shared');
    await writeJsonAtomic(path.join(target, '.sthang-update-version.json'), {
      schemaVersion: 1,
      platform: 'macos-arm64',
      version,
      manifestDigest: digest,
    });
    await writeJsonAtomic(path.join(root, 'updates', 'active.json'), {
      schemaVersion: 1,
      version,
      relativePath: `versions/${version}`,
      manifestDigest: digest,
    });
    assert.deepEqual(await resolveActiveSourceRoot(root, 'macos-arm64'), {
      sourceRoot: target,
      activeVersion: version,
    });
    await writeJsonAtomic(path.join(target, '.sthang-update-version.json'), {
      schemaVersion: 1,
      platform: 'macos-arm64',
      version,
      manifestDigest: 'e'.repeat(64),
    });
    await assert.rejects(() => resolveActiveSourceRoot(root, 'macos-arm64'), /marker/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('runtime activation keeps rollback material until the new version is healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), previous);
    await activateWithRollback({
      installRoot: root,
      target: { version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) },
      launch: async () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false }),
      healthCheck: async () => true,
      stop: async () => {},
    });
    const rollback = JSON.parse(await fs.readFile(path.join(updates, 'rollback.json'), 'utf8'));
    assert.deepEqual(rollback.previous, previous);
    assert.equal(rollback.active.version, '0.8.0');
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('runtime health failure stops the failed process and restores the prior pointer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  let stopped = false;
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), previous);
    await assert.rejects(() => activateWithRollback({
      installRoot: root,
      target: { version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) },
      launch: async () => Object.assign(new EventEmitter(), { pid: 456, exitCode: null, signalCode: null, killed: false }),
      healthCheck: async () => false,
      stop: async () => { stopped = true; },
    }), /healthy/i);
    assert.equal(stopped, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(updates, 'active.json'), 'utf8')), previous);
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('startup recovery rolls back an interrupted activation and records a safe notice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    const updates = path.join(root, 'updates');
    const previous = { schemaVersion: 1, version: '0.7.14', relativePath: 'legacy', manifestDigest: 'a'.repeat(64) };
    const target = { schemaVersion: 1, version: '0.8.0', relativePath: 'versions/0.8.0', manifestDigest: 'b'.repeat(64) };
    await writeJsonAtomic(path.join(updates, 'active.json'), target);
    await writeJsonAtomic(path.join(updates, 'transaction.json'), { schemaVersion: 1, status: 'activating', previous, target });
    assert.equal(await recoverInterruptedActivation(root), true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(updates, 'active.json'), 'utf8')), previous);
    const failure = JSON.parse(await fs.readFile(path.join(updates, 'last-failure.json'), 'utf8'));
    assert.match(failure.message, /rolled back/i);
    await assert.rejects(fs.access(path.join(updates, 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('runtime recovery is non-destructive when no transaction exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  try {
    assert.equal(await recoverInterruptedActivation(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('runtime startup repairs npm workspace links after the prepared tree is relocated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-links-'));
  const work = path.join(root, 'updates', 'work', '0.85.4-fixture', 'source');
  const target = path.join(root, 'versions', '0.85.4');
  try {
    for (const relative of ['apps/server', 'apps/web', 'packages/shared']) {
      await fs.mkdir(path.join(work, ...relative.split('/')), { recursive: true });
    }
    for (const [name, relative] of [['server', 'apps/server'], ['shared', 'packages/shared'], ['web', 'apps/web']]) {
      const link = path.join(work, 'node_modules', '@kcs', name);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(
        path.join(work, ...relative.split('/')),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(work, target);

    await assert.rejects(fs.realpath(path.join(target, 'node_modules', '@kcs', 'shared')));
    await ensureRuntimeWorkspaceLinks(target);

    for (const [name, relative] of [['server', 'apps/server'], ['shared', 'packages/shared'], ['web', 'apps/web']]) {
      assert.equal(
        await fs.realpath(path.join(target, 'node_modules', '@kcs', name)),
        await fs.realpath(path.join(target, ...relative.split('/'))),
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('atomic JSON replacement never exposes partial JSON to readers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'));
  const file = path.join(root, 'updates', 'active.json');
  try {
    await writeJsonAtomic(file, { schemaVersion: 1, version: '0.7.14', payload: 'a'.repeat(1000) });
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonAtomic(file, {
      schemaVersion: 1,
      version: `0.8.${index}`,
      payload: String(index).repeat(1000),
    })));
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(parsed.schemaVersion, 1);
    assert.match(parsed.version, /^0\.8\.\d+$/);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['active.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('path checks reject siblings and treat Windows path casing as equivalent', () => {
  const parent = path.resolve('/tmp/studio/versions');
  assert.equal(isInside(parent, path.join(parent, '0.8.0')), true);
  assert.equal(isInside(parent, path.resolve('/tmp/studio/versions-evil/0.8.0')), false);
  assert.equal(samePath('C:\\Users\\Creator\\App', 'c:\\users\\creator\\app\\', 'win32'), true);
});

test('runtime-only typecheck is explicit and skips only repository tests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-typecheck-'));
  try {
    assert.equal(shouldUseRuntimeOnlyTypecheck(root, [], {}), false);
    assert.equal(shouldUseRuntimeOnlyTypecheck(root, ['--runtime-only'], {}), true);

    // This disposable root intentionally has no repository tests tree. Full
    // source validation must still require tests/tsconfig.json instead of
    // silently weakening itself merely because that file is absent.
    await assert.rejects(fs.access(path.join(root, 'tests', 'tsconfig.json')));

    const runtimeProjects = typecheckProjectArgs(root, { runtimeOnly: true }).flat().join('\n');
    assert.doesNotMatch(runtimeProjects, /tests[\\/]tsconfig\.json/);
    assert.match(runtimeProjects, /packages[\\/]shared[\\/]tsconfig\.json/);
    assert.match(runtimeProjects, /apps[\\/]server[\\/]tsconfig\.json/);
    assert.match(runtimeProjects, /apps[\\/]web[\\/]tsconfig\.json/);

    const fullProjects = typecheckProjectArgs(root).flat().join('\n');
    assert.match(fullProjects, /tests[\\/]tsconfig\.json/);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('legacy v0.8 broker preparation uses runtime-only typecheck only inside its update work tree', async () => {
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-v08-broker-'));
  try {
    const runtimeRoot = path.join(installRoot, 'updates', 'work', '0.85.4-fixture', 'source');
    const siblingRoot = path.join(installRoot, 'updates', 'work-evil', '0.85.4-fixture', 'source');
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.mkdir(siblingRoot, { recursive: true });

    const legacyEnv = {
      KCS_NONINTERACTIVE: '1',
      STHANG_STUDIO_BROKER_VERSION: '1.0.0',
      STHANG_STUDIO_INSTALL_ROOT: installRoot,
    };

    assert.equal(isLegacyBrokerPreparation(runtimeRoot, legacyEnv), true);
    assert.equal(shouldUseRuntimeOnlyTypecheck(runtimeRoot, [], legacyEnv), true);
    assert.equal(isLegacyBrokerPreparation(siblingRoot, legacyEnv), false);
    assert.equal(isLegacyBrokerPreparation(runtimeRoot, { ...legacyEnv, KCS_NONINTERACTIVE: '0' }), false);
    assert.equal(isLegacyBrokerPreparation(runtimeRoot, { ...legacyEnv, STHANG_STUDIO_BROKER_VERSION: '9.9.9' }), false);
    assert.equal(isLegacyBrokerPreparation(runtimeRoot, { ...legacyEnv, STHANG_STUDIO_INSTALL_ROOT: '' }), false);

    await fs.mkdir(path.join(runtimeRoot, 'tests'), { recursive: true });
    await fs.writeFile(path.join(runtimeRoot, 'tests', 'tsconfig.json'), '{}\n');
    assert.equal(isLegacyBrokerPreparation(runtimeRoot, legacyEnv), false);
    assert.equal(shouldUseRuntimeOnlyTypecheck(runtimeRoot, [], legacyEnv), false);
    assert.equal(shouldUseRuntimeOnlyTypecheck(runtimeRoot, ['--runtime-only'], legacyEnv), true);
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});


const apiIdentity = { version: '0.85.6', activationId: 'activation-fixture' };
const webIdentity = { ...apiIdentity, webBuildId: 'c'.repeat(64) };
const readyApi = { ok: true, engineVersion: apiIdentity.version };
const readyWeb = { schemaVersion: 1, service: 'sthang-studio-web', version: webIdentity.version, buildId: webIdentity.webBuildId };

async function healthServer(t, handler) {
  const sockets = new Set();
  const pulses = new Set();
  const state = { calls: 0, peakSockets: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    handler(req, res, state, pulses);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    state.peakSockets = Math.max(state.peakSockets, sockets.size);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    for (const pulse of pulses) clearInterval(pulse);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}/health`, state, sockets };
}

function replyHealth(res, body, activationId = apiIdentity.activationId, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Sthang-Studio-Activation': activationId });
  res.end(JSON.stringify(body));
}

// The watchdog is test-only: regressions must fail rather than hang the test runner.
async function boundedProbe(url, expected, timeoutMs, options = {}) {
  let watchdog;
  try {
    return await Promise.race([
      urlReady(url, expected, timeoutMs, options),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Health probe exceeded its absolute deadline')), timeoutMs + 250); }),
    ]);
  } finally { clearTimeout(watchdog); }
}

for (const mode of ['no headers', 'stalled body', 'slow trickle']) {
  test(`activation health has an absolute deadline for ${mode}`, async (t) => {
    const f = await healthServer(t, (_req, res, _state, pulses) => {
      if (mode === 'no headers') return;
      res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId });
      res.write('{');
      if (mode === 'slow trickle') {
        const pulse = setInterval(() => res.write(' '), 5);
        pulses.add(pulse);
        res.once('close', () => { clearInterval(pulse); pulses.delete(pulse); });
      }
    });
    assert.equal(await boundedProbe(f.url, apiIdentity, 100, { attemptTimeoutMs: 40, retryMs: 5 }), false);
    await delay(25);
    assert.equal(f.sockets.size, 0, 'deadline destroys active response and request sockets');
    const calls = f.state.calls;
    await delay(60);
    assert.equal(f.state.calls, calls, 'deadline leaves no scheduled retries');
  });
}

test('activation health per-attempt deadline retries a trickling body within the total budget', async (t) => {
  const f = await healthServer(t, (_req, res, state, pulses) => {
    if (state.calls > 1) return replyHealth(res, readyApi);
    res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId }); res.write('{');
    const pulse = setInterval(() => res.write(' '), 5);
    pulses.add(pulse);
    res.once('close', () => { clearInterval(pulse); pulses.delete(pulse); });
  });
  assert.equal(await boundedProbe(f.url, apiIdentity, 350, { attemptTimeoutMs: 40, retryMs: 5 }), true);
  assert.equal(f.state.calls, 2);
  await delay(25);
  assert.equal(f.sockets.size, 0);
});

test('activation health rejects oversized byte bodies immediately and recovers on the next attempt', async (t) => {
  const f = await healthServer(t, (_req, res, state) => {
    if (state.calls > 1) return replyHealth(res, readyApi);
    res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId }); res.write('ខ'.repeat(100));
  });
  assert.equal(await boundedProbe(f.url, apiIdentity, 200, { attemptTimeoutMs: 1000, retryMs: 5, maxBodyBytes: 128 }), true);
  assert.equal(f.state.calls, 2);
});

test('activation health recovers from an aborted response without overlapping attempts', async (t) => {
  const f = await healthServer(t, (_req, res, state) => {
    if (state.calls > 1) return replyHealth(res, readyApi);
    res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId }); res.write('{');
    setImmediate(() => res.destroy());
  });
  assert.equal(await boundedProbe(f.url, apiIdentity, 300, { attemptTimeoutMs: 50, retryMs: 5 }), true);
  assert.equal(f.state.calls, 2, 'error, aborted and close schedule only one retry');
});

for (const [name, expected, body, nonce, status] of [
  ['API unavailable', apiIdentity, readyApi, apiIdentity.activationId, 503],
  ['API not healthy', apiIdentity, { ...readyApi, ok: false }, apiIdentity.activationId, 200],
  ['API malformed identity', apiIdentity, 'not a health object', apiIdentity.activationId, 200],
  ['API redirect', apiIdentity, readyApi, apiIdentity.activationId, 302],
  ['API wrong version', apiIdentity, { ...readyApi, engineVersion: '0.1.0' }, apiIdentity.activationId, 200],
  ['API wrong process', apiIdentity, readyApi, 'old-process', 200],
  ['web redirect', webIdentity, readyWeb, apiIdentity.activationId, 302],
  ['web unrelated HTML', webIdentity, '<html>another service</html>', apiIdentity.activationId, 200],
  ['web wrong version', webIdentity, { ...readyWeb, version: '0.1.0' }, apiIdentity.activationId, 200],
  ['web wrong build', webIdentity, { ...readyWeb, buildId: 'd'.repeat(64) }, apiIdentity.activationId, 200],
  ['web wrong process', webIdentity, readyWeb, 'old-process', 200],
]) {
  test(`activation health rejects ${name}`, async (t) => {
    const f = await healthServer(t, (_req, res) => replyHealth(res, body, nonce, status));
    assert.equal(await boundedProbe(f.url, expected, 50, { attemptTimeoutMs: 25, retryMs: 5 }), false);
  });
}

for (const [service, expected, body] of [['API', apiIdentity, readyApi], ['web', webIdentity, readyWeb]]) {
  test(`activation health accepts the exact ${service} version, build and process identity`, async (t) => {
    const f = await healthServer(t, (_req, res) => replyHealth(res, body));
    const controller = new AbortController();
    assert.equal(await boundedProbe(f.url, expected, 200, { signal: controller.signal, retryMs: 5 }), true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await delay(30);
    assert.equal(f.sockets.size, 0);
    assert.equal(f.state.calls, 1);
  });
}

test('activation health abort cancels an unfinished response and all future retries', async (t) => {
  const controller = new AbortController();
  const f = await healthServer(t, (_req, res) => {
    res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId }); res.write('{');
    controller.abort();
  });
  assert.equal(await boundedProbe(f.url, apiIdentity, 200, { signal: controller.signal, retryMs: 5 }), false);
  await delay(30);
  assert.equal(f.sockets.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.state.calls, 1);
});

test('activation rolls back if the launched process exits despite matching healthy listeners', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-exit-'));
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false });
  const previous = { schemaVersion: 1, version: '0.85.5', relativePath: 'versions/0.85.5', manifestDigest: 'a'.repeat(64) };
  let stopped = false;
  try {
    await writeJsonAtomic(path.join(root, 'updates', 'active.json'), previous);
    await assert.rejects(() => activateWithRollback({
      installRoot: root,
      target: { version: '0.85.6', relativePath: 'versions/0.85.6', manifestDigest: 'b'.repeat(64) },
      launch: async () => child,
      healthCheck: async () => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
        return true;
      },
      stop: async () => { stopped = true; },
    }), /healthy|stopped|exited/i);
    assert.equal(stopped, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'updates', 'active.json'), 'utf8')), previous);
    await assert.rejects(fs.access(path.join(root, 'updates', 'transaction.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('activation launch identity is fresh and a rollback launch clears inherited identity', () => {
  const first = buildStudioStartSpec('/tmp/studio', true, 'darwin');
  const second = buildStudioStartSpec('/tmp/studio', true, 'darwin');
  assert.ok(first.env.STHANG_STUDIO_ACTIVATION_ID);
  assert.notEqual(first.env.STHANG_STUDIO_ACTIVATION_ID, second.env.STHANG_STUDIO_ACTIVATION_ID);
  const old = process.env.STHANG_STUDIO_ACTIVATION_ID;
  process.env.STHANG_STUDIO_ACTIVATION_ID = 'previous-activation';
  try {
    const fallback = buildStudioStartSpec('/tmp/studio', false, 'darwin');
    assert.equal(fallback.env.STHANG_STUDIO_ACTIVATION_ID, undefined);
    assert.equal(fallback.env.STHANG_STUDIO_UPDATE_ACTIVATION, undefined);
  } finally {
    if (old === undefined) delete process.env.STHANG_STUDIO_ACTIVATION_ID;
    else process.env.STHANG_STUDIO_ACTIVATION_ID = old;
  }
});

test('activation exit cancels a pending real HTTP probe and restores the previous marker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false });
  const previous = { schemaVersion: 1, version: '0.85.5', relativePath: 'versions/0.85.5', manifestDigest: 'a'.repeat(64) };
  await writeJsonAtomic(path.join(root, 'updates', 'active.json'), previous);
  const f = await healthServer(t, (_req, res) => {
    res.writeHead(200, { 'X-Sthang-Studio-Activation': apiIdentity.activationId });
    res.write('{');
    child.exitCode = 1;
    child.emit('exit', 1, null);
  });
  await assert.rejects(() => activateWithRollback({
    installRoot: root,
    target: { version: '0.85.6', relativePath: 'versions/0.85.6', manifestDigest: 'b'.repeat(64) },
    launch: async () => child,
    healthCheck: async (_child, signal) => boundedProbe(f.url, apiIdentity, 500, { signal }),
    stop: async () => {},
  }), /stopped/i);
  await delay(25);
  assert.equal(f.sockets.size, 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'updates', 'active.json'), 'utf8')), previous);
  await assert.rejects(fs.access(path.join(root, 'updates', 'transaction.json')));
});

test('activation rollback removes the new pointer when no previous pointer existed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-first-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => activateWithRollback({
    installRoot: root,
    target: { version: '0.85.6', relativePath: 'versions/0.85.6', manifestDigest: 'b'.repeat(64) },
    launch: async () => { throw new Error('Failed to spawn'); },
    healthCheck: async () => true,
    stop: async () => {},
  }), /spawn/);
  await assert.rejects(fs.access(path.join(root, 'updates', 'active.json')));
  await assert.rejects(fs.access(path.join(root, 'updates', 'transaction.json')));
});

test('activation catches process exit during durable commit after health succeeds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-runtime-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false });
  const previous = { schemaVersion: 1, version: '0.85.5', relativePath: 'versions/0.85.5', manifestDigest: 'a'.repeat(64) };
  await writeJsonAtomic(path.join(root, 'updates', 'active.json'), previous);
  await assert.rejects(() => activateWithRollback({
    installRoot: root,
    target: { version: '0.85.6', relativePath: 'versions/0.85.6', manifestDigest: 'b'.repeat(64) },
    launch: async () => child,
    healthCheck: async () => {
      setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); });
      return true;
    },
    stop: async () => {},
  }), /stopped/i);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'updates', 'active.json'), 'utf8')), previous);
  await assert.rejects(fs.access(path.join(root, 'updates', 'transaction.json')));
});

test('frontend build identity is versioned, content-bound and served by the frontend itself', async (t) => {
  const { studioWebIdentityPlugin, validateWebIdentity, webSourceIdentity, WEB_IDENTITY_FILE } = await import('../scripts/web-runtime-identity.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-web-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'apps/web/package.json': JSON.stringify({ version: '0.85.6' }),
    'apps/web/index.html': '<div id="root"></div>',
    'apps/web/vite.config.ts': '// frontend config',
    'apps/web/tsconfig.json': '{}',
    'apps/web/tsconfig.app.json': '{}',
    'apps/web/src/main.ts': 'console.log("Studio")',
    'apps/web/public/icon.svg': '<svg/>',
    'packages/shared/src/index.ts': 'export const shared = 1;',
    'packages/shared/package.json': '{}',
    'packages/shared/tsconfig.json': '{}',
    'package-lock.json': '{}',
    'scripts/web-runtime-identity.mjs': '// identity plugin',
  };
  for (const [relative, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), value);
  }
  const first = webSourceIdentity(root);
  assert.equal(validateWebIdentity(first, '0.85.6'), first);
  assert.throws(() => validateWebIdentity(first, '0.85.5'), /identity/);
  assert.deepEqual(webSourceIdentity(root), first);
  await fs.writeFile(path.join(root, 'apps/web/src/main.ts'), 'console.log("changed")');
  const changed = webSourceIdentity(root);
  assert.notEqual(changed.buildId, first.buildId);
  const plugin = studioWebIdentityPlugin(root);
  let emitted;
  plugin.generateBundle.call({ emitFile(asset) { emitted = asset; } });
  assert.equal(emitted.fileName, WEB_IDENTITY_FILE);
  assert.deepEqual(JSON.parse(emitted.source), changed);
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const old = process.env.STHANG_STUDIO_ACTIVATION_ID;
  process.env.STHANG_STUDIO_ACTIVATION_ID = apiIdentity.activationId;
  try {
    const f = await healthServer(t, (req, res) => {
      req.url = `/${WEB_IDENTITY_FILE}`;
      middleware(req, res, () => { throw new Error('Frontend identity must not proxy to the API'); });
    });
    assert.equal(await boundedProbe(f.url, { ...apiIdentity, webBuildId: changed.buildId }, 200), true);
  } finally {
    if (old === undefined) delete process.env.STHANG_STUDIO_ACTIVATION_ID;
    else process.env.STHANG_STUDIO_ACTIVATION_ID = old;
  }
});
