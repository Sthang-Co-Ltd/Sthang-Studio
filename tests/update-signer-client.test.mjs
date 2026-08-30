import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  publicKeyHexFromKey,
  sha256,
  signDocument,
} from '../scripts/update-protocol.mjs';
import {
  authorizeSigningTrigger,
  runReleaseSigning,
  sourceContext,
  validateSignerEndpoint,
  validateUploadUrl,
} from '../scripts/update-signer-client.mjs';

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'Sthang-Co-Ltd/Sthang-Studio',
    GITHUB_REPOSITORY_ID: '1343890712',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'Sthang-Co-Ltd/Sthang-Studio/.github/workflows/studio-ota-sign.yml@refs/heads/main',
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    ...overrides,
  };
}

function releaseFixture(packageBytes, trust) {
  return {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: '0.8.0',
    publishedAt: '2026-08-30T00:00:00.000Z',
    releaseNotes: 'Test signed Studio release.',
    package: {
      url: 'https://updates.sthang.app/studio/windows/v0.8.0/Sthang-Studio-OTA-v0.8.0.zip',
      sha256: sha256(packageBytes),
      sizeBytes: packageBytes.length,
      unpackedSizeBytes: packageBytes.length + 128,
    },
    compatibility: {
      minBrokerVersion: trust.brokerVersion,
      stateSchema: 1,
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: 'b'.repeat(64),
      pythonFiles: [{ path: 'local-timing/requirements.txt', sha256: 'c'.repeat(64) }],
    },
  };
}

async function consumeBody(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('signing triggers allow guarded main workflows and trusted release comments only', () => {
  assert.deepEqual(authorizeSigningTrigger({}, environment()), { eventName: 'workflow_dispatch', issueNumber: null });
  const event = {
    action: 'created',
    issue: { number: 30, state: 'open', title: 'release: bootstrap Studio v0.8.0' },
    comment: { body: '/studio-ota-sign', author_association: 'OWNER' },
  };
  assert.deepEqual(authorizeSigningTrigger(event, environment({ GITHUB_EVENT_NAME: 'issue_comment' })), {
    eventName: 'issue_comment',
    issueNumber: 30,
  });
  assert.throws(
    () => authorizeSigningTrigger({ ...event, comment: { body: '/studio-ota-sign', author_association: 'NONE' } }, environment({ GITHUB_EVENT_NAME: 'issue_comment' })),
    /not an authorized Studio signing request/,
  );
  assert.throws(() => authorizeSigningTrigger({}, environment({ GITHUB_REF: 'refs/heads/feature' })), /accepted main branch/);
});

test('signer and upload endpoints are narrowly constrained', () => {
  assert.equal(validateSignerEndpoint('https://signer.sthang.app/v1/studio'), 'https://signer.sthang.app/v1/studio');
  assert.throws(() => validateSignerEndpoint('https://evil.example/v1/studio'), /not the approved endpoint/);
  assert.equal(
    validateUploadUrl('https://uploads.sthang.app/studio/session/package.zip?token=opaque'),
    'https://uploads.sthang.app/studio/session/package.zip?token=opaque',
  );
  assert.equal(
    validateUploadUrl('https://account.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=opaque'),
    'https://account.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=opaque',
  );
  assert.throws(() => validateUploadUrl('https://example.com/package.zip'), /not allowed/);
});

test('source context pins the accepted repository and exact signing workflow', () => {
  assert.equal(sourceContext(environment()).commit, 'a'.repeat(40));
  assert.throws(
    () => sourceContext(environment({ GITHUB_WORKFLOW_REF: 'Sthang-Co-Ltd/Sthang-Studio/.github/workflows/other.yml@refs/heads/main' })),
    /signing identity is invalid/,
  );
});

test('release signing uploads verified bytes and accepts only a matching trusted response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signer-client-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const trust = {
      schemaVersion: 1,
      product: 'sthang-studio',
      platform: 'windows-x64',
      channel: 'preview',
      endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
      keyId: 'studio-test-2026',
      publicKeyHex: publicKeyHexFromKey(publicKey),
      provisioned: true,
      brokerVersion: '1.0.0',
    };
    const packageBytes = Buffer.from('verified-studio-ota-package', 'utf8');
    const unsignedManifest = releaseFixture(packageBytes, trust);
    const packageFile = path.join(root, 'package.zip');
    const unsignedFile = path.join(root, 'release.unsigned.json');
    const signedFile = path.join(root, 'release.json');
    const receiptFile = path.join(root, 'receipt.json');
    const trustFile = path.join(root, 'trust.json');
    await fs.writeFile(packageFile, packageBytes);
    await fs.writeFile(unsignedFile, `${JSON.stringify(unsignedManifest, null, 2)}\n`);
    await fs.writeFile(trustFile, `${JSON.stringify(trust, null, 2)}\n`);

    let prepareRequest;
    let uploaded = Buffer.alloc(0);
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      if (href === 'https://signer.sthang.app/v1/studio/releases/prepare') {
        assert.equal(init.headers.Authorization, 'Bearer test.oidc.token');
        prepareRequest = JSON.parse(init.body);
        return Response.json({
          schemaVersion: 1,
          product: 'sthang-studio',
          operation: 'release-upload',
          sessionId: 'session_12345678901234567890',
          version: prepareRequest.unsignedManifest.version,
          unsignedManifestSha256: prepareRequest.unsignedManifestSha256,
          packageSha256: prepareRequest.packageSha256,
          packageSizeBytes: prepareRequest.packageSizeBytes,
          uploadUrl: 'https://uploads.sthang.app/studio/session/package.zip?token=opaque',
          uploadHeaders: { 'content-type': 'application/zip', 'if-none-match': '*' },
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
      if (href.startsWith('https://uploads.sthang.app/')) {
        uploaded = await consumeBody(init.body);
        return new Response('', { status: 200 });
      }
      if (href === 'https://signer.sthang.app/v1/studio/releases/finalize') {
        const finalizeRequest = JSON.parse(init.body);
        assert.equal(finalizeRequest.packageSha256, sha256(uploaded));
        const signedManifest = signDocument(prepareRequest.unsignedManifest, privateKey, trust.keyId);
        const signedManifestBytes = Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, 'utf8');
        const manifestSha256 = sha256(signedManifestBytes);
        return Response.json({
          schemaVersion: 1,
          product: 'sthang-studio',
          operation: 'release-finalized',
          sessionId: finalizeRequest.sessionId,
          version: signedManifest.version,
          sourceCommit: prepareRequest.source.commit,
          signedManifestBase64: signedManifestBytes.toString('base64'),
          manifestSha256,
          receipt: {
            schemaVersion: 1,
            product: 'sthang-studio',
            platform: 'windows-x64',
            channel: trust.channel,
            keyId: trust.keyId,
            version: signedManifest.version,
            manifestSha256,
            packageSha256: signedManifest.package.sha256,
            packageSizeBytes: signedManifest.package.sizeBytes,
            verifiedAt: new Date().toISOString(),
          },
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    };

    const result = await runReleaseSigning({
      unsignedManifestFile: unsignedFile,
      packageFile,
      signedManifestFile: signedFile,
      receiptFile,
      trustRootFile: trustFile,
      signerUrl: 'https://signer.sthang.app/v1/studio',
      oidcToken: 'test.oidc.token',
      fetchImpl,
      environment: environment(),
    });
    assert.equal(result.version, '0.8.0');
    assert.deepEqual(uploaded, packageBytes);
    assert.equal(JSON.parse(await fs.readFile(signedFile, 'utf8')).signature.keyId, trust.keyId);
    assert.equal(JSON.parse(await fs.readFile(receiptFile, 'utf8')).packageSha256, sha256(packageBytes));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unprovisioned trust fails before any signing-network request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signer-disabled-'));
  try {
    const trust = {
      schemaVersion: 1,
      product: 'sthang-studio',
      platform: 'windows-x64',
      channel: 'preview',
      endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
      keyId: 'studio-updates-unprovisioned',
      publicKeyHex: '',
      provisioned: false,
      brokerVersion: '1.0.0',
    };
    const packageBytes = Buffer.from('package');
    const unsignedManifest = releaseFixture(packageBytes, trust);
    const packageFile = path.join(root, 'package.zip');
    const unsignedFile = path.join(root, 'release.unsigned.json');
    const trustFile = path.join(root, 'trust.json');
    await fs.writeFile(packageFile, packageBytes);
    await fs.writeFile(unsignedFile, `${JSON.stringify(unsignedManifest)}\n`);
    await fs.writeFile(trustFile, `${JSON.stringify(trust)}\n`);
    let calls = 0;
    await assert.rejects(
      runReleaseSigning({
        unsignedManifestFile: unsignedFile,
        packageFile,
        signedManifestFile: path.join(root, 'signed.json'),
        receiptFile: path.join(root, 'receipt.json'),
        trustRootFile: trustFile,
        signerUrl: 'https://signer.sthang.app/v1/studio',
        oidcToken: 'test.oidc.token',
        fetchImpl: async () => { calls += 1; throw new Error('unexpected'); },
        environment: environment(),
      }),
      /trust root is not provisioned/,
    );
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the signing workflow contains no reusable signing secret and remains manually triggered', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/studio-ota-sign.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: studio-release-signing/);
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event\.comment\.body == '\/studio-ota-sign'/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.doesNotMatch(workflow, /\bpull_request:/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /PRIVATE KEY/);
});
