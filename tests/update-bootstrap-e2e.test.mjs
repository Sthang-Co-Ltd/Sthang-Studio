import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createUpdateService } from '../apps/server/src/updater.ts';
import {
  applyPending,
  readJson,
  recoverInterruptedActivation,
  sha256File,
  writeJsonAtomic,
} from '../scripts/update-runtime.mjs';
import {
  publicKeyHexFromKey,
  sha256,
  signDocument,
} from '../scripts/update-protocol.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousVersion = '0.8.0-test.1';
const targetVersion = '0.8.0-test.2';
const keyId = 'studio-bootstrap-e2e-test';
const previousManifestDigest = '1'.repeat(64);
const previousPackageDigest = '2'.repeat(64);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit code ${result.status}.`,
      result.stdout || '',
      result.stderr || '',
    ].filter(Boolean).join('\n'));
  }
  return result;
}

async function writeText(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, 'utf8');
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyRepositoryFile(relativePath, destinationRoot) {
  const source = path.join(repositoryRoot, relativePath);
  const destination = path.join(destinationRoot, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function fixtureDevSource(version) {
  return `import http from 'node:http';

const version = ${JSON.stringify(version)};
let closing = false;

const api = http.createServer((request, response) => {
  response.setHeader('Connection', 'close');
  if (request.url === '/api/health') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, engineVersion: version }));
    return;
  }
  response.statusCode = 404;
  response.end('Not found');
});

const web = http.createServer((_request, response) => {
  response.setHeader('Connection', 'close');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end('Sthang Studio updater integration fixture');
});

api.listen(8787, '127.0.0.1');
web.listen(5188, '127.0.0.1');

function stop() {
  if (closing) return;
  closing = true;
  let remaining = 2;
  const done = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  api.close(done);
  web.close(done);
  setTimeout(() => process.exit(0), 1_500).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
`;
}

async function createPreparedPreviousVersion(installRoot) {
  const directory = path.join(installRoot, 'versions', previousVersion);
  await writeText(path.join(directory, 'scripts', 'dev.mjs'), fixtureDevSource(previousVersion));
  await writeText(path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc'), '');
  await writeText(path.join(directory, '.venv', 'Scripts', 'python.exe'), '');
  await writeJson(path.join(directory, '.sthang-update-version.json'), {
    schemaVersion: 1,
    version: previousVersion,
    manifestDigest: previousManifestDigest,
    packageSha256: previousPackageDigest,
    preparedAt: new Date().toISOString(),
  });
  return {
    schemaVersion: 1,
    version: previousVersion,
    relativePath: `versions/${previousVersion}`,
    manifestDigest: previousManifestDigest,
    activatedAt: new Date().toISOString(),
  };
}

async function fileList(directory) {
  const output = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) output.push(fullPath);
      else throw new Error(`Fixture contains a non-file archive entry: ${fullPath}`);
    }
  }
  await walk(directory);
  return output.sort();
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function zipDirectory(source, destination) {
  await fs.rm(destination, { force: true });
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(source)},${psQuote(destination)},[IO.Compression.CompressionLevel]::Optimal,$false)`,
  ].join(';');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
}

async function createSyntheticRelease(fixtureRoot, trust, privateKey) {
  const source = path.join(fixtureRoot, 'target-source');
  const archive = path.join(fixtureRoot, `${targetVersion}.zip`);
  const rootPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const rootLock = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const typescript = structuredClone(rootLock.packages['node_modules/typescript']);
  assert.ok(typescript?.version, 'The repository lockfile must contain TypeScript.');

  const packageJson = {
    name: 'sthang-studio-bootstrap-e2e',
    version: targetVersion,
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      build: 'node -e "process.exit(0)"',
    },
    devDependencies: {
      typescript: rootPackage.devDependencies.typescript,
    },
  };
  const packageLock = {
    name: packageJson.name,
    version: targetVersion,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageJson.name,
        version: targetVersion,
        devDependencies: packageJson.devDependencies,
      },
      'node_modules/typescript': typescript,
    },
  };

  await writeJson(path.join(source, 'package.json'), packageJson);
  await writeJson(path.join(source, 'package-lock.json'), packageLock);
  await writeText(path.join(source, 'scripts', 'dev.mjs'), fixtureDevSource(targetVersion));
  await copyRepositoryFile('scripts/update-protocol.mjs', source);
  await writeText(path.join(source, 'apps', 'server', 'src', 'index.ts'), 'export {};\n');
  await writeJson(path.join(source, 'apps', 'web', 'package.json'), {
    name: 'sthang-studio-bootstrap-e2e-web',
    version: targetVersion,
    private: true,
  });
  await writeJson(path.join(source, 'config', 'update-trust-root.json'), trust);
  await writeText(path.join(source, 'local-timing', 'requirements-test.txt'), '# updater integration fixture\n');
  await writeText(path.join(source, 'setup-local-timing-windows.bat'), [
    '@echo off',
    'setlocal',
    'if not exist ".venv\\Scripts" mkdir ".venv\\Scripts"',
    'type nul > ".venv\\Scripts\\python.exe"',
    'exit /b 0',
    '',
  ].join('\r\n'));

  const files = await fileList(source);
  const unpackedSizeBytes = (await Promise.all(files.map(async (file) => (await fs.stat(file)).size)))
    .reduce((total, size) => total + size, 0);
  await zipDirectory(source, archive);

  const pythonFile = path.join(source, 'local-timing', 'requirements-test.txt');
  const unsignedManifest = {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: targetVersion,
    publishedAt: '2026-08-30T00:00:00.000Z',
    releaseNotes: 'Ephemeral signed bootstrap integration fixture. This is not a public release.',
    package: {
      url: `https://updates.sthang.app/studio/windows/v${targetVersion}/package.zip`,
      sha256: await sha256File(archive),
      sizeBytes: (await fs.stat(archive)).size,
      unpackedSizeBytes,
    },
    compatibility: {
      minBrokerVersion: '1.0.0',
      stateSchema: 1,
      manualInstallerRequired: false,
    },
    setup: {
      strategy: 'npm-ci-and-local-timing',
      packageLockSha256: await sha256File(path.join(source, 'package-lock.json')),
      pythonFiles: [{
        path: 'local-timing/requirements-test.txt',
        sha256: await sha256File(pythonFile),
      }],
    },
  };
  const manifest = signDocument(unsignedManifest, privateKey, keyId);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const pointer = signDocument({
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: targetVersion,
    manifestUrl: `https://updates.sthang.app/studio/windows/v${targetVersion}/release.json`,
    manifestSha256: sha256(manifestBytes),
  }, privateKey, keyId);
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  const packageBytes = await fs.readFile(archive);

  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    if (url === trust.endpoint) {
      return new Response(pointerBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(pointerBytes.length),
        },
      });
    }
    if (url === pointer.manifestUrl) {
      return new Response(manifestBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(manifestBytes.length),
        },
      });
    }
    if (url === manifest.package.url) {
      return new Response(packageBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': String(packageBytes.length),
        },
      });
    }
    return new Response('Not found', { status: 404 });
  };

  return {
    fetchImpl,
    manifestDigest: pointer.manifestSha256,
    packageSha256: manifest.package.sha256,
  };
}

function requestHealth(expectedVersion, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get('http://127.0.0.1:8787/api/health', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (response.statusCode === 200 && parsed.ok === true && parsed.engineVersion === expectedVersion) {
              resolve();
              return;
            }
          } catch { /* retry */ }
          schedule();
        });
      });
      request.setTimeout(1_000, () => request.destroy());
      request.on('error', schedule);
    };
    const schedule = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Studio fixture did not report ${expectedVersion} within ${timeoutMs} ms.`));
        return;
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

function stopFixtureProcesses(installRoot) {
  const escaped = installRoot.replaceAll("'", "''");
  const script = [
    `$root='${escaped}'`,
    "$owners=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(8787,5188) } | Select-Object -ExpandProperty OwningProcess -Unique",
    'foreach($owner in $owners){ taskkill.exe /PID $owner /T /F *> $null }',
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0) } | Sort-Object ProcessId -Descending | ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F *> $null }",
  ].join(';');
  spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { stdio: 'ignore', windowsHide: true });
}

async function assertStateUnchanged(state) {
  for (const [file, expected] of state) {
    assert.equal(await fs.readFile(file, 'utf8'), expected, `Stable state changed: ${file}`);
  }
}

test('ephemeral signed bootstrap update preserves state and recovers an interrupted activation', {
  skip: process.platform !== 'win32',
  timeout: 180_000,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-bootstrap-e2e-'));
  const localAppData = path.join(tempRoot, 'LocalAppData');
  const installRoot = path.join(localAppData, 'Sthang Studio', 'app');
  const updateRoot = path.join(installRoot, 'updates');
  const versionsRoot = path.join(installRoot, 'versions');
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalOpenBrowser = process.env.KCS_OPEN_BROWSER;

  try {
    process.env.LOCALAPPDATA = localAppData;
    process.env.KCS_OPEN_BROWSER = 'false';

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const trust = {
      schemaVersion: 1,
      product: 'sthang-studio',
      platform: 'windows-x64',
      channel: 'preview',
      endpoint: 'https://updates.sthang.app/studio/windows/latest.json',
      keyId,
      publicKeyHex: publicKeyHexFromKey(publicKey),
      provisioned: true,
      brokerVersion: '1.0.0',
    };

    for (const relativePath of [
      'scripts/update-runtime.mjs',
      'scripts/update-protocol.mjs',
      'scripts/prepare-studio-update.ps1',
      'scripts/launch-studio.ps1',
      'run-windows.bat',
    ]) {
      await copyRepositoryFile(relativePath, installRoot);
    }
    await writeText(path.join(installRoot, 'scripts', 'ensure-shortcut.ps1'), 'exit 0\n');
    await writeText(path.join(installRoot, '.env.example'), '# updater integration fixture\n');
    await writeJson(path.join(installRoot, 'config', 'update-trust-root.json'), trust);
    await writeText(path.join(installRoot, 'apps', 'server', '.env'), 'GEMINI_API_KEY=\n');

    const stableState = new Map([
      [path.join(installRoot, 'data', 'projects.json'), '{"fixture":"project"}\n'],
      [path.join(installRoot, 'uploads', 'media.marker'), 'media stays local\n'],
      [path.join(installRoot, 'exports', 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,000\nសាកល្បង\n'],
      [path.join(installRoot, 'apps', 'server', '.env'), 'GEMINI_API_KEY=\n'],
      [path.join(localAppData, 'Sthang Studio', 'gemini-key.dpapi'), 'protected-key-fixture\n'],
    ]);
    for (const [file, contents] of stableState) await writeText(file, contents);

    const previousPointer = await createPreparedPreviousVersion(installRoot);
    await writeJsonAtomic(path.join(updateRoot, 'active.json'), previousPointer);

    const previousLaunch = spawn(process.env.ComSpec || 'cmd.exe', [
      '/d', '/c', path.join(installRoot, 'run-windows.bat'),
    ], {
      cwd: installRoot,
      env: { ...process.env, KCS_OPEN_BROWSER: 'false' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    previousLaunch.unref();
    await requestHealth(previousVersion);
    stopFixtureProcesses(installRoot);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const release = await createSyntheticRelease(tempRoot, trust, privateKey);
    const service = await createUpdateService({
      trustRoot: trust,
      fetchImpl: release.fetchImpl,
      platform: 'win32',
      installRoot,
      updateRoot,
      versionsRoot,
    });
    const status = await service.check(previousVersion);
    assert.equal(status.status, 'available');
    assert.equal(status.offer.version, targetVersion);
    assert.equal(status.offer.downloaded, false);
    assert.equal(status.offer.manifestDigest, release.manifestDigest);

    const downloaded = await service.download(release.manifestDigest);
    assert.equal(downloaded.downloaded, true);
    const stagedStatus = await service.check(previousVersion);
    assert.equal(stagedStatus.status, 'available');
    assert.equal(stagedStatus.offer.downloaded, true);

    const prepared = await service.prepareInstall(previousVersion, release.manifestDigest);
    await applyPending(prepared.pendingFile);
    await requestHealth(targetVersion);

    const active = await readJson(path.join(updateRoot, 'active.json'));
    assert.equal(active.version, targetVersion);
    assert.equal(active.relativePath, `versions/${targetVersion}`);
    assert.equal(active.manifestDigest, release.manifestDigest);
    const rollback = await readJson(path.join(updateRoot, 'rollback.json'));
    assert.equal(rollback.previous.version, previousVersion);
    assert.equal(rollback.active.version, targetVersion);
    const preparedMarker = await readJson(path.join(versionsRoot, targetVersion, '.sthang-update-version.json'));
    assert.equal(preparedMarker.version, targetVersion);
    assert.equal(preparedMarker.packageSha256, release.packageSha256);
    await assert.rejects(fs.access(path.join(updateRoot, 'pending-install.json')));
    await assert.rejects(fs.access(path.join(updateRoot, 'transaction.json')));
    await assertStateUnchanged(stableState);

    stopFixtureProcesses(installRoot);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeJsonAtomic(path.join(updateRoot, 'transaction.json'), {
      schemaVersion: 1,
      status: 'activating',
      previous: previousPointer,
      target: {
        version: targetVersion,
        relativePath: `versions/${targetVersion}`,
        manifestDigest: release.manifestDigest,
      },
      startedAt: new Date().toISOString(),
    });
    assert.equal(await recoverInterruptedActivation(installRoot), true);
    const recovered = await readJson(path.join(updateRoot, 'active.json'));
    assert.equal(recovered.version, previousVersion);
    const failure = await readJson(path.join(updateRoot, 'last-failure.json'));
    assert.match(failure.message, /rolled back/i);
    await assert.rejects(fs.access(path.join(updateRoot, 'transaction.json')));

    const recoveredLaunch = spawn(process.env.ComSpec || 'cmd.exe', [
      '/d', '/c', path.join(installRoot, 'run-windows.bat'),
    ], {
      cwd: installRoot,
      env: { ...process.env, KCS_OPEN_BROWSER: 'false' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    recoveredLaunch.unref();
    await requestHealth(previousVersion);
    await assertStateUnchanged(stableState);
  } finally {
    stopFixtureProcesses(installRoot);
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalOpenBrowser === undefined) delete process.env.KCS_OPEN_BROWSER;
    else process.env.KCS_OPEN_BROWSER = originalOpenBrowser;
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
