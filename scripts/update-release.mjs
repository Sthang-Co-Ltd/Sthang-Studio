import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  publicKeyHexFromKey,
  sha256,
  signDocument,
  validateLatestPointer,
  validateReleaseManifest,
  validateReleaseReceipt,
  validateTrustRoot,
} from './update-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (required && (!value || value.startsWith('--'))) throw new Error(`Provide ${name}.`);
  return value || '';
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function hashFile(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function loadTrustRoot() {
  const file = path.join(root, 'config', 'update-trust-root.json');
  return validateTrustRoot(await readJson(file));
}

async function loadPrivateKey() {
  const file = flag('--private-key', { required: false }) || process.env.STHANG_STUDIO_UPDATE_PRIVATE_KEY_FILE || '';
  if (!file) {
    throw new Error('Provide the externally held private-key file. Production private keys must never be stored in this repository.');
  }
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('The production signing key must be held outside the Sthang Studio repository checkout.');
  }
  return crypto.createPrivateKey(await fs.readFile(resolved, 'utf8'));
}

async function assertProvisioned(privateKey) {
  const trust = await loadTrustRoot();
  if (!trust.provisioned) {
    throw new Error('The Studio production update trust root has not been provisioned. Obtain separate approval for signing-key custody, then commit only its public key.');
  }
  const actual = publicKeyHexFromKey(crypto.createPublicKey(privateKey));
  if (actual !== trust.publicKeyHex) throw new Error('The external private key does not match Studio’s committed public trust root.');
  return trust;
}

async function verifyPackage(manifest, packageFile) {
  const stat = await fs.stat(packageFile);
  if (stat.size !== manifest.package.sizeBytes) throw new Error('Release package size verification failed.');
  const packageSha256 = await hashFile(packageFile);
  if (packageSha256 !== manifest.package.sha256) throw new Error('Release package byte verification failed.');
  return { packageSha256, packageSizeBytes: stat.size };
}


async function verifyUnsigned() {
  const manifestFile = path.resolve(flag('--manifest'));
  const packageFile = path.resolve(flag('--package'));
  const trust = await loadTrustRoot();
  const manifest = validateReleaseManifest(await readJson(manifestFile), trust, { verifySignature: false });
  await verifyPackage(manifest, packageFile);
  console.log(`Unsigned Studio OTA candidate verified: ${manifestFile}`);
}

async function signRelease() {
  const input = path.resolve(flag('--input'));
  const output = path.resolve(flag('--output'));
  const privateKey = await loadPrivateKey();
  const trust = await assertProvisioned(privateKey);
  const unsigned = validateReleaseManifest(await readJson(input), trust, { verifySignature: false });
  const signed = signDocument(unsigned, privateKey, trust.keyId);
  validateReleaseManifest(signed, trust);
  await writeJson(output, signed);
  console.log(`Signed Studio release manifest: ${output}`);
}

async function verifyRelease({ writeReceipt = true } = {}) {
  const manifestFile = path.resolve(flag('--manifest'));
  const packageFile = path.resolve(flag('--package'));
  const trust = await loadTrustRoot();
  if (!trust.provisioned) throw new Error('The Studio production update trust root is not provisioned.');
  const manifestBytes = await fs.readFile(manifestFile);
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')), trust);
  const packageEvidence = await verifyPackage(manifest, packageFile);
  const evidence = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    keyId: trust.keyId,
    version: manifest.version,
    manifestSha256: sha256(manifestBytes),
    ...packageEvidence,
    verifiedAt: new Date().toISOString(),
  };
  if (writeReceipt) {
    const receiptFile = path.resolve(flag('--receipt'));
    await writeJson(receiptFile, evidence);
    console.log(`Verified Studio release receipt: ${receiptFile}`);
  }
  return { trust, manifest, manifestBytes, packageFile, evidence };
}

async function promote() {
  const manifestFile = path.resolve(flag('--manifest'));
  const packageFile = path.resolve(flag('--package'));
  const receiptFile = path.resolve(flag('--receipt'));
  const output = path.resolve(flag('--output'));
  const privateKey = await loadPrivateKey();
  const trust = await assertProvisioned(privateKey);
  const manifestBytes = await fs.readFile(manifestFile);
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')), trust);
  const packageEvidence = await verifyPackage(manifest, packageFile);
  const receipt = validateReleaseReceipt(await readJson(receiptFile), trust);
  const expectedManifestSha256 = sha256(manifestBytes);
  if (
    receipt.version !== manifest.version
    || receipt.manifestSha256 !== expectedManifestSha256
    || receipt.packageSha256 !== packageEvidence.packageSha256
    || receipt.packageSizeBytes !== packageEvidence.packageSizeBytes
  ) {
    throw new Error('The latest pointer may advance only from a matching verified release receipt and package.');
  }
  if (compareVersions(manifest.version, '0.0.0') <= 0) throw new Error('The release version is invalid.');

  const currentLatestFile = flag('--current-latest', { required: false });
  const initialPromotion = hasFlag('--initial');
  if (Boolean(currentLatestFile) === initialPromotion) {
    throw new Error('Promote with exactly one of --current-latest <signed-latest.json> or --initial.');
  }
  if (currentLatestFile) {
    const current = validateLatestPointer(await readJson(path.resolve(currentLatestFile)), trust);
    if (compareVersions(manifest.version, current.version) <= 0) {
      throw new Error('The mutable latest pointer may only advance to a newer verified version.');
    }
  }
  const unsignedPointer = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: trust.channel,
    version: manifest.version,
    manifestUrl: `https://updates.sthang.app/studio/windows/v${manifest.version}/release.json`,
    manifestSha256: expectedManifestSha256,
  };
  const pointer = signDocument(unsignedPointer, privateKey, trust.keyId);
  validateLatestPointer(pointer, trust);
  await writeJson(output, pointer);
  console.log(`Promotable latest pointer: ${output}`);
  console.log('No object was uploaded or deployed.');
}

const command = process.argv[2];
if (command === 'verify-unsigned') await verifyUnsigned();
else if (command === 'sign-release') await signRelease();
else if (command === 'verify-release') await verifyRelease();
else if (command === 'promote') await promote();
else throw new Error('Use verify-unsigned, sign-release, verify-release, or promote.');
