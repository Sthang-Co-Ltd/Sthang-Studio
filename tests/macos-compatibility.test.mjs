import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoints = ['INSTALL-MACOS.sh', 'setup-local-timing-macos.sh', 'run-macos.sh'];
const releaseEntrypoints = ['packaging/macos/Install Sthang Studio.command', 'scripts/install-release-package-macos.sh'];
const shell = process.env.STHANG_TEST_BASH || (process.platform === 'win32'
  ? path.resolve(path.dirname(spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]), '../bin/bash.exe')
  : '/bin/bash');

function pythonCommand() {
  const candidates = process.platform === 'win32' ? ['python', 'python3.12', 'python3'] : ['python3.12', 'python3'];
  return candidates.find((candidate) => spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0);
}

function shellPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function fixture(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['bin', 'scripts', 'node_modules', '.venv/bin']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const file of [...entrypoints, 'scripts/macos-common.sh', 'scripts/macos-managed-runtime.sh']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), `#!/usr/bin/env bash\n${text}\n`, { mode: 0o755 });
  write('bin/uname', 'if [[ "$1" == "-s" ]]; then echo "$MOCK_OS"; else echo "$MOCK_ARCH"; fi');
  write('bin/sw_vers', 'printf "%s\\n" "$MOCK_MACOS"');
  write('bin/node', 'echo "$MOCK_NODE_VERSION $MOCK_NODE_ARCH"');
  write('bin/npm', 'printf "npm %s\\n" "$*" >> "$MOCK_LOG"');
  write('bin/brew', 'printf "brew %s\\n" "$*" >> "$MOCK_LOG"; if [[ "$1" == "--prefix" && -n "${MOCK_BREW_PREFIX:-}" ]]; then printf "%s\\n" "$MOCK_BREW_PREFIX"; else exit 1; fi');
  write('bin/ffmpeg', '[[ "$MOCK_FFMPEG" != "broken" ]] || exit 1; if [[ "$*" == *"filter=ass"* && "$MOCK_FFMPEG" == "good" ]]; then echo "shaping: auto simple complex"; elif [[ "$*" == *"-encoders"* ]]; then echo " V..... libx264 H.264"; fi');
  write('bin/ffprobe', '[[ "$MOCK_FFPROBE" == "good" ]]');
  write('bin/file', 'printf "Mach-O 64-bit executable %s\\n" "$MOCK_FILE_ARCH"');
  const python = `if [[ "$1" == "-c" ]]; then
  [[ "$MOCK_PYTHON" == "good" ]]
elif [[ "$1" == "-m" ]]; then
  printf "python %s\\n" "$*" >> "$MOCK_LOG"
else
  printf "verify %s\\n" "$*" >> "$MOCK_LOG"
  if [[ "\${2:-}" == "--ready" ]]; then [[ "$MOCK_READY" == "yes" ]]; fi
fi`;
  write('bin/python3.12', python);
  write('.venv/bin/python', python);
  const env = {
    ...process.env, BASH_ENV: '', MOCK_OS: 'Darwin', MOCK_ARCH: 'arm64', MOCK_MACOS: '12.3',
    MOCK_NODE_VERSION: '22.12.0', MOCK_NODE_ARCH: 'arm64', MOCK_PYTHON: 'good',
    MOCK_FFMPEG: 'good', MOCK_FFPROBE: 'good', MOCK_FILE_ARCH: 'arm64', MOCK_READY: 'yes',
    STHANG_STUDIO_FILE: shellPath(path.join(dir, 'bin/file')),
    MOCK_LOG: path.join(dir, 'calls.log').replaceAll('\\', '/'), ...changes,
  };
  const run = (command) => spawnSync(shell, ['--noprofile', '--norc', '-c', `export PATH="$PWD/bin:$PATH"; ${command}`], {
    cwd: dir, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  return { dir, env, write, run, log: () => fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '' };
}

function cleanFixture(t, changes = {}) {
  const f = fixture(t, changes);
  const stateDir = path.join(f.dir, 'state');
  for (const relative of ['bin/node', 'bin/npm', 'bin/python3.12', 'bin/ffmpeg', 'bin/ffprobe', 'bin/brew', '.venv']) {
    fs.rmSync(path.join(f.dir, relative), { recursive: true, force: true });
  }

  f.write('bin/curl', `output=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$output" && -n "$url" ]] || exit 2
case "$url" in
  *node-v22.23.3-darwin-arm64.tar.gz) payload=node ;;
  *cpython-3.12.14*) payload=python ;;
  *FFmpeg-arm-silicon-Tools-20260424.zip) payload=ffmpeg ;;
  *) exit 3 ;;
esac
printf '%s' "$payload" > "$output"
printf 'download %s\\n' "$url" >> "$MOCK_LOG"`);
  f.write('bin/shasum', `payload="$(cat "${'${3}'}")"
if [[ "${'${MOCK_BAD_SHA:-}'}" == "$payload" ]]; then
  printf '0000000000000000000000000000000000000000000000000000000000000000  %s\\n' "${'${3}'}"
  exit 0
fi
case "$payload" in
  node) sha=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
  python) sha=9763f43db2481a6af36af82ec40302aab7a73632f880129d07a6e81aec846277 ;;
  ffmpeg) sha=7262b3ff400c0e88235647d99ab79067010694f059c4aa8af0bb0c43a951b2fc ;;
  *) exit 4 ;;
esac
printf '%s  %s\\n' "$sha" "${'${3}'}"`);
  f.write('bin/tar', `archive=''
dest=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -xzf) archive="$2"; shift 2 ;;
    -C) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
payload="$(cat "$archive")"
if [[ "$payload" == node ]]; then
  root="$dest/node-v22.23.3-darwin-arm64/bin"
  mkdir -p "$root"
  cat > "$root/node" <<'EOF'
#!/usr/bin/env bash
echo '22.23.3 arm64'
EOF
  cat > "$root/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$MOCK_LOG"
EOF
  chmod +x "$root/node" "$root/npm"
elif [[ "$payload" == python ]]; then
  root="$dest/python/bin"
  mkdir -p "$root"
  cat > "$root/python3.12" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-c" ]]; then
  exit 0
elif [[ "$1" == "-m" && "$2" == "venv" ]]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
elif [[ "$1" == "-m" ]]; then
  printf 'python %s\\n' "$*" >> "$MOCK_LOG"
  exit 0
fi
printf 'verify %s\\n' "$*" >> "$MOCK_LOG"
if [[ "${'${2:-}'}" == "--ready" ]]; then [[ "$MOCK_READY" == yes ]]; fi
EOF
  chmod +x "$root/python3.12"
else
  exit 5
fi`);
  f.write('bin/unzip', `archive=''
dest=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -q) archive="$2"; shift 2 ;;
    -d) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
payload="$(cat "$archive")"
mkdir -p "$dest"
if [[ "$payload" == ffmpeg ]]; then
  mkdir -p "$dest/Tools"
  cat > "$dest/Tools/ffmpeg" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"filter=ass"* ]]; then
  echo 'shaping: auto simple complex'
elif [[ "$*" == *"-encoders"* ]]; then
  echo ' V..... libx264 H.264'
elif [[ "$*" == *"-buildconf"* ]]; then
  echo 'configuration: --enable-gpl --enable-version3 --enable-libass --enable-libharfbuzz --enable-libx264'
fi
EOF
  printf '#!/usr/bin/env bash\\nexit 0\\n' > "$dest/Tools/ffprobe"
  chmod +x "$dest/Tools/ffmpeg" "$dest/Tools/ffprobe"
else
  exit 6
fi`);

  f.env.PATH = '/usr/bin:/bin';
  f.env.STHANG_STUDIO_CURL = shellPath(path.join(f.dir, 'bin/curl'));
  f.env.STHANG_STUDIO_SHASUM = shellPath(path.join(f.dir, 'bin/shasum'));
  f.env.STHANG_STUDIO_TAR = shellPath(path.join(f.dir, 'bin/tar'));
  f.env.STHANG_STUDIO_UNZIP = shellPath(path.join(f.dir, 'bin/unzip'));
  f.env.STHANG_STUDIO_STATE_ROOT = shellPath(stateDir);
  Object.assign(f.env, changes);
  f.managedStateDir = stateDir;
  return f;
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

for (const entry of entrypoints) {
  test(`${entry}: shell syntax`, () => success(spawnSync(shell, ['-n', path.join(root, entry)], { encoding: 'utf8', windowsHide: true })));
  for (const version of ['12.3', '12.7.6', '13.4', '13.5', '14.7', '15.0', '26.0', '27.0']) {
    test(`${entry}: accepts native arm64 macOS ${version}`, (t) => {
      const f = fixture(t, { MOCK_MACOS: version });
      success(f.run(`bash ./${entry}`));
      assert.doesNotMatch(f.log(), /brew install/);
    });
  }
  for (const changes of [
    { MOCK_MACOS: '11.7.10' }, { MOCK_MACOS: '12.0' }, { MOCK_MACOS: '12.2.1' },
    { MOCK_MACOS: '' }, { MOCK_MACOS: '12.broken' },
    { MOCK_MACOS: '12.0 trailing' }, { MOCK_MACOS: '12.0.0.1' },
    { MOCK_ARCH: 'x86_64' }, { MOCK_OS: 'Linux' },
  ]) {
    test(`${entry}: rejects ${JSON.stringify(changes)} before mutations`, (t) => {
      const f = fixture(t, changes);
      const result = f.run(`bash ./${entry}`);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(f.log(), '');
    });
  }
}

for (const entry of releaseEntrypoints) {
  test(`${entry}: shell syntax`, () => success(spawnSync(shell, ['-n', path.join(root, entry)], { encoding: 'utf8', windowsHide: true })));
}

test('tracked macOS shell entrypoints are stored with LF-only line endings', () => {
  for (const entry of [...entrypoints, ...releaseEntrypoints, 'scripts/macos-common.sh', 'scripts/macos-managed-runtime.sh']) {
    const tracked = spawnSync('git', ['show', `HEAD:${entry}`], { cwd: root, windowsHide: true });
    assert.equal(tracked.status, 0, String(tracked.stderr));
    assert.equal(tracked.stdout.includes(13), false, `${entry} contains a tracked carriage-return byte`);
  }
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /\*\.command text eol=lf/);
});

test('macOS release ZIP creation canonicalizes CRLF shell entrypoints to LF', (t) => {
  const python = pythonCommand();
  assert.ok(python, 'Python is required for the macOS package regression.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos package '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packageDir = path.join(dir, 'Sthang Studio test');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'Install Sthang Studio.command'), '#!/usr/bin/env bash\r\necho broken\r\n');
  const output = path.join(dir, 'normalized.zip');
  const result = spawnSync(python, ['-B', path.join(root, 'scripts/create-macos-release-zip.py'), packageDir, output], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  success(result);
  const probe = spawnSync(python, ['-B', '-c', [
    'import pathlib, sys, zipfile',
    'archive = zipfile.ZipFile(sys.argv[1])',
    "name = 'Sthang Studio test/Install Sthang Studio.command'",
    'data = archive.read(name)',
    'mode = (archive.getinfo(name).external_attr >> 16) & 0o777',
    "raise SystemExit(0 if data == b'#!/usr/bin/env bash\\necho broken\\n' and mode == 0o755 else 1)",
  ].join('; '), output], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  success(probe);
});

test('macOS release ZIP creation rejects lone carriage returns before writing an artifact', (t) => {
  const python = pythonCommand();
  assert.ok(python, 'Python is required for the macOS package regression.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos package invalid '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packageDir = path.join(dir, 'Sthang Studio test');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'Install Sthang Studio.command'), '#!/usr/bin/env bash\recho invalid\n');
  const output = path.join(dir, 'invalid.zip');
  fs.writeFileSync(output, 'stale artifact');
  const result = spawnSync(python, ['-B', path.join(root, 'scripts/create-macos-release-zip.py'), packageDir, output], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /unsupported carriage-return byte/);
  assert.equal(fs.existsSync(output), false);
});

for (const [macos, node, arch, accepted] of [
  ['12.3', '22.11.0', 'arm64', false], ['12.3', '22.12.0', 'arm64', true],
  ['12.3', '24.13.0', 'arm64', false], ['13.4.1', '24.13.0', 'arm64', false],
  ['13.5', '24.13.0', 'arm64', true], ['14.0', '22.12.0', 'arm64', true],
  ['15.0', '23.0.0', 'arm64', false], ['15.0', '24.13.0', 'x64', false],
  ['15.0', '24.13.0-beta', 'arm64', false], ['12.3', '', 'arm64', false],
]) {
  test(`Node policy: ${macos} / ${node} / ${arch}`, (t) => {
    const f = fixture(t, { MOCK_MACOS: macos, MOCK_NODE_VERSION: node, MOCK_NODE_ARCH: arch });
    const result = f.run('set -euo pipefail; source scripts/macos-common.sh; studio_macos_host; studio_macos_node_ok node');
    assert.equal(result.status, accepted ? 0 : 1, result.stdout + result.stderr);
  });
}

for (const version of ['12.3', '13.4', '13.5', '14.7', '15.0', '26.0']) {
  test(`clean Apple Silicon macOS ${version} provisions verified private runtimes`, (t) => {
    const f = cleanFixture(t, { MOCK_MACOS: version });
    success(f.run('bash ./INSTALL-MACOS.sh'));
    const firstLog = f.log();
    assert.match(firstLog, /download .*node-v22\.23\.3-darwin-arm64\.tar\.gz/);
    assert.match(firstLog, /download .*cpython-3\.12\.14/);
    assert.match(firstLog, /download .*FFmpeg-arm-silicon-Tools-20260424\.zip/);
    assert.match(firstLog, /npm ci --include=dev/);
    assert.doesNotMatch(firstLog, /brew install|sudo/);

    fs.writeFileSync(path.join(f.dir, 'calls.log'), '');
    success(f.run('bash ./run-macos.sh'));
    const launchLog = f.log();
    assert.match(launchLog, /npm run dev/);
    assert.doesNotMatch(launchLog, /download /);
  });
}

test('managed prerequisite download fails closed on a SHA-256 mismatch', (t) => {
  const f = cleanFixture(t, { MOCK_BAD_SHA: 'node' });
  const result = f.run('bash ./INSTALL-MACOS.sh');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /failed SHA-256 verification/);
  assert.doesNotMatch(f.log(), /npm ci/);
  assert.equal(fs.existsSync(path.join(f.managedStateDir, 'tools/macos-arm64/node-v22.23.3/bin/node')), false);
});

test('managed FFmpeg rejects the wrong executable architecture', (t) => {
  const f = cleanFixture(t, { MOCK_FILE_ARCH: 'x86_64' });
  const result = f.run('bash ./INSTALL-MACOS.sh');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /FFmpeg runtime failed native-arm64/);
  assert.equal(fs.existsSync(path.join(f.managedStateDir, 'tools/macos-arm64/ffmpeg-8.1-20260424/bin/ffmpeg')), false);
});

test('managed runtime pins are fixed and installer never invokes sudo or installs Homebrew', () => {
  const managed = fs.readFileSync(path.join(root, 'scripts/macos-managed-runtime.sh'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'INSTALL-MACOS.sh'), 'utf8');
  assert.match(managed, /node-v22\.23\.3-darwin-arm64\.tar\.gz/);
  assert.match(managed, /23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53/);
  assert.match(managed, /cpython-3\.12\.14\+20260924-aarch64-apple-darwin-install_only\.tar\.gz/);
  assert.match(managed, /9763f43db2481a6af36af82ec40302aab7a73632f880129d07a6e81aec846277/);
  assert.match(managed, /FFmpeg-arm-silicon-Tools-20260424\.zip/);
  assert.match(managed, /7262b3ff400c0e88235647d99ab79067010694f059c4aa8af0bb0c43a951b2fc/);
  assert.doesNotMatch(managed + installer, /\bsudo\b|brew install|releases\/latest/);
});

test('release installer restores the previous app after setup failure and succeeds on retry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos release rollback '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const oldApp = path.join(state, 'app');
  fs.mkdirSync(oldApp, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(oldApp, 'old.txt'), 'previous install');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement install');
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  const installScript = path.join(source, 'INSTALL-MACOS.sh');
  fs.writeFileSync(installScript, '#!/usr/bin/env bash\necho expected setup failure >&2\nexit 1\n', { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: shellPath(home),
    STHANG_STUDIO_STATE_ROOT: shellPath(state),
  };
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const failed = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /Restoring the previous installed application/);
  assert.equal(fs.readFileSync(path.join(oldApp, 'old.txt'), 'utf8'), 'previous install');
  assert.equal(fs.existsSync(path.join(oldApp, 'new.txt')), false);

  fs.writeFileSync(installScript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const retried = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  success(retried);
  assert.equal(fs.readFileSync(path.join(oldApp, 'new.txt'), 'utf8'), 'replacement install');
  assert.equal(fs.existsSync(path.join(oldApp, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(home, 'Applications', 'Sthang Studio.command')), true);
});

test('release installer recovers an interrupted prior swap before retrying setup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos interrupted install '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const installed = path.join(state, 'app');
  const backup = path.join(state, '.manual-install-backup');
  const staleLock = path.join(state, '.manual-install-lock');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(staleLock, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'interrupted-new.txt'), 'incomplete app');
  fs.writeFileSync(path.join(backup, 'old.txt'), 'last known good app');
  fs.writeFileSync(path.join(staleLock, 'pid'), '99999999\n');
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: shellPath(home),
    STHANG_STUDIO_STATE_ROOT: shellPath(state),
  };
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Recovering the previous app from an interrupted installation/);
  assert.equal(fs.readFileSync(path.join(installed, 'old.txt'), 'utf8'), 'last known good app');
  assert.equal(fs.existsSync(path.join(installed, 'interrupted-new.txt')), false);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(staleLock), false);
});

test('an installed keg-only Node 22 is discovered again at launch', (t) => {
  const f = fixture(t, { MOCK_NODE_VERSION: '24.13.0' });
  fs.mkdirSync(path.join(f.dir, 'runtime with spaces/bin'), { recursive: true });
  f.write('runtime with spaces/bin/node', 'echo "22.12.0 arm64"');
  f.write('runtime with spaces/bin/npm', 'echo "used compatible npm"');
  const result = f.run('export MOCK_BREW_PREFIX="$PWD/runtime with spaces"; bash ./run-macos.sh');
  success(result);
  assert.match(result.stdout, /used compatible npm/);
});

for (const entry of entrypoints) {
  test(`${entry}: rejects an incompatible venv without deleting it`, (t) => {
    const f = fixture(t, { MOCK_PYTHON: 'x64-or-wrong-version' });
    const before = fs.readFileSync(path.join(f.dir, '.venv/bin/python'));
    const result = f.run(`bash ./${entry}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Existing files have not been removed/);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, '.venv/bin/python')), before);
    assert.doesNotMatch(f.log(), /npm ci|python -m pip/);
  });
}

for (const changes of [{ MOCK_FFMPEG: 'missing-shaping' }, { MOCK_FFMPEG: 'broken' }, { MOCK_FFPROBE: 'broken' }, { MOCK_FILE_ARCH: 'x86_64' }]) {
  test(`launcher rejects unusable FFmpeg: ${JSON.stringify(changes)}`, (t) => {
    const f = fixture(t, changes);
    assert.equal(f.run('bash ./run-macos.sh').status, 1);
    assert.doesNotMatch(f.log(), /npm run dev/);
  });
}

for (const version of ['12.3', '13.0', '13.5', '14.0']) {
  test(`timing repair on ${version} uses the right profile and no native source builds`, (t) => {
    const f = fixture(t, { MOCK_MACOS: version, MOCK_READY: 'no' });
    success(f.run('bash ./setup-local-timing-macos.sh'));
    const log = f.log();
    assert.match(log, /--only-binary=:all: --no-binary=emoji/);
    assert.match(log, /--no-deps khmercut==0\.0\.2 kfa==0\.2\.0/);
    assert.match(log, /requirements-kfa-macos\.txt -r local-timing\/requirements-whisper\.txt/);
    if (Number(version.split('.')[0]) < 14) assert.match(log, /-c .*constraints-macos-legacy\.txt/);
    else {
      assert.doesNotMatch(log, /constraints-macos-legacy/);
      assert.match(log, /onnxruntime>=1\.20,<2\.0/);
    }
  });
}

test('launcher preserves custom state and environment locations', (t) => {
  const f = fixture(t, { STHANG_STUDIO_STATE_ROOT: '/custom state', STHANG_STUDIO_ENV_FILE: '/custom env' });
  f.write('bin/npm', 'printf "%s|%s\\n" "$STHANG_STUDIO_STATE_ROOT" "$STHANG_STUDIO_ENV_FILE"');
  const result = f.run('bash ./run-macos.sh');
  success(result);
  assert.match(result.stdout, /\/custom state\|\/custom env/);
});

test('manifest and lockfile agree on the Node 22 compatibility floor', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.engines.node, '^22.12.0 || >=24');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /\*\.sh text eol=lf/);
});

test('Python dependency-verifier regressions', () => {
  const python = pythonCommand();
  assert.ok(python, 'Python is required for the local macOS setup regressions.');
  success(spawnSync(python, ['-B', 'tests/macos_timing_check_test.py'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  }));
});
