import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256,
  validateReleaseManifest,
  validateTrustRoot,
} from './update-protocol.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repositoryRoot, 'release-artifacts');
const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version || '');
const commit = String(process.env.GITHUB_SHA || '').trim();
const expectedCommit = /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;

async function fileDigest(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function evidenceFor(name) {
  const file = path.join(outputRoot, name);
  const stat = await fs.stat(file);
  return {
    name,
    sizeBytes: stat.size,
    sha256: await fileDigest(file),
  };
}

const names = [
  `Sthang-Studio-Windows-v${version}.zip`,
  `Sthang-Studio-Windows-v${version}.zip.sha256`,
  `Sthang-Studio-OTA-v${version}.zip`,
  `Sthang-Studio-OTA-v${version}.zip.sha256`,
  `Sthang-Studio-OTA-v${version}.release.unsigned.json`,
];
const artifacts = [];
for (const name of names) artifacts.push(await evidenceFor(name));

const trustValue = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'config', 'update-trust-root.json'), 'utf8'));
const trust = validateTrustRoot(trustValue);
const unsignedManifestFile = path.join(outputRoot, `Sthang-Studio-OTA-v${version}.release.unsigned.json`);
const unsignedManifestBytes = await fs.readFile(unsignedManifestFile);
const unsignedManifest = validateReleaseManifest(
  JSON.parse(unsignedManifestBytes.toString('utf8').replace(/^\uFEFF/, '')),
  trust,
  { verifySignature: false },
);
const otaArtifact = artifacts.find((item) => item.name === `Sthang-Studio-OTA-v${version}.zip`);
if (!otaArtifact || otaArtifact.sha256 !== unsignedManifest.package.sha256 || otaArtifact.sizeBytes !== unsignedManifest.package.sizeBytes) {
  throw new Error('The unsigned OTA candidate does not match its manifest.');
}

const windowsChecksum = (
  await fs.readFile(path.join(outputRoot, `Sthang-Studio-Windows-v${version}.zip.sha256`), 'ascii')
).trim();
const otaChecksum = (
  await fs.readFile(path.join(outputRoot, `Sthang-Studio-OTA-v${version}.zip.sha256`), 'ascii')
).trim();
if (!windowsChecksum.startsWith(`${artifacts[0].sha256}  `)) {
  throw new Error('The ordinary Windows package checksum does not match the candidate bytes.');
}
if (!otaChecksum.startsWith(`${otaArtifact.sha256}  `)) {
  throw new Error('The OTA package checksum does not match the candidate bytes.');
}

const evidence = {
  schemaVersion: 1,
  kind: 'sthang-studio-unsigned-bootstrap-candidate',
  sourceCommit: expectedCommit,
  sourceVersion: version,
  generatedAt: new Date().toISOString(),
  runner: process.env.RUNNER_OS || process.platform,
  signed: false,
  published: false,
  promoted: false,
  releaseEvidence: false,
  trustRootProvisioned: trust.provisioned,
  manifestSha256: sha256(unsignedManifestBytes),
  artifacts,
  warning: 'Temporary CI artifact only. It is unsigned, unpublished, unpromoted, and must not be presented as a Studio release.',
};
await fs.writeFile(
  path.join(outputRoot, 'bootstrap-candidate-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8',
);
console.log(`Unsigned bootstrap candidate evidence recorded for ${expectedCommit || 'local source'} (${version}).`);
