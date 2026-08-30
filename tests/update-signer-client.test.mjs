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
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'release-owner',
    GITHUB_ACTOR_ID: '12345',
    GITHUB_TRIGGERING_ACTOR: 'release-owner',
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

async function createSigningFixture(root) {
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
  const files = {
    packageFile: path.join(root, 'package.zip'),
    unsignedFile: path.join(root, 'release.unsigned.json'),
    signedFile: path.join(root, 'release.json'),
    attestationFile: path.join(root, 'broker-attestation.json'),
    localReceiptFile: path.join(root, 'local-receipt.json'),
    trustFile: path.join(root, 'trust.json'),
  };
  await fs.writeFile(files.packageFile, packageBytes);
  await fs.writeFile(files.unsignedFile, `${JSON.stringify(unsignedManifest, null, 2)}\n`);
  await fs.writeFile(files.trustFile, `${JSON.stringify(trust, null, 2)}\n`);
  return { privateKey, trust, packageBytes, unsignedManifest, files };
}

function createBrokerFetch({
  privateKey,
  trust,
  mutateManifest = (value) => value,
  mutateAttestation = (value) => value,
}) {
  const state = { prepareRequest: null, uploaded: Buffer.alloc(0), prepareTokens: [], finalizeTokens: [] };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href === 'https://signer.sthang.app/v1/studio/releases/prepare') {
      state.prepareTokens.push(init.headers.Authorization);
      state.prepareRequest = JSON.parse(init.body);
      return Response.json({
        schemaVersion: 1,
        product: 'sthang-studio',
        operation: 'release-upload',
        sessionId: 'session_12345678901234567890',
        version: state.prepareRequest.unsignedManifest.version,
        unsignedManifestSha256: state.prepareRequest.unsignedManifestSha256,
        packageSha256: state.prepareRequest.packageSha256,
        packageSizeBytes: state.prepareRequest.packageSizeBytes,
        uploadUrl: 'https://uploads.sthang.app/v1/studio/sessions/session_12345678901234567890/package?token=opaque',
        uploadHeaders: {
          'content-type': 'application/zip',
          'if-none-match': '*',
          'x-content-sha256': state.prepareRequest.packageSha256,
        },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    }
    if (href.startsWith('https://uploads.sthang.app/')) {
      state.uploaded = await consumeBody(init.body);
      return new Response('', { status: 201 });
    }
    if (href === 'https://signer.sthang.app/v1/studio/releases/finalize') {
      state.finalizeTokens.push(init.headers.Authorization);
      const finalizeRequest = JSON.parse(init.body);
      assert.equal(finalizeRequest.packageSha256, sha256(state.uploaded));
      const manifestToSign = mutateManifest(structuredClone(state.prepareRequest.unsignedManifest));
      const signedManifest = signDocument(manifestToSign, privateKey, trust.keyId);
      const signedManifestBytes = Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, 'utf8');
      const manifestSha256 = sha256(signedManifestBytes);
      const unsignedAttestation = mutateAttestation({
        schemaVersion: 1,
        product: 'sthang-studio',
        platform: 'windows-x64',
        channel: trust.channel,
        operation: 'release-attestation',
        sessionId: finalizeRequest.sessionId,
        source: structuredClone(state.prepareRequest.source),
        version: signedManifest.version,
        unsignedManifestSha256: state.prepareRequest.unsignedManifestSha256,
        manifestSha256,
        packageSha256: signedManifest.package.sha256,
        packageSizeBytes: signedManifest.package.sizeBytes,
        verifiedAt: new Date().toISOString(),
      });
      const attestation = signDocument(unsignedAttestation, privateKey, trust.keyId);
      return Response.json({
        schemaVersion: 1,
        product: 'sthang-studio',
        operation: 'release-finalized',
        sessionId: finalizeRequest.sessionId,
        version: signedManifest.version,
        sourceCommit: state.prepareRequest.source.commit,
        unsignedManifestSha256: state.prepareRequest.unsignedManifestSha256,
        signedManifestBase64: signedManifestBytes.toString('base64'),
        manifestSha256,
        attestation,
      });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };
  return { fetchImpl, state };
}

test('signing triggers allow guarded main workflows and organization release comments only', () => {
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
  for (const authorAssociation of ['COLLABORATOR', 'CONTRIBUTOR', 'NONE']) {
    assert.throws(
      () => authorizeSigningTrigger({ ...event, comment: { body: '/studio-ota-sign', author_association: authorAssociation } }, environment({ GITHUB_EVENT_NAME: 'issue_comment' })),
      /not an authorized Studio signing request/,
    );
  }
  assert.throws(() => authorizeSigningTrigger({}, environment({ GITHUB_REF: 'refs/heads/feature' })), /accepted main branch/);
});

test('signer and upload endpoints are narrowly constrained and uploads are create-only', () => {
  assert.equal(validateSignerEndpoint('https://signer.sthang.app/v1/studio'), 'https://signer.sthang.app/v1/studio');
  assert.throws(() => validateSignerEndpoint('https://evil.example/v1/studio'), /not the approved endpoint/);
  assert.equal(
    validateUploadUrl('https://uploads.sthang.app/v1/studio/sessions/session/package?token=opaque'),
    'https://uploads.sthang.app/v1/studio/sessions/session/package?token=opaque',
  );
  assert.throws(() => validateUploadUrl('https://account.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=opaque'), /not allowed/);
  assert.throws(() => validateUploadUrl('https://example.com/package.zip'), /not allowed/);
});

test('source context pins stable repository, actor, main workflow, workflow SHA, and environment', () => {
  const context = sourceContext(environment());
  assert.equal(context.repositoryId, '1343890712');
  assert.equal(context.repositoryVisibility, 'public');
  assert.equal(context.commit, 'a'.repeat(40));
  assert.equal(context.workflowSha, context.commit);
  assert.equal(context.environment, 'studio-release-signing');
  assert.equal(context.actorId, '12345');
  assert.throws(() => sourceContext(environment({ GITHUB_REPOSITORY_ID: '999' })), /signing identity is invalid/);
  assert.throws(
    () => sourceContext(environment({ GITHUB_WORKFLOW_REF: 'Sthang-Co-Ltd/Sthang-Studio/.github/workflows/other.yml@refs/heads/main' })),
    /signing identity is invalid/,
  );
  assert.throws(() => sourceContext(environment({ GITHUB_WORKFLOW_SHA: 'b'.repeat(40) })), /signing identity is invalid/);
});

test('release signing uploads verified bytes and accepts only matching signed provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signer-client-'));
  try {
    const fixture = await createSigningFixture(root);
    const broker = createBrokerFetch(fixture);
    const result = await runReleaseSigning({
      unsignedManifestFile: fixture.files.unsignedFile,
      packageFile: fixture.files.packageFile,
      signedManifestFile: fixture.files.signedFile,
      brokerAttestationFile: fixture.files.attestationFile,
      localReceiptFile: fixture.files.localReceiptFile,
      trustRootFile: fixture.files.trustFile,
      signerUrl: 'https://signer.sthang.app/v1/studio',
      oidcToken: 'test.oidc.token',
      fetchImpl: broker.fetchImpl,
      environment: environment(),
    });
    assert.equal(result.version, '0.8.0');
    assert.deepEqual(broker.state.uploaded, fixture.packageBytes);
    assert.equal(broker.state.prepareTokens[0], 'Bearer test.oidc.token');
    assert.equal(broker.state.finalizeTokens[0], 'Bearer test.oidc.token');
    assert.match(broker.state.prepareRequest.source.workflowFileSha256, /^[0-9a-f]{64}$/);
    assert.match(broker.state.prepareRequest.source.signerClientSha256, /^[0-9a-f]{64}$/);
    assert.match(broker.state.prepareRequest.source.updateProtocolSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(await fs.readFile(fixture.files.signedFile, 'utf8')).signature.keyId, fixture.trust.keyId);
    assert.equal(JSON.parse(await fs.readFile(fixture.files.attestationFile, 'utf8')).source.commit, 'a'.repeat(40));
    assert.equal(JSON.parse(await fs.readFile(fixture.files.localReceiptFile, 'utf8')).packageSha256, sha256(fixture.packageBytes));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a broker cannot change any reviewed unsigned manifest field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signer-drift-'));
  try {
    const fixture = await createSigningFixture(root);
    const broker = createBrokerFetch({
      ...fixture,
      mutateManifest(value) {
        value.releaseNotes = 'Different notes inserted by the signing service.';
        return value;
      },
    });
    await assert.rejects(
      runReleaseSigning({
        unsignedManifestFile: fixture.files.unsignedFile,
        packageFile: fixture.files.packageFile,
        signedManifestFile: fixture.files.signedFile,
        brokerAttestationFile: fixture.files.attestationFile,
        localReceiptFile: fixture.files.localReceiptFile,
        trustRootFile: fixture.files.trustFile,
        signerUrl: 'https://signer.sthang.app/v1/studio',
        oidcToken: 'test.oidc.token',
        fetchImpl: broker.fetchImpl,
        environment: environment(),
      }),
      /changed the reviewed Studio release manifest/,
    );
    await assert.rejects(fs.access(fixture.files.signedFile));
    await assert.rejects(fs.access(fixture.files.attestationFile));
    await assert.rejects(fs.access(fixture.files.localReceiptFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a signed broker attestation cannot change source or release provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-signer-attestation-'));
  try {
    const fixture = await createSigningFixture(root);
    const broker = createBrokerFetch({
      ...fixture,
      mutateAttestation(value) {
        value.source.commit = 'd'.repeat(40);
        return value;
      },
    });
    await assert.rejects(
      runReleaseSigning({
        unsignedManifestFile: fixture.files.unsignedFile,
        packageFile: fixture.files.packageFile,
        signedManifestFile: fixture.files.signedFile,
        brokerAttestationFile: fixture.files.attestationFile,
        localReceiptFile: fixture.files.localReceiptFile,
        trustRootFile: fixture.files.trustFile,
        signerUrl: 'https://signer.sthang.app/v1/studio',
        oidcToken: 'test.oidc.token',
        fetchImpl: broker.fetchImpl,
        environment: environment(),
      }),
      /attestation did not match this release/,
    );
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
        brokerAttestationFile: path.join(root, 'attestation.json'),
        localReceiptFile: path.join(root, 'receipt.json'),
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

test('the signing workflow isolates OIDC from repository build code', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/studio-ota-sign.yml', import.meta.url), 'utf8');
  assert.match(workflow, /jobs:\n  build:/);
  assert.match(workflow, /\n  sign:\n    needs: build/);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  assert.equal((workflow.match(/environment: studio-release-signing/g) || []).length, 1);
  assert.match(workflow, /group: studio-ota-sign-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /gh api .*collaborators.*permission/);
  assert.match(workflow, /\$Permission -notin @\('admin', 'write'\)/);
  assert.match(workflow, /github\.event\.comment\.body == '\/studio-ota-sign'/);
  assert.match(workflow, /\["OWNER","MEMBER"\]/);
  assert.doesNotMatch(workflow, /COLLABORATOR/);
  assert.doesNotMatch(workflow, /uses:\s+[^\n]+@v\d/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.doesNotMatch(workflow, /\bpull_request:/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /PRIVATE KEY/);

  const signSection = workflow.split('\n  sign:\n')[1];
  assert.ok(signSection, 'sign job is missing');
  assert.doesNotMatch(signSection, /npm ci|npm run|package-ota-release|package-windows-release|setup-local-timing|python -m/);
  assert.match(signSection, /git hash-object/);
  assert.match(signSection, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(signSection, /--broker-attestation/);
  assert.match(signSection, /--local-receipt/);
});
