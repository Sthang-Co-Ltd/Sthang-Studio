import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, stateRootDir } from './config.js';
import {
  HEX_64,
  MAX_PACKAGE_BYTES,
  UpdateProtocolError,
  assertImmutableUpdateUrl as protocolImmutableUrl,
  canonicalJson,
  compareVersions,
  exactVersion,
  sanitizeReleaseNotes,
  sha256,
  validateLatestPointer,
  validateReleaseManifest,
  validateTrustRoot,
  verifySignedJson as protocolVerifySignedJson,
} from '../../../scripts/update-protocol.mjs';

const JSON_LIMIT_BYTES = 128 * 1024;

export { canonicalJson, compareVersions, sanitizeReleaseNotes, sha256 };

export interface UpdateSignature {
  algorithm: 'ed25519';
  keyId: string;
  value: string;
}

export interface UpdateTrustRoot {
  schemaVersion: 1;
  product: 'sthang-studio';
  platform: 'windows-x64';
  channel: 'preview';
  endpoint: string;
  keyId: string;
  publicKeyHex: string;
  provisioned: boolean;
  brokerVersion: string;
}

export interface LatestPointer {
  schemaVersion: 1;
  product: 'sthang-studio';
  platform: 'windows-x64';
  channel: 'preview';
  version: string;
  manifestUrl: string;
  manifestSha256: string;
  signature: UpdateSignature;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: 'sthang-studio';
  platform: 'windows-x64';
  channel: 'preview';
  version: string;
  publishedAt: string;
  releaseNotes: string;
  package: {
    url: string;
    sha256: string;
    sizeBytes: number;
    unpackedSizeBytes: number;
  };
  compatibility: {
    minBrokerVersion: string;
    stateSchema: 1;
    manualInstallerRequired: false;
  };
  setup: {
    strategy: 'npm-ci-and-local-timing';
    packageLockSha256: string;
    pythonFiles: Array<{ path: string; sha256: string }>;
  };
  signature: UpdateSignature;
}

export interface PublicUpdateOffer {
  version: string;
  publishedAt: string;
  releaseNotes: string;
  manifestDigest: string;
  downloaded: boolean;
}

export interface PublicUpdateFailure {
  failedAt: string;
  message: string;
}

export type UpdateStatus =
  | { status: 'disabled'; currentVersion: string; message: string; lastFailure?: PublicUpdateFailure }
  | { status: 'up-to-date'; currentVersion: string; lastFailure?: PublicUpdateFailure }
  | { status: 'available'; currentVersion: string; offer: PublicUpdateOffer; lastFailure?: PublicUpdateFailure };

export interface UpdateSafetySnapshot {
  dirty?: boolean;
  textEditing?: boolean;
  reviewMode?: boolean;
  proposalOpen?: boolean;
  busy?: boolean;
  activeJobs?: number;
}

interface CheckedRelease {
  pointer: LatestPointer;
  manifest: ReleaseManifest;
  manifestDigest: string;
  manifestBytes: Buffer;
}

interface ServiceOptions {
  trustRoot?: UpdateTrustRoot;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  updateRoot?: string;
  versionsRoot?: string;
  installRoot?: string;
}

export class UpdateError extends Error {
  constructor(
    readonly code: 'DISABLED' | 'NETWORK' | 'INVALID_RELEASE' | 'SIGNATURE' | 'CHANGED' | 'UNSAFE' | 'DOWNLOAD' | 'NOT_STAGED' | 'PLATFORM',
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

function redactUpdateDetails(value: unknown) {
  return String(value || '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[update service]')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[local path]')
    .replace(/\\\\[^\r\n]*/g, '[local path]')
    .trim()
    .slice(0, 500);
}

function safeProtocolMessage(error: unknown) {
  return redactUpdateDetails(error instanceof Error ? error.message : 'The update metadata is invalid.');
}

function protocolFailure(error: unknown, fallbackCode: UpdateError['code'] = 'INVALID_RELEASE') {
  if (error instanceof UpdateError) return error;
  const message = safeProtocolMessage(error);
  const code = /signature|signed by|trust root|public key/i.test(message) ? 'SIGNATURE' : fallbackCode;
  return new UpdateError(code, message);
}

export function verifySignedJson(value: Record<string, unknown>, trust: Pick<UpdateTrustRoot, 'schemaVersion' | 'product' | 'platform' | 'channel' | 'endpoint' | 'keyId' | 'publicKeyHex' | 'provisioned' | 'brokerVersion'>) {
  try { protocolVerifySignedJson(value, trust); }
  catch (error) { throw protocolFailure(error, 'SIGNATURE'); }
}

export function assertImmutableUpdateUrl(raw: string, version: string, label: string) {
  try { return protocolImmutableUrl(raw, version, label); }
  catch (error) { throw protocolFailure(error); }
}

async function loadDefaultTrustRoot(): Promise<UpdateTrustRoot> {
  const trustFile = process.env.STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE
    || path.join(stateRootDir, 'config', 'update-trust-root.json');
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(trustFile, 'utf8')); }
  catch (error) {
    throw new UpdateError('DISABLED', 'Signed Studio updates are unavailable because this installation has no valid update trust root.', 503);
  }
  if (parsed && typeof parsed === 'object' && process.env.STHANG_STUDIO_BROKER_VERSION) {
    parsed = { ...(parsed as Record<string, unknown>), brokerVersion: process.env.STHANG_STUDIO_BROKER_VERSION };
  }
  try { return validateTrustRoot(parsed) as unknown as UpdateTrustRoot; }
  catch (error) { throw new UpdateError('DISABLED', safeProtocolMessage(error), 503); }
}

async function readResponseBytes(response: Response, limit: number) {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunkValue of body) {
    const chunk = Buffer.from(chunkValue);
    total += chunk.length;
    if (total > limit) {
      try { await response.body.cancel(); } catch { /* best-effort abort */ }
      throw new UpdateError('INVALID_RELEASE', 'The update service returned an unexpected response.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchBytes(fetchImpl: typeof fetch, url: string, limit = JSON_LIMIT_BYTES) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new UpdateError('NETWORK', 'Studio could not reach the update service. You can keep using this version.', 503);
  }
  if (!response.ok) throw new UpdateError('NETWORK', 'Studio could not check for updates. You can keep using this version.', 503);
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw && (!/^\d+$/.test(declaredRaw) || Number(declaredRaw) > limit)) {
    throw new UpdateError('INVALID_RELEASE', 'The update service returned an unexpected response.');
  }
  return readResponseBytes(response, limit);
}

async function checkedRelease(fetchImpl: typeof fetch, trust: UpdateTrustRoot): Promise<CheckedRelease> {
  const pointerBytes = await fetchBytes(fetchImpl, trust.endpoint);
  let pointerValue: unknown;
  try { pointerValue = JSON.parse(pointerBytes.toString('utf8')); }
  catch { throw new UpdateError('INVALID_RELEASE', 'The update service returned an invalid pointer.'); }
  let pointer: LatestPointer;
  try { pointer = validateLatestPointer(pointerValue, trust) as unknown as LatestPointer; }
  catch (error) { throw protocolFailure(error); }

  const manifestBytes = await fetchBytes(fetchImpl, pointer.manifestUrl);
  if (sha256(manifestBytes) !== pointer.manifestSha256) {
    throw new UpdateError('SIGNATURE', 'The update manifest did not match its signed pointer.');
  }
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new UpdateError('INVALID_RELEASE', 'The update manifest is invalid.'); }
  let manifest: ReleaseManifest;
  try { manifest = validateReleaseManifest(manifestValue, trust) as unknown as ReleaseManifest; }
  catch (error) { throw protocolFailure(error); }
  if (manifest.version !== pointer.version) {
    throw new UpdateError('INVALID_RELEASE', 'The update pointer and release version do not match.');
  }
  return { pointer, manifest, manifestDigest: pointer.manifestSha256, manifestBytes };
}

async function writeAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeBufferAtomic(file: string, value: Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, value, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function fileHash(file: string) {
  const digest = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(file);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function downloadVerified(response: Response, target: string, expectedSize: number, expectedHash: string) {
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw && (!/^\d+$/.test(declaredRaw) || Number(declaredRaw) !== expectedSize)) {
    throw new UpdateError('DOWNLOAD', 'The update download size did not match its signed manifest.');
  }
  if (!response.body) throw new UpdateError('DOWNLOAD', 'The update download was empty. This version is unchanged.');
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.part`;
  const handle = await fs.open(temp, 'wx', 0o600);
  const digest = crypto.createHash('sha256');
  let total = 0;
  let closed = false;
  try {
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunkValue of body) {
      const chunk = Buffer.from(chunkValue);
      total += chunk.length;
      if (total > expectedSize || total > MAX_PACKAGE_BYTES) {
        throw new UpdateError('DOWNLOAD', 'The update download exceeded its signed size. This version is unchanged.');
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten <= 0) throw new Error('The staged update could not be written.');
        offset += bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    closed = true;
    if (total !== expectedSize || digest.digest('hex') !== expectedHash) {
      throw new UpdateError('SIGNATURE', 'The downloaded update failed verification. This version is unchanged.');
    }
    await fs.rm(target, { force: true });
    await fs.rename(temp, target);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function safeVersionPath(base: string, version: string) {
  try { exactVersion(version); }
  catch (error) { throw protocolFailure(error); }
  const target = path.resolve(base, version);
  const prefix = `${path.resolve(base)}${path.sep}`;
  if (!target.startsWith(prefix)) throw new UpdateError('INVALID_RELEASE', 'The update version path is invalid.');
  return target;
}

function sanitizeFailureMessage(value: unknown) {
  return redactUpdateDetails(value);
}

async function readLastFailure(updateRoot: string): Promise<PublicUpdateFailure | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(updateRoot, 'last-failure.json'), 'utf8')) as { failedAt?: unknown; message?: unknown };
    const failedAt = typeof value.failedAt === 'string' && Number.isFinite(Date.parse(value.failedAt)) ? value.failedAt : '';
    const message = sanitizeFailureMessage(value.message);
    return failedAt && message ? { failedAt, message } : undefined;
  } catch { return undefined; }
}

export function unsafeUpdateReasons(snapshot: UpdateSafetySnapshot) {
  const reasons: string[] = [];
  if (snapshot.dirty) reasons.push('Save the current caption changes first.');
  if (snapshot.textEditing) reasons.push('Finish the current text edit first.');
  if (snapshot.reviewMode) reasons.push('Leave Review before installing an update.');
  if (snapshot.proposalOpen) reasons.push('Finish or close the regeneration comparison first.');
  if (snapshot.busy) reasons.push('Wait for the current Studio action to finish.');
  if (Number.isFinite(snapshot.activeJobs) && Number(snapshot.activeJobs) > 0) reasons.push('Wait for active caption processing to finish or cancel it.');
  return reasons;
}

export async function createUpdateService(options: ServiceOptions = {}) {
  const trust = options.trustRoot || await loadDefaultTrustRoot();
  const fetchImpl = options.fetchImpl || fetch;
  const platform = options.platform || process.platform;
  const installRoot = options.installRoot || stateRootDir;
  const updateRoot = options.updateRoot || config.updateDir;
  const versionsRoot = options.versionsRoot || config.versionsDir;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(operation: () => Promise<T>) => {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const ensureEnabled = () => {
    if (platform !== 'win32') throw new UpdateError('PLATFORM', 'Signed Studio updates are available on Windows installations only.', 409);
    if (!trust.provisioned) throw new UpdateError('DISABLED', 'Signed Studio updates are not enabled in this source build. Use the current GitHub Release download.', 503);
  };

  const stagePaths = (release: CheckedRelease) => {
    const directory = safeVersionPath(path.join(updateRoot, 'staging'), release.manifest.version);
    return {
      directory,
      packageFile: path.join(directory, 'package.zip'),
      manifestFile: path.join(directory, 'release.json'),
      receiptFile: path.join(directory, 'receipt.json'),
    };
  };

  const staged = async (release: CheckedRelease) => {
    const paths = stagePaths(release);
    try {
      const receipt = JSON.parse(await fs.readFile(paths.receiptFile, 'utf8')) as {
        manifestDigest?: unknown;
        packageSha256?: unknown;
        packageSizeBytes?: unknown;
      };
      const stat = await fs.stat(paths.packageFile);
      return receipt.manifestDigest === release.manifestDigest
        && receipt.packageSha256 === release.manifest.package.sha256
        && receipt.packageSizeBytes === release.manifest.package.sizeBytes
        && stat.size === release.manifest.package.sizeBytes
        && await fileHash(paths.manifestFile) === release.manifestDigest
        && await fileHash(paths.packageFile) === release.manifest.package.sha256;
    } catch { return false; }
  };

  const check = async (currentVersion: string): Promise<UpdateStatus> => {
    try { exactVersion(currentVersion, 'current version'); }
    catch (error) { throw protocolFailure(error); }
    const lastFailure = await readLastFailure(updateRoot);
    if (platform !== 'win32') return { status: 'disabled', currentVersion, message: 'Signed Studio updates are available on Windows installations only.', ...(lastFailure ? { lastFailure } : {}) };
    if (!trust.provisioned) return { status: 'disabled', currentVersion, message: 'Signed Studio updates are not enabled in this source build. Use the current GitHub Release download.', ...(lastFailure ? { lastFailure } : {}) };
    const release = await checkedRelease(fetchImpl, trust);
    if (compareVersions(release.manifest.version, currentVersion) <= 0) {
      return { status: 'up-to-date', currentVersion, ...(lastFailure ? { lastFailure } : {}) };
    }
    return {
      status: 'available',
      currentVersion,
      offer: {
        version: release.manifest.version,
        publishedAt: release.manifest.publishedAt,
        releaseNotes: release.manifest.releaseNotes,
        manifestDigest: release.manifestDigest,
        downloaded: await staged(release),
      },
      ...(lastFailure ? { lastFailure } : {}),
    };
  };

  const resolveExpected = async (expectedDigest: string) => {
    ensureEnabled();
    if (!HEX_64.test(expectedDigest || '')) throw new UpdateError('INVALID_RELEASE', 'The selected update is invalid.');
    const release = await checkedRelease(fetchImpl, trust);
    if (release.manifestDigest !== expectedDigest) {
      throw new UpdateError('CHANGED', 'A different Studio update is now available. Review the new version before continuing.', 409);
    }
    return release;
  };

  const downloadUnlocked = async (expectedDigest: string) => {
    const release = await resolveExpected(expectedDigest);
    const paths = stagePaths(release);
    await fs.mkdir(paths.directory, { recursive: true });
    await fs.rm(paths.receiptFile, { force: true });
    let response: Response;
    try {
      response = await fetchImpl(release.manifest.package.url, {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch { throw new UpdateError('DOWNLOAD', 'Studio could not download the update. This version is unchanged.', 503); }
    if (!response.ok) throw new UpdateError('DOWNLOAD', 'Studio could not download the update. This version is unchanged.', 503);
    try {
      await downloadVerified(response, paths.packageFile, release.manifest.package.sizeBytes, release.manifest.package.sha256);
      await writeBufferAtomic(paths.manifestFile, release.manifestBytes);
      await writeAtomic(paths.receiptFile, {
        schemaVersion: 1,
        version: release.manifest.version,
        manifestDigest: release.manifestDigest,
        packageSha256: release.manifest.package.sha256,
        packageSizeBytes: release.manifest.package.sizeBytes,
        verifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      throw new UpdateError('DOWNLOAD', 'Studio could not stage the verified update. This version is unchanged.', 503);
    }
    return { version: release.manifest.version, manifestDigest: release.manifestDigest, downloaded: true as const };
  };

  const prepareInstallUnlocked = async (currentVersion: string, expectedDigest: string) => {
    try { exactVersion(currentVersion, 'current version'); }
    catch (error) { throw protocolFailure(error); }
    const release = await resolveExpected(expectedDigest);
    if (compareVersions(release.manifest.version, currentVersion) <= 0) {
      throw new UpdateError('CHANGED', 'This Studio update is no longer newer than the installed version. Check again before continuing.', 409);
    }
    const paths = stagePaths(release);
    if (!await staged(release)) throw new UpdateError('NOT_STAGED', 'Download and verify this update before installing it.', 409);
    const targetDirectory = safeVersionPath(versionsRoot, release.manifest.version);
    const relativePath = path.relative(installRoot, targetDirectory).replaceAll('\\', '/');
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new UpdateError('INVALID_RELEASE', 'The update target path is invalid.');
    const pendingFile = path.join(updateRoot, 'pending-install.json');
    await writeAtomic(pendingFile, {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      installRoot,
      updateRoot,
      versionsRoot,
      currentVersion,
      targetVersion: release.manifest.version,
      targetRelativePath: relativePath,
      manifestDigest: release.manifestDigest,
      manifestPath: paths.manifestFile,
      packagePath: paths.packageFile,
    });
    return { version: release.manifest.version, pendingFile };
  };

  return {
    check,
    download: (expectedDigest: string) => exclusive(() => downloadUnlocked(expectedDigest)),
    prepareInstall: (currentVersion: string, expectedDigest: string) => exclusive(() => prepareInstallUnlocked(currentVersion, expectedDigest)),
    trustRoot: { ...trust, publicKeyHex: trust.provisioned ? '[committed public key]' : '[unprovisioned]' },
  };
}

export function publicUpdateError(error: unknown) {
  if (error instanceof UpdateError) return { status: error.httpStatus, body: { code: error.code, error: sanitizeFailureMessage(error.message) } };
  if (error instanceof UpdateProtocolError) {
    return { status: 400, body: { code: 'INVALID_RELEASE', error: sanitizeFailureMessage(error.message) } };
  }
  console.error('[updates] Internal failure:', sanitizeFailureMessage(error instanceof Error ? error.message : error));
  return { status: 500, body: { code: 'INTERNAL', error: 'Studio could not complete the update action. Your installed version remains unchanged.' } };
}
