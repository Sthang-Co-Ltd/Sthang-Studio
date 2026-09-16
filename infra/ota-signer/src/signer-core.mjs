const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const STUDIO_REPOSITORY = 'Sthang-Co-Ltd/Sthang-Studio';
export const STUDIO_REPOSITORY_ID = 1343890712;
export const STUDIO_SIGNING_ACTOR_LOGIN = 'SweepCoon';
export const STUDIO_SIGNING_ACTOR_ID = 230290682;
export const STUDIO_SIGNING_KEY_ID = 'studio-updates-ed25519-root-v1';
export const STUDIO_PUBLIC_KEY_HEX = '0e9ff5aaa1d9b3ea80887bd372d73fe83d5d7aaf51bfcfa09c3c07b1280cce5d';
export const STUDIO_UPDATE_HOST = 'updates.sthang.app';
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_UNPACKED_BYTES = 24 * 1024 * 1024;

const ALLOWED_TOP_LEVEL_FILES = new Set([
  '.env.example',
  'package.json',
  'package-lock.json',
  'INSTALL-NEW-PC.bat',
  'setup-windows.bat',
  'setup-local-timing-windows.bat',
  'run-windows.bat',
  'STOP-STHANG-STUDIO.bat',
  'STOP-KHMER-CAPTION-STUDIO.bat',
  'README.md',
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'TRADEMARKS.md',
]);
const ALLOWED_ROOTS = ['apps/', 'packages/', 'local-timing/', 'scripts/', 'config/', '.sthang/'];
const FORBIDDEN_PACKAGE_PARTS = new Set([
  'data', 'uploads', 'exports', 'node_modules', '.venv', 'versions', 'updates', 'release-artifacts', '.env',
]);
const REQUIRED_PACKAGE_PATHS = new Set([
  'package.json',
  'package-lock.json',
  'config/update-trust-root.json',
  'scripts/update-protocol.mjs',
  'scripts/update-runtime.mjs',
  'scripts/launch-studio.ps1',
  'scripts/prepare-studio-update.ps1',
  'run-windows.bat',
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;

class SignerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SignerError';
    this.status = status;
  }
}

function json(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('Only JSON values can be canonicalized.');
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) throw new SignerError('Invalid hexadecimal value.');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function sha256Hex(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function compareBytes(left, right) {
  return left.byteLength === right.byteLength && constantTimeEqual(left, right);
}

async function readBoundedBody(request, maximumBytes) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maximumBytes) throw new SignerError('Request body is too large.', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new SignerError('Request body is too large.', 413);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function verifyGithubWebhook(request, bodyBytes, secret) {
  if (typeof secret !== 'string' || secret.length < 24) throw new SignerError('Webhook verification is unavailable.', 503);
  const signature = request.headers.get('x-hub-signature-256') || '';
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) throw new SignerError('Webhook signature is missing.', 401);
  const supplied = fromHex(signature.slice(7).toLowerCase());
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, bodyBytes));
  if (!constantTimeEqual(supplied, expected)) throw new SignerError('Webhook signature is invalid.', 401);
}

function safeJsonParse(bytes, label) {
  try {
    return JSON.parse(textDecoder.decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new SignerError(`${label} is invalid.`);
  }
}

function exactVersion(value) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw new SignerError('Studio release version is invalid.');
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SignerError(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) throw new SignerError(`${label} has unexpected fields.`);
  return value;
}

function unsignedDocument(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function strictBase64Bytes(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SignerError(`${label} is invalid.`);
  }
  let binary;
  try { binary = atob(value); } catch { throw new SignerError(`${label} is invalid.`); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let roundTrip = '';
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  if (btoa(roundTrip) !== value) throw new SignerError(`${label} is invalid.`);
  return bytes;
}

async function verifySignedDocument(value, label) {
  const signature = exactObjectKeys(value?.signature, ['algorithm', 'keyId', 'value'], `${label} signature`);
  if (signature.algorithm !== 'ed25519' || signature.keyId !== STUDIO_SIGNING_KEY_ID) throw new SignerError(`${label} signature identity is invalid.`);
  const signatureBytes = strictBase64Bytes(signature.value, `${label} signature`);
  if (signatureBytes.byteLength !== 64) throw new SignerError(`${label} signature is invalid.`);
  const publicKey = await crypto.subtle.importKey('raw', fromHex(STUDIO_PUBLIC_KEY_HEX), { name: 'Ed25519' }, false, ['verify']);
  const valid = await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, textEncoder.encode(canonicalJson(unsignedDocument(value))));
  if (!valid) throw new SignerError(`${label} signature verification failed.`, 409);
}

function parsePrerelease(raw) {
  return raw ? raw.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part) : [];
}

export function compareStudioVersions(left, right) {
  const a = VERSION_PATTERN.exec(exactVersion(left));
  const b = VERSION_PATTERN.exec(exactVersion(right));
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  const leftPre = parsePrerelease(a[4]);
  const rightPre = parsePrerelease(b[4]);
  if (!leftPre.length && !rightPre.length) return 0;
  if (!leftPre.length) return 1;
  if (!rightPre.length) return -1;
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'string') return -1;
    if (typeof leftPart === 'string' && typeof rightPart === 'number') return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function sanitizeReleaseNotes(value) {
  if (typeof value !== 'string') throw new SignerError('Release notes are invalid.');
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
  if (!normalized || normalized.length > 4000) throw new SignerError('Release notes are outside the supported bounds.');
  const lines = normalized.split('\n');
  if (lines.length > 40 || lines.some((line) => line.length > 240)) throw new SignerError('Release notes are outside the supported bounds.');
  return normalized;
}

function isAllowedPayloadPath(path) {
  return ALLOWED_TOP_LEVEL_FILES.has(path) || ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

function assertSafeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 512) throw new SignerError('Archive contains an invalid path.');
  if (rawPath.includes('\\') || rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath) || rawPath.includes('//') || /[\u0000-\u001F\u007F]/.test(rawPath)) {
    throw new SignerError('Archive contains an unsafe path.');
  }
  const segments = rawPath.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) throw new SignerError('Archive contains an unsafe path.');
  for (const segment of segments) {
    if (segment.includes(':') || /[ .]$/.test(segment)) throw new SignerError('Archive contains an unsafe Windows path.');
    const base = segment.split('.')[0];
    if (WINDOWS_RESERVED.test(base)) throw new SignerError('Archive contains a reserved Windows path.');
  }
  const lower = segments.map((segment) => segment.toLowerCase());
  if (lower.some((segment) => FORBIDDEN_PACKAGE_PARTS.has(segment))) throw new SignerError('Archive contains protected runtime state.');
  return segments.join('/');
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(view, offset) {
  return view.getUint16(offset, true);
}
function u32(view, offset) {
  return view.getUint32(offset, true);
}

async function inflateRawBounded(bytes, expectedBytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes || total > MAX_UNPACKED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new SignerError('Archive entry expands beyond its declared size.');
    }
    chunks.push(value);
  }
  if (total !== expectedBytes) throw new SignerError('Archive entry size is invalid.');
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeZipName(decoder, bytes, start, end) {
  try { return decoder.decode(bytes.subarray(start, end)); }
  catch { throw new SignerError('Archive path encoding is invalid.'); }
}

export async function parseZip(inputBytes, { stripFirstSegment = false } = {}) {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new SignerError('Archive size is not supported.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) === 0x06054B50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new SignerError('Archive directory is missing.');
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) throw new SignerError('Multi-disk archives are not supported.');
  const entryCount = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (entryCount === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) throw new SignerError('ZIP64 archives are not supported.');
  if (entryCount > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > eocd) throw new SignerError('Archive directory is invalid.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map();
  const lowerPaths = new Set();
  let offset = centralOffset;
  let totalUnpacked = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || u32(view, offset) !== 0x02014B50) throw new SignerError('Archive directory entry is invalid.');
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const expectedCrc = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const externalAttributes = u32(view, offset + 38);
    const localOffset = u32(view, offset + 42);
    const unixMode = externalAttributes >>> 16;
    if (flags & (0x0001 | 0x0040 | 0x2000)) throw new SignerError('Encrypted ZIP entries are not supported.');
    if (![0, 8].includes(method)) throw new SignerError('Archive compression method is not supported.');
    if ((unixMode & 0xF000) === 0xA000) throw new SignerError('Archive symlinks are not supported.');
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) throw new SignerError('ZIP64 entries are not supported.');
    if (uncompressedSize > MAX_UNPACKED_BYTES - totalUnpacked) throw new SignerError('Archive expands beyond the supported size.');

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.byteLength) throw new SignerError('Archive entry metadata is invalid.');
    const rawName = decodeZipName(decoder, bytes, nameStart, nameEnd);
    offset = nameEnd + extraLength + commentLength;
    if (rawName.endsWith('/')) continue;

    let path = assertSafeArchivePath(rawName);
    if (stripFirstSegment) {
      const slash = path.indexOf('/');
      if (slash < 0) continue;
      path = assertSafeArchivePath(path.slice(slash + 1));
    }
    const lower = path.toLowerCase();
    if (lowerPaths.has(lower)) throw new SignerError('Archive contains duplicate paths.');
    lowerPaths.add(lower);

    if (localOffset + 30 > bytes.byteLength || u32(view, localOffset) !== 0x04034B50) throw new SignerError('Archive local entry is invalid.');
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd + localExtraLength > bytes.byteLength) throw new SignerError('Archive local metadata is invalid.');
    const localName = decodeZipName(decoder, bytes, localNameStart, localNameEnd);
    if (localFlags !== flags || localMethod !== method || localName !== rawName) throw new SignerError('Archive local and central metadata do not match.');

    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new SignerError('Archive entry data is invalid.');
    const compressed = bytes.subarray(dataStart, dataEnd);
    const content = method === 0
      ? compressed.slice()
      : await inflateRawBounded(compressed, uncompressedSize);
    if (content.byteLength !== uncompressedSize || crc32(content) !== expectedCrc) throw new SignerError('Archive entry integrity check failed.');
    totalUnpacked += content.byteLength;
    entries.set(path, content);
  }

  return { entries, totalUnpacked };
}

export function expectedPayload(sourceEntries) {
  const expected = new Map();
  for (const [path, bytes] of sourceEntries.entries()) {
    if (isAllowedPayloadPath(path)) expected.set(path, bytes);
  }
  return expected;
}

export function assertPackageMatchesSource(packageEntries, sourceEntries) {
  const expected = expectedPayload(sourceEntries);
  for (const required of REQUIRED_PACKAGE_PATHS) {
    if (!expected.has(required) || !packageEntries.has(required)) throw new SignerError(`Staged package is missing required source: ${required}.`);
  }
  if (expected.size !== packageEntries.size) throw new SignerError('Staged package file set does not match accepted source.');
  for (const [path, sourceBytes] of expected.entries()) {
    const packageBytes = packageEntries.get(path);
    if (!packageBytes || !compareBytes(packageBytes, sourceBytes)) throw new SignerError(`Staged package does not match accepted source at ${path}.`);
  }
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com/repos/${STUDIO_REPOSITORY}/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Sthang-Studio-OTA-Signer',
      'x-github-api-version': '2026-03-10',
    },
    redirect: 'manual',
    cache: 'no-store',
  });
  if (!response.ok) throw new SignerError('Could not verify accepted Studio source.', 502);
  return response.json();
}

async function fetchGithubArchive(commit) {
  const first = await fetch(`https://api.github.com/repos/${STUDIO_REPOSITORY}/zipball/${commit}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Sthang-Studio-OTA-Signer',
      'x-github-api-version': '2026-03-10',
    },
    redirect: 'manual',
    cache: 'no-store',
  });
  if (![301, 302, 303, 307, 308].includes(first.status)) throw new SignerError('Accepted Studio source archive redirect is invalid.', 502);
  const location = first.headers.get('location') || '';
  let url;
  try { url = new URL(location); } catch { throw new SignerError('Accepted Studio source archive location is invalid.', 502); }
  if (url.protocol !== 'https:' || url.hostname !== 'codeload.github.com' || url.port || url.username || url.password) {
    throw new SignerError('Accepted Studio source archive location is not trusted.', 502);
  }
  const response = await fetch(url, {
    headers: { 'user-agent': 'Sthang-Studio-OTA-Signer' },
    redirect: 'manual',
    cache: 'no-store',
  });
  if (!response.ok) throw new SignerError('Could not retrieve accepted Studio source archive.', 502);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_ARCHIVE_BYTES) throw new SignerError('Accepted Studio source archive is too large.', 413);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new SignerError('Accepted Studio source archive is too large.', 413);
  return bytes;
}

async function acceptedMain() {
  const branch = await githubJson('branches/main');
  const sha = String(branch?.commit?.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new SignerError('Accepted Studio source identity is invalid.', 502);
  return sha;
}

async function requireMain(commit, message) {
  if (await acceptedMain() !== commit) throw new SignerError(message, 409);
}

async function sourceArchive(commit) {
  const bytes = await fetchGithubArchive(commit);
  const parsed = await parseZip(bytes, { stripFirstSegment: true });
  return { ...parsed, archiveSha256: await sha256Hex(bytes) };
}

function sourceText(entries, path) {
  const bytes = entries.get(path);
  if (!bytes) throw new SignerError(`Accepted Studio source is missing ${path}.`);
  return textDecoder.decode(bytes).replace(/^\uFEFF/, '');
}

function sourceJson(entries, path) {
  try { return JSON.parse(sourceText(entries, path)); }
  catch { throw new SignerError(`Accepted Studio source has invalid ${path}.`); }
}

function validateTrustRoot(entries) {
  const trust = sourceJson(entries, 'config/update-trust-root.json');
  if (
    trust?.schemaVersion !== 1
    || trust?.product !== 'sthang-studio'
    || trust?.platform !== 'windows-x64'
    || trust?.channel !== 'preview'
    || trust?.endpoint !== 'https://updates.sthang.app/studio/windows/latest.json'
    || trust?.keyId !== STUDIO_SIGNING_KEY_ID
    || String(trust?.publicKeyHex || '').toLowerCase() !== STUDIO_PUBLIC_KEY_HEX
    || trust?.provisioned !== true
    || !VERSION_PATTERN.test(String(trust?.brokerVersion || ''))
  ) throw new SignerError('Accepted Studio trust root is not provisioned for this signer.', 409);
  return trust;
}

export async function buildManifest(sourceEntries, packageBytes, packageUnpackedSize, { publishedAt = new Date().toISOString() } = {}) {
  const packageJson = sourceJson(sourceEntries, 'package.json');
  const version = exactVersion(packageJson?.version);
  const trust = validateTrustRoot(sourceEntries);
  const notes = sanitizeReleaseNotes(sourceText(sourceEntries, `release-notes/v${version}.txt`));
  const pythonFiles = [...sourceEntries.keys()]
    .filter((path) => /^local-timing\/requirements(?:-[a-z0-9-]+)?\.txt$/.test(path))
    .sort();
  if (!pythonFiles.length || pythonFiles.length > 8) throw new SignerError('Accepted Python dependency declaration is invalid.');
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version,
    publishedAt,
    releaseNotes: notes,
    package: {
      url: `https://${STUDIO_UPDATE_HOST}/studio/windows/v${version}/Sthang-Studio-OTA-v${version}.zip`,
      sha256: await sha256Hex(packageBytes),
      sizeBytes: packageBytes.byteLength,
      unpackedSizeBytes: packageUnpackedSize,
    },
    compatibility: {
      minBrokerVersion: trust.brokerVersion,
      stateSchema: 1,
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: await sha256Hex(sourceEntries.get('package-lock.json')),
      pythonFiles: await Promise.all(pythonFiles.map(async (path) => ({ path, sha256: await sha256Hex(sourceEntries.get(path)) }))),
    },
  };
}

function pemToDer(pem) {
  if (typeof pem !== 'string') throw new SignerError('Signing key is unavailable.', 503);
  const match = pem.match(/-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----/);
  if (!match) throw new SignerError('Signing key format is invalid.', 503);
  const base64 = match[1].replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function signingKey(env) {
  const pem = await env.STUDIO_SIGNING_KEY.get();
  const privateKey = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'Ed25519' }, false, ['sign']);
  const publicKey = await crypto.subtle.importKey('raw', fromHex(STUDIO_PUBLIC_KEY_HEX), { name: 'Ed25519' }, false, ['verify']);
  const challenge = textEncoder.encode('sthang-studio-ota-key-check-v1');
  const signature = await crypto.subtle.sign('Ed25519', privateKey, challenge);
  if (!await crypto.subtle.verify('Ed25519', publicKey, signature, challenge)) throw new SignerError('Signing key does not match the registered Studio public key.', 503);
  return privateKey;
}

async function privateSigningStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof SignerError)) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name).slice(0, 80) : typeof error;
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240)
        : 'unexpected runtime failure';
      console.error(JSON.stringify({ event: 'studio-ota-private-signing-failure', stage, name, message }));
    }
    throw error;
  }
}

async function signerRuntimeStage(operationName, stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof SignerError)) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name).slice(0, 80) : typeof error;
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240)
        : 'unexpected runtime failure';
      console.error(JSON.stringify({ event: 'studio-ota-runtime-failure', operation: operationName, stage, name, message }));
    }
    throw error;
  }
}

export async function signDocument(unsigned, key) {
  const payload = textEncoder.encode(canonicalJson(unsigned));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, payload));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return {
    ...unsigned,
    signature: { algorithm: 'ed25519', keyId: STUDIO_SIGNING_KEY_ID, value: btoa(binary) },
  };
}

async function putCreateOrMatch(bucket, key, bytes, metadata = {}) {
  const existing = await bucket.get(key);
  if (existing) {
    const existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (!compareBytes(existingBytes, bytes)) throw new SignerError('Immutable release object already exists with different bytes.', 409);
    return { reused: true };
  }
  const stored = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    customMetadata: metadata,
  });
  if (!stored) {
    const raced = await bucket.get(key);
    if (!raced) throw new SignerError('Could not create immutable release object.', 409);
    const racedBytes = new Uint8Array(await raced.arrayBuffer());
    if (!compareBytes(racedBytes, bytes)) throw new SignerError('Immutable release object race produced different bytes.', 409);
  }
  return { reused: false };
}

async function writeStatus(bucket, issueNumber, value) {
  await bucket.put(`status/issues/${issueNumber}.json`, `${JSON.stringify(value)}\n`, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  });
}

async function stageObject(bucket, commit) {
  const key = `staging/${commit}/package.zip`;
  const object = await bucket.get(key);
  if (!object) throw new SignerError('No staged OTA candidate exists for the current accepted main commit.', 409);
  if (object.size <= 0 || object.size > MAX_ARCHIVE_BYTES) throw new SignerError('Staged OTA candidate size is not supported.', 413);
  return { key, bytes: new Uint8Array(await object.arrayBuffer()) };
}

function authorizedIssueCommand(payload, command) {
  if (
    payload?.action !== 'created'
    || payload?.repository?.full_name !== STUDIO_REPOSITORY
    || payload?.repository?.id !== STUDIO_REPOSITORY_ID
    || payload?.issue?.state !== 'open'
    || Object.hasOwn(payload?.issue || {}, 'pull_request')
    || typeof payload?.issue?.title !== 'string'
    || !payload.issue.title.toLowerCase().startsWith('release:')
    || payload?.comment?.body !== command
    || payload?.comment?.user?.login !== STUDIO_SIGNING_ACTOR_LOGIN
    || payload?.comment?.user?.id !== STUDIO_SIGNING_ACTOR_ID
    || payload?.sender?.login !== STUDIO_SIGNING_ACTOR_LOGIN
    || payload?.sender?.id !== STUDIO_SIGNING_ACTOR_ID
    || !['OWNER', 'MEMBER'].includes(payload?.comment?.author_association)
    || !Number.isSafeInteger(payload?.issue?.number)
    || !Number.isSafeInteger(payload?.comment?.id)
  ) throw new SignerError('This issue comment is not an authorized Studio signing request.', 403);
  return {
    issueNumber: payload.issue.number,
    commentId: payload.comment.id,
    actor: payload.sender.login,
    actorId: payload.sender.id,
  };
}

export function releaseIssueCommand(payload) {
  return authorizedIssueCommand(payload, '/studio-ota-sign');
}

export function promotionIssueCommand(payload) {
  return authorizedIssueCommand(payload, '/studio-ota-promote');
}

async function processSigning(env, requestContext, deliveryId) {
  const commit = await signerRuntimeStage('sign', 'accepted-main', () => acceptedMain());
  const staged = await signerRuntimeStage('sign', 'staged-package-load', () => stageObject(env.STUDIO_UPDATES, commit));
  const [source, stagedZip] = await Promise.all([
    signerRuntimeStage('sign', 'accepted-source-archive', () => sourceArchive(commit)),
    signerRuntimeStage('sign', 'staged-package-zip', () => parseZip(staged.bytes)),
  ]);
  await signerRuntimeStage('sign', 'package-source-comparison', async () => assertPackageMatchesSource(stagedZip.entries, source.entries));
  const manifest = await signerRuntimeStage('sign', 'release-manifest-build', () => buildManifest(source.entries, staged.bytes, stagedZip.totalUnpacked));

  await requireMain(commit, 'Accepted main changed before signing. Stage a new candidate from the new main commit.');
  const key = await privateSigningStage('key-import-and-self-check', () => signingKey(env));
  const signedManifest = await privateSigningStage('release-manifest-signature', () => signDocument(manifest, key));
  const signedManifestBytes = textEncoder.encode(`${JSON.stringify(signedManifest, null, 2)}\n`);
  const manifestSha256 = await sha256Hex(signedManifestBytes);
  const verifiedAt = new Date().toISOString();
  const attestationUnsigned = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    operation: 'release-attestation',
    source: {
      repository: STUDIO_REPOSITORY,
      repositoryId: STUDIO_REPOSITORY_ID,
      commit,
      sourceArchiveSha256: source.archiveSha256,
      issueNumber: requestContext.issueNumber,
      commentId: requestContext.commentId,
      actor: requestContext.actor,
      actorId: requestContext.actorId,
      webhookDeliveryId: deliveryId,
    },
    version: manifest.version,
    manifestSha256,
    packageSha256: manifest.package.sha256,
    packageSizeBytes: manifest.package.sizeBytes,
    verifiedAt,
  };
  const attestation = await privateSigningStage('release-attestation-signature', () => signDocument(attestationUnsigned, key));
  const attestationBytes = textEncoder.encode(`${JSON.stringify(attestation, null, 2)}\n`);

  await requireMain(commit, 'Accepted main changed during signing. No immutable release objects were written.');
  const prefix = `studio/windows/v${manifest.version}`;
  await putCreateOrMatch(env.STUDIO_UPDATES, `${prefix}/Sthang-Studio-OTA-v${manifest.version}.zip`, staged.bytes, {
    sha256: manifest.package.sha256,
    sourceCommit: commit,
  });
  await putCreateOrMatch(env.STUDIO_UPDATES, `${prefix}/release.json`, signedManifestBytes, {
    sha256: manifestSha256,
    sourceCommit: commit,
  });
  await putCreateOrMatch(env.STUDIO_UPDATES, `${prefix}/release-attestation.json`, attestationBytes, {
    sourceCommit: commit,
  });

  const status = {
    schemaVersion: 1,
    product: 'sthang-studio',
    operation: 'release-signed',
    issueNumber: requestContext.issueNumber,
    version: manifest.version,
    sourceCommit: commit,
    manifestSha256,
    packageSha256: manifest.package.sha256,
    packageSizeBytes: manifest.package.sizeBytes,
    verifiedAt,
  };
  await writeStatus(env.STUDIO_UPDATES, requestContext.issueNumber, status);
  return status;
}

async function bucketBytes(bucket, key, label, maximumBytes = MAX_ARCHIVE_BYTES) {
  const object = await bucket.get(key);
  if (!object) throw new SignerError(`${label} is unavailable.`, 409);
  if (object.size <= 0 || object.size > maximumBytes) throw new SignerError(`${label} size is invalid.`, 409);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > maximumBytes) throw new SignerError(`${label} size is invalid.`, 409);
  return { object, bytes };
}

async function fetchExactPublic(url, expectedBytes, label) {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache', 'user-agent': 'Sthang-Studio-OTA-Signer' },
    redirect: 'manual',
    cache: 'no-store',
  });
  if (!response.ok) throw new SignerError(`${label} is not publicly available.`, 502);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!compareBytes(bytes, expectedBytes)) throw new SignerError(`${label} does not match verified immutable bytes.`, 502);
}

function validateReleaseStatus(value, issueNumber, commit, version) {
  const status = exactObjectKeys(value, [
    'schemaVersion', 'product', 'operation', 'issueNumber', 'version', 'sourceCommit',
    'manifestSha256', 'packageSha256', 'packageSizeBytes', 'verifiedAt',
  ], 'release signing status');
  if (
    status.schemaVersion !== 1
    || status.product !== 'sthang-studio'
    || status.operation !== 'release-signed'
    || status.issueNumber !== issueNumber
    || status.version !== version
    || status.sourceCommit !== commit
    || !/^[0-9a-f]{64}$/.test(status.manifestSha256)
    || !/^[0-9a-f]{64}$/.test(status.packageSha256)
    || !Number.isSafeInteger(status.packageSizeBytes)
    || status.packageSizeBytes <= 0
    || !Number.isFinite(Date.parse(status.verifiedAt))
  ) throw new SignerError('Release signing status does not match the current accepted release.', 409);
  return status;
}

function validateAttestation(value, { issueNumber, commit, version, manifestSha256, packageSha256, packageSizeBytes }) {
  const attestation = exactObjectKeys(value, [
    'schemaVersion', 'product', 'platform', 'channel', 'operation', 'source', 'version',
    'manifestSha256', 'packageSha256', 'packageSizeBytes', 'verifiedAt', 'signature',
  ], 'release attestation');
  const source = exactObjectKeys(attestation.source, [
    'repository', 'repositoryId', 'commit', 'sourceArchiveSha256', 'issueNumber', 'commentId',
    'actor', 'actorId', 'webhookDeliveryId',
  ], 'release attestation source');
  if (
    attestation.schemaVersion !== 1
    || attestation.product !== 'sthang-studio'
    || attestation.platform !== 'windows-x64'
    || attestation.channel !== 'preview'
    || attestation.operation !== 'release-attestation'
    || attestation.version !== version
    || attestation.manifestSha256 !== manifestSha256
    || attestation.packageSha256 !== packageSha256
    || attestation.packageSizeBytes !== packageSizeBytes
    || !Number.isFinite(Date.parse(attestation.verifiedAt))
    || source.repository !== STUDIO_REPOSITORY
    || source.repositoryId !== STUDIO_REPOSITORY_ID
    || source.commit !== commit
    || source.issueNumber !== issueNumber
    || source.actor !== STUDIO_SIGNING_ACTOR_LOGIN
    || source.actorId !== STUDIO_SIGNING_ACTOR_ID
    || !/^[0-9a-f]{64}$/.test(source.sourceArchiveSha256)
  ) throw new SignerError('Release attestation does not match the current accepted release.', 409);
  return attestation;
}

async function verifyGithubRecoveryRelease(version, commit) {
  const [release, taggedCommit] = await Promise.all([
    githubJson(`releases/tags/v${version}`),
    githubJson(`commits/v${version}`),
  ]);
  if (
    release?.tag_name !== `v${version}`
    || release?.draft !== false
    || release?.prerelease !== true
    || String(taggedCommit?.sha || '').toLowerCase() !== commit
  ) throw new SignerError('The matching GitHub recovery release is not published from the accepted commit.', 409);
  const requiredAssets = [
    `Sthang-Studio-Windows-v${version}.zip`,
    `Sthang-Studio-Windows-v${version}.zip.sha256`,
    `Sthang-Studio-macOS-Apple-Silicon-v${version}.zip`,
    `Sthang-Studio-macOS-Apple-Silicon-v${version}.zip.sha256`,
  ];
  for (const name of requiredAssets) {
    const asset = Array.isArray(release.assets) ? release.assets.find((candidate) => candidate?.name === name) : null;
    if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || ''))) {
      throw new SignerError(`The matching GitHub recovery release asset is not verified: ${name}.`, 409);
    }
  }
}

export function latestPointerDocument(version, manifestSha256) {
  const checkedVersion = exactVersion(version);
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) throw new SignerError('Release manifest hash is invalid.');
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: checkedVersion,
    manifestUrl: `https://${STUDIO_UPDATE_HOST}/studio/windows/v${checkedVersion}/release.json`,
    manifestSha256,
  };
}

async function validateExistingLatest(bytes) {
  const pointer = safeJsonParse(bytes, 'Current latest pointer');
  exactObjectKeys(pointer, [
    'schemaVersion', 'product', 'platform', 'channel', 'version', 'manifestUrl', 'manifestSha256', 'signature',
  ], 'current latest pointer');
  await verifySignedDocument(pointer, 'Current latest pointer');
  const version = exactVersion(pointer.version);
  if (
    pointer.schemaVersion !== 1
    || pointer.product !== 'sthang-studio'
    || pointer.platform !== 'windows-x64'
    || pointer.channel !== 'preview'
    || pointer.manifestUrl !== `https://${STUDIO_UPDATE_HOST}/studio/windows/v${version}/release.json`
    || !/^[0-9a-f]{64}$/.test(pointer.manifestSha256)
  ) throw new SignerError('Current latest pointer identity is invalid.', 409);
  return pointer;
}

async function verifyPromotionEvidence(env, requestContext) {
  const commit = await acceptedMain();
  const source = await sourceArchive(commit);
  const version = exactVersion(sourceJson(source.entries, 'package.json')?.version);
  const prefix = `studio/windows/v${version}`;
  const [statusObject, packageObject, manifestObject, attestationObject] = await Promise.all([
    bucketBytes(env.STUDIO_UPDATES, `status/issues/${requestContext.issueNumber}.json`, 'Release signing status', 32 * 1024),
    bucketBytes(env.STUDIO_UPDATES, `${prefix}/Sthang-Studio-OTA-v${version}.zip`, 'Immutable OTA package'),
    bucketBytes(env.STUDIO_UPDATES, `${prefix}/release.json`, 'Signed release manifest', 64 * 1024),
    bucketBytes(env.STUDIO_UPDATES, `${prefix}/release-attestation.json`, 'Signed release attestation', 64 * 1024),
  ]);
  const status = validateReleaseStatus(safeJsonParse(statusObject.bytes, 'Release signing status'), requestContext.issueNumber, commit, version);
  if (status.packageSizeBytes !== packageObject.bytes.byteLength || status.packageSha256 !== await sha256Hex(packageObject.bytes)) {
    throw new SignerError('Immutable OTA package does not match release signing status.', 409);
  }
  const packageZip = await parseZip(packageObject.bytes);
  assertPackageMatchesSource(packageZip.entries, source.entries);

  const manifest = safeJsonParse(manifestObject.bytes, 'Signed release manifest');
  await verifySignedDocument(manifest, 'Signed release manifest');
  const manifestSha256 = await sha256Hex(manifestObject.bytes);
  if (manifestSha256 !== status.manifestSha256) throw new SignerError('Signed release manifest does not match release signing status.', 409);
  const expectedManifest = await buildManifest(source.entries, packageObject.bytes, packageZip.totalUnpacked, { publishedAt: manifest.publishedAt });
  if (canonicalJson(unsignedDocument(manifest)) !== canonicalJson(expectedManifest)) {
    throw new SignerError('Signed release manifest does not match current accepted source and package.', 409);
  }

  const attestation = safeJsonParse(attestationObject.bytes, 'Signed release attestation');
  await verifySignedDocument(attestation, 'Signed release attestation');
  validateAttestation(attestation, {
    issueNumber: requestContext.issueNumber,
    commit,
    version,
    manifestSha256,
    packageSha256: status.packageSha256,
    packageSizeBytes: status.packageSizeBytes,
  });

  await verifyGithubRecoveryRelease(version, commit);
  await Promise.all([
    fetchExactPublic(`https://${STUDIO_UPDATE_HOST}/${prefix}/release.json`, manifestObject.bytes, 'Public immutable release manifest'),
    fetchExactPublic(`https://${STUDIO_UPDATE_HOST}/${prefix}/Sthang-Studio-OTA-v${version}.zip`, packageObject.bytes, 'Public immutable OTA package'),
    fetchExactPublic(`https://${STUDIO_UPDATE_HOST}/${prefix}/release-attestation.json`, attestationObject.bytes, 'Public immutable release attestation'),
  ]);
  return { commit, version, manifest, manifestBytes: manifestObject.bytes, manifestSha256, packageSha256: status.packageSha256 };
}

async function processPromotion(env, requestContext, deliveryId) {
  const evidence = await verifyPromotionEvidence(env, requestContext);
  const latestKey = 'studio/windows/latest.json';
  const previous = await env.STUDIO_UPDATES.get(latestKey);
  let previousBytes = null;
  if (previous) {
    previousBytes = new Uint8Array(await previous.arrayBuffer());
    const current = await validateExistingLatest(previousBytes);
    if (compareStudioVersions(evidence.version, current.version) <= 0) {
      throw new SignerError('The latest pointer may only advance to a newer verified version.', 409);
    }
  }

  await requireMain(evidence.commit, 'Accepted main changed before latest-pointer signing. Verify the new accepted release first.');
  const key = await privateSigningStage('latest-key-import-and-self-check', () => signingKey(env));
  const signedPointer = await privateSigningStage('latest-pointer-signature', () => signDocument(latestPointerDocument(evidence.version, evidence.manifestSha256), key));
  const pointerBytes = textEncoder.encode(`${JSON.stringify(signedPointer, null, 2)}\n`);
  const latestSha256 = await sha256Hex(pointerBytes);
  await requireMain(evidence.commit, 'Accepted main changed during latest-pointer promotion. No pointer was written.');

  await env.STUDIO_UPDATES.put(latestKey, pointerBytes, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { sourceCommit: evidence.commit, manifestSha256: evidence.manifestSha256, deliveryId },
  });
  try {
    const stored = await bucketBytes(env.STUDIO_UPDATES, latestKey, 'Promoted latest pointer', 32 * 1024);
    if (!compareBytes(stored.bytes, pointerBytes)) throw new SignerError('Promoted latest pointer bytes could not be verified.', 502);
    await validateExistingLatest(stored.bytes);
    await fetchExactPublic(`https://${STUDIO_UPDATE_HOST}/studio/windows/latest.json`, pointerBytes, 'Public latest pointer');
  } catch (error) {
    if (previousBytes) {
      await env.STUDIO_UPDATES.put(latestKey, previousBytes, {
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
      }).catch(() => {});
    } else {
      await env.STUDIO_UPDATES.delete(latestKey).catch(() => {});
    }
    throw error;
  }

  const status = {
    schemaVersion: 1,
    product: 'sthang-studio',
    operation: 'latest-promoted',
    issueNumber: requestContext.issueNumber,
    version: evidence.version,
    sourceCommit: evidence.commit,
    manifestSha256: evidence.manifestSha256,
    latestSha256,
    promotedAt: new Date().toISOString(),
  };
  await writeStatus(env.STUDIO_UPDATES, requestContext.issueNumber, status);
  return status;
}

async function handleWebhook(request, env) {
  const bodyBytes = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  await verifyGithubWebhook(request, bodyBytes, env.STUDIO_GITHUB_WEBHOOK_SECRET);
  const event = request.headers.get('x-github-event') || '';
  const deliveryId = (request.headers.get('x-github-delivery') || '').toLowerCase();
  if (!/^[0-9a-f-]{20,80}$/.test(deliveryId)) throw new SignerError('Webhook delivery identity is invalid.', 400);
  if (event === 'ping') return json({ ok: true, service: 'sthang-studio-ota-signer' });
  if (event !== 'issue_comment') return json({ ok: true, ignored: true });

  const payload = safeJsonParse(bodyBytes, 'Webhook payload');
  const command = payload?.comment?.body;
  const operation = command === '/studio-ota-sign' ? 'sign' : command === '/studio-ota-promote' ? 'promote' : null;
  if (!operation) throw new SignerError('This issue comment is not an authorized Studio signing request.', 403);
  const context = operation === 'sign' ? releaseIssueCommand(payload) : promotionIssueCommand(payload);
  const replayKey = `audit/webhook/${deliveryId}.json`;
  const replayBytes = textEncoder.encode(`${JSON.stringify({ receivedAt: new Date().toISOString(), issueNumber: context.issueNumber, commentId: context.commentId })}\n`);
  const replay = await env.STUDIO_UPDATES.put(replayKey, replayBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  if (!replay) return json({ ok: true, duplicate: true }, 202);

  try {
    const status = operation === 'sign'
      ? await processSigning(env, context, deliveryId)
      : await processPromotion(env, context, deliveryId);
    await putCreateOrMatch(env.STUDIO_UPDATES, `audit/webhook/${deliveryId}.result.json`, textEncoder.encode(`${JSON.stringify(status)}\n`));
    return json({ ok: true, accepted: true, version: status.version }, 202);
  } catch (error) {
    const message = error instanceof SignerError ? error.message : operation === 'sign' ? 'Signing request failed.' : 'Latest-pointer promotion failed.';
    const status = {
      schemaVersion: 1,
      product: 'sthang-studio',
      operation: operation === 'sign' ? 'release-signing-failed' : 'latest-promotion-failed',
      issueNumber: context.issueNumber,
      message,
      failedAt: new Date().toISOString(),
    };
    await writeStatus(env.STUDIO_UPDATES, context.issueNumber, status).catch(() => {});
    await putCreateOrMatch(env.STUDIO_UPDATES, `audit/webhook/${deliveryId}.result.json`, textEncoder.encode(`${JSON.stringify(status)}\n`)).catch(() => {});
    throw error;
  }
}

async function readPublicStatus(env, issueNumber) {
  const object = await env.STUDIO_UPDATES.get(`status/issues/${issueNumber}.json`);
  if (!object) return json({ ok: true, status: 'none' }, 404);
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'sthang-studio-ota-signer', keyId: STUDIO_SIGNING_KEY_ID });
  }
  const statusMatch = /^\/v1\/studio\/issues\/(\d+)\/latest$/.exec(url.pathname);
  if (request.method === 'GET' && statusMatch) return readPublicStatus(env, Number(statusMatch[1]));
  if (request.method === 'POST' && url.pathname === '/github/webhook') return handleWebhook(request, env);
  return json({ ok: false, error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status = error instanceof SignerError ? error.status : 500;
      const message = error instanceof SignerError ? error.message : 'Signing service request failed.';
      return json({ ok: false, error: message }, status);
    }
  },
};
