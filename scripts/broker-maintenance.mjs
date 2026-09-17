import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  canonicalJson, exactVersion, sha256, validateReleaseManifest, validateTrustRoot,
} from './update-protocol.mjs';
import {
  BROKER_DESCRIPTOR, BROKER_PATHS, BROKER_UPDATE_NOTE, MAX_BROKER_DESCRIPTOR_BYTES,
  MAX_BROKER_FILE_BYTES, validateBrokerDescriptor,
} from './broker-contract.mjs';
import { MAX_BROKER_ARCHIVE_BYTES, readBrokerArchive } from './broker-archive.mjs';

const PUBLIC_KEY = '0e9ff5aaa1d9b3ea80887bd372d73fe83d5d7aaf51bfcfa09c3c07b1280cce5d';
const KEY_ID = 'studio-updates-ed25519-root-v1';
const LAUNCHER = BROKER_PATHS[0];
const JSON_LIMIT = 128 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
const relativeFile = (root, relative) => path.join(root, ...relative.split('/'));
function samePath(a, b) {
  const normalize = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

// Refuse redirected ancestors, junctions, symlink leaves and hard-linked files.
// The process runs as the installation owner; it never elevates permissions.
async function plainAncestors(file) {
  let directory = path.dirname(path.resolve(file));
  for (;;) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected broker paths are not supported.');
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
async function readRegular(file, maximum = JSON_LIMIT) {
  await plainAncestors(file);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('Unexpected broker file.');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Broker file changed during verification.');
    const bytes = await handle.readFile();
    const after = await fs.lstat(file);
    if (bytes.length > maximum || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== bytes.length || after.isSymbolicLink() || after.nlink !== 1) throw new Error('Broker file changed during verification.');
    return bytes;
  } finally { await handle.close(); }
}
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function mkdirPlain(directory) {
  if (!await exists(directory)) {
    await plainAncestors(directory);
    try { await fs.mkdir(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unexpected broker directory.');
  await plainAncestors(path.join(directory, 'placeholder'));
}
async function writeNew(file, bytes) {
  await plainAncestors(file);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function replaceFile(temporary, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(temporary, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 7) throw error;
      await sleep(50 * (attempt + 1));
    }
  }
}
function payloadEntry(entries, relative, maximum = MAX_BROKER_FILE_BYTES) {
  const value = entries.get(relative);
  if (!value || value.length === 0 || value.length > maximum) throw new Error('The signed broker package is incomplete.');
  return Buffer.from(value);
}

/** No signature bypass. Receipts/markers alone never authorize broker code. */
export async function verifyBrokerPackage({ manifestBytes, packageBytes, trust, appVersion, manifestDigest }) {
  if (!/^[0-9a-f]{64}$/.test(manifestDigest) || manifestBytes.length > JSON_LIMIT || sha256(manifestBytes) !== manifestDigest) throw new Error('Broker manifest identity mismatch.');
  const manifest = validateReleaseManifest(json(manifestBytes), trust);
  if (manifest.version !== exactVersion(appVersion)) throw new Error('The broker source belongs to a different app version.');
  if (packageBytes.length > MAX_BROKER_ARCHIVE_BYTES || packageBytes.length !== manifest.package.sizeBytes
      || sha256(packageBytes) !== manifest.package.sha256) throw new Error('Broker package identity mismatch.');
  const { entries, totalUnpacked } = await readBrokerArchive(packageBytes);
  if (totalUnpacked !== manifest.package.unpackedSizeBytes) throw new Error('Broker package expansion mismatch.');
  const app = json(payloadEntry(entries, 'package.json'));
  if (app.name !== 'sthang-studio' || app.version !== manifest.version) throw new Error('Broker package application mismatch.');
  if (sha256(payloadEntry(entries, 'package-lock.json', MAX_BROKER_ARCHIVE_BYTES)) !== manifest.setup.packageLockSha256) throw new Error('Broker package lock mismatch.');
  for (const item of manifest.setup.pythonFiles) {
    if (sha256(payloadEntry(entries, item.path)) !== item.sha256) throw new Error('Broker package dependency mismatch.');
  }
  const descriptorBytes = payloadEntry(entries, BROKER_DESCRIPTOR, MAX_BROKER_DESCRIPTOR_BYTES);
  const descriptor = validateBrokerDescriptor(json(descriptorBytes));
  const files = new Map();
  for (const relative of BROKER_PATHS) {
    const bytes = payloadEntry(entries, relative);
    if (bytes.length !== descriptor.files[relative].sizeBytes || sha256(bytes) !== descriptor.files[relative].sha256) throw new Error('Broker payload file mismatch.');
    files.set(relative, bytes);
  }
  const declaration = Buffer.from(files.get(LAUNCHER)).toString('utf8').match(/^\$BrokerVersion = '([^']+)'\r?$/gm);
  if (declaration?.length !== 1 || declaration[0].trim() !== `$BrokerVersion = '${descriptor.brokerVersion}'`) throw new Error('Broker payload version mismatch.');
  return { descriptor, descriptorBytes, files, manifest };
}

async function brokerRootFor(installRoot, version) {
  // The historical 1.0.0 launcher never dispatched bundles.
  const slot = path.join(installRoot, 'broker-versions', version);
  return version !== '1.0.0' && await exists(slot) ? slot : installRoot;
}
async function snapshotBroker(installRoot, profile) {
  const root = await brokerRootFor(installRoot, profile.brokerVersion);
  const hashes = {};
  for (const relative of BROKER_PATHS) {
    const bytes = await readRegular(relativeFile(root, relative), MAX_BROKER_FILE_BYTES);
    const digest = sha256(bytes);
    const allowed = profile.files[relative];
    if (!allowed.includes(digest)) throw new Error('The installed broker has unrecognized modifications. Manual recovery is required.');
    hashes[relative] = digest;
  }
  const launcher = await readRegular(relativeFile(installRoot, LAUNCHER), MAX_BROKER_FILE_BYTES);
  if (sha256(launcher) !== hashes[LAUNCHER]) throw new Error('The stable broker entrypoint does not match its bundle.');
  return { root, hashes, launcher, version: profile.brokerVersion };
}
async function identifyBroker(installRoot, descriptor) {
  const digest = sha256(await readRegular(relativeFile(installRoot, LAUNCHER), MAX_BROKER_FILE_BYTES));
  const current = { brokerVersion: descriptor.brokerVersion, files: Object.fromEntries(BROKER_PATHS.map((p) => [p, [descriptor.files[p].sha256]])) };
  const profile = [current, ...descriptor.predecessors].find((p) => p.files[LAUNCHER].includes(digest));
  if (!profile) throw new Error('Unknown or newer installed broker. Automatic replacement is refused.');
  return { ...await snapshotBroker(installRoot, profile), current: profile === current, profile };
}
async function assertSlot(root, proof) {
  const descriptor = await readRegular(relativeFile(root, BROKER_DESCRIPTOR), MAX_BROKER_DESCRIPTOR_BYTES);
  if (!descriptor.equals(proof.descriptorBytes)) throw new Error('The immutable broker slot has conflicting metadata.');
  for (const relative of BROKER_PATHS) {
    const bytes = await readRegular(relativeFile(root, relative), MAX_BROKER_FILE_BYTES);
    if (!bytes.equals(proof.files.get(relative))) throw new Error('The immutable broker slot has conflicting bytes.');
  }
}
function runProbe(command, args, options = {}) {
  // Do not block caption processing or API health responses while PowerShell
  // checks the staged broker. Only this owned probe process may be terminated.
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options, timeout: 15_000, killSignal: 'SIGKILL', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', count = 0, oversized = false;
    const consume = (chunk, output) => {
      count += chunk.length;
      if (count > 16 * 1024) { oversized = true; child.kill('SIGKILL'); return; }
      if (output) stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.once('error', () => reject(new Error('The staged broker probe could not start.')));
    child.once('close', (code) => {
      if (code !== 0 || oversized) reject(new Error('The staged broker failed syntax or launch verification.'));
      else resolve(stdout);
    });
  });
}
async function probeSlot(root, version) {
  for (const relative of BROKER_PATHS.filter((p) => p.endsWith('.mjs'))) await runProbe(process.execPath, ['--check', relativeFile(root, relative)]);
  await runProbe(process.execPath, ['--input-type=module', '-e', 'await import(process.env.STHANG_BROKER_PROBE_URL)'], {
    env: { ...process.env, STHANG_BROKER_PROBE_URL: pathToFileURL(relativeFile(root, 'scripts/update-runtime.mjs')).href },
  });
  if (process.platform === 'win32') {
    // Run the real selected launcher in a non-launching integrity/version probe.
    const output = await runProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', relativeFile(root, LAUNCHER), '-BrokerProbe']);
    if (output.trim() !== `STHANG_STUDIO_BROKER=${version}`) throw new Error('The staged broker reports the wrong version.');
    await runProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e=$null; $t=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile($env:STHANG_BROKER_PARSE_FILE,[ref]$t,[ref]$e); if($e.Count){exit 1}'],
    { env: { ...process.env, STHANG_BROKER_PARSE_FILE: relativeFile(root, 'scripts/prepare-studio-update.ps1') } });
  }
}

async function settledContext(installRoot, sourceRoot) {
  if (!path.isAbsolute(installRoot) || !path.isAbsolute(sourceRoot)) throw new Error('Broker maintenance requires absolute installation paths.');
  const updateRoot = path.join(installRoot, 'updates');
  if (!await exists(updateRoot) || !await exists(path.join(updateRoot, 'active.json'))) return null;
  for (const name of ['transaction.json', 'pending-install.json']) {
    if (await exists(path.join(updateRoot, name))) throw new Error('The application update has not settled yet.');
  }
  const activeBytes = await readRegular(path.join(updateRoot, 'active.json'));
  const active = json(activeBytes);
  const version = exactVersion(active.version);
  if (active.schemaVersion !== 1 || active.relativePath !== `versions/${version}` || !/^[0-9a-f]{64}$/.test(active.manifestDigest)) throw new Error('Invalid active release evidence.');
  const target = path.join(installRoot, 'versions', version);
  if (!samePath(sourceRoot, target)) return null;
  const markerFile = path.join(target, '.sthang-update-version.json');
  const receiptFile = path.join(updateRoot, 'receipts', `${version}.json`);
  const rollbackFile = path.join(updateRoot, 'rollback.json');
  const markerBytes = await readRegular(markerFile), receiptBytes = await readRegular(receiptFile), rollbackBytes = await readRegular(rollbackFile);
  const marker = json(markerBytes), receipt = json(receiptBytes), rollback = json(rollbackBytes);
  for (const item of [marker, receipt]) {
    if (item.schemaVersion !== 1 || item.version !== version || item.manifestDigest !== active.manifestDigest
        || !/^[0-9a-f]{64}$/.test(item.packageSha256)) throw new Error('Prepared release evidence mismatch.');
  }
  if (marker.packageSha256 !== receipt.packageSha256 || rollback.schemaVersion !== 1
      || rollback.active?.version !== version || rollback.active?.relativePath !== active.relativePath
      || rollback.active?.manifestDigest !== active.manifestDigest) throw new Error('The app activation has not been committed.');
  return { active, packageSha256: marker.packageSha256, snapshot: [activeBytes, markerBytes, receiptBytes, rollbackBytes].map(sha256).join(':') };
}

/**
 * Filesystem/crypto integration entrypoint. A caller must supply the current
 * trusted key, not one taken from the candidate archive. Production routing is
 * exclusively through maintainActiveBroker below; tests use ephemeral keys.
 */
export async function upgradeActivatedBroker({ installRoot, sourceRoot, trust }) {
  const context = await settledContext(installRoot, sourceRoot);
  if (!context) return { status: 'skipped' };
  const stage = path.join(installRoot, 'updates', 'staging', context.active.version);
  const manifestFile = path.join(stage, 'release.json'), packageFile = path.join(stage, 'package.zip');
  const manifestBytes = await readRegular(manifestFile), packageBytes = await readRegular(packageFile, MAX_BROKER_ARCHIVE_BYTES);
  const proof = await verifyBrokerPackage({ manifestBytes, packageBytes, trust, appVersion: context.active.version, manifestDigest: context.active.manifestDigest });
  if (proof.manifest.package.sha256 !== context.packageSha256) throw new Error('Broker source differs from the activated release.');
  const before = await identifyBroker(installRoot, proof.descriptor);
  if (before.current) {
    await assertSlot(before.root, proof);
    if (await exists(path.join(installRoot, 'updates', 'broker-maintenance', 'lock'))) {
      throw new Error('Interrupted broker maintenance needs review before another update.');
    }
    return { status: 'current', brokerVersion: before.version };
  }
  if (!proof.manifest.releaseNotes.split('\n').includes(BROKER_UPDATE_NOTE)) {
    throw new Error('The signed release does not authorize this broker upgrade.');
  }
  const maintenance = path.join(installRoot, 'updates', 'broker-maintenance');
  await mkdirPlain(maintenance);
  const lock = path.join(maintenance, 'lock');
  const token = `${process.pid}:${randomUUID()}`;
  // Never steal an unknown/stale lock. After a crash both launcher states remain
  // runnable; an operator may clear a stale lock only after checking its owner.
  await writeNew(lock, Buffer.from(token));
  let staging = null, temporary = null, backup = null, switched = false;
  const launcherFile = relativeFile(installRoot, LAUNCHER);
  const assertUnchanged = async () => {
    const now = await settledContext(installRoot, sourceRoot);
    if (!now || now.snapshot !== context.snapshot || sha256(await readRegular(manifestFile)) !== context.active.manifestDigest
        || sha256(await readRegular(packageFile, MAX_BROKER_ARCHIVE_BYTES)) !== proof.manifest.package.sha256) throw new Error('Update evidence changed during broker maintenance.');
    const broker = await snapshotBroker(installRoot, before.profile);
    if (canonicalJson(broker.hashes) !== canonicalJson(before.hashes)) throw new Error('Installed broker changed during maintenance.');
  };
  try {
    await assertUnchanged();
    const slots = path.join(installRoot, 'broker-versions');
    await mkdirPlain(slots);
    const target = path.join(slots, proof.descriptor.brokerVersion);
    if (await exists(target)) {
      await assertSlot(target, proof);
      await probeSlot(target, proof.descriptor.brokerVersion);
    } else {
      staging = await fs.mkdtemp(path.join(slots, '.staging-'));
      await mkdirPlain(path.join(staging, 'scripts'));
      await mkdirPlain(path.join(staging, 'config'));
      for (const relative of BROKER_PATHS) await writeNew(relativeFile(staging, relative), proof.files.get(relative));
      await writeNew(relativeFile(staging, BROKER_DESCRIPTOR), proof.descriptorBytes);
      await assertSlot(staging, proof);
      await probeSlot(staging, proof.descriptor.brokerVersion);
      await fs.rename(staging, target);
      staging = null;
    }
    await assertSlot(target, proof);
    const backups = path.join(maintenance, 'backups');
    await mkdirPlain(backups);
    const auditRoot = await fs.mkdtemp(path.join(backups, `${proof.descriptor.brokerVersion}-`));
    backup = path.join(auditRoot, 'launch-studio.ps1.original');
    await writeNew(backup, before.launcher);
    if (!(await readRegular(backup, MAX_BROKER_FILE_BYTES)).equals(before.launcher)) throw new Error('Broker backup verification failed.');
    const audit = {
      schemaVersion: 1, operation: 'broker-upgrade', previousVersion: before.version,
      brokerVersion: proof.descriptor.brokerVersion, appVersion: context.active.version,
      manifestSha256: context.active.manifestDigest, packageSha256: proof.manifest.package.sha256,
      originalLauncherSha256: sha256(before.launcher), launcherSha256: proof.descriptor.files[LAUNCHER].sha256,
    };
    await writeNew(path.join(auditRoot, 'prepared.json'), Buffer.from(`${JSON.stringify(audit, null, 2)}\n`));
    temporary = `${launcherFile}.broker-${randomUUID()}.tmp`;
    await writeNew(temporary, proof.files.get(LAUNCHER));
    if (!(await readRegular(temporary, MAX_BROKER_FILE_BYTES)).equals(proof.files.get(LAUNCHER))) throw new Error('Broker entrypoint staging failed.');
    await assertUnchanged();
    await assertSlot(target, proof);
    // The single stable-file replacement is the broker activation point. Every
    // dependency already exists in the immutable slot; no app pointer is edited.
    await replaceFile(temporary, launcherFile);
    temporary = null;
    switched = true;
    if (!(await readRegular(launcherFile, MAX_BROKER_FILE_BYTES)).equals(proof.files.get(LAUNCHER))) throw new Error('Broker entrypoint verification failed.');
    await assertSlot(target, proof);
    await writeNew(path.join(auditRoot, 'committed.json'), Buffer.from(`${JSON.stringify({ ...audit, committedAt: new Date().toISOString() }, null, 2)}\n`));
    return { status: 'updated', brokerVersion: proof.descriptor.brokerVersion };
  } catch (error) {
    if (switched && backup) {
      // Do not overwrite an unrelated writer's changes during recovery.
      const current = await readRegular(launcherFile, MAX_BROKER_FILE_BYTES);
      const original = await readRegular(backup, MAX_BROKER_FILE_BYTES);
      if (!current.equals(proof.files.get(LAUNCHER)) || !original.equals(before.launcher)) throw new Error('Broker restoration needs manual review; the verified backup was retained.');
      const restore = `${launcherFile}.restore-${randomUUID()}.tmp`;
      await writeNew(restore, original);
      await replaceFile(restore, launcherFile);
      if (!(await readRegular(launcherFile, MAX_BROKER_FILE_BYTES)).equals(original)) throw new Error('Broker restoration verification failed.');
    }
    throw error;
  } finally {
    // Only remove paths created by this operation, never version slots/backups.
    if (temporary) await fs.unlink(temporary).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    // A cleanup failure must not mask the verified outcome. Retain an unknown
    // lock for manual inspection instead of deleting another writer's lock.
    try {
      if ((await readRegular(lock, 256)).toString() === token) await fs.unlink(lock);
    } catch { /* retained lock is fail-closed for subsequent maintenance */ }
  }
}

/** A running legacy launcher keeps its old code until a normal restart. */
export function brokerSessionNotice(result, loadedBrokerVersion) {
  if (result.status === 'deferred') return 'Let the current update finish, then restart Studio before checking for another update.';
  if (result.status === 'updated' || (result.status === 'current' && result.brokerVersion !== loadedBrokerVersion)) {
    return 'Restart Sthang Studio to finish its update-helper upgrade, then check again.';
  }
  return null;
}

export function committedBrokerTrust(value, loadedBrokerVersion) {
  const trust = validateTrustRoot(value);
  if (trust.keyId !== KEY_ID || trust.publicKeyHex !== PUBLIC_KEY) throw new Error('The committed Studio broker trust root does not match.');
  if (loadedBrokerVersion) trust.brokerVersion = exactVersion(loadedBrokerVersion, 'loaded broker version');
  return trust;
}

/** Called once by the update router after the app's previously confirmed OTA. */
export async function maintainActiveBroker({ installRoot, sourceRoot }) {
  if (process.platform !== 'win32' || samePath(installRoot, sourceRoot)) return { status: 'skipped' };
  const updateRoot = path.join(installRoot, 'updates');
  if (!await exists(path.join(updateRoot, 'active.json'))) return { status: 'skipped' };
  // Startup UI can arrive just before the old broker finishes its health check.
  // Bounded local settling only: no polling of the update service or downloads.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const busy = await exists(path.join(updateRoot, 'transaction.json')) || await exists(path.join(updateRoot, 'pending-install.json'));
    if (!busy) break;
    if (attempt === 19) return { status: 'deferred' };
    await sleep(500);
  }
  const trust = committedBrokerTrust(
    json(await readRegular(path.join(installRoot, 'config', 'update-trust-root.json'))),
    process.env.STHANG_STUDIO_BROKER_VERSION,
  );
  return upgradeActivatedBroker({ installRoot, sourceRoot, trust });
}
