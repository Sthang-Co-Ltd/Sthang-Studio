#!/usr/bin/env node
/**
 * Native CI-only acceptance using the *installed* Windows 0.85.6 updater and
 * the byte-exact v0.86.0 OTA ZIP. This test has no production signing access.
 * Ed25519 private material exists in memory only; only the disposable installed
 * baseline's public trust file is temporarily swapped and restored afterward.
 * The signed production trust root in both release ZIPs stays unchanged.
 * App state/downloads stay under RUNNER_TEMP. Genuine unmodified Windows
 * installation and OTA helpers integrate with the fresh GitHub runner Desktop
 * KnownFolder under USERPROFILE; the owning Python verifier guards and removes
 * only test-created Studio shortcuts after the native children are stopped.
 * Successful candidate install/API/web health is real native execution. The
 * forced-false health callback with a synthetic Node child, and interrupted
 * transaction-marker replay, are explicitly synthetic rollback regressions.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASELINE = '0.85.6';
const TARGET = '0.86.0';
const PLATFORM = 'windows-x64';
const UPDATE_BASE = 'https://updates.sthang.app/studio/windows/';
const PACKAGE_NAME = `Sthang-Studio-OTA-v${TARGET}.zip`;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ACTIVATION_HEADER = 'x-sthang-studio-activation';
const ACTIVATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const APPLY_TIMEOUT_MS = 55 * 60_000;

function requireCondition(value, message) {
  if (!value) throw new Error('Windows OTA acceptance: ' + message);
}

function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function assertAbsent(file, message) {
  try { await fs.lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Windows OTA acceptance: ' + message);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function activationIdFrom(response) {
  const value = response.headers.get(ACTIVATION_HEADER);
  requireCondition(value === null || ACTIVATION_UUID.test(value),
    'an activation response returned a malformed per-launch identity header.');
  return value;
}

function verifyActivationPair(apiActivationId, webActivationId, legacyBroker = false) {
  requireCondition(apiActivationId === webActivationId,
    'the API and independently built frontend have different activation identity headers.');
  if (legacyBroker) {
    // The genuine v0.85.6 broker only supplies UPDATE_ACTIVATION=1 on launch;
    // its startStudio never generates STHANG_STUDIO_ACTIVATION_ID. Both headers
    // must therefore be absent when this exact older broker launches v0.86.0.
    requireCondition(apiActivationId === null,
      'the v0.85.6 broker unexpectedly supplied a launch identity.');
  } else {
    // v0.86.0+ broker activation sends crypto.randomUUID() to both services.
    requireCondition(typeof apiActivationId === 'string' && ACTIVATION_UUID.test(apiActivationId),
      'a current broker must supply the same valid per-launch UUID to both services.');
  }
}

function fixtureFetch({ pointerBytes, manifestBytes, packageBytes, manifestUrl, packageUrl, corrupt = false }) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let payload;
    let mime;
    if (url === UPDATE_BASE + 'latest.json') {
      payload = pointerBytes;
      mime = 'application/json';
    } else if (url === manifestUrl) {
      payload = manifestBytes;
      mime = 'application/json';
    } else if (url === packageUrl) {
      payload = corrupt ? Buffer.from(packageBytes) : packageBytes;
      if (corrupt) payload[0] ^= 0x1;
      mime = 'application/zip';
    } else {
      throw new Error('The signed fixture attempted an unreviewed network destination.');
    }
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': mime, 'content-length': String(payload.length) },
    });
  };
}

function signedFixture(protocol, unsigned, privateKey, trust, packageBytes) {
  const signed = protocol.signDocument(unsigned, privateKey, trust.keyId);
  const manifestBytes = Buffer.from(JSON.stringify(signed, null, 2) + '\n');
  const digest = hash(manifestBytes);
  const manifestUrl = UPDATE_BASE + 'v' + TARGET + '/release.json';
  const pointer = protocol.signDocument({
    schemaVersion: 1, product: 'sthang-studio', platform: PLATFORM,
    channel: 'preview', version: TARGET,
    manifestUrl, manifestSha256: digest,
  }, privateKey, trust.keyId);
  protocol.validateReleaseManifest(signed, trust);
  protocol.validateLatestPointer(pointer, trust);
  return {
    pointerBytes: Buffer.from(JSON.stringify(pointer, null, 2) + '\n'),
    manifestBytes, manifestUrl, packageBytes, packageUrl: unsigned.package.url,
    digest,
  };
}

function stripAppChildEnvironment(environment) {
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === 'PSMODULEPATH'
      || name === 'GH_TOKEN' || name === 'GITHUB_TOKEN' || name === 'GIT_ASKPASS'
      || name === 'SSH_AUTH_SOCK' || name === 'NODE_OPTIONS'
      || name === 'ACTIONS_RUNTIME_TOKEN' || name === 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
      || name === 'ACTIONS_ID_TOKEN_REQUEST_URL' || name === 'STHANG_STUDIO_UPDATE_PRIVATE_KEY_FILE'
      || name === 'STHANG_STUDIO_UPDATE_ACTIVATION' || name === 'STHANG_STUDIO_ACTIVATION_ID'
      || name.endsWith('_TOKEN') || name.endsWith('_SECRET')
      || name.endsWith('_PASSWORD') || name.endsWith('_API_KEY')) {
      delete environment[name];
    }
  }
  return environment;
}

function childEnv(installRoot) {
  const environment = { ...process.env,
    STHANG_STUDIO_INSTALL_ROOT: installRoot,
    STHANG_STUDIO_STATE_ROOT: installRoot,
    STHANG_STUDIO_ENV_FILE: path.join(installRoot, 'apps', 'server', '.env'),
    STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE: path.join(installRoot, 'config', 'update-trust-root.json'),
    STHANG_STUDIO_BROKER_VERSION: '1.0.0',
    KCS_NONINTERACTIVE: '1', KCS_OPEN_BROWSER: 'false',
    ORT_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
  };
  // Windows PowerShell 5.1 must construct its own module search paths.
  // pwsh 7 module paths leaked via Python/cmd break Utility cmdlet autoload.
  return stripAppChildEnvironment(environment);
}

async function waitForHealth(expectedVersion, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let reason = 'not ready';
  while (Date.now() < until) {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) {
        const json = await response.json();
        if (json.ok === true && json.engineVersion === expectedVersion) {
          return { body: json, activationId: activationIdFrom(response) };
        }
        reason = 'wrong API identity';
      } else reason = 'wrong HTTP status';
    } catch { reason = 'API unavailable'; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Windows OTA acceptance: native API health failed (${reason}).`);
}

async function waitForWebIdentity(installRoot, timeoutMs = 90_000) {
  const expected = await readJson(path.join(installRoot, 'versions', TARGET,
    'apps', 'web', 'dist', 'studio-web-identity.json'));
  requireCondition(expected.schemaVersion === 1 && expected.service === 'sthang-studio-web'
    && expected.version === TARGET && HEX64.test(expected.buildId),
  'the native candidate has no valid independently built web identity.');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch('http://127.0.0.1:5188/studio-web-identity.json', {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 200) {
        const offered = await response.json();
        if (offered.schemaVersion === 1 && offered.service === expected.service
          && offered.version === TARGET && offered.buildId === expected.buildId) {
          return activationIdFrom(response);
        }
      }
    } catch { /* Bounded polling while the native Vite service becomes ready. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Windows OTA acceptance: fresh candidate frontend did not serve its own exact build identity.');
}

async function nativeLogTail(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return '[no native log]'; }
  return text.split(/\r?\n/u).slice(-18).join('\n')
    .replace(/https?:\/\/\S+/giu, '[service endpoint]')
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '[runner path]')
    .replace(/(?:(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*)[^\s]+/giu, '[redacted setting]')
    .slice(-1700);
}

function sanitizedError(error) {
  return String(error?.message || 'unexpected failure')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[service endpoint]')
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '[runner path]')
    .replace(/(?:(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*)[^\s]+/giu, '[redacted setting]')
    .slice(-2000);
}

function nativeStageFailure(primary, cleanupErrors) {
  if (!primary && cleanupErrors.length === 0) return null;
  if (primary && cleanupErrors.length === 0) return primary;
  const details = cleanupErrors.map((error) => sanitizedError(error)).join(' | ');
  if (primary) {
    return new Error('Primary native acceptance failure: ' + sanitizedError(primary)
      + '\nSecondary fixture cleanup failure: ' + details, { cause: primary });
  }
  return new Error('Native acceptance cleanup failure: ' + details);
}

async function portAvailable(port = 8787) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function ownedFixtureListener(listener, installRoot, installCreatedMs) {
  if (!listener || ![8787, 5188].includes(listener.port)
    || !Number.isSafeInteger(listener.pid) || listener.pid <= 1
    || String(listener.name).toLowerCase() !== 'node.exe'
    || typeof listener.command !== 'string') return false;
  const command = listener.command.toLowerCase();
  if (command.includes(installRoot.toLowerCase())) return true;
  // Genuine v0.85.6 scripts/dev.mjs starts the backend as
  // `node --import tsx src/index.ts` with cwd inside the installed server.
  // Once its absolute-path launcher exits, the surviving listener's command
  // line no longer contains installRoot. The fresh runner's ports were
  // verified empty before this fixture launched; require this exact argv,
  // port, executable, and creation after the private installation.
  const started = Date.parse(listener.createdUtc);
  const executable = path.win32.normalize(String(listener.executable || '')).toLowerCase();
  const expectedNode = path.win32.normalize(process.execPath).toLowerCase();
  return listener.port === 8787 && Number.isFinite(started)
    && started >= installCreatedMs
    && executable === expectedNode
    && /(?:^|\s)--import\s+["']?tsx["']?\s+["']?src[\\/]index\.ts(?:["']|\s|$)/iu.test(listener.command);
}

async function stopOwnedStudio(installRoot) {
  // Windows CI has an isolated, freshly installed Studio tree. Target only
  // processes anchored in that tree or its exact known backend port-owner.
  // Unknown listeners must survive and block Desktop shortcut cleanup.
  const environment = childEnv(installRoot);
  environment.STHANG_STUDIO_ACCEPTANCE_INSTALL_ROOT = installRoot;
  const createdMs = (await fs.stat(installRoot)).birthtimeMs;
  requireCondition(Number.isFinite(createdMs) && createdMs > 0,
    'cannot attest creation time of the disposable Windows installation.');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $root = [Environment]::GetEnvironmentVariable('STHANG_STUDIO_ACCEPTANCE_INSTALL_ROOT')
    if (-not $root) { exit 2 }
    $processes = @(Get-CimInstance Win32_Process)
    $byPid = @{}
    foreach ($proc in $processes) { $byPid[[int]$proc.ProcessId] = $proc }
    $anchored = @($processes | Where-Object {
      $_.CommandLine -and $_.ProcessId -ne $PID -and
      $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ($_.Name -ieq 'node.exe' -or $_.Name -ieq 'cmd.exe' -or $_.Name -ieq 'powershell.exe')
    } | ForEach-Object { [int]$_.ProcessId })
    $listeners = @(foreach ($port in @(8787, 5188)) {
      foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        $id = [int]$connection.OwningProcess
        $proc = $byPid[$id]
        if ($null -eq $proc) {
          [pscustomobject]@{
            port = $port; pid = $id; name = ''; command = '';
            executable = ''; createdUtc = ''; parentPid = 0
          }
        } else {
          $started = if ($proc.CreationDate) { $proc.CreationDate.ToUniversalTime().ToString('o') } else { '' }
          [pscustomobject]@{
            port = $port; pid = $id; name = [string]$proc.Name;
            command = [string]$proc.CommandLine; createdUtc = $started;
            executable = [string]$proc.ExecutablePath; parentPid = [int]$proc.ParentProcessId
          }
        }
      }
    })
    [pscustomobject]@{ anchored = @($anchored); listeners = @($listeners) } |
      ConvertTo-Json -Compress -Depth 4
  `;
  const inspect = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: environment, cwd: installRoot, encoding: 'utf8', timeout: 20_000,
      maxBuffer: 512 * 1024, windowsHide: true,
    });
    requireCondition(!result.error && result.status === 0,
      'cannot inspect exact Windows fixture process ownership and listener ports.');
    let snapshot;
    try { snapshot = JSON.parse(result.stdout); } catch {
      throw new Error('Windows OTA acceptance: fixture process ownership record is malformed.');
    }
    requireCondition(snapshot && Array.isArray(snapshot.anchored) && Array.isArray(snapshot.listeners)
      && snapshot.anchored.length <= 40 && snapshot.listeners.length <= 16
      && snapshot.anchored.every((pid) => Number.isSafeInteger(pid) && pid > 1)
      && snapshot.listeners.every((item) => item && [8787, 5188].includes(item.port)
        && Number.isSafeInteger(item.pid) && item.pid > 0),
    'Windows fixture process ownership record exceeded its verified shape.');
    const ids = new Set(snapshot.anchored);
    for (const listener of snapshot.listeners) {
      const ownedParent = Number.isSafeInteger(listener.parentPid)
        && ids.has(listener.parentPid)
        && String(listener.name).toLowerCase() === 'node.exe'
        && Date.parse(listener.createdUtc) >= createdMs;
      if (ownedParent || ownedFixtureListener(listener, installRoot, createdMs)) ids.add(listener.pid);
    }
    return { ids, listeners: snapshot.listeners };
  };
  const until = Date.now() + 15_000;
  let last = { ids: new Set(), listeners: [] };
  while (Date.now() < until) {
    last = inspect();
    if (last.ids.size === 0 && await portAvailable(8787) && await portAvailable(5188)) return;
    for (const pid of last.ids) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 10_000,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  const unknownPorts = [...new Set(last.listeners.filter((item) =>
    !ownedFixtureListener(item, installRoot, createdMs)).map((item) => item.port))];
  const portState = await Promise.all([8787, 5188].map(async (port) =>
    ({ port, free: await portAvailable(port) })));
  throw new Error('Windows OTA acceptance: native cleanup incomplete: '
    + (last.ids.size ? 'owned fixture processes remain; ' : '')
    + (unknownPorts.length ? 'unrecognized listeners on ports ' + unknownPorts.join(',') + '; ' : '')
    + 'port 8787 ' + (portState[0].free ? 'free' : 'occupied')
    + ', port 5188 ' + (portState[1].free ? 'free' : 'occupied')
    + '. Desktop cleanup remains blocked.');
}

async function stopOnlyFromPython(rawRoot) {
  requireCondition(process.platform === 'win32' && process.arch === 'x64'
    && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows'
    && (process.env.GITHUB_REPOSITORY || '').toLowerCase() === 'sthang-co-ltd/sthang-studio'
    && (!process.env.RUNNER_ENVIRONMENT || process.env.RUNNER_ENVIRONMENT === 'github-hosted'),
  'test process cleanup is supported only on this native GitHub Windows runner.');
  requireCondition(typeof rawRoot === 'string' && path.isAbsolute(rawRoot),
    'the disposable installation path must be absolute.');
  const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
  const expected = path.join(runnerTemp, 'sthang-windows-acceptance',
    'state', 'local', 'Sthang Studio', 'app');
  requireCondition(path.resolve(rawRoot).toLowerCase() === path.resolve(expected).toLowerCase()
    && within(runnerTemp, expected),
  'process cleanup cannot target anything except the precise disposable installation.');
  const stat = await fs.lstat(expected);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink()
    && within(runnerTemp, await fs.realpath(expected)),
  'the native process cleanup target escaped the runner temporary workspace.');
  await stopOwnedStudio(expected);
}

async function runBroker(label, broker, pending, installRoot, logRoot, timeoutMs) {
  const file = path.join(logRoot, label + '.log');
  const log = await fs.open(file, 'wx');
  let child;
  try {
    child = spawn(process.execPath, [broker, 'apply', pending], {
      cwd: installRoot, env: childEnv(installRoot), windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    const status = await new Promise((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }, timeoutMs);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) reject(new Error('Native broker ' + label + ' exceeded its deadline.'));
        else resolve({ code, signal });
      });
    });
    return { ...status, logFile: file };
  } finally { await log.close(); }
}

async function protectedState(installRoot) {
  const files = new Map();
  const records = [
    ['data/acceptance-only-state.txt', 'synthetic studio project and history\n'],
    ['uploads/acceptance-only-media.txt', 'synthetic local user media\n'],
    ['exports/acceptance-only-export.txt', 'synthetic local rendered export\n'],
  ];
  // Real baseline setup creates apps/server/.env from the normal template.
  // It is user-state even in this disposable install: preserve its exact bytes.
  const environmentFile = path.join(installRoot, 'apps', 'server', '.env');
  const environmentStat = await fs.lstat(environmentFile);
  requireCondition(environmentStat.isFile() && !environmentStat.isSymbolicLink(),
    'the installed v0.85.6 environment is not a regular local configuration file.');
  files.set(environmentFile, hash(await fs.readFile(environmentFile)));
  for (const [relative, contents] of records) {
    const file = path.join(installRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await assertAbsent(file, 'the purported new test sentinel already exists.');
    await fs.writeFile(file, contents, { flag: 'wx' });
    files.set(file, hash(await fs.readFile(file)));
  }
  return async () => {
    for (const [file, expected] of files) {
      requireCondition(hash(await fs.readFile(file)) === expected,
        'an OTA stage altered protected synthetic user-owned state.');
    }
  };
}

async function failureActivationCore(runtime, installRoot, previousActive, confirmSentinels) {
  // Synthetic-only rollback contract: a test Node child and deliberately false
  // health callback. Never report this as a real native-health failure run.
  const fake = { version: '0.86.1', relativePath: 'versions/0.86.1', manifestDigest: 'f'.repeat(64) };
  const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: installRoot, env: childEnv(installRoot), stdio: 'ignore', windowsHide: true,
  });
  let failed = false;
  try {
    await runtime.activateWithRollback({
      installRoot, target: fake, launch: async () => child(),
      healthCheck: async () => false,
      stop: async (processHandle) => {
        if (processHandle.pid) spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' });
      },
    });
  } catch (error) {
    failed = /healthy|process stopped/i.test(String(error?.message));
  }
  requireCondition(failed, 'the old native runtime accepted failed activation health.');
  const updates = path.join(installRoot, 'updates');
  requireCondition(JSON.stringify(await readJson(path.join(updates, 'active.json'))) === JSON.stringify(previousActive),
    'failed activation health did not restore the previously accepted pointer.');
  await assertAbsent(path.join(updates, 'transaction.json'), 'failed activation left a live transaction.');
  await confirmSentinels();
}

async function crashWindows(runtime, installRoot, previousActive, manifestDigest, confirmSentinels) {
  const updateRoot = path.join(installRoot, 'updates');
  const active = path.join(updateRoot, 'active.json');
  const transaction = path.join(updateRoot, 'transaction.json');
  // Use a *different* synthetic selection from the already healthy 0.86.0
  // pointer so the after-swap recovery assertion catches a failed rollback.
  const fake = { version: '0.86.1', relativePath: 'versions/0.86.1',
    manifestDigest: hash(Buffer.from('synthetic interrupted upgrade after ' + manifestDigest)) };
  for (const afterPointerSwap of [false, true]) {
    await runtime.writeJsonAtomic(transaction, {
      schemaVersion: 1, status: 'activating', previous: previousActive, target: fake,
      startedAt: new Date().toISOString(),
    });
    if (afterPointerSwap) await runtime.writeJsonAtomic(active, { schemaVersion: 1, ...fake });
    requireCondition(await runtime.recoverInterruptedActivation(installRoot) === true,
      'the genuine old broker did not recover an interrupted activation.');
    requireCondition(JSON.stringify(await readJson(active)) === JSON.stringify(previousActive),
      'interrupted activation lost its previous known-good selection.');
    await assertAbsent(transaction, 'recovery did not clear the interruption marker.');
    await confirmSentinels();
  }
}

async function acceptance() {
  requireCondition(process.platform === 'win32' && process.arch === 'x64'
    && process.version === 'v24.21.0' && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_OS === 'Windows'
    && (process.env.GITHUB_REPOSITORY || '').toLowerCase() === 'sthang-co-ltd/sthang-studio',
  'the genuine Windows runner and reviewed Node 24.21.0 are required.');
  const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
  const request = JSON.parse(process.env.STUDIO_WINDOWS_OTA_REQUEST || '{}');
  const keys = ['installedRoot', 'workRoot', 'candidateZip', 'unsignedManifest', 'expectedCommit'];
  requireCondition(Object.keys(request).length === keys.length && keys.every((key) => Object.hasOwn(request, key))
    && HEX40.test(request.expectedCommit), 'the exact bounded native request is required.');
  for (const key of keys.slice(0, 4)) {
    requireCondition(typeof request[key] === 'string' && path.isAbsolute(request[key])
      && within(runnerTemp, request[key]), key + ' must be beneath RUNNER_TEMP.');
    requireCondition(within(runnerTemp, await fs.realpath(request[key])), key + ' resolved outside RUNNER_TEMP.');
  }
  const { installedRoot, workRoot, candidateZip, unsignedManifest } = request;
  requireCondition(!within(installedRoot, workRoot) && !within(workRoot, installedRoot),
    'the installed app and test inputs must be separate.');
  requireCondition((await readJson(path.join(installedRoot, 'package.json'))).version === BASELINE,
    'only the original installed 0.85.6 Windows bootstrap is accepted.');
  const trustFile = path.join(installedRoot, 'config', 'update-trust-root.json');
  const baseline = await fs.readFile(trustFile);
  const originalTrust = JSON.parse(baseline.toString('utf8'));
  requireCondition(originalTrust.schemaVersion === 1 && originalTrust.product === 'sthang-studio'
    && originalTrust.provisioned === true && originalTrust.platform === PLATFORM
    && originalTrust.endpoint === UPDATE_BASE + 'latest.json'
    && originalTrust.brokerVersion === '1.0.0'
    && HEX64.test(originalTrust.publicKeyHex),
  'the genuine installed public trust root is invalid.');
  const manifest = await readJson(unsignedManifest);
  const packageBytes = await fs.readFile(candidateZip);
  requireCondition(manifest.schemaVersion === 1 && manifest.product === 'sthang-studio'
    && manifest.version === TARGET && manifest.platform === PLATFORM && !Object.hasOwn(manifest, 'signature')
    && manifest.package.url === UPDATE_BASE + 'v' + TARGET + '/' + PACKAGE_NAME
    && manifest.package.sha256 === hash(packageBytes)
    && manifest.package.sizeBytes === packageBytes.length,
  'candidate bytes or unsigned manifest do not match exact Windows 0.86.0.');

  process.env.STHANG_STUDIO_INSTALL_ROOT = installedRoot;
  process.env.STHANG_STUDIO_STATE_ROOT = installedRoot;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(installedRoot, 'apps', 'server', '.env');
  process.env.STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE = trustFile;
  process.env.STHANG_STUDIO_BROKER_VERSION = '1.0.0';
  const protocol = await import(pathToFileURL(path.join(installedRoot, 'scripts', 'update-protocol.mjs')).href);
  // Genuine v0.85.6 setup performs npm ci but does not compile apps/server/dist.
  // The installed server itself loads src/index.ts through tsx and its NodeNext
  // .js-specifier resolution. Import that same installed source with the same
  // loader (started by Python with node --import tsx), never checkout code.
  const { createUpdateService } = await import(pathToFileURL(path.join(installedRoot, 'apps', 'server', 'src', 'updater.ts')).href);
  const runtime = await import(pathToFileURL(path.join(installedRoot, 'scripts', 'update-runtime.mjs')).href);
  requireCondition(typeof createUpdateService === 'function'
    && typeof runtime.activateWithRollback === 'function'
    && typeof runtime.recoverInterruptedActivation === 'function',
  'the real installed baseline updater entrypoints are unavailable.');
  const ephemeral = crypto.generateKeyPairSync('ed25519');
  const fixtureTrust = {
    ...originalTrust,
    keyId: 'studio-native-windows-ci-' + crypto.randomUUID(),
    publicKeyHex: protocol.publicKeyHexFromKey(ephemeral.publicKey),
  };
  protocol.validateTrustRoot(fixtureTrust);
  protocol.validateReleaseManifest(manifest, fixtureTrust, { verifySignature: false });
  const good = signedFixture(protocol, manifest, ephemeral.privateKey, fixtureTrust, packageBytes);
  const bad = structuredClone(manifest);
  bad.setup.packageLockSha256 = '0'.repeat(64);
  const badPreparation = signedFixture(protocol, bad, ephemeral.privateKey, fixtureTrust, packageBytes);
  const updates = path.join(installedRoot, 'updates');
  const active = path.join(updates, 'active.json');
  const pending = path.join(updates, 'pending-install.json');
  const broker = path.join(installedRoot, 'scripts', 'update-runtime.mjs');
  const stableBrokerDigest = hash(await fs.readFile(broker));
  const confirmSentinels = await protectedState(installedRoot);
  await assertAbsent(active, 'a fresh manually installed baseline unexpectedly has an active OTA pointer.');
  await assertAbsent(pending, 'a fresh manually installed baseline unexpectedly has a pending OTA install.');
  requireCondition(await portAvailable(8787) && await portAvailable(5188),
    'the Windows test runner already has occupied Studio ports.');
  const logRoot = await fs.mkdtemp(path.join(workRoot, 'win-ota-native-'));
  let trustModified = false;
  let primaryFailure = null;
  try {
    // This path exists ONLY under the runner's disposable LOCALAPPDATA override.
    // The private test key never leaves this process or reaches any release ZIP.
    trustModified = true;
    await fs.writeFile(trustFile, JSON.stringify(fixtureTrust, null, 2) + '\n');
    const baseOptions = {
      trustRoot: fixtureTrust, platform: 'win32', arch: 'x64', brokerActive: true,
      installRoot: installedRoot, updateRoot: updates,
      versionsRoot: path.join(installedRoot, 'versions'),
    };
    const serviceFor = (fixture, corrupt = false) => createUpdateService({
      ...baseOptions, fetchImpl: fixtureFetch({ ...fixture, corrupt }),
    });
    const corrupted = await serviceFor(good, true);
    const offer = await corrupted.check(BASELINE);
    requireCondition(offer.status === 'available' && offer.offer.version === TARGET,
      'the genuine installed 0.85.6 updater did not offer the fixture.');
    let rejected = false;
    try { await corrupted.download(good.digest); }
    catch (error) { rejected = error?.code === 'DOWNLOAD' || error?.code === 'SIGNATURE'; }
    requireCondition(rejected, 'the genuine downloader accepted a byte-corrupted OTA ZIP.');
    await assertAbsent(path.join(updates, 'staging', TARGET, 'receipt.json'),
      'the damaged ZIP received a trusted download receipt.');
    await assertAbsent(active, 'a damaged download changed the active version.');
    await confirmSentinels();
    console.log('PASS: genuine 0.85.6 signed-fixture check and corrupted download rejection.');

    const invalid = await serviceFor(badPreparation);
    const invalidOffer = await invalid.check(BASELINE);
    requireCondition(invalidOffer.status === 'available', 'signed bad-setup fixture was not offered.');
    await invalid.download(badPreparation.digest);
    const invalidPending = await invalid.prepareInstall(BASELINE, badPreparation.digest);
    requireCondition(invalidPending.pendingFile === pending, 'invalid fixture prepared an unexpected pending path.');
    const failed = await runBroker('expected-package-lock-failure', broker, pending, installedRoot,
      logRoot, 5 * 60_000);
    requireCondition(failed.code !== 0, 'the old broker accepted an invalid signed package-lock preimage. Log tail: '
      + await nativeLogTail(failed.logFile));
    const failureLog = await fs.readFile(failed.logFile, 'utf8');
    requireCondition(failureLog.includes('The package lock failed signed verification.'),
      'native old broker did not reach package-lock verification before failing. Log tail: '
      + await nativeLogTail(failed.logFile));
    await assertAbsent(active, 'failed dependency preflight changed the active version.');
    await assertAbsent(pending, 'failed dependency preflight retained a pending install.');
    await assertAbsent(path.join(updates, 'receipts', TARGET + '.json'),
      'failed preflight wrote a successful preparation receipt.');
    await waitForHealth(BASELINE);
    await confirmSentinels();
    await stopOwnedStudio(installedRoot);
    console.log('PASS: old native PowerShell broker rejected signed but inconsistent package lock and relaunched 0.85.6.');

    // Crash windows are simulated from the exact transaction shape persisted by
    // the real installed broker; no actual runner termination is needed.
    const transaction = path.join(updates, 'transaction.json');
    const crashTarget = { version: TARGET, relativePath: 'versions/' + TARGET,
      manifestDigest: good.digest };
    for (const afterPointerSwap of [false, true]) {
      await runtime.writeJsonAtomic(transaction, {
        schemaVersion: 1, status: 'activating', previous: null,
        target: crashTarget, startedAt: new Date().toISOString(),
      });
      if (afterPointerSwap) await runtime.writeJsonAtomic(active, {
        schemaVersion: 1, ...crashTarget, activatedAt: new Date().toISOString(),
      });
      requireCondition(await runtime.recoverInterruptedActivation(installedRoot) === true,
        'old broker did not recover before/after pointer interruption.');
      await assertAbsent(active, 'interrupted activation did not restore the legacy baseline selection.');
      await assertAbsent(transaction, 'crash recovery retained a transaction marker.');
      await confirmSentinels();
    }
    console.log('PASS: old installed broker restored baseline after both synthetic crash windows.');

    const service = await serviceFor(good);
    const validOffer = await service.check(BASELINE);
    requireCondition(validOffer.status === 'available' && validOffer.offer.manifestDigest === good.digest,
      'old client rejected the exact verified Windows candidate.');
    await service.download(good.digest);
    requireCondition((await service.check(BASELINE)).offer?.downloaded === true,
      'old client did not recognize the verified download receipt.');
    const prepared = await service.prepareInstall(BASELINE, good.digest);
    requireCondition(prepared.pendingFile === pending && prepared.version === TARGET,
      'old client did not request the approved candidate.');
    const native = await runBroker('native-successful-upgrade', broker, pending,
      installedRoot, logRoot, APPLY_TIMEOUT_MS);
    requireCondition(native.code === 0,
      'the genuine v0.85.6 broker did not complete actual native 0.86.0 dependency preparation and activation. Log tail: '
      + await nativeLogTail(native.logFile));
    const pointer = await readJson(active);
    requireCondition(pointer.version === TARGET && pointer.relativePath === 'versions/' + TARGET
      && pointer.manifestDigest === good.digest,
    'the native broker activated an unexpected version or manifest.');
    await assertAbsent(transaction, 'successful native activation retained its transaction marker.');
    await assertAbsent(pending, 'successful native activation retained a pending update.');
    const identity = await waitForHealth(TARGET);
    requireCondition(identity.body.ok === true && identity.body.engineVersion === TARGET,
      'candidate native API health has incorrect version evidence.');
    const webActivationId = await waitForWebIdentity(installedRoot);
    verifyActivationPair(identity.activationId, webActivationId, true);
    await confirmSentinels();
    requireCondition(hash(await fs.readFile(broker)) === stableBrokerDigest,
      'successful OTA replaced the stable v0.85.6 broker.');
    console.log('PASS: genuine old broker applied exact v0.86.0 ZIP with native dependencies, API health and retained user state.');

    await failureActivationCore(runtime, installedRoot, pointer, confirmSentinels);
    await crashWindows(runtime, installedRoot, pointer, good.digest, confirmSentinels);
    console.log('PASS (SYNTHETIC): old activation core rejected forced-false health on a test Node child and recovered simulated crash-pointer states.');
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupFailures = [];
  try {
    if (trustModified) await fs.writeFile(trustFile, baseline);
    requireCondition(hash(await fs.readFile(trustFile)) === hash(baseline),
      'the genuine production public trust root was not restored byte for byte.');
  } catch (error) { cleanupFailures.push(error); }
  try { await stopOwnedStudio(installedRoot); }
  catch (error) { cleanupFailures.push(error); }
  try { await confirmSentinels(); }
  catch (error) { cleanupFailures.push(error); }
  const failure = nativeStageFailure(primaryFailure, cleanupFailures);
  if (failure) throw failure;
  // All test release signatures remain ephemeral and the production trust
  // root was restored before any native fixture success is reported.
  console.log('WINDOWS NATIVE FIXTURE OTA PASS: real v0.86.0 startup/health plus synthetic rollback probes; production signature and live pointer not exercised.');
}

if (process.argv.length === 3 && process.argv[2] === '--stop-owned') {
  // Root travels only through environment; putting it in this helper's
  // command line would make Win32_Process ownership checks match/kill itself.
  stopOnlyFromPython(process.env.STHANG_CI_STOP_ROOT).then(() => {
    console.log('Disposable native Studio processes stopped; runner Desktop is ready for bounded shortcut cleanup.');
  }).catch((error) => {
    console.error('WINDOWS NATIVE CLEANUP FAILED: ' + (error?.message || 'unexpected error'));
    process.exitCode = 1;
  });
} else if (process.argv.slice(2).join(' ') === '--self-test') {
  const inherited = {
    PSModulePath: 'PS7 user', PSMODULEPATH: 'PS7 system',
    psmodulepath: 'PS7 built-in', Path: 'untouched-path',
    LOCALAPPDATA: 'untouched-local', GH_TOKEN: 'test-token',
  };
  assert.deepEqual(stripAppChildEnvironment(inherited),
    { Path: 'untouched-path', LOCALAPPDATA: 'untouched-local' });
  assert.equal(within('C:\\runner', 'C:\\runner\\fixture'), process.platform === 'win32');
  assert.equal(hash(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const currentId = crypto.randomUUID();
  assert.equal(activationIdFrom(new Response('', { headers: { 'X-Sthang-Studio-Activation': currentId } })), currentId);
  assert.equal(activationIdFrom(new Response('')), null);
  assert.throws(() => activationIdFrom(new Response('', { headers: { 'X-Sthang-Studio-Activation': 'invalid' } })),
    /malformed per-launch identity header/iu);
  assert.doesNotThrow(() => verifyActivationPair(currentId, currentId));
  assert.doesNotThrow(() => verifyActivationPair(null, null, true));
  assert.throws(() => verifyActivationPair(currentId, null), /different activation identity/iu);
  assert.throws(() => verifyActivationPair(null, null), /must supply/iu);
  assert.throws(() => verifyActivationPair(currentId, currentId, true), /unexpectedly supplied/iu);
  const root = path.win32.join('C:\\runner-temp', 'sthang-windows-acceptance',
    'state', 'local', 'Sthang Studio', 'app');
  const installedAt = Date.now() - 5_000;
  const relativeBackend = {
    port: 8787, pid: 12345, name: 'node.exe', executable: process.execPath,
    createdUtc: new Date().toISOString(), command: '"node.exe" --import tsx src/index.ts',
  };
  assert.equal(ownedFixtureListener(relativeBackend, root, installedAt), true);
  assert.equal(ownedFixtureListener({ ...relativeBackend, port: 5188 }, root, installedAt), false);
  assert.equal(ownedFixtureListener({ ...relativeBackend, command: '"node.exe" other.js' },
    root, installedAt), false);
  assert.equal(ownedFixtureListener({ ...relativeBackend, executable: 'C:\\unknown\\node.exe' },
    root, installedAt), false);
  assert.equal(ownedFixtureListener({ ...relativeBackend, createdUtc: new Date(0).toISOString() },
    root, installedAt), false);
  assert.equal(ownedFixtureListener({ ...relativeBackend, name: 'powershell.exe' },
    root, installedAt), false);
  assert.equal(ownedFixtureListener({
    ...relativeBackend, port: 5188,
    command: path.win32.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  }, root, installedAt), true);
  assert.equal(nativeStageFailure(null, []), null);
  assert.equal(nativeStageFailure(new Error('native failing stage'), []).message, 'native failing stage');
  const bothFailures = nativeStageFailure(new Error('native failing stage'),
    [new Error('owned listener remains')]);
  assert.match(bothFailures.message, /Primary native acceptance failure: native failing stage/iu);
  assert.match(bothFailures.message, /Secondary fixture cleanup failure: owned listener remains/iu);
  assert.equal(nativeStageFailure(null, [new Error('cleanup only')]).message,
    'Native acceptance cleanup failure: cleanup only');
  console.log('Windows OTA acceptance static guards PASS (native broker not executed).');
} else {
  acceptance().catch((error) => {
    console.error('WINDOWS OTA ACCEPTANCE FAILED: ' + (error?.message || 'unexpected error'));
    process.exitCode = 1;
  });
}
