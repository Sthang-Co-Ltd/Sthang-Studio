import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { BROKER_DESCRIPTOR, BROKER_PATHS, BROKER_UPDATE_NOTE, validateBrokerDescriptor } from '../scripts/broker-contract.mjs';
import { archiveCrc32, readBrokerArchive } from '../scripts/broker-archive.mjs';
import { brokerSessionNotice, committedBrokerTrust, upgradeActivatedBroker, verifyBrokerPackage } from '../scripts/broker-maintenance.mjs';
import { brokerExportBytes, verifyBrokerSource } from '../scripts/verify-studio-broker.mjs';
import { publicKeyHexFromKey, sha256, signDocument, validateReleaseManifest } from '../scripts/update-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = '0.99.0'; // Synthetic fixture only; never a release artifact.
const buffer = (value) => Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
const launcher = BROKER_PATHS[0];
const pairs = generateKeyPairSync('ed25519');
const trust = {
  schemaVersion: 1, product: 'sthang-studio', platform: 'windows-x64', channel: 'preview',
  endpoint: 'https://updates.sthang.app/studio/windows/latest.json', keyId: 'ephemeral-broker-fixture',
  publicKeyHex: publicKeyHexFromKey(pairs.publicKey), provisioned: true, brokerVersion: '1.0.0',
};
const targetFiles = new Map(await Promise.all(BROKER_PATHS.map(async (relative) => [relative, brokerExportBytes(relative, await fs.readFile(path.join(root, relative)))])));
const actualDescriptor = JSON.parse(await fs.readFile(path.join(root, BROKER_DESCRIPTOR), 'utf8'));
const legacyFiles = new Map(BROKER_PATHS.map((relative) => [relative, buffer(relative.endsWith('.ps1') ? '# synthetic previous broker\r\n' : '// synthetic previous broker\n')]));

// Independent ZIP fixture encoder; the product reader never writes ZIPs.
function zip(entries, deflate = false) {
  const locals = [], central = [];
  let offset = 0;
  for (const [relative, value] of entries) {
    const name = Buffer.from(relative), data = Buffer.from(value);
    const compressed = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0, crc = archiveCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function candidate({ note = BROKER_UPDATE_NOTE, minimum = '1.0.0', editDescriptor, editEntries, deflate = false } = {}) {
  const descriptor = structuredClone(actualDescriptor);
  descriptor.predecessors = [{ brokerVersion: '1.0.0', files: Object.fromEntries([...legacyFiles].map(([p, bytes]) => [p, [sha256(bytes)]])) }];
  editDescriptor?.(descriptor);
  const entries = new Map([...targetFiles, [BROKER_DESCRIPTOR, buffer(descriptor)],
    ['package.json', buffer({ name: 'sthang-studio', version: release })],
    ['package-lock.json', buffer({ name: 'sthang-studio', version: release, lockfileVersion: 3 })],
    ['local-timing/requirements.txt', buffer('# synthetic dependencies\n')]]);
  editEntries?.(entries);
  const packageBytes = zip([...entries], deflate);
  const unsigned = {
    schemaVersion: 1, product: 'sthang-studio', platform: 'windows-x64', channel: 'preview', version: release,
    publishedAt: '2026-09-17T00:00:00Z', releaseNotes: note,
    package: { url: `https://updates.sthang.app/studio/windows/v${release}/package.zip`, sha256: sha256(packageBytes), sizeBytes: packageBytes.length, unpackedSizeBytes: [...entries.values()].reduce((total, bytes) => total + bytes.length, 0) },
    compatibility: { minBrokerVersion: minimum, stateSchema: 1, manualInstallerRequired: false },
    setup: { strategy: 'npm-ci-and-local-timing', packageLockSha256: sha256(entries.get('package-lock.json')), pythonFiles: [{ path: 'local-timing/requirements.txt', sha256: sha256(entries.get('local-timing/requirements.txt')) }] },
  };
  const manifestBytes = buffer(signDocument(unsigned, pairs.privateKey, trust.keyId));
  return { manifestBytes, packageBytes, manifestDigest: sha256(manifestBytes), appVersion: release, trust, descriptor, entries, unsigned };
}
async function put(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
async function fixture(t, options = {}) {
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-broker-test-'));
  t.after(() => fs.rm(installRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const sourceRoot = path.join(installRoot, 'versions', release);
  const c = candidate(options);
  for (const [p, bytes] of legacyFiles) await put(path.join(installRoot, p), bytes);
  const active = { schemaVersion: 1, version: release, relativePath: `versions/${release}`, manifestDigest: c.manifestDigest };
  const marker = { schemaVersion: 1, version: release, manifestDigest: c.manifestDigest, packageSha256: sha256(c.packageBytes) };
  await put(path.join(installRoot, 'updates', 'active.json'), buffer(active));
  await put(path.join(sourceRoot, '.sthang-update-version.json'), buffer(marker));
  await put(path.join(installRoot, 'updates', 'receipts', `${release}.json`), buffer(marker));
  await put(path.join(installRoot, 'updates', 'rollback.json'), buffer({ schemaVersion: 1, previous: null, active }));
  await put(path.join(installRoot, 'updates', 'staging', release, 'release.json'), c.manifestBytes);
  await put(path.join(installRoot, 'updates', 'staging', release, 'package.zip'), c.packageBytes);
  const protectedFiles = ['data/projects.json', 'data/profile.json', 'data/history/fixture.json', 'data/jobs.json', 'data/proposals/fixture.json', 'uploads/fixture.txt', 'exports/captions.srt', 'apps/server/.env', 'config/update-trust-root.json', 'data/secure-key-marker.txt', 'run-windows.bat'];
  for (const p of protectedFiles) await put(path.join(installRoot, p), buffer(`synthetic state: ${p}\n`));
  const protectedBytes = await Promise.all(protectedFiles.map((p) => fs.readFile(path.join(installRoot, p))));
  return { ...c, installRoot, sourceRoot, protectedFiles, protectedBytes, active, marker };
}
async function unchanged(f) {
  assert.equal(await fs.readFile(path.join(f.installRoot, launcher), 'utf8'), legacyFiles.get(launcher).toString());
  for (const [i, p] of f.protectedFiles.entries()) assert.deepEqual(await fs.readFile(path.join(f.installRoot, p)), f.protectedBytes[i], p);
}

test('broker source export identities match the descriptor, independent from the admission floor', async () => {
  assert.deepEqual(await verifyBrokerSource(root), { brokerVersion: '1.0.1', minimumBrokerVersion: '1.0.0' });
  assert.equal(validateBrokerDescriptor(actualDescriptor), actualDescriptor);
  for (const p of BROKER_PATHS) assert.equal(sha256(targetFiles.get(p)), actualDescriptor.files[p].sha256);
});

test('stored and deflated signed packages verify without adding fields rejected by old schema-1 clients', async () => {
  for (const deflate of [false, true]) {
    const c = candidate({ deflate });
    assert.equal((await verifyBrokerPackage(c)).descriptor.brokerVersion, '1.0.1');
    assert.equal(validateReleaseManifest(JSON.parse(c.manifestBytes), trust).compatibility.minBrokerVersion, '1.0.0');
  }
});

test('a future minimum rejects the old broker but admits the repaired broker', async () => {
  const c = candidate({ minimum: '1.0.1' });
  assert.throws(() => validateReleaseManifest(JSON.parse(c.manifestBytes), trust), /newer Studio installer/);
  assert.equal(validateReleaseManifest(JSON.parse(c.manifestBytes), { ...trust, brokerVersion: '1.0.1' }).version, release);
});

test('broker maintenance rejects altered signatures, packages, file lists, and undisclosed changes', async () => {
  const c = candidate();
  const corruptManifest = JSON.parse(c.manifestBytes); corruptManifest.publishedAt = '2026-09-18T00:00:00Z';
  const bytes = buffer(corruptManifest);
  await assert.rejects(verifyBrokerPackage({ ...c, manifestBytes: bytes, manifestDigest: sha256(bytes) }), /signature/);
  const corruptPackage = Buffer.from(c.packageBytes); corruptPackage[40] ^= 1;
  await assert.rejects(verifyBrokerPackage({ ...c, packageBytes: corruptPackage }), /package identity/);
  // Authentication of a package is separate from authorization to replace the broker.
  assert.equal((await verifyBrokerPackage(candidate({ note: 'An ordinary app update.' }))).descriptor.brokerVersion, '1.0.1');
  await assert.rejects(verifyBrokerPackage(candidate({ editDescriptor: (d) => { d.files['apps/server/.env'] = d.files[launcher]; } })), /invalid schema/);
  await assert.rejects(verifyBrokerPackage(candidate({ editEntries: (entries) => { entries.set(launcher, buffer('# modified launcher\n')); } })), /payload file mismatch/);
  await assert.rejects(verifyBrokerPackage(candidate({ editDescriptor: (d) => { d.predecessors[0].brokerVersion = '1.0.2'; } })), /downgrade/);
  await assert.rejects(verifyBrokerPackage(candidate({ editDescriptor: (d) => { d.brokerVersion = '1.0.2'; } })), /version mismatch/);
});

test('signed upgrade replaces only the stable launcher after the complete bundle is staged; retry is idempotent', async (t) => {
  const f = await fixture(t);
  const evidence = ['active.json', 'rollback.json', `receipts/${release}.json`, `staging/${release}/release.json`, `staging/${release}/package.zip`];
  const originalEvidence = await Promise.all(evidence.map((p) => fs.readFile(path.join(f.installRoot, 'updates', p))));
  assert.deepEqual(await upgradeActivatedBroker(f), { status: 'updated', brokerVersion: '1.0.1' });
  const slot = path.join(f.installRoot, 'broker-versions', '1.0.1');
  for (const p of BROKER_PATHS) {
    assert.deepEqual(await fs.readFile(path.join(slot, p)), targetFiles.get(p));
    assert.deepEqual(await fs.readFile(path.join(f.installRoot, p)), p === launcher ? targetFiles.get(p) : legacyFiles.get(p));
  }
  for (const [i, p] of f.protectedFiles.entries()) assert.deepEqual(await fs.readFile(path.join(f.installRoot, p)), f.protectedBytes[i]);
  for (const [i, p] of evidence.entries()) assert.deepEqual(await fs.readFile(path.join(f.installRoot, 'updates', p)), originalEvidence[i]);
  const backups = path.join(f.installRoot, 'updates', 'broker-maintenance', 'backups');
  const dirs = await fs.readdir(backups); assert.equal(dirs.length, 1);
  assert.deepEqual(await fs.readFile(path.join(backups, dirs[0], 'launch-studio.ps1.original')), legacyFiles.get(launcher));
  assert.equal(JSON.parse(await fs.readFile(path.join(backups, dirs[0], 'committed.json'))).brokerVersion, '1.0.1');
  assert.deepEqual(await upgradeActivatedBroker(f), { status: 'current', brokerVersion: '1.0.1' });
  assert.deepEqual(await fs.readdir(backups), dirs);
});

test('preparation receipts alone do not authorize repair; health completion and exact active context are required', async (t) => {
  for (const name of ['transaction.json', 'pending-install.json']) {
    const f = await fixture(t); await put(path.join(f.installRoot, 'updates', name), buffer({}));
    await assert.rejects(upgradeActivatedBroker(f), /not settled/); await unchanged(f);
  }
  const f = await fixture(t); await fs.unlink(path.join(f.installRoot, 'updates', 'rollback.json'));
  await assert.rejects(upgradeActivatedBroker(f)); await unchanged(f);
  const other = await fixture(t);
  assert.deepEqual(await upgradeActivatedBroker({ ...other, sourceRoot: path.join(other.installRoot, 'other-source') }), { status: 'skipped' });
  await unchanged(other);
});

test('unknown installed modifications and same-version slot conflicts fail before the launcher switch', async (t) => {
  const f = await fixture(t); await fs.appendFile(path.join(f.installRoot, BROKER_PATHS[1]), '// local changes');
  await assert.rejects(upgradeActivatedBroker(f), /unrecognized/); await unchanged(f);
  const conflict = await fixture(t);
  await put(path.join(conflict.installRoot, 'broker-versions', '1.0.1', BROKER_DESCRIPTOR), buffer({}));
  await assert.rejects(upgradeActivatedBroker(conflict), /conflicting/); await unchanged(conflict);
});

test('matching launcher bytes do not bypass integrity checks of the installed descriptor', async (t) => {
  const f = await fixture(t); await upgradeActivatedBroker(f);
  await fs.writeFile(path.join(f.installRoot, 'broker-versions', '1.0.1', BROKER_DESCRIPTOR), '{}');
  await assert.rejects(upgradeActivatedBroker(f), /conflicting metadata/);
});

test('hard-linked files and redirected ancestors are never repaired', async (t) => {
  const f = await fixture(t);
  await fs.link(path.join(f.installRoot, launcher), path.join(f.installRoot, 'external-link.ps1'));
  await assert.rejects(upgradeActivatedBroker(f), /Unexpected broker file/);
  const g = await fixture(t);
  const scripts = path.join(g.installRoot, 'scripts'), moved = path.join(g.installRoot, 'redirected-scripts');
  await fs.rename(scripts, moved);
  await fs.symlink(moved, scripts, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(upgradeActivatedBroker(g), /Redirected broker paths/);
});

test('a held or stale maintenance lock is not stolen', async (t) => {
  const f = await fixture(t), lock = path.join(f.installRoot, 'updates', 'broker-maintenance', 'lock');
  await put(lock, 'another-owner');
  await assert.rejects(upgradeActivatedBroker(f), { code: 'EEXIST' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'another-owner'); await unchanged(f);
});

test('concurrent repairs cannot interleave stable broker replacements', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([upgradeActivatedBroker(f), upgradeActivatedBroker(f)]);
  const completed = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(completed.filter((r) => r.status === 'updated').length, 1);
  assert.ok(completed.every((r) => ['updated', 'current'].includes(r.status)));
  assert.deepEqual(await fs.readFile(path.join(f.installRoot, launcher)), targetFiles.get(launcher));
  assert.deepEqual(await upgradeActivatedBroker(f), { status: 'current', brokerVersion: '1.0.1' });
});

test('a write failure before switching leaves the previous broker intact', async (t) => {
  const f = await fixture(t), original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to) === path.join(f.installRoot, launcher)) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
    return original(from, to);
  });
  await assert.rejects(upgradeActivatedBroker(f), /synthetic write failure/); await unchanged(f);
});

test('failure after switching restores the verified previous launcher rather than leaving a partial upgrade', async (t) => {
  const f = await fixture(t), original = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file).endsWith('committed.json')) throw new Error('synthetic audit failure');
    return original(file, ...args);
  });
  await assert.rejects(upgradeActivatedBroker(f), /synthetic audit failure/); await unchanged(f);
});

test('a changed app activation during staging aborts without overwriting the launcher', async (t) => {
  const f = await fixture(t), original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    const result = await original(from, to);
    if (String(to).endsWith(path.join('broker-versions', '1.0.1'))) await put(path.join(f.installRoot, 'updates', 'transaction.json'), buffer({ status: 'activating' }));
    return result;
  });
  await assert.rejects(upgradeActivatedBroker(f), /not settled/); await unchanged(f);
});

test('the new launcher probes both fresh root and selected bundle on native Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-broker-paths-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const name of ['ordinary', 'spaces here', 'spaces & more', '(parentheses)', 'ខ្មែរ']) {
    const install = path.join(temporary, name);
    for (const [p, bytes] of targetFiles) await put(path.join(install, p), bytes);
    await put(path.join(install, BROKER_DESCRIPTOR), buffer(actualDescriptor));
    for (const bundled of [false, true]) {
      if (bundled) {
        for (const [p, bytes] of targetFiles) await put(path.join(install, 'broker-versions', '1.0.1', p), bytes);
        await put(path.join(install, 'broker-versions', '1.0.1', BROKER_DESCRIPTOR), buffer(actualDescriptor));
      }
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(install, launcher), '-BrokerProbe'], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, `${name}/${bundled}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), 'STHANG_STUDIO_BROKER=1.0.1');
    }
  }
});

test('ZIP inspection rejects traversal, duplicate, protected, conflicting and corrupt entries', async () => {
  for (const bad of ['../escape', '/absolute', 'x\\escape', 'x:stream', 'con.txt', 'updates/pointer', 'broker-versions/1.0.1/x', 'data/private', '.env']) {
    await assert.rejects(readBrokerArchive(zip([[bad, buffer('x')]])), /Unsafe/);
  }
  await assert.rejects(readBrokerArchive(zip([['one', buffer('x')], ['ONE', buffer('y')]])), /Duplicate/);
  await assert.rejects(readBrokerArchive(zip([['one', buffer('x')], ['one/two', buffer('y')]])), /Conflicting/);
  const corrupt = zip([['one', buffer('abc')]]); corrupt[33] ^= 1;
  await assert.rejects(readBrokerArchive(corrupt), /integrity/);
  const mismatch = zip([['one', buffer('abc')]]); mismatch.writeUInt16LE(8, 8);
  await assert.rejects(readBrokerArchive(mismatch), /headers/);
  await assert.rejects(readBrokerArchive(Buffer.alloc(22)), /directory/);
});


test('production maintenance pins the committed Studio key rather than accepting the package key', async () => {
  const value = JSON.parse(await fs.readFile(path.join(root, 'config/update-trust-root.json')));
  assert.equal(committedBrokerTrust(value, '1.0.1').brokerVersion, '1.0.1');
  assert.throws(() => committedBrokerTrust({ ...value, publicKeyHex: trust.publicKeyHex }, '1.0.1'), /trust root does not match/);
  assert.throws(() => committedBrokerTrust(value, 'not-a-version'), /invalid/);
});

test('the same immutable broker is reused by a later signed release requiring 1.0.1', async (t) => {
  const f = await fixture(t);
  await upgradeActivatedBroker(f);
  const c = candidate({ minimum: '1.0.1', note: 'An ordinary app update.' });
  const active = { ...f.active, manifestDigest: c.manifestDigest };
  const marker = { ...f.marker, manifestDigest: c.manifestDigest, packageSha256: sha256(c.packageBytes) };
  await put(path.join(f.installRoot, 'updates', 'active.json'), buffer(active));
  await put(path.join(f.sourceRoot, '.sthang-update-version.json'), buffer(marker));
  await put(path.join(f.installRoot, 'updates', 'receipts', `${release}.json`), buffer(marker));
  await put(path.join(f.installRoot, 'updates', 'rollback.json'), buffer({ schemaVersion: 1, active }));
  await put(path.join(f.installRoot, 'updates', 'staging', release, 'release.json'), c.manifestBytes);
  await put(path.join(f.installRoot, 'updates', 'staging', release, 'package.zip'), c.packageBytes);
  assert.deepEqual(await upgradeActivatedBroker({ ...f, trust: { ...trust, brokerVersion: '1.0.1' } }), { status: 'current', brokerVersion: '1.0.1' });
});

test('broker ZIP reader verifies a real git archive with the Windows export EOL rules', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-broker-git-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const c = candidate();
  for (const [relative, bytes] of c.entries) await put(path.join(temporary, relative), bytes);
  await put(path.join(temporary, '.gitattributes'), '*.ps1 text eol=crlf\n*.mjs text eol=lf\n*.json text eol=lf\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (args) => {
    const result = spawnSync('git', ['-c', 'user.name=Broker archive fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(temporary, '.disabled-hooks')}`,
      '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd: temporary, env, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString()); return result.stdout;
  };
  git(['init', '--quiet']); git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic broker source']);
  const packageBytes = git(['archive', '--format=zip', 'HEAD', '--', 'scripts', 'config', 'local-timing', 'package.json', 'package-lock.json']);
  const parsed = await readBrokerArchive(packageBytes);
  for (const [relative, bytes] of c.entries) assert.deepEqual(Buffer.from(parsed.entries.get(relative)), bytes);
  const unsigned = { ...c.unsigned, package: { ...c.unsigned.package, sizeBytes: packageBytes.length, sha256: sha256(packageBytes), unpackedSizeBytes: parsed.totalUnpacked } };
  const manifestBytes = buffer(signDocument(unsigned, pairs.privateKey, trust.keyId));
  assert.equal((await verifyBrokerPackage({ ...c, packageBytes, manifestBytes, manifestDigest: sha256(manifestBytes) })).descriptor.brokerVersion, '1.0.1');
  assert.equal(archiveCrc32(buffer('123456789')), 0xcbf43926);
});

test('broker source verifier refuses undisclosed release staging and an unsupported future minimum', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-broker-policy-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const [relative, bytes] of targetFiles) await put(path.join(temporary, relative), bytes);
  await put(path.join(temporary, BROKER_DESCRIPTOR), buffer(actualDescriptor));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/update-trust-root.json')));
  await put(path.join(temporary, 'config/update-trust-root.json'), buffer(config));
  await put(path.join(temporary, 'package.json'), buffer({ version: release }));
  await put(path.join(temporary, `release-notes/v${release}.txt`), 'Synthetic app release only.\n');
  await assert.rejects(verifyBrokerSource(temporary, { release: true }), /must disclose/);
  await put(path.join(temporary, `release-notes/v${release}.txt`), `${BROKER_UPDATE_NOTE}\n`);
  assert.equal((await verifyBrokerSource(temporary, { release: true })).minimumBrokerVersion, '1.0.0');
  await put(path.join(temporary, 'config/update-trust-root.json'), buffer({ ...config, brokerVersion: '1.0.2' }));
  await assert.rejects(verifyBrokerSource(temporary), /newer than its recovery installer/);
});


test('a still-loaded old launcher cannot take another update after a successful broker switch', () => {
  assert.match(brokerSessionNotice({ status: 'updated', brokerVersion: '1.0.1' }, '1.0.0'), /Restart/);
  assert.match(brokerSessionNotice({ status: 'current', brokerVersion: '1.0.1' }, '1.0.0'), /Restart/);
  assert.match(brokerSessionNotice({ status: 'current', brokerVersion: '1.0.1' }), /Restart/);
  assert.match(brokerSessionNotice({ status: 'deferred' }, '1.0.0'), /current update finish/);
  assert.equal(brokerSessionNotice({ status: 'current', brokerVersion: '1.0.1' }, '1.0.1'), null);
  assert.equal(brokerSessionNotice({ status: 'skipped' }), null);
});


test('an old broker is not changed unless the signed offer disclosed the helper upgrade', async (t) => {
  const f = await fixture(t, { note: 'An ordinary app update.' });
  await assert.rejects(upgradeActivatedBroker(f), /does not authorize/);
  await unchanged(f);
  await assert.rejects(fs.access(path.join(f.installRoot, 'broker-versions')));
});
