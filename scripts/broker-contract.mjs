// These are the only executable files a broker upgrade may install. Never let
// signed metadata broaden this list: user state and the trust root are excluded.
export const BROKER_PATHS = Object.freeze([
  'scripts/launch-studio.ps1',
  'scripts/update-runtime.mjs',
  'scripts/update-protocol.mjs',
  'scripts/prepare-studio-update.ps1',
]);
export const BROKER_DESCRIPTOR = 'config/studio-broker.json';
export const BROKER_UPDATE_NOTE = 'Includes a verified update-helper upgrade.';
export const MAX_BROKER_FILE_BYTES = 256 * 1024;
export const MAX_BROKER_DESCRIPTOR_BYTES = 32 * 1024;
const HASH = /^[0-9a-f]{64}$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} has an invalid schema.`);
  }
}

export function brokerVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
      || value.length > 40 || value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('The broker version is invalid.');
  }
  return value;
}

export function compareBrokerVersions(left, right) {
  const a = brokerVersion(left).split('.').map(Number);
  const b = brokerVersion(right).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function validateBrokerDescriptor(value) {
  exactKeys(value, ['schemaVersion', 'product', 'platform', 'brokerVersion', 'files', 'predecessors'], 'Broker descriptor');
  if (value.schemaVersion !== 1 || value.product !== 'sthang-studio' || value.platform !== 'windows-x64') {
    throw new Error('The broker identity is invalid.');
  }
  const version = brokerVersion(value.brokerVersion);
  exactKeys(value.files, BROKER_PATHS, 'Broker files');
  for (const relative of BROKER_PATHS) {
    const item = value.files[relative];
    exactKeys(item, ['sha256', 'sizeBytes'], 'Broker file');
    if (!HASH.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes)
        || item.sizeBytes <= 0 || item.sizeBytes > MAX_BROKER_FILE_BYTES) {
      throw new Error('A broker file identity is invalid.');
    }
  }
  if (!Array.isArray(value.predecessors) || value.predecessors.length > 16) {
    throw new Error('The broker predecessor list is invalid.');
  }
  const seen = new Set();
  for (const previous of value.predecessors) {
    exactKeys(previous, ['brokerVersion', 'files'], 'Broker predecessor');
    if (compareBrokerVersions(previous.brokerVersion, version) >= 0 || seen.has(previous.brokerVersion)) {
      throw new Error('Broker downgrade or duplicate predecessor is not allowed.');
    }
    seen.add(previous.brokerVersion);
    exactKeys(previous.files, BROKER_PATHS, 'Predecessor files');
    for (const hashes of Object.values(previous.files)) {
      if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > 16
          || hashes.some((digest) => typeof digest !== 'string' || !HASH.test(digest))
          || new Set(hashes).size !== hashes.length) {
        throw new Error('A broker predecessor fingerprint is invalid.');
      }
    }
  }
  return value;
}
