import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVATION_HEADER, WEB_IDENTITY_FILE, WEB_IDENTITY_PATH, validateWebIdentity } from './web-runtime-identity.mjs';
import {
  HEX_64,
  compareVersions,
  exactVersion,
  sha256,
  validateReleaseManifest,
  validateTrustRoot,
} from './update-protocol.mjs';

export async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

async function readRequiredJson(file, label) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${label} is invalid or missing.`); }
}

const atomicWriteQueues = new Map();
const WINDOWS_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameAtomicWithRetry(temp, file) {
  const maxAttempts = process.platform === 'win32' ? 12 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const retryable = process.platform === 'win32'
        && WINDOWS_RENAME_RETRY_CODES.has(error?.code)
        && attempt < maxAttempts;
      if (!retryable) throw error;
      await wait(Math.min(250, 5 * (2 ** (attempt - 1))));
    }
  }
}

async function syncParentDirectory(file) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(path.dirname(path.resolve(file)), 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function removeFileDurable(file) {
  await fs.rm(file, { force: true });
  await syncParentDirectory(file);
}

async function writeJsonAtomicUnlocked(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameAtomicWithRetry(temp, file);
    await syncParentDirectory(file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  const resolvedFile = path.resolve(file);
  const key = process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile;
  const previous = atomicWriteQueues.get(key) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => writeJsonAtomicUnlocked(resolvedFile, value));
  let tail;
  tail = operation
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (atomicWriteQueues.get(key) === tail) atomicWriteQueues.delete(key);
    });
  atomicWriteQueues.set(key, tail);
  return operation;
}

export async function sha256File(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function samePath(left, right, platform = process.platform) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '');
  const a = normalize(left);
  const b = normalize(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function updatePlatformForRuntime(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  return '';
}

function brokerSourceRoot(installRoot, updatePlatform = updatePlatformForRuntime()) {
  return updatePlatform === 'macos-arm64' ? path.join(installRoot, 'app') : installRoot;
}

function trustRootPath(installRoot, updatePlatform = updatePlatformForRuntime()) {
  if (process.env.STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE) {
    return path.resolve(process.env.STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE);
  }
  const name = updatePlatform === 'macos-arm64' ? 'update-trust-root-macos.json' : 'update-trust-root.json';
  return path.join(brokerSourceRoot(installRoot, updatePlatform), 'config', name);
}

function safeFailureMessage(message) {
  return String(message || 'Update failed')
    .replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, '[update service]')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[local path]')
    .replace(/\\\\[^\r\n]*/g, '[local path]')
    .trim()
    .slice(0, 500);
}

async function appendFailure(updateRoot, message) {
  await writeJsonAtomic(path.join(updateRoot, 'last-failure.json'), {
    failedAt: new Date().toISOString(),
    message: safeFailureMessage(message),
  });
}

export async function recoverInterruptedActivation(installRoot) {
  const updateRoot = path.join(installRoot, 'updates');
  const transactionFile = path.join(updateRoot, 'transaction.json');
  const transaction = await readJson(transactionFile);
  if (!transaction || transaction.status !== 'activating') return false;
  const activeFile = path.join(updateRoot, 'active.json');
  if (transaction.previous) await writeJsonAtomic(activeFile, transaction.previous);
  else await removeFileDurable(activeFile);
  await removeFileDurable(transactionFile);
  await appendFailure(updateRoot, 'An interrupted Studio update was rolled back before launch. The previous version remains active.');
  return true;
}

export async function resolveActiveSourceRoot(installRoot, updatePlatform = updatePlatformForRuntime()) {
  const baseline = brokerSourceRoot(installRoot, updatePlatform);
  const active = await readJson(path.join(installRoot, 'updates', 'active.json'));
  if (!active) return { sourceRoot: baseline, activeVersion: '' };
  const version = exactVersion(String(active.version || ''), 'active version');
  const manifestDigest = String(active.manifestDigest || '').toLowerCase();
  if (!HEX_64.test(manifestDigest)) throw new Error('The active Studio manifest identity is invalid.');
  const relativePath = String(active.relativePath || '').replaceAll('\\', '/');
  if (relativePath !== 'versions/' + version) throw new Error('The active Studio version path is invalid.');
  const versionsRoot = path.join(installRoot, 'versions');
  const sourceRoot = path.resolve(installRoot, ...relativePath.split('/'));
  if (!isInside(versionsRoot, sourceRoot)) throw new Error('The active Studio version is outside the immutable version area.');
  const marker = await readRequiredJson(path.join(sourceRoot, '.sthang-update-version.json'), 'The active Studio version marker');
  if (
    marker.schemaVersion !== 1
    || marker.version !== version
    || String(marker.manifestDigest || '').toLowerCase() !== manifestDigest
  ) throw new Error('The active Studio version marker is invalid.');
  const required = updatePlatform === 'macos-arm64'
    ? ['run-macos.sh', 'apps/server/dist/index.js', 'apps/web/dist/index.html', 'packages/shared/dist/index.js']
    : ['scripts/dev.mjs'];
  for (const relative of required) await fs.access(path.join(sourceRoot, ...relative.split('/')));
  return { sourceRoot, activeVersion: version };
}

function launchedProcessAlive(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null && !child.killed;
}

export async function activateWithRollback({ installRoot, target, launch, healthCheck, stop }) {
  const updateRoot = path.join(installRoot, 'updates');
  const activeFile = path.join(updateRoot, 'active.json');
  const transactionFile = path.join(updateRoot, 'transaction.json');
  const previous = await readJson(activeFile);
  const transaction = { schemaVersion: 1, status: 'activating', previous, target, startedAt: new Date().toISOString() };
  await writeJsonAtomic(transactionFile, transaction);
  let launched;
  const health = new AbortController();
  const stopped = () => health.abort();
  const requireAlive = () => {
    if (health.signal.aborted || !launchedProcessAlive(launched)) {
      throw new Error('The new Studio process stopped before activation completed.');
    }
  };
  try {
    await writeJsonAtomic(activeFile, { schemaVersion: 1, ...target, activatedAt: new Date().toISOString() });
    launched = await launch();
    launched.once('exit', stopped);
    launched.once('error', stopped);
    requireAlive();
    const healthy = await healthCheck(launched, health.signal);
    requireAlive();
    if (!healthy) throw new Error('The new Studio version did not become healthy.');
    await writeJsonAtomic(path.join(updateRoot, 'rollback.json'), {
      schemaVersion: 1,
      previous,
      active: target,
      replacedAt: new Date().toISOString(),
    });
    requireAlive();
    await removeFileDurable(transactionFile);
    requireAlive();
    return { previous, launched };
  } catch (error) {
    health.abort();
    if (launched) await stop(launched).catch(() => {});
    if (previous) await writeJsonAtomic(activeFile, previous);
    else await removeFileDurable(activeFile);
    await removeFileDurable(transactionFile);
    throw error;
  } finally {
    health.abort();
    launched?.removeListener('exit', stopped);
    launched?.removeListener('error', stopped);
  }
}

// Total and per-attempt deadlines cover DNS/connect, headers and the complete
// body, including an endless trickle. All terminal events converge once, and all
// timers/sockets are disposed on success, timeout, process exit or cancellation.
export function urlReady(url, expected, timeoutMs = 90_000, {
  signal, attemptTimeoutMs = 1_500, retryMs = 400, maxBodyBytes = 32_000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let retryTimer;
    let requestTimer;
    let request;
    let response;
    const deadlineAt = performance.now() + timeoutMs;
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
    const deadline = setTimeout(abort, Math.max(0, timeoutMs));
    const attempt = () => {
      if (settled) return;
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) return finish(false);
      const attemptDeadlineAt = performance.now() + Math.min(attemptTimeoutMs, remaining);
      let completed = false;
      const complete = (ready) => {
        if (completed || settled) return;
        completed = true;
        clearAttempt();
        if (performance.now() >= deadlineAt) return finish(false);
        if (ready && performance.now() < attemptDeadlineAt) return finish(true);
        retryTimer = setTimeout(attempt, Math.min(retryMs, Math.max(0, deadlineAt - performance.now())));
      };
      requestTimer = setTimeout(() => complete(false), Math.min(attemptTimeoutMs, remaining));
      try {
        request = http.get(url, { agent: false }, (incoming) => {
          if (completed || settled) { incoming.destroy(); return; }
          response = incoming;
          incoming.on('error', () => complete(false));
          incoming.on('aborted', () => complete(false));
          incoming.on('close', () => complete(false));
          if (incoming.statusCode !== 200
            || incoming.headers[ACTIVATION_HEADER.toLowerCase()] !== expected.activationId
            || Number(incoming.headers['content-length']) > maxBodyBytes) {
            complete(false); return;
          }
          let bytes = 0;
          const chunks = [];
          incoming.on('data', (chunk) => {
            if (completed || settled) return;
            bytes += chunk.length;
            if (bytes > maxBodyBytes) { complete(false); return; }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            if (completed || settled) return;
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const matches = expected.webBuildId
                ? parsed.schemaVersion === 1 && parsed.service === 'sthang-studio-web'
                  && parsed.version === expected.version && parsed.buildId === expected.webBuildId
                : parsed.ok === true && parsed.engineVersion === expected.version;
              complete(incoming.complete && matches);
            } catch { complete(false); }
          });
        });
        request.on('error', () => complete(false));
      } catch { complete(false); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || !expected?.version || !expected?.activationId || timeoutMs <= 0) abort();
    else attempt();
  });
}

export function buildStudioStartSpec(installRoot, activation = false, platform = process.platform, activationId = crypto.randomUUID()) {
  const environment = { ...process.env };
  if (activation) {
    environment.STHANG_STUDIO_UPDATE_ACTIVATION = '1';
    environment.STHANG_STUDIO_ACTIVATION_ID = activationId;
  } else {
    delete environment.STHANG_STUDIO_UPDATE_ACTIVATION;
    delete environment.STHANG_STUDIO_ACTIVATION_ID;
  }
  if (platform === 'darwin') {
    const appRoot = path.join(installRoot, 'app');
    environment.STHANG_STUDIO_STATE_ROOT = installRoot;
    return {
      command: '/bin/bash',
      args: [path.join(appRoot, 'run-macos.sh')],
      cwd: appRoot,
      env: environment,
    };
  }
  const command = process.env.ComSpec || 'cmd.exe';
  return {
    command,
    args: ['/d', '/c', 'run-windows.bat'],
    cwd: installRoot,
    env: environment,
  };
}

async function startStudio(installRoot, activation = false, platform = process.platform, activationId) {
  const spec = buildStudioStartSpec(installRoot, activation, platform, activationId);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    env: spec.env,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child;
}

async function stopTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); }
  catch {
    try { process.kill(pid, 'SIGTERM'); } catch { }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await wait(100);
    } catch {
      return;
    }
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch {
    try { process.kill(pid, 'SIGKILL'); } catch { }
  }
}

async function acquireMacInstallLock(pendingPath) {
  const resolvedPending = path.resolve(pendingPath);
  const updateRoot = path.dirname(resolvedPending);
  if (path.basename(resolvedPending).toLowerCase() !== 'pending-install.json' || path.basename(updateRoot).toLowerCase() !== 'updates') {
    throw new Error('The pending Studio update location is invalid.');
  }
  const installRoot = path.dirname(updateRoot);
  const lockFile = path.join(installRoot, '.manual-install.lock');
  const shlock = process.env.STHANG_STUDIO_SHLOCK || '/usr/bin/shlock';
  const result = spawnSync(shlock, ['-p', String(process.pid), '-f', lockFile], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    let owner = '';
    try { owner = (await fs.readFile(lockFile, 'utf8')).trim(); } catch { }
    throw new Error(owner
      ? `Another Sthang Studio installation/update is running (PID ${owner}).`
      : 'Another Sthang Studio installation/update is running.');
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const owner = (await fs.readFile(lockFile, 'utf8')).trim();
      if (owner === String(process.pid)) await fs.rm(lockFile, { force: true });
    } catch { }
  };
}

export async function validatePending(pendingPath, updatePlatform = updatePlatformForRuntime()) {
  if (!updatePlatform) throw new Error('Studio updates are not supported on this platform.');
  const resolvedPending = path.resolve(pendingPath);
  const updateRoot = path.dirname(resolvedPending);
  const installRoot = path.dirname(updateRoot);
  if (path.basename(resolvedPending).toLowerCase() !== 'pending-install.json' || path.basename(updateRoot).toLowerCase() !== 'updates') {
    throw new Error('The pending Studio update location is invalid.');
  }
  const pending = await readRequiredJson(resolvedPending, 'The pending Studio update');
  if (pending.schemaVersion !== 1) throw new Error('The pending Studio update schema is invalid.');
  const declaredInstallRoot = path.resolve(String(pending.installRoot || ''));
  const declaredUpdateRoot = path.resolve(String(pending.updateRoot || ''));
  const versionsRoot = path.resolve(String(pending.versionsRoot || ''));
  const pathPlatform = updatePlatform === 'windows-x64' ? 'win32' : 'darwin';
  if (
    !samePath(declaredInstallRoot, installRoot, pathPlatform)
    || !samePath(declaredUpdateRoot, updateRoot, pathPlatform)
    || !samePath(versionsRoot, path.join(installRoot, 'versions'), pathPlatform)
  ) {
    throw new Error('The pending Studio update roots are invalid.');
  }
  if (String(pending.platform || '') !== updatePlatform) throw new Error('The pending Studio update platform is invalid.');

  const currentVersion = exactVersion(String(pending.currentVersion || ''), 'current version');
  const targetVersion = exactVersion(String(pending.targetVersion || ''), 'target version');
  if (compareVersions(targetVersion, currentVersion) <= 0) throw new Error('The pending Studio release is not newer than the active version.');
  const manifestDigest = String(pending.manifestDigest || '').toLowerCase();
  if (!HEX_64.test(manifestDigest)) throw new Error('The pending Studio manifest digest is invalid.');

  const stageRoot = path.join(updateRoot, 'staging', targetVersion);
  const manifestPath = path.resolve(String(pending.manifestPath || ''));
  const packagePath = path.resolve(String(pending.packagePath || ''));
  if (
    !isInside(updateRoot, stageRoot)
    || !samePath(path.dirname(manifestPath), stageRoot, pathPlatform)
    || !samePath(path.dirname(packagePath), stageRoot, pathPlatform)
  ) {
    throw new Error('The staged Studio update paths are invalid.');
  }
  if (path.basename(manifestPath).toLowerCase() !== 'release.json' || path.basename(packagePath).toLowerCase() !== 'package.zip') {
    throw new Error('The staged Studio update files are invalid.');
  }

  const trustValue = await readRequiredJson(trustRootPath(installRoot, updatePlatform), 'The Studio update trust root');
  if (process.env.STHANG_STUDIO_BROKER_VERSION) trustValue.brokerVersion = process.env.STHANG_STUDIO_BROKER_VERSION;
  const trust = validateTrustRoot(trustValue);
  if (!trust.provisioned) throw new Error('The Studio production update trust root is not provisioned.');
  if (trust.platform !== updatePlatform) throw new Error('The Studio update trust root does not match this platform.');
  const manifestBytes = await fs.readFile(manifestPath);
  if (sha256(manifestBytes) !== manifestDigest) throw new Error('The staged Studio manifest failed its final byte check.');
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')), trust);
  if (manifest.version !== targetVersion) throw new Error('The staged Studio manifest version is invalid.');

  const packageStat = await fs.stat(packagePath);
  if (packageStat.size !== manifest.package.sizeBytes || await sha256File(packagePath) !== manifest.package.sha256) {
    throw new Error('The staged Studio package failed its final byte check.');
  }

  const targetRelativePath = String(pending.targetRelativePath || '').replaceAll('\\', '/');
  if (targetRelativePath !== `versions/${targetVersion}`) throw new Error('The pending Studio target path is invalid.');
  const targetDirectory = path.resolve(installRoot, ...targetRelativePath.split('/'));
  if (!isInside(versionsRoot, targetDirectory)) throw new Error('The prepared Studio target is invalid.');

  const verifiedPending = {
    schemaVersion: 1,
    platform: updatePlatform,
    createdAt: typeof pending.createdAt === 'string' ? pending.createdAt : new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    installRoot,
    updateRoot,
    versionsRoot,
    currentVersion,
    targetVersion,
    targetRelativePath,
    manifestDigest,
    manifestPath,
    packagePath,
  };
  await writeJsonAtomic(resolvedPending, verifiedPending);
  return { pending: verifiedPending, targetDirectory };
}

export async function applyPending(pendingPath) {
  const updatePlatform = updatePlatformForRuntime();
  if (!updatePlatform) throw new Error('Studio update activation is not supported on this platform.');
  let verified;
  let updateRoot = path.dirname(path.resolve(pendingPath));
  let installRoot = path.dirname(updateRoot);
  let releaseMacInstallLock = async () => {};
  try {
    if (updatePlatform === 'macos-arm64') {
      releaseMacInstallLock = await acquireMacInstallLock(pendingPath);
    }
    verified = await validatePending(pendingPath, updatePlatform);
    ({ updateRoot, installRoot } = verified.pending);
    const brokerRoot = brokerSourceRoot(installRoot, updatePlatform);
    const result = updatePlatform === 'windows-x64'
      ? spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(brokerRoot, 'scripts', 'prepare-studio-update.ps1'),
        '-PendingPath', path.resolve(pendingPath),
      ], { cwd: brokerRoot, stdio: 'inherit', windowsHide: false })
      : spawnSync('/bin/bash', [
        path.join(brokerRoot, 'scripts', 'prepare-studio-update-macos.sh'),
        path.resolve(pendingPath),
      ], {
        cwd: brokerRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          STHANG_STUDIO_STATE_ROOT: installRoot,
          STHANG_STUDIO_INSTALL_LOCK_HELD: '1',
        },
      });
    if (result.status !== 0) throw new Error('Studio could not prepare the staged update or its dependencies.');

    await fs.access(path.join(verified.targetDirectory, 'scripts', 'dev.mjs'));
    await fs.access(path.join(verified.targetDirectory, '.sthang-update-version.json'));
    if (updatePlatform === 'macos-arm64') {
      await fs.access(path.join(verified.targetDirectory, 'apps', 'server', 'dist', 'index.js'));
      await fs.access(path.join(verified.targetDirectory, 'apps', 'web', 'dist', 'index.html'));
      await fs.access(path.join(verified.targetDirectory, 'packages', 'shared', 'dist', 'index.js'));
    }
    const target = {
      version: verified.pending.targetVersion,
      relativePath: verified.pending.targetRelativePath,
      manifestDigest: verified.pending.manifestDigest,
    };
    // The signed/prepared frontend supplies its own identity. Never synthesize
    // it from API health, the expected version, or a generic successful HTML page.
    const webIdentity = validateWebIdentity(await readRequiredJson(
      path.join(verified.targetDirectory, 'apps', 'web', 'dist', WEB_IDENTITY_FILE),
      'The prepared Studio web identity',
    ), target.version);
    const activationId = crypto.randomUUID();
    const expected = { version: target.version, activationId };
    await activateWithRollback({
      installRoot,
      target,
      launch: async () => startStudio(installRoot, true, updatePlatform === 'macos-arm64' ? 'darwin' : 'win32', activationId),
      healthCheck: async (_child, signal) => {
        const webPort = updatePlatform === 'macos-arm64' ? 8787 : 5188;
        const [api, web] = await Promise.all([
          urlReady('http://127.0.0.1:8787/api/health', expected, 90_000, { signal }),
          urlReady(`http://127.0.0.1:${webPort}${WEB_IDENTITY_PATH}`, { ...expected, webBuildId: webIdentity.buildId }, 90_000, { signal }),
        ]);
        return api && web;
      },
      stop: async (child) => stopTree(child.pid),
    });
    await fs.rm(path.resolve(pendingPath), { force: true });
    await fs.rm(path.join(updateRoot, 'last-failure.json'), { force: true });
  } catch (error) {
    await appendFailure(updateRoot, error instanceof Error ? error.message : error).catch(() => {});
    await fs.rm(path.resolve(pendingPath), { force: true }).catch(() => {});
    const fallbackLauncher = updatePlatform === 'macos-arm64'
      ? path.join(installRoot, 'app', 'run-macos.sh')
      : path.join(installRoot, 'run-windows.bat');
    if (fsSync.existsSync(fallbackLauncher)) {
      await startStudio(installRoot, false, updatePlatform === 'macos-arm64' ? 'darwin' : 'win32');
    }
    throw error;
  } finally {
    await releaseMacInstallLock();
  }
}

export async function brokerMac(installRoot) {
  if (updatePlatformForRuntime() !== 'macos-arm64') {
    throw new Error('The macOS Studio broker requires native Apple Silicon.');
  }
  const updateRoot = path.join(installRoot, 'updates');
  const pendingFile = path.join(updateRoot, 'pending-install.json');
  const baselineRoot = path.join(installRoot, 'app');
  let selection;
  if (process.env.STHANG_STUDIO_UPDATE_ACTIVATION !== '1') {
    try {
      await recoverInterruptedActivation(installRoot);
    } catch (error) {
      console.warn('Studio could not complete update recovery. The manually installed version will be used.', safeFailureMessage(error instanceof Error ? error.message : error));
      selection = { sourceRoot: baselineRoot, activeVersion: '' };
    }
  }
  if (!selection) {
    try {
      selection = await resolveActiveSourceRoot(installRoot, 'macos-arm64');
    } catch (error) {
      console.warn('The active update pointer was invalid. The manually installed version will be used.', safeFailureMessage(error instanceof Error ? error.message : error));
      selection = { sourceRoot: baselineRoot, activeVersion: '' };
    }
  }
  const environment = {
    ...process.env,
    STHANG_STUDIO_INSTALL_ROOT: installRoot,
    STHANG_STUDIO_STATE_ROOT: installRoot,
    STHANG_STUDIO_BROKER_CHILD: '1',
    STHANG_STUDIO_ENV_FILE: path.join(baselineRoot, 'apps', 'server', '.env'),
    STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE: path.join(baselineRoot, 'config', 'update-trust-root-macos.json'),
    STHANG_STUDIO_ACTIVE_VERSION: selection.activeVersion,
    STHANG_STUDIO_BROKER_VERSION: '1.0.0',
  };
  delete environment.STHANG_STUDIO_UPDATE_ACTIVATION;
  const child = spawn('/bin/bash', [path.join(selection.sourceRoot, 'run-macos.sh')], {
    cwd: selection.sourceRoot,
    env: environment,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  if (exitCode !== 42) return Number(exitCode);
  if (!fsSync.existsSync(pendingFile)) throw new Error('Studio requested an update restart, but no verified pending release was found.');
  await applyPending(pendingFile);
  return 42;
}

async function cli() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'recover') {
    if (!argument) throw new Error('Install root is required.');
    await recoverInterruptedActivation(path.resolve(argument));
    return;
  }
  if (command === 'apply') {
    if (!argument) throw new Error('Pending update path is required.');
    await applyPending(path.resolve(argument));
    return;
  }
  if (command === 'broker-macos') {
    if (!argument) throw new Error('Install root is required.');
    process.exitCode = await brokerMac(path.resolve(argument));
    return;
  }
  throw new Error('Unknown update runtime command.');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) cli().catch((error) => {
  console.error('Sthang Studio update could not finish:', safeFailureMessage(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
