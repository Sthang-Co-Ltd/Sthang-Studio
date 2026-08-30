import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UpdateError,
  createUpdateService,
  publicUpdateError,
  unsafeUpdateReasons,
  type ReleaseManifest,
  type UpdateTrustRoot,
} from '../apps/server/src/updater.js';
import {
  publicKeyHexFromKey,
  sha256,
  signDocument,
} from '../scripts/update-protocol.mjs';

interface SignedFixture {
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  manifestUrl: string;
  packageBytes: Buffer;
  packageUrl: string;
  pointerBytes: Buffer;
}

function signingFixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const trust: UpdateTrustRoot = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
    keyId: 'studio-update-test-key',
    publicKeyHex: publicKeyHexFromKey(pair.publicKey),
    provisioned: true,
    brokerVersion: '1.0.0',
  };
  return { ...pair, trust };
}

function releaseFixture(
  signing: ReturnType<typeof signingFixture>,
  options: { version?: string; notes?: string; packageBytes?: Buffer } = {},
): SignedFixture {
  const version = options.version || '0.8.0';
  const packageBytes = options.packageBytes || Buffer.from(`signed-package-${version}`);
  const packageUrl = `https://updates.sthang.app/studio/windows/v${version}/Sthang-Studio-OTA-v${version}.zip`;
  const manifestUrl = `https://updates.sthang.app/studio/windows/v${version}/release.json`;
  const unsigned = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version,
    publishedAt: '2026-08-30T00:00:00.000Z',
    releaseNotes: options.notes || 'Safe signed Studio update.',
    package: {
      url: packageUrl,
      sha256: sha256(packageBytes),
      sizeBytes: packageBytes.length,
      unpackedSizeBytes: 4096,
    },
    compatibility: {
      minBrokerVersion: '1.0.0',
      stateSchema: 1,
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: 'a'.repeat(64),
      pythonFiles: [{ path: 'local-timing/requirements.txt', sha256: 'b'.repeat(64) }],
    },
  } as const;
  const manifest = signDocument(unsigned, signing.privateKey, signing.trust.keyId) as unknown as ReleaseManifest;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const pointer = signDocument({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version,
    manifestUrl,
    manifestSha256: sha256(manifestBytes),
  }, signing.privateKey, signing.trust.keyId);
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
  return { manifest, manifestBytes, manifestUrl, packageBytes, packageUrl, pointerBytes };
}

function fetchFixture(current: () => SignedFixture, packageOverride?: () => Buffer) {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const release = current();
    if (url === 'https://updates.sthang.app/studio/windows/latest.json') {
      return new Response(release.pointerBytes, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(release.pointerBytes.length) },
      });
    }
    if (url === release.manifestUrl) {
      return new Response(release.manifestBytes, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(release.manifestBytes.length) },
      });
    }
    if (url === release.packageUrl) {
      const body = packageOverride ? packageOverride() : release.packageBytes;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/zip', 'content-length': String(body.length) },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function withRoots(run: (roots: { root: string; updateRoot: string; versionsRoot: string }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-update-service-'));
  const updateRoot = path.join(root, 'updates');
  const versionsRoot = path.join(root, 'versions');
  try {
    await run({ root, updateRoot, versionsRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('unprovisioned builds fail closed without contacting an update service', async () => {
  const signing = signingFixture();
  let fetched = false;
  const service = await createUpdateService({
    trustRoot: { ...signing.trust, keyId: 'studio-updates-unprovisioned', publicKeyHex: '', provisioned: false },
    platform: 'win32',
    fetchImpl: (async () => { fetched = true; return new Response(); }) as typeof fetch,
  });
  const status = await service.check('0.7.14');
  assert.equal(status.status, 'disabled');
  assert.equal(fetched, false);
});

test('check, staged download, and final install preparation preserve stable user state', async () => withRoots(async ({ root, updateRoot, versionsRoot }) => {
  const signing = signingFixture();
  let current = releaseFixture(signing);
  const service = await createUpdateService({
    trustRoot: signing.trust,
    platform: 'win32',
    fetchImpl: fetchFixture(() => current),
    installRoot: root,
    updateRoot,
    versionsRoot,
  });
  const stateFiles = [
    ['data/projects/project-1.json', 'project-state'],
    ['data/history/project-1/entry.json', 'history-state'],
    ['data/profile.json', 'correction-memory-state'],
    ['data/jobs.json', 'resumable-job-state'],
    ['data/proposals/proposal-1.json', 'proposal-state'],
    ['data/cache/project-1/cache.json', 'compatible-cache-state'],
    ['uploads/media.mp4', 'media-state'],
    ['exports/result.srt', 'export-state'],
    ['apps/server/.env', 'GEMINI_API_KEY=preserved'],
  ];
  for (const [relative, contents] of stateFiles) {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }

  const first = await service.check('0.7.14');
  assert.equal(first.status, 'available');
  if (first.status !== 'available') return;
  assert.equal(first.offer.downloaded, false);
  await service.download(first.offer.manifestDigest);
  const second = await service.check('0.7.14');
  assert.equal(second.status, 'available');
  if (second.status !== 'available') return;
  assert.equal(second.offer.downloaded, true);
  const prepared = await service.prepareInstall('0.7.14', second.offer.manifestDigest);
  const pending = JSON.parse(await fs.readFile(prepared.pendingFile, 'utf8')) as Record<string, unknown>;
  assert.equal(pending.targetVersion, '0.8.0');
  assert.equal(pending.targetRelativePath, 'versions/0.8.0');
  assert.equal(pending.manifestDigest, sha256(current.manifestBytes));
  for (const [relative, contents] of stateFiles) {
    assert.equal(await fs.readFile(path.join(root, ...relative.split('/')), 'utf8'), contents);
  }
}));

test('a changed latest manifest must be reviewed again before installation', async () => withRoots(async ({ root, updateRoot, versionsRoot }) => {
  const signing = signingFixture();
  let current = releaseFixture(signing, { notes: 'First offer.' });
  const service = await createUpdateService({
    trustRoot: signing.trust,
    platform: 'win32',
    fetchImpl: fetchFixture(() => current),
    installRoot: root,
    updateRoot,
    versionsRoot,
  });
  const status = await service.check('0.7.14');
  assert.equal(status.status, 'available');
  if (status.status !== 'available') return;
  await service.download(status.offer.manifestDigest);
  current = releaseFixture(signing, { version: '0.8.1', notes: 'Replacement offer.' });
  await assert.rejects(
    () => service.prepareInstall('0.7.14', status.offer.manifestDigest),
    (error: unknown) => error instanceof UpdateError && error.code === 'CHANGED',
  );
}));

test('tampered package bytes are rejected before a staging receipt exists', async () => withRoots(async ({ root, updateRoot, versionsRoot }) => {
  const signing = signingFixture();
  const current = releaseFixture(signing);
  const service = await createUpdateService({
    trustRoot: signing.trust,
    platform: 'win32',
    fetchImpl: fetchFixture(() => current, () => Buffer.from('tampered-package')),
    installRoot: root,
    updateRoot,
    versionsRoot,
  });
  const status = await service.check('0.7.14');
  assert.equal(status.status, 'available');
  if (status.status !== 'available') return;
  await assert.rejects(() => service.download(status.offer.manifestDigest), /size|verification/i);
  await assert.rejects(fs.access(path.join(updateRoot, 'staging', '0.8.0', 'receipt.json')));
}));

test('signature tampering and malformed release metadata are rejected', async () => withRoots(async ({ root, updateRoot, versionsRoot }) => {
  const signing = signingFixture();
  const valid = releaseFixture(signing);
  const tampered = {
    ...valid,
    manifestBytes: Buffer.from(`${JSON.stringify({ ...valid.manifest, releaseNotes: 'Tampered after signing.' }, null, 2)}\n`),
  };
  const pointer = signDocument({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: '0.8.0',
    manifestUrl: tampered.manifestUrl,
    manifestSha256: sha256(tampered.manifestBytes),
  }, signing.privateKey, signing.trust.keyId);
  tampered.pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
  const service = await createUpdateService({
    trustRoot: signing.trust,
    platform: 'win32',
    fetchImpl: fetchFixture(() => tampered),
    installRoot: root,
    updateRoot,
    versionsRoot,
  });
  await assert.rejects(
    () => service.check('0.7.14'),
    (error: unknown) => error instanceof UpdateError && error.code === 'SIGNATURE',
  );
}));

test('metadata responses are hard-bounded while streaming even without content-length', async () => {
  const signing = signingFixture();
  const oversized = Buffer.alloc((128 * 1024) + 1, 0x61);
  const service = await createUpdateService({
    trustRoot: signing.trust,
    platform: 'win32',
    fetchImpl: (async () => new Response(oversized, { status: 200 })) as typeof fetch,
  });
  await assert.rejects(
    () => service.check('0.7.14'),
    (error: unknown) => error instanceof UpdateError && error.code === 'INVALID_RELEASE',
  );
});

test('unsafe active caption work produces actionable blockers', () => {
  const reasons = unsafeUpdateReasons({ dirty: true, textEditing: true, reviewMode: true, proposalOpen: true, busy: true, activeJobs: 1 });
  assert.equal(reasons.length, 6);
  assert.match(reasons.join(' '), /Save/);
  assert.match(reasons.join(' '), /Review/);
  assert.match(reasons.join(' '), /processing/);
});

test('browser-facing updater errors redact raw endpoints and local paths', () => {
  const result = publicUpdateError(new UpdateError('DOWNLOAD', 'Failed at https://updates.sthang.app/private C:\\Users\\Creator\\secret.txt', 503));
  assert.equal(result.status, 503);
  assert.doesNotMatch(result.body.error, /https:\/\//i);
  assert.doesNotMatch(result.body.error, /C:\\Users/i);
  assert.match(result.body.error, /\[update service\]|\[local path\]/);
});
