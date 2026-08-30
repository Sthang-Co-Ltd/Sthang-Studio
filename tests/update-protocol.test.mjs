import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assertImmutableUpdateUrl,
  canonicalJson,
  compareVersions,
  publicKeyHexFromKey,
  sanitizeReleaseNotes,
  sha256,
  signDocument,
  validateLatestPointer,
  validateReleaseManifest,
  validateReleaseReceipt,
  validateTrustRoot,
  verifySignedJson,
} from '../scripts/update-protocol.mjs';

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    ...pair,
    publicKeyHex: publicKeyHexFromKey(pair.publicKey),
  };
}

function trust(publicKeyHex, overrides = {}) {
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
    keyId: 'studio-update-test-key',
    publicKeyHex,
    provisioned: true,
    brokerVersion: '1.0.0',
    ...overrides,
  };
}

function unsignedManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: '0.8.0',
    publishedAt: '2026-08-30T00:00:00.000Z',
    releaseNotes: 'Signed Studio update test.',
    package: {
      url: 'https://updates.sthang.app/studio/windows/v0.8.0/Sthang-Studio-OTA-v0.8.0.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      unpackedSizeBytes: 4096,
    },
    compatibility: {
      minBrokerVersion: '1.0.0',
      stateSchema: 1,
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: 'b'.repeat(64),
      pythonFiles: [
        { path: 'local-timing/requirements.txt', sha256: 'c'.repeat(64) },
        { path: 'local-timing/requirements-kfa.txt', sha256: 'd'.repeat(64) },
      ],
    },
    ...overrides,
  };
}

test('canonical JSON and Ed25519 verification are deterministic and tamper-evident', () => {
  const pair = keys();
  const root = trust(pair.publicKeyHex);
  const signed = signDocument({ z: 2, a: { y: true, x: 'Khmer ខ្មែរ' } }, pair.privateKey, root.keyId);
  assert.equal(canonicalJson({ z: 2, a: { y: true, x: 'Khmer ខ្មែរ' } }), canonicalJson({ a: { x: 'Khmer ខ្មែរ', y: true }, z: 2 }));
  verifySignedJson(signed, root);
  assert.throws(() => verifySignedJson({ ...signed, z: 3 }, root), /signature/i);
  assert.throws(() => verifySignedJson({ ...signed, signature: { ...signed.signature, keyId: 'aco-key' } }, root), /untrusted Studio key/i);
});

test('Studio trust roots fail closed until an approved public key is provisioned', () => {
  const unprovisioned = validateTrustRoot({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
    keyId: 'studio-updates-unprovisioned',
    publicKeyHex: '',
    provisioned: false,
    brokerVersion: '1.0.0',
  });
  assert.equal(unprovisioned.provisioned, false);
  assert.throws(() => validateTrustRoot({ ...unprovisioned, provisioned: true }), /not provisioned correctly/i);
  assert.throws(() => validateTrustRoot({ ...unprovisioned, endpoint: 'https://example.com/latest.json' }), /approved Studio endpoint/i);
});

test('release manifests bind immutable Sthang URLs, dependency inputs, and bounded plain text', () => {
  const pair = keys();
  const root = trust(pair.publicKeyHex);
  const signed = signDocument(unsignedManifest(), pair.privateKey, root.keyId);
  const validated = validateReleaseManifest(signed, root);
  assert.equal(validated.version, '0.8.0');
  assert.equal(validated.setup.pythonFiles.length, 2);

  assert.throws(() => validateReleaseManifest(signDocument(unsignedManifest({
    package: { ...unsignedManifest().package, url: 'https://updates.sthang.app/studio/windows/latest.zip' },
  }), pair.privateKey, root.keyId), root), /versioned correctly|immutable/i);
  assert.throws(() => validateReleaseManifest(signDocument(unsignedManifest({
    releaseNotes: 'Unsafe\u0000notes',
  }), pair.privateKey, root.keyId), root), /bounded sanitized plain text/i);
  assert.throws(() => validateReleaseManifest(signDocument(unsignedManifest({
    compatibility: { minBrokerVersion: '2.0.0', stateSchema: 1, manualInstallerRequired: false },
  }), pair.privateKey, root.keyId), root), /newer Studio installer/i);
  assert.throws(() => validateReleaseManifest(signDocument(unsignedManifest({
    setup: { ...unsignedManifest().setup, pythonFiles: [{ path: '../requirements.txt', sha256: 'c'.repeat(64) }] },
  }), pair.privateKey, root.keyId), root), /not allowed/i);
  assert.throws(
    () => assertImmutableUpdateUrl('https://updates.sthang.app/studio/windows/v0.8.0/%2e%2e/escape.zip', '0.8.0'),
    /immutable|versioned/i,
  );
  assert.throws(
    () => assertImmutableUpdateUrl('https://updates.sthang.app/studio/windows/v0.8.0/package.zip?token=secret', '0.8.0'),
    /immutable/i,
  );
});

test('latest pointers bind the exact immutable manifest bytes', () => {
  const pair = keys();
  const root = trust(pair.publicKeyHex);
  const manifest = signDocument(unsignedManifest(), pair.privateKey, root.keyId);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const pointer = signDocument({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: '0.8.0',
    manifestUrl: 'https://updates.sthang.app/studio/windows/v0.8.0/release.json',
    manifestSha256: sha256(bytes),
  }, pair.privateKey, root.keyId);
  assert.equal(validateLatestPointer(pointer, root).manifestSha256, sha256(bytes));
  assert.throws(() => validateLatestPointer({ ...pointer, manifestSha256: 'f'.repeat(64) }, root), /signature/i);
});

test('version comparison follows semantic prerelease ordering', () => {
  assert.equal(compareVersions('0.8.0', '0.7.14'), 1);
  assert.equal(compareVersions('0.8.0-beta.2', '0.8.0-beta.10'), -1);
  assert.equal(compareVersions('0.8.0', '0.8.0-beta.10'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
});

test('release-note sanitizer removes controls and enforces line and size bounds', () => {
  const notes = sanitizeReleaseNotes(`Hello\u0000\u202e\n${'x'.repeat(600)}\n${'line\n'.repeat(80)}`);
  assert.ok(notes.length <= 4000);
  assert.ok(notes.split('\n').length <= 40);
  assert.ok(notes.split('\n').every((line) => line.length <= 240));
  assert.ok(!notes.includes('\u0000'));
  assert.ok(!notes.includes('\u202e'));
});


test('release receipts are strict evidence for exact manifest and package bytes', () => {
  const pair = keys();
  const root = trust(pair.publicKeyHex);
  const receipt = validateReleaseReceipt({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    keyId: root.keyId,
    version: '0.8.0',
    manifestSha256: 'a'.repeat(64),
    packageSha256: 'b'.repeat(64),
    packageSizeBytes: 1024,
    verifiedAt: '2026-08-30T00:05:00.000Z',
  }, root);
  assert.equal(receipt.version, '0.8.0');
  assert.throws(() => validateReleaseReceipt({ ...receipt, keyId: 'aco-update-key' }, root), /identity/i);
  assert.throws(() => validateReleaseReceipt({ ...receipt, extra: true }, root), /unexpected fields/i);
});
