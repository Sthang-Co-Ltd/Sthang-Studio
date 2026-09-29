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

function macTrust(publicKeyHex, overrides = {}) {
  return trust(publicKeyHex, {
    platform: 'macos-arm64',
    endpoint: 'https://updates.sthang.app/studio/macos-arm64/latest.json',
    ...overrides,
  });
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

function unsignedMacManifest(overrides = {}) {
  return unsignedManifest({
    schemaVersion: 2,
    platform: 'macos-arm64',
    source: {
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      buildEvidenceSha256: '4'.repeat(64),
      derivedRuntimeManifestSha256: '3'.repeat(64),
    },
    package: {
      ...unsignedManifest().package,
      url: 'https://updates.sthang.app/studio/macos-arm64/v0.8.0/Sthang-Studio-OTA-macOS-Apple-Silicon-v0.8.0.zip',
    },
    compatibility: {
      ...unsignedManifest().compatibility,
      minMacos: '12.3',
      arch: 'arm64',
    },
    setup: {
      ...unsignedManifest().setup,
      strategy: 'macos-curated-runtime',
    },
    ...overrides,
  });
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

test('macOS trust roots are platform-bound to the macOS update namespace', () => {
  const pair = keys();
  const root = validateTrustRoot(macTrust(pair.publicKeyHex));
  assert.equal(root.platform, 'macos-arm64');
  assert.equal(root.endpoint, 'https://updates.sthang.app/studio/macos-arm64/latest.json');
  assert.throws(() => validateTrustRoot({ ...root, endpoint: 'https://updates.sthang.app/studio/windows/latest.json' }), /approved Studio endpoint/i);
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

test('macOS manifests require the curated runtime strategy and macOS immutable namespace', () => {
  const pair = keys();
  const root = macTrust(pair.publicKeyHex);
  const signed = signDocument(unsignedMacManifest(), pair.privateKey, root.keyId);
  const validated = validateReleaseManifest(signed, root);
  assert.equal(validated.platform, 'macos-arm64');
  assert.equal(validated.schemaVersion, 2);
  assert.equal(validated.source.commit, '1'.repeat(40));
  assert.equal(validated.setup.strategy, 'macos-curated-runtime');
  assert.match(validated.package.url, /\/studio\/macos-arm64\/v0\.8\.0\//);
  assert.throws(() => validateReleaseManifest(signDocument(unsignedMacManifest({
    setup: { ...unsignedMacManifest().setup, strategy: 'npm-ci-and-local-timing' },
  }), pair.privateKey, root.keyId), root), /setup strategy/i);
  assert.throws(() => validateReleaseManifest(signDocument(unsignedMacManifest({
    package: { ...unsignedMacManifest().package, url: 'https://updates.sthang.app/studio/windows/v0.8.0/package.zip' },
  }), pair.privateKey, root.keyId), root), /immutable|versioned/i);
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

test('macOS latest pointers cannot cross into the Windows channel', () => {
  const pair = keys();
  const root = macTrust(pair.publicKeyHex);
  const manifest = signDocument(unsignedMacManifest(), pair.privateKey, root.keyId);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const pointer = signDocument({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'macos-arm64',
    channel: 'preview',
    version: '0.8.0',
    manifestUrl: 'https://updates.sthang.app/studio/macos-arm64/v0.8.0/release.json',
    manifestSha256: sha256(bytes),
  }, pair.privateKey, root.keyId);
  assert.equal(validateLatestPointer(pointer, root).platform, 'macos-arm64');
  assert.throws(() => validateLatestPointer(signDocument({
    ...pointer,
    platform: 'windows-x64',
    signature: undefined,
  }, pair.privateKey, root.keyId), root), /identity/i);
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
