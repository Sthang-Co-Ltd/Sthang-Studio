import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  else await fs.rm(activeFile, { force: true });
  await fs.rm(transactionFile, { force: true });
  await appendFailure(updateRoot, 'An interrupted Studio update was rolled back before launch. The previous version remains active.');
  return true;
}

export async function activateWithRollback({ installRoot, target, launch, healthCheck, stop }) {
  const updateRoot = path.join(installRoot, 'updates');
  const activeFile = path.join(updateRoot, 'active.json');
  const transactionFile = path.join(updateRoot, 'transaction.json');
  const previous = await readJson(activeFile);
  const transaction = { schemaVersion: 1, status: 'activating', previous, target, startedAt: new Date().toISOString() };
  await writeJsonAtomic(transactionFile, transaction);
  await writeJsonAtomic(activeFile, { schemaVersion: 1, ...target, activatedAt: new Date().toISOString() });
  let launched;
  try {
    launched = await launch();
    const healthy = await healthCheck();
    if (!healthy) throw new Error('The new Studio version did not become healthy.');
    await writeJsonAtomic(path.join(updateRoot, 'rollback.json'), {
      schemaVersion: 1,
      previous,
      active: target,
      replacedAt: new Date().toISOString(),
    });
    await fs.rm(transactionFile, { force: true });
    return { previous, launched };
  } catch (error) {
    if (launched) await stop(launched).catch(() => {});
    if (previous) await writeJsonAtomic(activeFile, previous);
    else await fs.rm(activeFile, { force: true });
    await fs.rm(transactionFile, { force: true });
    throw error;
  }
}

function urlReady(url, expectedVersion, timeoutMs = 90_000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const schedule = () => {
      if (Date.now() - startedAt >= timeoutMs) return resolve(false);
      setTimeout(attempt, 400);
    };
    const attempt = () => {
      const request = http.get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { if (body.length < 32_000) body += chunk; });
        response.on('end', () => {
          const status = response.statusCode || 500;
          if (status < 200 || status >= 400) return schedule();
          if (!expectedVersion) return resolve(true);
          try {
            const parsed = JSON.parse(body);
            if (parsed.ok === true && parsed.engineVersion === expectedVersion) return resolve(true);
          } catch { }
          schedule();
        });
      });
      request.setTimeout(1_500, () => request.destroy());
      request.on('error', schedule);
    };
    attempt();
  });
}

function startStudio(installRoot, activation = false) {
  const command = process.env.ComSpec || 'cmd.exe';
  const environment = { ...process.env };
  if (activation) environment.STHANG_STUDIO_UPDATE_ACTIVATION = '1';
  else delete environment.STHANG_STUDIO_UPDATE_ACTIVATION;
  const child = spawn(command, ['/d', '/c', path.join(installRoot, 'run-windows.bat')], {
    cwd: installRoot,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    env: environment,
  });
  child.unref();
  return child.pid;
}

function stopTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

async function validatePending(pendingPath) {
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
  if (!samePath(declaredInstallRoot, installRoot, 'win32') || !samePath(declaredUpdateRoot, updateRoot, 'win32') || !samePath(versionsRoot, path.join(installRoot, 'versions'), 'win32')) {
    throw new Error('The pending Studio update roots are invalid.');
  }

  const currentVersion = exactVersion(String(pending.currentVersion || ''), 'current version');
  const targetVersion = exactVersion(String(pending.targetVersion || ''), 'target version');
  if (compareVersions(targetVersion, currentVersion) <= 0) throw new Error('The pending Studio release is not newer than the active version.');
  const manifestDigest = String(pending.manifestDigest || '').toLowerCase();
  if (!HEX_64.test(manifestDigest)) throw new Error('The pending Studio manifest digest is invalid.');

  const stageRoot = path.join(updateRoot, 'staging', targetVersion);
  const manifestPath = path.resolve(String(pending.manifestPath || ''));
  const packagePath = path.resolve(String(pending.packagePath || ''));
  if (!isInside(updateRoot, stageRoot) || !samePath(path.dirname(manifestPath), stageRoot, 'win32') || !samePath(path.dirname(packagePath), stageRoot, 'win32')) {
    throw new Error('The staged Studio update paths are invalid.');
  }
  if (path.basename(manifestPath).toLowerCase() !== 'release.json' || path.basename(packagePath).toLowerCase() !== 'package.zip') {
    throw new Error('The staged Studio update files are invalid.');
  }

  const trustValue = await readRequiredJson(path.join(installRoot, 'config', 'update-trust-root.json'), 'The Studio update trust root');
  if (process.env.STHANG_STUDIO_BROKER_VERSION) trustValue.brokerVersion = process.env.STHANG_STUDIO_BROKER_VERSION;
  const trust = validateTrustRoot(trustValue);
  if (!trust.provisioned) throw new Error('The Studio production update trust root is not provisioned.');
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
  if (process.platform !== 'win32') throw new Error('Studio update activation is Windows-only.');
  let verified;
  let updateRoot = path.dirname(path.resolve(pendingPath));
  let installRoot = path.dirname(updateRoot);
  try {
    verified = await validatePending(pendingPath);
    ({ updateRoot, installRoot } = verified.pending);
    const prepare = path.join(installRoot, 'scripts', 'prepare-studio-update.ps1');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', prepare,
      '-PendingPath', path.resolve(pendingPath),
    ], { cwd: installRoot, stdio: 'inherit', windowsHide: false });
    if (result.status !== 0) throw new Error('Studio could not prepare the staged update or its dependencies.');

    await fs.access(path.join(verified.targetDirectory, 'scripts', 'dev.mjs'));
    await fs.access(path.join(verified.targetDirectory, '.sthang-update-version.json'));
    const target = {
      version: verified.pending.targetVersion,
      relativePath: verified.pending.targetRelativePath,
      manifestDigest: verified.pending.manifestDigest,
    };
    await activateWithRollback({
      installRoot,
      target,
      launch: async () => startStudio(installRoot, true),
      healthCheck: async () => {
        const [api, web] = await Promise.all([
          urlReady('http://127.0.0.1:8787/api/health', target.version),
          urlReady('http://127.0.0.1:5188/', ''),
        ]);
        return api && web;
      },
      stop: async (pid) => stopTree(pid),
    });
    await fs.rm(path.resolve(pendingPath), { force: true });
    await fs.rm(path.join(updateRoot, 'last-failure.json'), { force: true });
  } catch (error) {
    await appendFailure(updateRoot, error instanceof Error ? error.message : error).catch(() => {});
    await fs.rm(path.resolve(pendingPath), { force: true }).catch(() => {});
    if (fsSync.existsSync(path.join(installRoot, 'run-windows.bat'))) startStudio(installRoot, false);
    throw error;
  }
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
  throw new Error('Unknown update runtime command.');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) cli().catch((error) => {
  console.error('Sthang Studio update could not finish:', safeFailureMessage(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
