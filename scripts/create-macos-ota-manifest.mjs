import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeReleaseNotes, validateReleaseManifest, validateTrustRoot } from './update-protocol.mjs';

const [
  payloadRootArg,
  packageFileArg,
  outputArg,
  commitArg,
  treeArg,
  unpackedSizeArg,
  releaseNotesArg,
  publishedAtArg,
] = process.argv.slice(2);

if (!payloadRootArg || !packageFileArg || !outputArg || !commitArg || !treeArg || !unpackedSizeArg || !releaseNotesArg || !publishedAtArg) {
  throw new Error('usage: create-macos-ota-manifest.mjs <payload-root> <package.zip> <output.json> <commit> <tree> <unpacked-size> <release-notes> <published-at>');
}

const payloadRoot = path.resolve(payloadRootArg);
const packageFile = path.resolve(packageFileArg);
const output = path.resolve(outputArg);
const commit = String(commitArg).trim().toLowerCase();
const tree = String(treeArg).trim().toLowerCase();
const unpackedSizeBytes = Number(unpackedSizeArg);
const releaseNotesFile = path.resolve(releaseNotesArg);
const publishedAt = String(publishedAtArg).trim();

if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) throw new Error('Exact source commit/tree are required.');
if (!Number.isSafeInteger(unpackedSizeBytes) || unpackedSizeBytes <= 0) throw new Error('The macOS OTA expanded size is invalid.');
if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('The macOS OTA publication timestamp is invalid.');

function bytes(relative) {
  return fs.readFileSync(path.join(payloadRoot, ...relative.split('/')));
}
function json(relative) {
  return JSON.parse(bytes(relative).toString('utf8').replace(/^\uFEFF/u, ''));
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const packageJson = json('package.json');
const version = String(packageJson.version || '');
const trust = validateTrustRoot(json('config/update-trust-root-macos.json'));
const derivedManifestBytes = bytes('.sthang/macos-derived-runtime.json');
const derived = JSON.parse(derivedManifestBytes.toString('utf8'));
const buildEvidenceBytes = bytes('.sthang/macos-release-build.json');
const buildEvidence = JSON.parse(buildEvidenceBytes.toString('utf8'));
if (
  derived.schemaVersion !== 2
  || derived.sourceCommit !== commit
  || derived.sourceTree !== tree
  || derived.packageLockSha256 !== sha256(bytes('package-lock.json'))
  || derived.buildEvidenceSha256 !== sha256(buildEvidenceBytes)
  || buildEvidence.schemaVersion !== 1
  || buildEvidence.packageLockSha256 !== derived.packageLockSha256
) throw new Error('The staged macOS derived-runtime evidence does not match the exact release source.');

const pythonFiles = fs.readdirSync(path.join(payloadRoot, 'local-timing'))
  .filter((name) => /^requirements(?:-[a-z0-9-]+)?\.txt$/u.test(name))
  .sort()
  .map((name) => {
    const relative = `local-timing/${name}`;
    return { path: relative, sha256: sha256(bytes(relative)) };
  });
if (!pythonFiles.length || pythonFiles.length > 8) throw new Error('The macOS Python dependency declaration is invalid.');

const packageBytes = fs.readFileSync(packageFile);
const releaseNotes = sanitizeReleaseNotes(fs.readFileSync(releaseNotesFile, 'utf8'));
const unsigned = {
  schemaVersion: 2,
  product: 'sthang-studio',
  platform: 'macos-arm64',
  channel: trust.channel,
  version,
  publishedAt,
  releaseNotes,
  source: {
    commit,
    tree,
    buildEvidenceSha256: sha256(buildEvidenceBytes),
    derivedRuntimeManifestSha256: sha256(derivedManifestBytes),
  },
  package: {
    url: `https://updates.sthang.app/studio/macos-arm64/v${version}/Sthang-Studio-OTA-macOS-Apple-Silicon-v${version}.zip`,
    sha256: sha256(packageBytes),
    sizeBytes: packageBytes.length,
    unpackedSizeBytes,
  },
  compatibility: {
    minBrokerVersion: '1.0.0',
    stateSchema: 1,
    manualInstallerRequired: false,
    minMacos: '12.3',
    arch: 'arm64',
  },
  setup: {
    strategy: 'macos-curated-runtime',
    packageLockSha256: sha256(bytes('package-lock.json')),
    pythonFiles,
  },
};
const validated = validateReleaseManifest(unsigned, trust, { verifySignature: false });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
console.log(`Unsigned macOS OTA manifest ready for Sthang Studio ${version}: ${output}`);
