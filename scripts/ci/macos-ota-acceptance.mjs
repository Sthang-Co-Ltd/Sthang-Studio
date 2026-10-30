#!/usr/bin/env node
/**
 * Native CI-only acceptance of the installed v0.85.6 Apple Silicon broker
 * against an exact, preverified v0.89.0 OTA ZIP. All signed offers here use
 * a fresh in-memory TEST key. No production signer, R2 pointer, or remote
 * update endpoint is used.
 *
 * Call AFTER the separately reviewed native installer helper has installed
 * the real v0.85.6 baseline and checked the candidate ZIP/source digest,
 * BEFORE that helper installs the v0.89.0 recovery package manually.
 *
 * node scripts/ci/macos-ota-acceptance.mjs --request '{"stateRoot":"/.../state",
 *   "candidatePackagePath":"/.../candidate.zip",
 *   "unsignedManifestPath":"/.../unsigned.json",
 *   "expectedCommit":"<40-hex-commit>","workRoot":"/.../work"}'
 *
 * --self-test performs host-independent guard checks only; it is NOT native
 * OTA acceptance and does not change files.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'sthang-co-ltd/sthang-studio';
const BASELINE = '0.85.6';
const CANDIDATE = '0.89.0';
const PLATFORM = 'macos-arm64';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UPDATE_URL = 'https://updates.sthang.app/studio/macos-arm64/';
const PACKAGE_NAME = 'Sthang-Studio-OTA-macOS-Apple-Silicon-v' + CANDIDATE + '.zip';
const PRODUCTION_KEY_ID = 'studio-updates-ed25519-root-v1';
const PRODUCTION_PUBLIC_KEY_HEX = '0e9ff5aaa1d9b3ea80887bd372d73fe83d5d7aaf51bfcfa09c3c07b1280cce5d';
const MAX_INPUT_PACKAGE_BYTES = 64 * 1024 * 1024;
const APPLY_DEADLINE_MS = 20 * 60 * 1000;
const HEALTH_DEADLINE_MS = 90 * 1000;

function requireCondition(value, message) {
  if (!value) throw new Error('Mac OTA acceptance: ' + message);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function separate(left, right) {
  return left !== right && !inside(left, right) && !inside(right, left);
}

async function approvedPath(label, raw, runnerTemp, type) {
  requireCondition(typeof raw === 'string' && path.isAbsolute(raw), label + ' must be absolute.');
  const absolute = path.resolve(raw);
  requireCondition(inside(runnerTemp, absolute), label + ' must be under RUNNER_TEMP.');
  const stat = await fs.lstat(absolute);
  requireCondition(!stat.isSymbolicLink(), label + ' must not be a symlink.');
  requireCondition(type === 'file' ? stat.isFile() : stat.isDirectory(), label + ' has the wrong type.');
  const real = await fs.realpath(absolute);
  requireCondition(inside(runnerTemp, real), label + ' resolves outside RUNNER_TEMP.');
  return real;
}

async function validateRequest(raw) {
  requireCondition(process.platform === 'darwin' && process.arch === 'arm64',
    'native Apple Silicon macOS is required.');
  requireCondition(process.env.GITHUB_ACTIONS === 'true',
    'GitHub Actions execution is required.');
  requireCondition(process.env.RUNNER_OS === 'macOS' && process.env.RUNNER_ARCH === 'ARM64'
    && (!process.env.RUNNER_ENVIRONMENT || process.env.RUNNER_ENVIRONMENT === 'github-hosted'),
  'the selected GitHub macOS arm64 runner is required.');
  requireCondition((process.env.GITHUB_REPOSITORY || '').toLowerCase() === REPOSITORY,
    'only the Sthang Studio GitHub repository is allowed.');
  requireCondition(process.version === 'v24.21.0',
    'the exact reviewed Node 24.21.0 runtime is required.');
  const macos = spawnSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8', timeout: 10_000,
  });
  requireCondition(macos.status === 0 && /^15\.\d+(?:\.\d+)?\s*$/.test(macos.stdout),
    'the workflow requires a native macOS 15 runner.');
  requireCondition(typeof process.env.RUNNER_TEMP === 'string' && path.isAbsolute(process.env.RUNNER_TEMP),
    'RUNNER_TEMP must be an absolute runner workspace.');
  const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
  requireCondition(path.isAbsolute(runnerTemp), 'RUNNER_TEMP is invalid.');
  const keys = ['stateRoot', 'candidatePackagePath', 'unsignedManifestPath', 'expectedCommit', 'workRoot'];
  requireCondition(raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key)),
  'request must contain only stateRoot, candidatePackagePath, unsignedManifestPath, expectedCommit, and workRoot.');
  requireCondition(typeof raw.expectedCommit === 'string' && HEX40.test(raw.expectedCommit),
    'exact lowercase 40-character candidate commit is required.');
  const stateRoot = await approvedPath('stateRoot', raw.stateRoot, runnerTemp, 'directory');
  const candidatePackagePath = await approvedPath('candidatePackagePath', raw.candidatePackagePath, runnerTemp, 'file');
  const unsignedManifestPath = await approvedPath('unsignedManifestPath', raw.unsignedManifestPath, runnerTemp, 'file');
  const workRoot = await approvedPath('workRoot', raw.workRoot, runnerTemp, 'directory');
  requireCondition(separate(stateRoot, workRoot)
    && separate(stateRoot, candidatePackagePath) && separate(stateRoot, unsignedManifestPath),
  'baseline state and acceptance inputs must be separate.');
  requireCondition(candidatePackagePath !== unsignedManifestPath,
    'package and unsigned manifest must be distinct files.');
  return { stateRoot, candidatePackagePath, unsignedManifestPath,
    expectedCommit: raw.expectedCommit, workRoot };
}

async function requiredRegular(file, parent) {
  requireCondition(inside(parent, path.resolve(file)), 'an installed source path escaped its root.');
  const stat = await fs.lstat(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink(),
    'the installed baseline is missing a regular required file.');
}

async function optionalFileDigest(file) {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicReplace(file, bytes, mode) {
  const temporary = path.join(path.dirname(file), '.mac-ota-ci-' + crypto.randomUUID() + '.tmp');
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function createSentinels(stateRoot) {
  const files = [
    path.join(stateRoot, 'data', 'ota-ci-protected-state.txt'),
    path.join(stateRoot, 'data', 'history', 'ota-ci-protected-history.txt'),
    path.join(stateRoot, 'data', 'proposals', 'ota-ci-protected-proposal.txt'),
    path.join(stateRoot, 'exports', 'ota-ci-protected-export.txt'),
    path.join(stateRoot, 'uploads', 'ota-ci-protected-media.txt'),
  ];
  for (const file of files) {
    const folder = path.dirname(file);
    await fs.mkdir(folder, { recursive: true });
    requireCondition(inside(stateRoot, await fs.realpath(folder)),
      'a protected state folder resolves outside the synthetic installation.');
    await fs.writeFile(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const protectedExisting = [
    path.join(stateRoot, 'app', 'apps', 'server', '.env'),
    path.join(stateRoot, 'app', 'package.json'),
    path.join(stateRoot, 'app', 'run-macos.sh'),
    path.join(stateRoot, 'app', 'scripts', 'update-runtime.mjs'),
    path.join(stateRoot, 'data', 'projects.json'),
    path.join(stateRoot, 'data', 'jobs.json'),
  ];
  const snapshots = [];
  for (const file of [...files, ...protectedExisting]) {
    snapshots.push({ file, digest: await optionalFileDigest(file) });
  }
  return async () => {
    for (const { file, digest } of snapshots) {
      requireCondition(await optionalFileDigest(file) === digest,
        'the OTA flow modified protected synthetic user data.');
    }
  };
}

function response(bytes, type) {
  return new Response(bytes, { status: 200, headers: {
    'content-type': type,
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
  } });
}

function fixtureFetch({ pointerBytes, manifestBytes, packageBytes, manifestUrl, packageUrl, corrupt = false }) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
    if (url === UPDATE_URL + 'latest.json') return response(pointerBytes, 'application/json');
    if (url === manifestUrl) return response(manifestBytes, 'application/json');
    if (url === packageUrl) {
      if (!corrupt) return response(packageBytes, 'application/zip');
      const altered = Buffer.from(packageBytes);
      altered[altered.length - 1] ^= 0x01;
      return response(altered, 'application/zip');
    }
    throw new Error('The fixture forbids any network request outside its three exact update URLs.');
  };
}

async function portAvailable() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(8787, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForFreePort(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await portAvailable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('Mac OTA acceptance: Studio port 8787 remains occupied.');
}

function localGet(relative, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: 8787, path: relative, agent: false }, (reply) => {
      const chunks = [];
      let total = 0;
      reply.on('data', (chunk) => {
        total += chunk.byteLength;
        if (total > limit) { request.destroy(new Error('Local health response is too large.')); return; }
        chunks.push(chunk);
      });
      reply.on('end', () => resolve({ status: reply.statusCode, body: Buffer.concat(chunks) }));
      reply.on('error', reject);
    });
    request.setTimeout(2_500, () => request.destroy(new Error('Local health timed out.')));
    request.on('error', reject);
  });
}

async function waitForInstalledHealth(version, installedRoot = null) {
  let expectedWeb = null;
  if (installedRoot) {
    expectedWeb = JSON.parse(await fs.readFile(
      path.join(installedRoot, 'apps', 'web', 'dist', 'studio-web-identity.json'), 'utf8'));
    requireCondition(expectedWeb.schemaVersion === 1 && expectedWeb.version === version
      && typeof expectedWeb.buildId === 'string' && expectedWeb.buildId.length > 0,
    'the candidate web identity file is invalid.');
  }
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  let lastFailure = '';
  do {
    try {
      const api = await localGet('/api/health', 32 * 1024);
      const page = await localGet('/');
      const health = JSON.parse(api.body.toString('utf8'));
      if (api.status === 200 && health.ok === true && health.engineVersion === version
        && page.status === 200 && page.body.includes(Buffer.from('<div id="root"></div>'))) {
        if (!expectedWeb) return;
        const web = await localGet('/studio-web-identity.json', 32 * 1024);
        const value = JSON.parse(web.body.toString('utf8'));
        if (web.status === 200 && value.schemaVersion === 1 && value.service === 'sthang-studio-web'
          && value.version === version && value.buildId === expectedWeb.buildId) return;
      }
      lastFailure = 'wrong installed version or frontend identity';
    } catch {
      lastFailure = 'local broker response unavailable';
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error('Mac OTA acceptance: native Studio health failed (' + lastFailure + ').');
}

async function waitForNativeHealth(version, installedRoot, logFile, stateRoot, logRoot) {
  try {
    await waitForInstalledHealth(version, installedRoot);
  } catch (error) {
    throw new Error((error?.message || 'Native health check failed.') + '\n'
      + await nativeLogTail(logFile, stateRoot, logRoot));
  }
}

function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,command='], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  requireCondition(!result.error && result.status === 0, 'cannot inspect owned Studio process groups.');
  return result.stdout.split(/\r?\n/).map((line) => {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return parsed && { pid: Number(parsed[1]), pgid: Number(parsed[2]), command: parsed[3] };
  }).filter(Boolean);
}

function ownedGroupIds(rows, stateRoot) {
  const allowed = [
    path.join(stateRoot, 'app', 'scripts', 'dev.mjs'),
    path.join(stateRoot, 'versions', CANDIDATE, 'scripts', 'dev.mjs'),
  ];
  // The v0.85.6 launcher execs the baseline broker before starting dev.mjs
  // in the broker's process group; the broker, not dev.mjs, is its group leader.
  const broker = path.join(stateRoot, 'app', 'scripts', 'update-runtime.mjs');
  const launcher = path.join(stateRoot, 'app', 'run-macos.sh');
  const brokerLauncher = path.join(stateRoot, 'app', 'scripts', 'launch-studio-macos.sh');
  return rows
    .filter(({ pid, pgid, command }) => pid === pgid && pgid > 1 && pgid !== process.pid
      && /^(?:\/\S+\/)?(?:node|bash)\s/.test(command)
      && ((allowed.some((file) => command.includes(file)) && command.includes('--production'))
        || (command.includes(broker) && command.includes('broker-macos')
          && command.includes(stateRoot))
        || command.includes(launcher) || command.includes(brokerLauncher)))
    .map(({ pgid }) => pgid);
}

function ownedGroups(stateRoot) {
  return ownedGroupIds(processRows(), stateRoot);
}

async function stopOwnedGroups(stateRoot) {
  const groups = [...new Set(ownedGroups(stateRoot))];
  for (const id of groups) {
    try { process.kill(-id, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!groups.some((id) => ownedGroups(stateRoot).includes(id))) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const id of groups) {
    if (!ownedGroups(stateRoot).includes(id)) continue;
    try { process.kill(-id, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  await waitForFreePort(10_000);
}

function childEnvironment(stateRoot) {
  const environment = { ...process.env,
    STHANG_STUDIO_STATE_ROOT: stateRoot,
    STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE: path.join(stateRoot, 'app', 'config', 'update-trust-root-macos.json'),
    STHANG_STUDIO_BROKER_VERSION: '1.0.0',
    KCS_NONINTERACTIVE: '1',
    KCS_OPEN_BROWSER: 'false',
    ORT_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    PORT: '8787',
  };
  for (const name of [
    'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'STHANG_STUDIO_UPDATE_ACTIVATION',
    'STHANG_STUDIO_ACTIVATION_ID', 'STHANG_STUDIO_BROKER_CHILD', 'NODE_OPTIONS',
  ]) delete environment[name];
  // A downloaded app and its setup subprocesses never need CI credentials.
  for (const name of Object.keys(environment)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL)/i.test(name)
      || /^(?:GH_|AWS_|CLOUDFLARE_)/i.test(name)) delete environment[name];
  }
  return environment;
}

async function nativeLogTail(file, stateRoot, workRoot) {
  let output = '';
  try {
    const stat = await fs.stat(file);
    const size = Math.min(stat.size, 24 * 1024);
    const data = Buffer.alloc(size);
    const handle = await fs.open(file, 'r');
    try { await handle.read(data, 0, size, stat.size - size); }
    finally { await handle.close(); }
    output = data.toString('utf8');
  } catch { return '[native stage log unavailable]'; }
  return output
    .replaceAll(stateRoot, '[isolated-state]')
    .replaceAll(workRoot, '[isolated-work]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[external-url]')
    .replace(/([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL)[A-Za-z_]*)\s*[:=]\s*[^\s]+/gi,
      '$1=[redacted]')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .split(/\r?\n/).slice(-14).join('\n').slice(-1_800);
}

async function runLogged(label, command, args, logRoot, cwd, environment, timeoutMs) {
  const logFile = path.join(logRoot, label + '.log');
  const output = await fs.open(logFile, 'wx', 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd, env: environment, detached: true,
      stdio: ['ignore', output.fd, output.fd],
    });
    const status = await new Promise((resolve, reject) => {
      let timedOut = false;
      let reapingTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (child.pid > 1) process.kill(-child.pid, 'SIGKILL'); } catch {}
        reapingTimer = setTimeout(() =>
          reject(new Error('Timed out reaping native stage ' + label + '.')), 10_000);
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(reapingTimer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(reapingTimer);
        if (timedOut) reject(new Error('Timed out running native stage ' + label + '.'));
        else resolve({ code, signal });
      });
    });
    return { ...status, logFile, tail: await nativeLogTail(
      logFile, environment.STHANG_STUDIO_STATE_ROOT, logRoot) };
  } catch (error) {
    throw new Error('Native stage ' + label + ' failed: ' + (error?.message || 'unknown error')
      + '\n' + await nativeLogTail(logFile, environment.STHANG_STUDIO_STATE_ROOT, logRoot));
  } finally {
    await output.close();
  }
}

async function launchNativeBroker(stateRoot, logRoot, environment, label, activation = false) {
  const app = path.join(stateRoot, 'app');
  const logFile = path.join(logRoot, label + '.log');
  const output = await fs.open(logFile, 'wx', 0o600);
  try {
    const local = { ...environment };
    if (activation) local.STHANG_STUDIO_UPDATE_ACTIVATION = '1';
    const child = spawn('/bin/bash', [path.join(app, 'run-macos.sh')], {
      cwd: app, env: local, detached: true,
      stdio: ['ignore', output.fd, output.fd],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native broker spawn timed out.')), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
    });
    requireCondition(Number.isSafeInteger(child.pid) && child.pid > 1,
      'native broker launched without a trackable process group.');
    return child.pid;
  } catch (error) {
    throw new Error('Native broker launch ' + label + ' failed: '
      + (error?.message || 'unknown error') + '\n'
      + await nativeLogTail(logFile, stateRoot, logRoot));
  } finally {
    await output.close();
  }
}

async function runOldApply(label, pendingFile, stateRoot, logRoot, environment) {
  const script = path.join(stateRoot, 'app', 'scripts', 'update-runtime.mjs');
  return runLogged(label, process.execPath, [script, 'apply', pendingFile],
    logRoot, path.join(stateRoot, 'app'), environment, APPLY_DEADLINE_MS);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function assertMissing(file, message) {
  try {
    await fs.lstat(file);
    throw new Error('Mac OTA acceptance: ' + message);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function controlSnapshot(files) {
  const records = new Map();
  for (const file of files) {
    try {
      const info = await fs.lstat(file);
      requireCondition(info.isFile() && !info.isSymbolicLink(),
        'a baseline control record is not a regular file.');
      records.set(file, { bytes: await fs.readFile(file), mode: info.mode & 0o777 });
    } catch (error) {
      if (error?.code === 'ENOENT') records.set(file, null);
      else throw error;
    }
  }
  return records;
}

async function restoreControlSnapshot(snapshot) {
  for (const [file, original] of snapshot) {
    if (original === null) {
      await fs.rm(file, { force: true });
    } else {
      await atomicReplace(file, original.bytes, original.mode);
    }
  }
  for (const [file, original] of snapshot) {
    const actual = await optionalFileDigest(file);
    const expected = original
      ? crypto.createHash('sha256').update(original.bytes).digest('hex')
      : null;
    requireCondition(actual === expected, 'the baseline update-control bytes were not restored.');
  }
}

async function removeFixtureStaging(updateRoot, version) {
  const directory = path.join(updateRoot, 'staging', version);
  let exists = true;
  try {
    const info = await fs.lstat(directory);
    requireCondition(info.isDirectory() && !info.isSymbolicLink(),
      'the test staging directory became an unexpected entry.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) {
    // Only these three files can be created by the actual checked-out
    // updater's staging logic. Never recursively remove unknown user state.
    for (const name of ['package.zip', 'release.json', 'receipt.json']) {
      const file = path.join(directory, name);
      try {
        const info = await fs.lstat(file);
        requireCondition(info.isFile() && !info.isSymbolicLink(),
          'a fixture staging entry changed type unexpectedly.');
        await fs.rm(file);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await fs.rmdir(directory);
  }
  const receipt = path.join(updateRoot, 'receipts', version + '.json');
  try {
    const info = await fs.lstat(receipt);
    requireCondition(info.isFile() && !info.isSymbolicLink(),
      'the native preparation receipt changed type unexpectedly.');
    await fs.rm(receipt);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function exercise(request) {
  const { stateRoot, candidatePackagePath, unsignedManifestPath, expectedCommit, workRoot } = request;
  const app = path.join(stateRoot, 'app');
  const trustFile = path.join(app, 'config', 'update-trust-root-macos.json');
  const protocolPath = path.join(app, 'scripts', 'update-protocol.mjs');
  const updaterPath = path.join(app, 'apps', 'server', 'dist', 'updater.js');
  const runtimePath = path.join(app, 'scripts', 'update-runtime.mjs');
  const updates = path.join(stateRoot, 'updates');
  const target = path.join(stateRoot, 'versions', CANDIDATE);
  const active = path.join(updates, 'active.json');
  const transaction = path.join(updates, 'transaction.json');
  const pending = path.join(updates, 'pending-install.json');

  const appReal = await fs.realpath(app);
  requireCondition(inside(stateRoot, appReal)
    && (await fs.lstat(app)).isDirectory() && !(await fs.lstat(app)).isSymbolicLink(),
  'the installed broker root is not a real directory inside synthetic state.');
  for (const file of [trustFile, protocolPath, updaterPath, runtimePath,
    path.join(app, 'run-macos.sh'), path.join(app, 'package.json')]) {
    await requiredRegular(file, stateRoot);
    requireCondition(inside(stateRoot, await fs.realpath(file)),
      'an installed broker source resolves outside synthetic state.');
  }
  requireCondition((await readJson(path.join(app, 'package.json'))).version === BASELINE,
    'the genuine installed v0.85.6 baseline is required.');
  requireCondition((await fs.readFile(path.join(app, '.sthang', 'macos-curated-runtime'), 'utf8')).trim()
    === 'production-runtime-v1', 'the installed v0.85.6 runtime is not curated.');
  requireCondition((await fs.stat(path.join(app, '.venv', 'bin', 'python'))).isFile(),
    'the baseline timing environment is missing.');
  requireCondition((await fs.stat(path.join(app, 'node_modules'))).isDirectory(),
    'the baseline installed Node dependencies are missing.');
  await assertMissing(active, 'a baseline active OTA pointer already exists.');
  await assertMissing(transaction, 'an existing update transaction must not be overwritten.');
  await assertMissing(pending, 'an existing pending release must not be overwritten.');
  await assertMissing(target, 'the baseline already contains an immutable v0.89.0 version.');
  await assertMissing(path.join(updates, 'staging', CANDIDATE),
    'the baseline already contains a staged candidate.');
  await assertMissing(path.join(updates, 'receipts', CANDIDATE + '.json'),
    'the baseline already contains a prepared candidate receipt.');
  await waitForFreePort(3_000);
  requireCondition(ownedGroups(stateRoot).length === 0,
    'an existing broker process group already owns this synthetic installation.');
  const controls = await controlSnapshot([
    active, pending, transaction,
    path.join(updates, 'rollback.json'),
    path.join(updates, 'high-water.json'),
    path.join(updates, 'last-failure.json'),
  ]);

  requireCondition((await fs.stat(unsignedManifestPath)).size <= 128 * 1024,
    'the reviewed unsigned manifest is too large.');
  const packageStat = await fs.stat(candidatePackagePath);
  requireCondition(packageStat.size > 0 && packageStat.size <= MAX_INPUT_PACKAGE_BYTES,
    'candidate ZIP size is outside the bounded native fixture limit.');
  const unsigned = await readJson(unsignedManifestPath);
  const packageBytes = await fs.readFile(candidatePackagePath);
  requireCondition(unsigned?.schemaVersion === 2 && unsigned.product === 'sthang-studio'
    && unsigned.platform === PLATFORM && unsigned.channel === 'preview'
    && unsigned.version === CANDIDATE && unsigned.source?.commit === expectedCommit,
  'the selected unsigned manifest has the wrong source, version or platform.');
  requireCondition(!Object.hasOwn(unsigned, 'signature'),
    'the input must be the reviewed unsigned manifest, never a production signed offer.');
  requireCondition(unsigned.package?.url === UPDATE_URL + 'v' + CANDIDATE + '/' + PACKAGE_NAME,
    'the candidate package URL is not the exact immutable macOS target.');
  requireCondition(unsigned.package?.sizeBytes === packageBytes.length
    && HEX64.test(unsigned.package?.sha256 || '')
    && crypto.createHash('sha256').update(packageBytes).digest('hex') === unsigned.package.sha256,
  'candidate ZIP bytes do not match the reviewed unsigned manifest.');

  // Installed config.ts-derived modules capture this root at import time.
  process.env.STHANG_STUDIO_STATE_ROOT = stateRoot;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(app, 'apps', 'server', '.env');
  process.env.STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE = trustFile;
  process.env.STHANG_STUDIO_BROKER_VERSION = '1.0.0';
  const protocol = await import(pathToFileURL(protocolPath).href);
  const { createUpdateService } = await import(pathToFileURL(updaterPath).href);
  const runtime = await import(pathToFileURL(runtimePath).href);
  requireCondition(typeof createUpdateService === 'function'
    && typeof runtime.recoverInterruptedActivation === 'function'
    && typeof runtime.writeJsonAtomic === 'function'
    && typeof protocol.signDocument === 'function',
  'the installed v0.85.6 broker entrypoints are unavailable.');

  const oldTrustBytes = await fs.readFile(trustFile);
  const oldTrustStat = await fs.stat(trustFile);
  const originalTrust = JSON.parse(oldTrustBytes.toString('utf8'));
  requireCondition(originalTrust.provisioned === true && originalTrust.platform === PLATFORM
    && originalTrust.endpoint === UPDATE_URL + 'latest.json'
    && originalTrust.brokerVersion === '1.0.0'
    && originalTrust.keyId === PRODUCTION_KEY_ID
    && originalTrust.publicKeyHex === PRODUCTION_PUBLIC_KEY_HEX,
  'the baseline production public trust identity is invalid.');
  const ephemeral = crypto.generateKeyPairSync('ed25519');
  const trust = { ...originalTrust,
    keyId: 'studio-native-ota-ci-' + crypto.randomUUID(),
    publicKeyHex: protocol.publicKeyHexFromKey(ephemeral.publicKey),
  };
  protocol.validateTrustRoot(trust);
  protocol.validateReleaseManifest(unsigned, trust, { verifySignature: false });
  const signedManifest = protocol.signDocument(unsigned, ephemeral.privateKey, trust.keyId);
  const manifestBytes = Buffer.from(JSON.stringify(signedManifest, null, 2) + '\n');
  const manifestDigest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const manifestUrl = UPDATE_URL + 'v' + CANDIDATE + '/release.json';
  const signedPointer = protocol.signDocument({
    schemaVersion: 1, product: 'sthang-studio', platform: PLATFORM,
    channel: 'preview', version: CANDIDATE,
    manifestUrl, manifestSha256: manifestDigest,
  }, ephemeral.privateKey, trust.keyId);
  const pointerBytes = Buffer.from(JSON.stringify(signedPointer, null, 2) + '\n');
  protocol.validateLatestPointer(signedPointer, trust);
  protocol.validateReleaseManifest(signedManifest, trust);

  const logRoot = await fs.mkdtemp(path.join(workRoot, 'ota-native-'));
  console.log('Mac OTA fixture logs: ' + logRoot);
  const environment = childEnvironment(stateRoot);
  const confirmSentinels = await createSentinels(stateRoot);
  let trustModified = false;
  let cleanupError;
  const results = [];
  try {
    // Also restore if an interrupted/failed replacement returns an error
    // after the disposable baseline file was changed.
    trustModified = true;
    await atomicReplace(trustFile, Buffer.from(JSON.stringify(trust, null, 2) + '\n'),
      oldTrustStat.mode & 0o777);
    const baseOptions = {
      trustRoot: trust, platform: 'darwin', arch: 'arm64', brokerActive: true,
      installRoot: stateRoot, updateRoot: updates, versionsRoot: path.join(stateRoot, 'versions'),
    };
    const fetchValues = { pointerBytes, manifestBytes, packageBytes, manifestUrl,
      packageUrl: unsigned.package.url };
    const corrupt = await createUpdateService({
      ...baseOptions, fetchImpl: fixtureFetch({ ...fetchValues, corrupt: true }),
    });
    const badOffer = await corrupt.check(BASELINE);
    requireCondition(badOffer.status === 'available' && badOffer.offer.version === CANDIDATE
      && badOffer.offer.manifestDigest === manifestDigest && !badOffer.offer.downloaded,
    'the installed v0.85.6 updater did not offer the exact fixture release.');
    let rejected = false;
    try { await corrupt.download(manifestDigest); }
    catch (error) {
      rejected = error?.code === 'SIGNATURE' || error?.code === 'DOWNLOAD';
    }
    requireCondition(rejected, 'the actual baseline downloader accepted corrupted candidate bytes.');
    await assertMissing(path.join(updates, 'staging', CANDIDATE, 'receipt.json'),
      'a corrupted package was given a trusted receipt.');
    await assertMissing(active, 'the corrupted download changed active Studio.');
    await confirmSentinels();
    results.push('PASS: genuine v0.85.6 fixture check and corrupted-ZIP rejection.');
    console.log(results.at(-1));

    const service = await createUpdateService({
      ...baseOptions, fetchImpl: fixtureFetch(fetchValues),
    });
    const offer = await service.check(BASELINE);
    requireCondition(offer.status === 'available' && offer.offer.manifestDigest === manifestDigest,
      'the baseline checker rejected the exact ephemeral Ed25519 offer.');
    const downloaded = await service.download(manifestDigest);
    requireCondition(downloaded?.downloaded && downloaded.version === CANDIDATE,
      'the actual baseline downloader did not verify the candidate ZIP.');
    requireCondition((await service.check(BASELINE)).offer?.downloaded === true,
      'the baseline updater did not recognize its verified staging receipt.');
    const prepare = async () => {
      const prepared = await service.prepareInstall(BASELINE, manifestDigest);
      requireCondition(prepared.version === CANDIDATE && prepared.pendingFile === pending,
        'the baseline broker prepared an unexpected update target.');
      const contents = await readJson(pending);
      requireCondition(contents.platform === PLATFORM && contents.targetVersion === CANDIDATE
        && contents.currentVersion === BASELINE
        && contents.manifestDigest === manifestDigest && contents.targetRelativePath === 'versions/' + CANDIDATE,
      'the baseline broker wrote an unexpected pending transaction.');
      return prepared.pendingFile;
    };
    // Full old Python preparation is run against the authentic candidate ZIP.
    // The only injected fault is an existing synthetic *target* marker that
    // must be refused AFTER the real candidate extraction/dependency setup.
    await fs.mkdir(path.dirname(target), { recursive: true });
    requireCondition(inside(stateRoot, await fs.realpath(path.dirname(target))),
      'immutable versions root resolved outside synthetic state.');
    await fs.mkdir(target, { recursive: false });
    const blockingMarker = path.join(target, '.sthang-update-version.json');
    await fs.writeFile(blockingMarker, JSON.stringify({
      schemaVersion: 1, platform: PLATFORM, version: BASELINE,
    }) + '\n', { flag: 'wx' });
    try {
      const failedPending = await prepare();
      results.push('PASS: actual v0.85.6 download, stage receipt, and prepareInstall of the exact v0.89.0 ZIP.');
      console.log(results.at(-1));
      requireCondition(await portAvailable(), 'the test port was occupied before failed preparation.');
      const failed = await runOldApply('native-preparation-rejected', failedPending, stateRoot,
        logRoot, environment);
      requireCondition(failed.code !== 0,
        'the old native broker accepted a conflicting immutable version.\n' + failed.tail);
      requireCondition(/The existing immutable version directory does not match this release/.test(failed.tail),
        'the failed native path did not reach post-dependency immutable-target verification.\n' + failed.tail);
      await assertMissing(active, 'failed native preparation incorrectly activated the candidate.');
      await assertMissing(pending, 'failed native preparation retained a pending install.');
      await assertMissing(path.join(updates, 'receipts', CANDIDATE + '.json'),
        'a failed native preparation wrote a successful preparation receipt.');
      await waitForNativeHealth(BASELINE, null, failed.logFile, stateRoot, logRoot);
      await confirmSentinels();
      results.push('PASS: real old Python candidate extraction/dependency preparation reached its end, rejected conflicting immutable target, and recovered the v0.85.6 launcher.');
      console.log(results.at(-1));
    } finally {
      await stopOwnedGroups(stateRoot);
      requireCondition((await fs.readFile(blockingMarker, 'utf8')).includes(BASELINE),
        'the synthetic immutable blocker was overwritten.');
      await fs.rm(blockingMarker);
      await fs.rmdir(target);
    }

    // Crash-window simulation: persist the exact journal shape written by the
    // old broker after activation starts, before it can complete health.
    const interruptedTarget = {
      version: CANDIDATE, relativePath: 'versions/' + CANDIDATE,
      manifestDigest,
    };
    await runtime.writeJsonAtomic(transaction, {
      schemaVersion: 1, status: 'activating', previous: null,
      target: interruptedTarget, startedAt: new Date().toISOString(),
    });
    await runtime.writeJsonAtomic(active, {
      schemaVersion: 1, ...interruptedTarget, activatedAt: new Date().toISOString(),
    });
    requireCondition(await runtime.recoverInterruptedActivation(stateRoot) === true,
      'the genuine old broker did not recover the synthetic interrupted activation.');
    await assertMissing(active, 'the interrupted activation left a stale active version.');
    await assertMissing(transaction, 'the interrupted activation retained its journal.');
    const recovered = await runtime.resolveActiveSourceRoot(stateRoot, PLATFORM);
    requireCondition(recovered.sourceRoot === app && recovered.activeVersion === '',
      'interrupted activation did not restore the baseline broker.');
    await confirmSentinels();
    results.push('PASS: synthetic crash journal recovered by the genuine v0.85.6 broker, restoring baseline selection and protected state.');
    console.log(results.at(-1));

    // End-to-end install: the installed old runtime validates signed bytes,
    // executes real preparation, switches the version pointer, starts the
    // prepared candidate, and validates API/UI health through loopback.
    const successPending = await prepare();
    requireCondition(await portAvailable(), 'Studio port occupied before the actual native OTA.');
    const applied = await runOldApply('native-ota-success', successPending, stateRoot,
      logRoot, environment);
    requireCondition(applied.code === 0 && !applied.signal,
      'the installed v0.85.6 broker failed to apply the real candidate ZIP.\n' + applied.tail);
    await waitForNativeHealth(CANDIDATE, target, applied.logFile, stateRoot, logRoot);
    const pointer = await readJson(active);
    requireCondition(pointer.schemaVersion === 1 && pointer.version === CANDIDATE
      && pointer.relativePath === 'versions/' + CANDIDATE
      && pointer.manifestDigest === manifestDigest,
    'the native broker did not activate the exact candidate version.');
    const marker = await readJson(path.join(target, '.sthang-update-version.json'));
    requireCondition(marker.schemaVersion === 1 && marker.version === CANDIDATE
      && marker.platform === PLATFORM && marker.manifestDigest === manifestDigest
      && marker.packageSha256 === unsigned.package.sha256,
    'the prepared version marker does not match the signed fixture manifest.');
    const rollback = await readJson(path.join(updates, 'rollback.json'));
    requireCondition(rollback?.schemaVersion === 1 && rollback.previous === null
      && rollback.active.version === CANDIDATE,
    'the completed native activation lacks its rollback receipt.');
    await assertMissing(pending, 'a successful OTA retained pending-install.json.');
    await assertMissing(transaction, 'a successful OTA retained an activation transaction.');
    const preparationReceipt = await readJson(path.join(updates, 'receipts', CANDIDATE + '.json'));
    requireCondition(preparationReceipt.schemaVersion === 1
      && preparationReceipt.version === CANDIDATE
      && preparationReceipt.manifestDigest === manifestDigest
      && preparationReceipt.packageSha256 === unsigned.package.sha256,
    'real native dependency preparation did not publish its exact-version receipt.');
    const highWater = await readJson(path.join(updates, 'high-water.json'));
    requireCondition(highWater.schemaVersion === 1 && highWater.platform === PLATFORM
      && highWater.highestVersion === CANDIDATE && highWater.manifestDigest === manifestDigest,
    'the genuine baseline client did not retain its signed-version anti-replay floor.');
    requireCondition((await fs.stat(path.join(target, '.venv', 'bin', 'python'))).isFile(),
      'the prepared candidate does not include an installed Python environment.');
    requireCondition((await fs.stat(path.join(target, 'node_modules'))).isDirectory(),
      'the prepared candidate does not include installed Node dependencies.');
    const smoke = await runLogged('native-candidate-timing-ready',
      path.join(target, '.venv', 'bin', 'python'),
      ['-B', path.join(target, 'scripts', 'check-macos-timing.py'), '--ready'],
      logRoot, target, environment, 180_000);
    requireCondition(smoke.code === 0 && !smoke.signal,
      'the installed candidate native Python/KFA dependency readiness check failed.\n' + smoke.tail);
    await confirmSentinels();
    results.push('PASS: real v0.85.6 broker applied v0.89.0, prepared installed dependencies, activated the exact version, and served native API/UI/build identity health.');
    console.log(results.at(-1));

    // Exercise the old broker's *real* post-launch activation rollback with
    // the already prepared native candidate. The only injected fault is the
    // health callback returning false AFTER the actual 0.89.0 API and web
    // identity have been observed. This is not a real unhealthy release.
    await stopOwnedGroups(stateRoot);
    await fs.rm(active);
    const selectedBaseline = await runtime.resolveActiveSourceRoot(stateRoot, PLATFORM);
    requireCondition(selectedBaseline.sourceRoot === app && selectedBaseline.activeVersion === '',
      'the native health-fault fixture did not begin at the original v0.85.6 baseline.');
    let launchedFaultGroup = null;
    let observedCandidateHealth = false;
    let stoppedFaultGroup = false;
    await assert.rejects(
      () => runtime.activateWithRollback({
        installRoot: stateRoot,
        target: interruptedTarget,
        launch: async () => {
          launchedFaultGroup = await launchNativeBroker(stateRoot, logRoot, environment,
            'native-injected-health-failure-launch', true);
          return launchedFaultGroup;
        },
        healthCheck: async () => {
          await waitForNativeHealth(CANDIDATE, target,
            path.join(logRoot, 'native-injected-health-failure-launch.log'),
            stateRoot, logRoot);
          observedCandidateHealth = true;
          return false; // CI fixture: deliberately fail AFTER genuine local health.
        },
        stop: async (pid) => {
          requireCondition(pid === launchedFaultGroup,
            'old broker tried to stop an unexpected process group.');
          await stopOwnedGroups(stateRoot);
          stoppedFaultGroup = true;
        },
      }),
      /The new Studio version did not become healthy/,
    );
    requireCondition(observedCandidateHealth && stoppedFaultGroup,
      'the old broker did not exercise the injected post-launch health rollback.');
    await assertMissing(active, 'failed native activation left a stale v0.89.0 pointer.');
    await assertMissing(transaction, 'failed native activation retained its crash journal.');
    requireCondition((await runtime.resolveActiveSourceRoot(stateRoot, PLATFORM)).sourceRoot === app,
      'failed native activation did not restore the original installed broker.');
    await confirmSentinels();
    requireCondition(await portAvailable(), 'the rejected candidate native process was not reaped.');
    await launchNativeBroker(stateRoot, logRoot, environment,
      'native-baseline-after-health-rollback', false);
    await waitForNativeHealth(BASELINE, null,
      path.join(logRoot, 'native-baseline-after-health-rollback.log'),
      stateRoot, logRoot);
    await stopOwnedGroups(stateRoot);
    results.push('PASS: real native 0.89.0 process passed API/UI health, then an injected health rejection exercised old-broker pointer rollback, process cleanup, and genuine v0.85.6 relaunch.');
    console.log(results.at(-1));
  } finally {
    try { await stopOwnedGroups(stateRoot); } catch (error) { cleanupError = error; }
    try {
      await removeFixtureStaging(updates, CANDIDATE);
      await restoreControlSnapshot(controls);
      await assertMissing(active, 'a fixture active OTA pointer remained after cleanup.');
      await assertMissing(pending, 'a fixture pending OTA pointer remained after cleanup.');
      await assertMissing(transaction, 'a fixture activation journal remained after cleanup.');
      const restored = await runtime.resolveActiveSourceRoot(stateRoot, PLATFORM);
      requireCondition(restored.sourceRoot === app && restored.activeVersion === '',
        'the original v0.85.6 broker was not restored as the selected version.');
    } catch (error) { cleanupError ??= error; }
    try {
      if (trustModified) {
        await atomicReplace(trustFile, oldTrustBytes, oldTrustStat.mode & 0o777);
        requireCondition((await fs.readFile(trustFile)).equals(oldTrustBytes),
          'the exact production public trust bytes were not restored.');
      }
      await confirmSentinels();
    } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
  console.log('Mac OTA CI fixture acceptance PASSED; original baseline control/trust bytes restored.');
  console.log('Prepared immutable v0.89.0 candidate retained; production signed Mac OTA remains untested.');
}

async function selfTest() {
  assert.equal(inside('/tmp/runner', '/tmp/runner/state'), true);
  assert.equal(inside('/tmp/runner', '/tmp/runner'), false);
  assert.equal(inside('/tmp/runner', '/tmp/runner-else'), false);
  assert.equal(inside('/tmp/runner', '/tmp/runner/../outside'), false);
  assert.equal(separate('/tmp/runner/state', '/tmp/runner/work'), true);
  assert.equal(separate('/tmp/runner/state', '/tmp/runner/state/child'), false);
  assert.match('a'.repeat(40), HEX40);
  assert.match('f'.repeat(64), HEX64);
  const fakeRoot = path.join('/tmp', 'runner', 'state');
  const baseline = path.join(fakeRoot, 'app', 'scripts', 'update-runtime.mjs');
  const groups = ownedGroupIds([
    { pid: 700125, pgid: 700125, command: 'node ' + baseline + ' broker-macos ' + fakeRoot },
    { pid: 700126, pgid: 700125, command: 'node ' + path.join(fakeRoot, 'versions', CANDIDATE, 'scripts', 'dev.mjs') + ' --production' },
    { pid: 225, pgid: 225, command: 'node /tmp/unrelated/scripts/dev.mjs --production' },
    { pid: 325, pgid: 325, command: 'node ' + baseline + ' recover ' + fakeRoot },
  ], fakeRoot);
  assert.deepEqual(groups, [700125]);
  const protocol = await import(new URL('../update-protocol.mjs', import.meta.url));
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'ci-ephemeral-key';
  const trust = {
    schemaVersion: 1, product: 'sthang-studio', platform: PLATFORM,
    channel: 'preview', endpoint: UPDATE_URL + 'latest.json',
    keyId, publicKeyHex: protocol.publicKeyHexFromKey(pair.publicKey),
    provisioned: true, brokerVersion: '1.0.0',
  };
  const signedPointer = protocol.signDocument({
    schemaVersion: 1, product: 'sthang-studio', platform: PLATFORM,
    channel: 'preview', version: CANDIDATE,
    manifestUrl: UPDATE_URL + 'v' + CANDIDATE + '/release.json',
    manifestSha256: 'a'.repeat(64),
  }, pair.privateKey, keyId);
  protocol.validateLatestPointer(signedPointer, trust);
  assert.throws(() => protocol.validateLatestPointer(signedPointer, {
    ...trust, publicKeyHex: protocol.publicKeyHexFromKey(crypto.generateKeyPairSync('ed25519').publicKey),
  }));
  const original = Buffer.from('a synthetic signed-fixture ZIP');
  const fixtures = fixtureFetch({
    pointerBytes: Buffer.from(JSON.stringify(signedPointer)),
    manifestBytes: Buffer.from('{}'),
    packageBytes: original,
    manifestUrl: signedPointer.manifestUrl,
    packageUrl: UPDATE_URL + 'v' + CANDIDATE + '/' + PACKAGE_NAME,
    corrupt: true,
  });
  const corrupted = Buffer.from(await (await fixtures(
    UPDATE_URL + 'v' + CANDIDATE + '/' + PACKAGE_NAME)).arrayBuffer());
  assert.equal(corrupted.length, original.length);
  assert.notEqual(crypto.createHash('sha256').update(corrupted).digest('hex'),
    crypto.createHash('sha256').update(original).digest('hex'));
  await assert.rejects(() => fixtures('https://example.org/invalid'));
  console.log('macOS OTA acceptance static guards PASS (native broker stages NOT executed).');
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') return selfTest();
  requireCondition(process.argv.length === 4 && process.argv[2] === '--request',
    'usage: node macos-ota-acceptance.mjs --request <JSON>');
  let request;
  try { request = JSON.parse(process.argv[3]); }
  catch { throw new Error('Mac OTA acceptance: --request must contain one JSON object.'); }
  const validated = await validateRequest(request);
  await exercise(validated);
}

main().catch((error) => {
  console.error('MACOS OTA ACCEPTANCE FAILED: ' + (error?.message || 'unexpected error'));
  process.exitCode = 1;
});
