import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEX_64,
  MAX_PACKAGE_BYTES,
  canonicalJson,
  sha256,
  unsignedDocument,
  validateReleaseManifest,
  validateReleaseReceipt,
  validateTrustRoot,
  verifySignedJson,
} from './update-protocol.mjs';

export const SIGNER_AUDIENCE = 'https://signer.sthang.app/studio-ota';
export const SIGNER_HOST = 'signer.sthang.app';
export const SIGNER_BASE_PATH = '/v1/studio';
export const SIGNING_WORKFLOW_PATH = '.github/workflows/studio-ota-sign.yml';
export const SIGNING_ENVIRONMENT = 'studio-release-signing';
export const STUDIO_REPOSITORY = 'Sthang-Co-Ltd/Sthang-Studio';
export const STUDIO_REPOSITORY_ID = '1343890712';
const MAX_JSON_BYTES = 256 * 1024;
const SAFE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER']);
const SAFE_UPLOAD_HEADERS = new Set([
  'content-type',
  'if-none-match',
  'x-content-sha256',
]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SignerClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignerClientError';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SignerClientError(`${label} is invalid.`);
  }
  return value;
}

function exactKeys(value, label, expected) {
  const item = object(value, label);
  const actual = Object.keys(item).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    throw new SignerClientError(`${label} has unexpected fields.`);
  }
  return item;
}

function text(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SignerClientError(`${label} is invalid.`);
  }
  return value.trim();
}

function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new SignerClientError(`${label} is invalid.`);
  }
  return value;
}

function digest(value, label) {
  const result = text(value, label, 64).toLowerCase();
  if (!HEX_64.test(result)) throw new SignerClientError(`${label} is invalid.`);
  return result;
}

function strictBase64(value, label, maximumBytes) {
  const encoded = text(value, label, Math.ceil(maximumBytes * 4 / 3) + 8);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new SignerClientError(`${label} is invalid.`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maximumBytes || bytes.toString('base64') !== encoded) {
    throw new SignerClientError(`${label} is invalid.`);
  }
  return bytes;
}

function safeMessage(value) {
  return String(value || 'Signing request failed')
    .replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, '[signing service]')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[local path]')
    .replace(/\\\\[^\r\n]*/g, '[local path]')
    .trim()
    .slice(0, 500);
}

async function readJson(file, label) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new SignerClientError(`${label} is invalid or missing.`);
  }
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeBytesAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await writeBytesAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

export function validateSignerEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new SignerClientError('The Studio signing broker URL is invalid.'); }
  if (
    url.protocol !== 'https:'
    || url.hostname !== SIGNER_HOST
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname.replace(/\/$/, '') !== SIGNER_BASE_PATH
  ) {
    throw new SignerClientError('The Studio signing broker URL is not the approved endpoint.');
  }
  return `${url.origin}${SIGNER_BASE_PATH}`;
}

export function validateUploadUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new SignerClientError('The signing upload URL is invalid.'); }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'uploads.sthang.app'
    || url.port
    || url.username
    || url.password
    || url.hash
    || !url.pathname.startsWith('/v1/studio/sessions/')
    || /[\u0000-\u001f\u007f]/.test(url.toString())
  ) {
    throw new SignerClientError('The signing upload URL is not allowed.');
  }
  return url.toString();
}

function validateUploadHeaders(value) {
  const headers = object(value, 'Signing upload headers');
  const entries = Object.entries(headers);
  if (entries.length > 4) throw new SignerClientError('The signing upload headers are invalid.');
  const result = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (!SAFE_UPLOAD_HEADERS.has(name) || typeof rawValue !== 'string' || rawValue.length > 500 || /[\r\n\u0000]/.test(rawValue)) {
      throw new SignerClientError('The signing upload headers are invalid.');
    }
    result[name] = rawValue;
  }
  if (result['if-none-match'] !== '*') {
    throw new SignerClientError('The signing upload must be create-only.');
  }
  return result;
}

export function authorizeSigningTrigger(event, environment = process.env) {
  const eventName = environment.GITHUB_EVENT_NAME;
  if (environment.GITHUB_REF !== 'refs/heads/main') {
    throw new SignerClientError('Studio release signing must run from the accepted main branch.');
  }
  if (eventName === 'workflow_dispatch') return { eventName, issueNumber: null };
  if (eventName !== 'issue_comment') throw new SignerClientError('This event cannot request a Studio signature.');

  const issue = object(event.issue, 'Release issue');
  const comment = object(event.comment, 'Release issue comment');
  const association = text(comment.author_association, 'Comment author association', 40);
  if (
    event.action !== 'created'
    || issue.state !== 'open'
    || Object.hasOwn(issue, 'pull_request')
    || !text(issue.title, 'Release issue title', 300).toLowerCase().startsWith('release:')
    || text(comment.body, 'Release command', 100) !== '/studio-ota-sign'
    || !SAFE_ASSOCIATIONS.has(association)
  ) {
    throw new SignerClientError('This issue comment is not an authorized Studio signing request.');
  }
  return { eventName, issueNumber: positiveInteger(issue.number, 'Release issue number') };
}

export function sourceContext(environment = process.env) {
  const repository = text(environment.GITHUB_REPOSITORY, 'GitHub repository', 200);
  const repositoryId = text(environment.GITHUB_REPOSITORY_ID, 'GitHub repository id', 40);
  const commit = text(environment.GITHUB_SHA, 'GitHub commit', 40).toLowerCase();
  const workflowRef = text(environment.GITHUB_WORKFLOW_REF, 'GitHub workflow ref', 500);
  const workflowSha = text(environment.GITHUB_WORKFLOW_SHA, 'GitHub workflow SHA', 40).toLowerCase();
  const runId = text(environment.GITHUB_RUN_ID, 'GitHub run id', 40);
  const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
  const eventName = text(environment.GITHUB_EVENT_NAME, 'GitHub event', 80);
  const actor = text(environment.GITHUB_ACTOR, 'GitHub actor', 80);
  const actorId = text(environment.GITHUB_ACTOR_ID, 'GitHub actor id', 40);
  const triggeringActor = text(environment.GITHUB_TRIGGERING_ACTOR, 'GitHub triggering actor', 80);
  const expectedWorkflowRef = `${STUDIO_REPOSITORY}/${SIGNING_WORKFLOW_PATH}@refs/heads/main`;
  if (
    repository !== STUDIO_REPOSITORY
    || repositoryId !== STUDIO_REPOSITORY_ID
    || !/^[0-9a-f]{40}$/.test(commit)
    || workflowRef !== expectedWorkflowRef
    || !/^[0-9a-f]{40}$/.test(workflowSha)
    || workflowSha !== commit
    || !/^\d+$/.test(runId)
    || !/^\d+$/.test(actorId)
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1
    || !['workflow_dispatch', 'issue_comment'].includes(eventName)
    || environment.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new SignerClientError('The GitHub signing identity is invalid.');
  }
  return {
    repository,
    repositoryId,
    repositoryVisibility: 'public',
    ref: 'refs/heads/main',
    commit,
    workflowRef,
    workflowSha,
    environment: SIGNING_ENVIRONMENT,
    runId,
    runAttempt,
    eventName,
    actor,
    actorId,
    triggeringActor,
  };
}

async function sourceProvenance(environment) {
  return {
    ...sourceContext(environment),
    workflowFileSha256: await fileSha256(path.join(ROOT, SIGNING_WORKFLOW_PATH)),
    signerClientSha256: await fileSha256(fileURLToPath(import.meta.url)),
    updateProtocolSha256: await fileSha256(path.join(ROOT, 'scripts', 'update-protocol.mjs')),
  };
}

async function readResponseBytes(response, maximumBytes = MAX_JSON_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunkValue of response.body) {
    const chunk = Buffer.from(chunkValue);
    total += chunk.length;
    if (total > maximumBytes) {
      try { await response.body.cancel(); } catch { /* best effort */ }
      throw new SignerClientError('The signing service returned an unexpected response.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function responseJson(response, label) {
  const bytes = await readResponseBytes(response);
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new SignerClientError(`${label} returned invalid data.`); }
}

export async function requestOidcToken(fetchImpl = fetch, environment = process.env) {
  const requestUrl = text(environment.ACTIONS_ID_TOKEN_REQUEST_URL, 'GitHub OIDC request URL', 2_000);
  const requestToken = text(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GitHub OIDC request token', 4_000);
  let url;
  try { url = new URL(requestUrl); } catch { throw new SignerClientError('The GitHub OIDC request URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new SignerClientError('The GitHub OIDC request URL is invalid.');
  }
  url.searchParams.set('audience', SIGNER_AUDIENCE);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SignerClientError('GitHub could not provide a signing identity.');
  }
  if (!response.ok) throw new SignerClientError('GitHub could not provide a signing identity.');
  const value = exactKeys(await responseJson(response, 'GitHub OIDC'), 'GitHub OIDC response', ['value']).value;
  const token = text(value, 'GitHub OIDC token', 20_000);
  if (token.split('.').length !== 3) throw new SignerClientError('The GitHub OIDC token is invalid.');
  return token;
}

async function postJson(url, token, value, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: `${JSON.stringify(value)}\n`,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SignerClientError('Studio could not reach the signing service.');
  }
  if (!response.ok) throw new SignerClientError('The signing service refused this release request.');
  return responseJson(response, 'The signing service');
}

async function uploadPackage(url, headers, packageFile, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers,
      body: fsSync.createReadStream(packageFile),
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    throw new SignerClientError('Studio could not upload the verified release package for signing.');
  }
  if (!response.ok) throw new SignerClientError('The signing upload was refused.');
  await readResponseBytes(response, 16 * 1024).catch(() => {});
}

function validatePrepareResponse(value, request) {
  const item = exactKeys(value, 'Signing preparation response', [
    'schemaVersion', 'product', 'operation', 'sessionId', 'version',
    'unsignedManifestSha256', 'packageSha256', 'packageSizeBytes',
    'uploadUrl', 'uploadHeaders', 'expiresAt',
  ]);
  const sessionId = text(item.sessionId, 'Signing session id', 160);
  const expiresAt = text(item.expiresAt, 'Signing upload expiry', 80);
  const expiry = Date.parse(expiresAt);
  if (
    item.schemaVersion !== 1
    || item.product !== 'sthang-studio'
    || item.operation !== 'release-upload'
    || !/^[A-Za-z0-9_-]{20,160}$/.test(sessionId)
    || item.version !== request.unsignedManifest.version
    || item.unsignedManifestSha256 !== request.unsignedManifestSha256
    || item.packageSha256 !== request.packageSha256
    || item.packageSizeBytes !== request.packageSizeBytes
    || !Number.isFinite(expiry)
    || expiry <= Date.now()
    || expiry > Date.now() + 30 * 60_000
  ) {
    throw new SignerClientError('The signing preparation response did not match this release.');
  }
  return {
    sessionId,
    uploadUrl: validateUploadUrl(item.uploadUrl),
    uploadHeaders: validateUploadHeaders(item.uploadHeaders),
    expiresAt,
  };
}

function validateBrokerAttestation(value, request, session, manifestSha256, trust) {
  const item = exactKeys(value, 'Broker verification attestation', [
    'schemaVersion', 'product', 'platform', 'channel', 'operation', 'sessionId',
    'source', 'version', 'unsignedManifestSha256', 'manifestSha256',
    'packageSha256', 'packageSizeBytes', 'verifiedAt', 'signature',
  ]);
  try { verifySignedJson(item, trust); }
  catch { throw new SignerClientError('The broker verification attestation signature is invalid.'); }
  const verifiedAt = text(item.verifiedAt, 'Broker verification time', 80);
  if (
    item.schemaVersion !== 1
    || item.product !== 'sthang-studio'
    || item.platform !== 'windows-x64'
    || item.channel !== trust.channel
    || item.operation !== 'release-attestation'
    || item.sessionId !== session.sessionId
    || canonicalJson(item.source) !== canonicalJson(request.source)
    || item.version !== request.unsignedManifest.version
    || digest(item.unsignedManifestSha256, 'Attested unsigned manifest hash') !== request.unsignedManifestSha256
    || digest(item.manifestSha256, 'Attested signed manifest hash') !== manifestSha256
    || digest(item.packageSha256, 'Attested package hash') !== request.packageSha256
    || positiveInteger(item.packageSizeBytes, 'Attested package size', MAX_PACKAGE_BYTES) !== request.packageSizeBytes
    || !Number.isFinite(Date.parse(verifiedAt))
  ) {
    throw new SignerClientError('The broker verification attestation did not match this release.');
  }
  return item;
}

function validateFinalizeResponse(value, request, session, trust) {
  const item = exactKeys(value, 'Signing finalization response', [
    'schemaVersion', 'product', 'operation', 'sessionId', 'version', 'sourceCommit',
    'unsignedManifestSha256', 'signedManifestBase64', 'manifestSha256', 'attestation',
  ]);
  if (
    item.schemaVersion !== 1
    || item.product !== 'sthang-studio'
    || item.operation !== 'release-finalized'
    || item.sessionId !== session.sessionId
    || item.version !== request.unsignedManifest.version
    || item.sourceCommit !== request.source.commit
    || item.unsignedManifestSha256 !== request.unsignedManifestSha256
    || !HEX_64.test(String(item.manifestSha256 || ''))
  ) {
    throw new SignerClientError('The signing finalization response did not match this release.');
  }
  const signedManifestBytes = strictBase64(item.signedManifestBase64, 'Signed release manifest', MAX_JSON_BYTES);
  if (sha256(signedManifestBytes) !== item.manifestSha256) {
    throw new SignerClientError('The signed release manifest bytes did not match the signing response.');
  }
  let signedManifestValue;
  try { signedManifestValue = JSON.parse(signedManifestBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new SignerClientError('The signed release manifest is invalid.'); }
  const signedManifest = validateReleaseManifest(signedManifestValue, trust);
  if (canonicalJson(unsignedDocument(signedManifest)) !== canonicalJson(request.unsignedManifest)) {
    throw new SignerClientError('The signing service changed the reviewed Studio release manifest.');
  }
  const attestation = validateBrokerAttestation(item.attestation, request, session, item.manifestSha256, trust);
  const localReceipt = validateReleaseReceipt({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    keyId: trust.keyId,
    version: signedManifest.version,
    manifestSha256: item.manifestSha256,
    packageSha256: request.packageSha256,
    packageSizeBytes: request.packageSizeBytes,
    verifiedAt: attestation.verifiedAt,
  }, trust);
  return {
    signedManifestBytes,
    signedManifest,
    attestation,
    localReceipt,
    manifestSha256: item.manifestSha256,
  };
}

export async function runReleaseSigning({
  unsignedManifestFile,
  packageFile,
  signedManifestFile,
  brokerAttestationFile,
  localReceiptFile,
  trustRootFile,
  signerUrl = process.env.STHANG_STUDIO_SIGNER_URL,
  oidcToken,
  fetchImpl = fetch,
  environment = process.env,
}) {
  const trust = validateTrustRoot(await readJson(trustRootFile, 'The Studio update trust root'));
  if (!trust.provisioned) {
    throw new SignerClientError('The Studio production update trust root is not provisioned.');
  }
  const source = await sourceProvenance(environment);
  const endpoint = validateSignerEndpoint(signerUrl);
  const unsignedManifestBytes = await fs.readFile(unsignedManifestFile);
  let unsignedManifestValue;
  try { unsignedManifestValue = JSON.parse(unsignedManifestBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new SignerClientError('The unsigned Studio release manifest is invalid.'); }
  const unsignedManifest = validateReleaseManifest(unsignedManifestValue, trust, { verifySignature: false });
  const packageStat = await fs.stat(packageFile);
  if (!packageStat.isFile() || packageStat.size <= 0 || packageStat.size > MAX_PACKAGE_BYTES) {
    throw new SignerClientError('The Studio OTA package is invalid.');
  }
  const packageSha256 = await fileSha256(packageFile);
  if (packageStat.size !== unsignedManifest.package.sizeBytes || packageSha256 !== unsignedManifest.package.sha256) {
    throw new SignerClientError('The unsigned manifest does not match the verified OTA package bytes.');
  }

  const request = {
    schemaVersion: 1,
    product: 'sthang-studio',
    operation: 'prepare-release',
    source,
    unsignedManifest,
    unsignedManifestSha256: sha256(Buffer.from(canonicalJson(unsignedManifest), 'utf8')),
    packageSha256,
    packageSizeBytes: packageStat.size,
  };
  const prepareToken = oidcToken || await requestOidcToken(fetchImpl, environment);
  const preparedValue = await postJson(`${endpoint}/releases/prepare`, prepareToken, request, fetchImpl);
  const session = validatePrepareResponse(preparedValue, request);
  await uploadPackage(session.uploadUrl, session.uploadHeaders, packageFile, fetchImpl);
  const finalizeToken = oidcToken || await requestOidcToken(fetchImpl, environment);
  const finalizedValue = await postJson(`${endpoint}/releases/finalize`, finalizeToken, {
    schemaVersion: 1,
    product: 'sthang-studio',
    operation: 'finalize-release',
    sessionId: session.sessionId,
    version: unsignedManifest.version,
    sourceCommit: source.commit,
    unsignedManifestSha256: request.unsignedManifestSha256,
    packageSha256,
    packageSizeBytes: packageStat.size,
  }, fetchImpl);
  const finalized = validateFinalizeResponse(finalizedValue, request, session, trust);
  await writeBytesAtomic(signedManifestFile, finalized.signedManifestBytes);
  await writeJsonAtomic(brokerAttestationFile, finalized.attestation);
  await writeJsonAtomic(localReceiptFile, finalized.localReceipt);
  return {
    version: finalized.signedManifest.version,
    sourceCommit: source.commit,
    manifestSha256: finalized.manifestSha256,
    packageSha256,
    packageSizeBytes: packageStat.size,
    signedManifestFile,
    brokerAttestationFile,
    localReceiptFile,
  };
}

function flag(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (required && (!value || value.startsWith('--'))) throw new SignerClientError(`Provide ${name}.`);
  return value || '';
}

async function cli() {
  const command = process.argv[2];
  if (command === 'authorize-trigger') {
    const event = await readJson(path.resolve(flag('--event')), 'The GitHub event payload');
    const result = authorizeSigningTrigger(event);
    console.log(`Authorized Studio signing trigger${result.issueNumber ? ` from release issue #${result.issueNumber}` : ''}.`);
    return;
  }
  if (command === 'sign-release') {
    const result = await runReleaseSigning({
      unsignedManifestFile: path.resolve(flag('--manifest')),
      packageFile: path.resolve(flag('--package')),
      signedManifestFile: path.resolve(flag('--signed-manifest')),
      brokerAttestationFile: path.resolve(flag('--broker-attestation')),
      localReceiptFile: path.resolve(flag('--local-receipt')),
      trustRootFile: path.resolve(flag('--trust-root')),
    });
    console.log(`Studio release ${result.version} signed and independently verified.`);
    console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    console.log(`Package SHA-256: ${result.packageSha256}`);
    return;
  }
  throw new SignerClientError('Use authorize-trigger or sign-release.');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) cli().catch((error) => {
  console.error(`Studio release signing could not finish: ${safeMessage(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
