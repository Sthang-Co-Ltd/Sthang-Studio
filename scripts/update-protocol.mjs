import crypto from 'node:crypto';

export const UPDATE_HOST = 'updates.sthang.app';
export const UPDATE_BASE_PATH = '/studio/windows/';
export const LATEST_PATH = `${UPDATE_BASE_PATH}latest.json`;
export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const HEX_64 = /^[0-9a-f]{64}$/;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export class UpdateProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpdateProtocolError';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateProtocolError(`${label} is invalid.`);
  }
  return value;
}

function exactKeys(value, label, expected) {
  const item = object(value, label);
  const actual = Object.keys(item).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    throw new UpdateProtocolError(`${label} has unexpected fields.`);
  }
  return item;
}

function text(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new UpdateProtocolError(`${label} is invalid.`);
  }
  return value.trim();
}

function integer(value, label, max) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new UpdateProtocolError(`${label} is invalid.`);
  }
  return value;
}

export function exactVersion(value, label = 'version') {
  const version = text(value, label, 80);
  if (!VERSION_PATTERN.test(version)) throw new UpdateProtocolError(`${label} is invalid.`);
  return version;
}

export function canonicalJson(value) {
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

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function unsignedDocument(value) {
  const copy = { ...object(value, 'signed document') };
  delete copy.signature;
  return copy;
}

function strictBase64(value, label) {
  const encoded = text(value, label, 256);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new UpdateProtocolError(`${label} is invalid.`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new UpdateProtocolError(`${label} is invalid.`);
  return bytes;
}

function signature(value) {
  const item = exactKeys(value, 'signature', ['algorithm', 'keyId', 'value']);
  if (item.algorithm !== 'ed25519') throw new UpdateProtocolError('The update signature algorithm is not supported.');
  const keyId = text(item.keyId, 'signature key', 120);
  const bytes = strictBase64(item.value, 'signature value');
  if (bytes.length !== 64) throw new UpdateProtocolError('The update signature is invalid.');
  return { algorithm: 'ed25519', keyId, value: item.value };
}

function parsePrerelease(raw) {
  return raw ? raw.split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part) : [];
}

export function compareVersions(left, right) {
  const a = VERSION_PATTERN.exec(exactVersion(left, 'left version'));
  const b = VERSION_PATTERN.exec(exactVersion(right, 'right version'));
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

export function sanitizeReleaseNotes(value) {
  const input = typeof value === 'string' ? value : '';
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .split('\n')
    .slice(0, 40)
    .map((line) => line.slice(0, 240).trimEnd())
    .join('\n')
    .trim()
    .slice(0, 4_000);
}

function hash(value, label) {
  const result = text(value, label, 64).toLowerCase();
  if (!HEX_64.test(result)) throw new UpdateProtocolError(`${label} is invalid.`);
  return result;
}

export function assertLatestEndpoint(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new UpdateProtocolError('The update endpoint is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== UPDATE_HOST || url.port || url.username || url.password || url.search || url.hash || url.pathname !== LATEST_PATH) {
    throw new UpdateProtocolError('The update endpoint is not the approved Studio endpoint.');
  }
  return url.toString();
}

export function assertImmutableUpdateUrl(raw, version, label = 'The update URL') {
  const safeVersion = exactVersion(version);
  let url;
  try { url = new URL(raw); } catch { throw new UpdateProtocolError(`${label} is invalid.`); }
  const prefix = `${UPDATE_BASE_PATH}v${safeVersion}/`;
  if (url.protocol !== 'https:' || url.hostname !== UPDATE_HOST || url.port || url.username || url.password || url.search || url.hash) {
    throw new UpdateProtocolError(`${label} is not an approved immutable Studio URL.`);
  }
  if (!url.pathname.startsWith(prefix) || url.pathname.length <= prefix.length || url.pathname.includes('//') || /%(?:2e|2f|3a|5c)/i.test(url.pathname)) {
    throw new UpdateProtocolError(`${label} is not versioned correctly.`);
  }
  return url.toString();
}

export function validateTrustRoot(value) {
  const item = exactKeys(value, 'Studio update trust root', [
    'schemaVersion', 'product', 'platform', 'channel', 'endpoint', 'keyId', 'publicKeyHex', 'provisioned', 'brokerVersion',
  ]);
  if (item.schemaVersion !== 1 || item.product !== 'sthang-studio' || item.platform !== 'windows-x64' || item.channel !== 'preview') {
    throw new UpdateProtocolError('The Studio update trust root identity is invalid.');
  }
  const provisioned = item.provisioned === true;
  if (item.provisioned !== true && item.provisioned !== false) throw new UpdateProtocolError('The Studio update trust-root state is invalid.');
  const keyId = text(item.keyId, 'trust-root key id', 120);
  const publicKeyHex = typeof item.publicKeyHex === 'string' ? item.publicKeyHex.trim().toLowerCase() : '';
  if (provisioned) {
    if (/unprovisioned|placeholder/i.test(keyId) || !HEX_64.test(publicKeyHex)) {
      throw new UpdateProtocolError('The Studio production update trust root is not provisioned correctly.');
    }
  } else if (publicKeyHex && !HEX_64.test(publicKeyHex)) {
    throw new UpdateProtocolError('The unprovisioned Studio public-key slot is invalid.');
  }
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    endpoint: assertLatestEndpoint(text(item.endpoint, 'update endpoint', 500)),
    keyId,
    publicKeyHex,
    provisioned,
    brokerVersion: exactVersion(item.brokerVersion, 'broker version'),
  };
}

export function verifySignedJson(value, trustValue) {
  const trust = validateTrustRoot(trustValue);
  if (!trust.provisioned || !HEX_64.test(trust.publicKeyHex)) {
    throw new UpdateProtocolError('The Studio production update trust root is not provisioned.');
  }
  const item = object(value, 'signed update document');
  const signedBy = signature(item.signature);
  if (signedBy.keyId !== trust.keyId) throw new UpdateProtocolError('This update was signed by an untrusted Studio key.');
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(trust.publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalJson(unsignedDocument(item)), 'utf8'),
    key,
    Buffer.from(signedBy.value, 'base64'),
  );
  if (!verified) throw new UpdateProtocolError('The Studio update signature could not be verified.');
  return signedBy;
}

export function validateLatestPointer(value, trustValue, { verifySignature = true } = {}) {
  const trust = validateTrustRoot(trustValue);
  const item = exactKeys(value, 'latest pointer', [
    'schemaVersion', 'product', 'platform', 'channel', 'version', 'manifestUrl', 'manifestSha256', 'signature',
  ]);
  if (verifySignature) verifySignedJson(item, trust);
  const version = exactVersion(item.version);
  if (item.schemaVersion !== 1 || item.product !== 'sthang-studio' || item.platform !== 'windows-x64' || item.channel !== trust.channel) {
    throw new UpdateProtocolError('The latest pointer identity is invalid.');
  }
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    version,
    manifestUrl: assertImmutableUpdateUrl(text(item.manifestUrl, 'manifest URL', 500), version, 'The update manifest URL'),
    manifestSha256: hash(item.manifestSha256, 'manifest hash'),
    signature: signature(item.signature),
  };
}

export function validateReleaseManifest(value, trustValue, { verifySignature = true } = {}) {
  const trust = validateTrustRoot(trustValue);
  const manifestKeys = ['schemaVersion', 'product', 'platform', 'channel', 'version', 'publishedAt', 'releaseNotes', 'package', 'compatibility', 'setup'];
  if (verifySignature) manifestKeys.push('signature');
  const item = exactKeys(value, 'release manifest', manifestKeys);
  if (verifySignature) verifySignedJson(item, trust);
  const version = exactVersion(item.version);
  if (item.schemaVersion !== 1 || item.product !== 'sthang-studio' || item.platform !== 'windows-x64' || item.channel !== trust.channel) {
    throw new UpdateProtocolError('The release manifest identity is invalid.');
  }
  const publishedAt = text(item.publishedAt, 'published time', 80);
  if (!Number.isFinite(Date.parse(publishedAt))) throw new UpdateProtocolError('The update published time is invalid.');
  const releaseNotes = sanitizeReleaseNotes(item.releaseNotes);
  if (typeof item.releaseNotes !== 'string' || releaseNotes !== item.releaseNotes) {
    throw new UpdateProtocolError('Release notes must be bounded sanitized plain text.');
  }
  const packageValue = exactKeys(item.package, 'release package', ['url', 'sha256', 'sizeBytes', 'unpackedSizeBytes']);
  const compatibility = exactKeys(item.compatibility, 'release compatibility', ['minBrokerVersion', 'stateSchema', 'manualInstallerRequired']);
  if (compatibility.manualInstallerRequired !== true && compatibility.manualInstallerRequired !== false) {
    throw new UpdateProtocolError('The manual-installer compatibility flag is invalid.');
  }
  const setup = exactKeys(item.setup, 'release setup', ['strategy', 'packageLockSha256', 'pythonFiles']);
  if (setup.strategy !== 'npm-ci-and-local-timing') throw new UpdateProtocolError('The update setup strategy is not supported.');
  if (!Array.isArray(setup.pythonFiles) || setup.pythonFiles.length < 1 || setup.pythonFiles.length > 8) {
    throw new UpdateProtocolError('The Python dependency declaration is invalid.');
  }
  const seen = new Set();
  const pythonFiles = setup.pythonFiles.map((entry, index) => {
    const file = exactKeys(entry, `Python dependency ${index + 1}`, ['path', 'sha256']);
    const relative = text(file.path, 'Python dependency path', 160).replaceAll('\\', '/');
    if (!/^local-timing\/requirements(?:-[a-z0-9-]+)?\.txt$/.test(relative) || seen.has(relative)) {
      throw new UpdateProtocolError('A Python dependency path is not allowed.');
    }
    seen.add(relative);
    return { path: relative, sha256: hash(file.sha256, 'Python dependency hash') };
  });
  const minimumBroker = exactVersion(compatibility.minBrokerVersion, 'minimum broker version');
  if (compareVersions(trust.brokerVersion, minimumBroker) < 0) {
    throw new UpdateProtocolError('This update needs a newer Studio installer. Use the manual Windows download instead.');
  }
  if (compatibility.manualInstallerRequired) {
    throw new UpdateProtocolError('This release needs the manual Windows installer.');
  }
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    version,
    publishedAt,
    releaseNotes,
    package: {
      url: assertImmutableUpdateUrl(text(packageValue.url, 'package URL', 500), version, 'The update package URL'),
      sha256: hash(packageValue.sha256, 'package hash'),
      sizeBytes: integer(packageValue.sizeBytes, 'package size', MAX_PACKAGE_BYTES),
      unpackedSizeBytes: integer(packageValue.unpackedSizeBytes, 'unpacked package size', MAX_UNPACKED_BYTES),
    },
    compatibility: {
      minBrokerVersion: minimumBroker,
      stateSchema: compatibility.stateSchema === 1 ? 1 : (() => { throw new UpdateProtocolError('The update state schema is not supported.'); })(),
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: hash(setup.packageLockSha256, 'package lock hash'),
      pythonFiles,
    },
    ...(verifySignature ? { signature: signature(item.signature) } : {}),
  };
}


export function validateReleaseReceipt(value, trustValue) {
  const trust = validateTrustRoot(trustValue);
  const item = exactKeys(value, 'release verification receipt', [
    'schemaVersion', 'product', 'platform', 'channel', 'keyId', 'version',
    'manifestSha256', 'packageSha256', 'packageSizeBytes', 'verifiedAt',
  ]);
  if (
    item.schemaVersion !== 1
    || item.product !== 'sthang-studio'
    || item.platform !== 'windows-x64'
    || item.channel !== trust.channel
    || item.keyId !== trust.keyId
  ) {
    throw new UpdateProtocolError('The release verification receipt identity is invalid.');
  }
  const verifiedAt = text(item.verifiedAt, 'receipt verification time', 80);
  if (!Number.isFinite(Date.parse(verifiedAt))) throw new UpdateProtocolError('The receipt verification time is invalid.');
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    keyId: trust.keyId,
    version: exactVersion(item.version, 'receipt version'),
    manifestSha256: hash(item.manifestSha256, 'receipt manifest hash'),
    packageSha256: hash(item.packageSha256, 'receipt package hash'),
    packageSizeBytes: integer(item.packageSizeBytes, 'receipt package size', MAX_PACKAGE_BYTES),
    verifiedAt,
  };
}

export function publicKeyHexFromKey(key) {
  const der = Buffer.from(key.export({ format: 'der', type: 'spki' }));
  if (!der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) || der.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new UpdateProtocolError('The signing key is not Ed25519.');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length).toString('hex');
}

export function signDocument(value, privateKey, keyId) {
  const unsigned = unsignedDocument(value);
  const signatureValue = crypto.sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKey).toString('base64');
  return { ...unsigned, signature: { algorithm: 'ed25519', keyId, value: signatureValue } };
}
