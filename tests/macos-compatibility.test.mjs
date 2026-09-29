import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

function releaseInstallerEnv(dir, home, state, changes = {}) {
  const shlock = path.join(dir, 'mock-shlock');
  fs.writeFileSync(shlock, `#!/usr/bin/env bash
set -euo pipefail
lock_file=''
pid=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) lock_file="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$lock_file" && -n "$pid" ]] || exit 2
if [[ "${'${MOCK_SHLOCK_DENY:-}'}" == 1 ]]; then exit 1; fi
if [[ -f "$lock_file" ]]; then
  prior="$(cat "$lock_file" 2>/dev/null || true)"
  if [[ "$prior" != 99999999 ]]; then exit 1; fi
  rm -f -- "$lock_file"
fi
printf '%s\\n' "$pid" > "$lock_file"
`, { mode: 0o755 });
  const sips = path.join(dir, 'mock-sips');
  fs.writeFileSync(sips, `#!/usr/bin/env bash
set -e
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--out" ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]] || exit 2
mkdir -p "$(dirname "$out")"
printf 'png' > "$out"
`, { mode: 0o755 });
  const iconutil = path.join(dir, 'mock-iconutil');
  fs.writeFileSync(iconutil, `#!/usr/bin/env bash
set -e
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]] || exit 2
printf 'icns' > "$out"
`, { mode: 0o755 });
  const plutil = path.join(dir, 'mock-plutil');
  fs.writeFileSync(plutil, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return {
    ...process.env,
    HOME: shellPath(home),
    STHANG_STUDIO_STATE_ROOT: shellPath(state),
    STHANG_STUDIO_SHLOCK: shellPath(shlock),
    STHANG_STUDIO_SIPS: shellPath(sips),
    STHANG_STUDIO_ICONUTIL: shellPath(iconutil),
    STHANG_STUDIO_PLUTIL: shellPath(plutil),
    ...changes,
  };
}

function completeReleaseSource(source) {
  fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'apps/web/public/brand'), { recursive: true });
  if (!fs.existsSync(path.join(source, 'config/update-trust-root-macos.json'))) {
    fs.writeFileSync(path.join(source, 'config/update-trust-root-macos.json'), '{}\n');
  }
  for (const name of ['launch-studio-macos.sh', 'prepare-studio-update-macos.sh']) {
    const file = path.join(source, 'scripts', name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  const preparePython = path.join(source, 'scripts/prepare-studio-update-macos.py');
  if (!fs.existsSync(preparePython)) fs.writeFileSync(preparePython, '# fixture\n');
  fs.writeFileSync(path.join(source, 'apps/web/public/brand/sthang-studio-icon.png'), 'fixture icon');
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
  write('bin/node', 'if [[ "$1" == "-p" ]]; then echo "$MOCK_NODE_VERSION $MOCK_NODE_ARCH"; else printf "node %s\\n" "$*" >> "$MOCK_LOG"; fi');
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
  const run = (command, timeout = 90_000) => spawnSync(shell, ['--noprofile', '--norc', '-c', `export PATH="$PWD/bin:$PATH"; ${command}`], {
    cwd: dir, env, encoding: 'utf8', timeout, windowsHide: true,
  });
  return { dir, env, write, run, log: () => fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '' };
}

function markCuratedRuntime(f) {
  for (const relative of ['.sthang', 'apps/server/dist', 'apps/web/dist', 'packages/shared/dist']) {
    fs.mkdirSync(path.join(f.dir, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(f.dir, '.sthang/macos-curated-runtime'), 'production-runtime-v1\n');
  fs.writeFileSync(path.join(f.dir, 'apps/server/dist/index.js'), 'console.log("server")\n');
  fs.writeFileSync(path.join(f.dir, 'apps/web/dist/index.html'), '<div id="root"></div>\n');
  fs.writeFileSync(path.join(f.dir, 'packages/shared/dist/index.js'), 'export {}\n');
  fs.writeFileSync(path.join(f.dir, 'scripts/dev.mjs'), '// packaged runtime launcher fixture\n');
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
    'info = archive.getinfo(name)',
    'mode = (info.external_attr >> 16) & 0o777',
    "raise SystemExit(0 if data == b'#!/usr/bin/env bash\\necho broken\\n' and mode == 0o755 and info.date_time == (1980, 1, 1, 0, 0, 0) else 1)",
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

test('macOS OTA extraction rejects traversal, protected state, symlinks, case collisions, and signed-size drift', (t) => {
  const python = pythonCommand();
  assert.ok(python, 'Python is required for the macOS OTA extraction regression.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos ota extractor '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = String.raw`
import importlib.util, io, pathlib, stat, sys, tempfile, zipfile
spec = importlib.util.spec_from_file_location("prep", sys.argv[1])
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)

def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as z:
        for item in entries:
            if isinstance(item, tuple):
                name, data = item
                z.writestr(name, data)
            else:
                z.writestr(item, b"x")
    stream.seek(0)
    return stream

def reject(stream, size):
    destination = pathlib.Path(tempfile.mkdtemp(dir=sys.argv[2]))
    try:
        try:
            prep.safe_extract_opened(stream, destination, size)
        except RuntimeError:
            return
        raise AssertionError("unsafe archive was accepted")
    finally:
        import shutil
        shutil.rmtree(destination, ignore_errors=True)

reject(archive([("../escape.txt", b"x")]), 1)
reject(archive([("node_modules/evil.js", b"x")]), 1)
reject(archive([("Apps/File.txt", b"a"), ("apps/file.txt", b"b")]), 2)

stream = io.BytesIO()
with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as z:
    info = zipfile.ZipInfo("link")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    z.writestr(info, b"target")
stream.seek(0)
reject(stream, 6)

reject(archive([("safe.txt", b"abc")]), 4)
`;
  const result = spawnSync(python, ['-c', code, path.join(root, 'scripts/prepare-studio-update-macos.py'), dir], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  success(result);
});

test('macOS OTA ZIP creator is rootless, preserves shell executability, and rejects protected state', (t) => {
  const python = pythonCommand();
  assert.ok(python, 'Python is required for the macOS OTA package regression.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos ota zip '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payload, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'run-macos.sh'), '#!/usr/bin/env bash\r\necho ok\r\n');
  fs.writeFileSync(path.join(payload, 'scripts/file.txt'), 'payload');
  const output = path.join(dir, 'ota.zip');
  success(spawnSync(python, [path.join(root, 'scripts/create-macos-ota-zip.py'), payload, output], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  }));
  const probe = spawnSync(python, ['-c', [
    'import sys,zipfile',
    'z=zipfile.ZipFile(sys.argv[1])',
    'names=z.namelist()',
    'info=z.getinfo("run-macos.sh")',
    'data=z.read("run-macos.sh")',
    'mode=(info.external_attr>>16)&0o777',
    'raise SystemExit(0 if names==["run-macos.sh","scripts/file.txt"] and data==b"#!/usr/bin/env bash\\necho ok\\n" and mode==0o755 else 1)',
  ].join('; '), output], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  success(probe);

  const firstHash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  const changedTime = new Date('2026-09-29T12:34:56Z');
  fs.utimesSync(path.join(payload, 'run-macos.sh'), changedTime, changedTime);
  fs.utimesSync(path.join(payload, 'scripts/file.txt'), new Date('2025-01-02T03:04:05Z'), new Date('2025-01-02T03:04:05Z'));
  success(spawnSync(python, [path.join(root, 'scripts/create-macos-ota-zip.py'), payload, output], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  }));
  const secondHash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  assert.equal(secondHash, firstHash, 'macOS OTA ZIP bytes must not depend on source mtimes');

  fs.mkdirSync(path.join(payload, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'node_modules/evil.js'), 'evil');
  fs.writeFileSync(output, 'stale');
  const rejected = spawnSync(python, [path.join(root, 'scripts/create-macos-ota-zip.py'), payload, output], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.equal(fs.existsSync(output), false);
});

test('macOS release packager builds derived output from an isolated captured commit projection', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/package-macos-release.ps1'), 'utf8');
  assert.match(script, /git -c core\.autocrlf=false -c core\.eol=lf archive --format=zip "--output=\$BuildArchive" \$Commit/);
  assert.match(script, /npm\.cmd ci --include=dev --ignore-scripts=false --no-audit --no-fund/);
  assert.match(script, /Push-Location \$BuildRoot/);
  assert.match(script, /\$SourceBuild = Join-Path \$BuildRoot \$BuildOutput/);
  assert.match(script, /git -c core\.autocrlf=false -c core\.eol=lf archive --format=zip "--output=\$PayloadZip" \$Commit -- @PayloadPaths/);
  assert.doesNotMatch(script, /\$SourceBuild = Join-Path \$Root \$BuildOutput/);
  assert.match(script, /\$BuildPackageLockShaAfterBuild -ne \$BuildPackageLockSha/);
  assert.match(script, /\$PayloadPackageLockSha -ne \$BuildPackageLockSha/);
  assert.match(script, /ComputeHash\(\$DerivedStream\)/);
  assert.match(script, /Packaged package-lock\.json hash does not match the derived-runtime manifest/);
});

test('macOS derived-runtime verifier binds output to commit, tree, and exact package lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos derived runtime '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const relative of ['apps/server/dist', 'apps/web/dist', 'packages/shared/dist', '.sthang']) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'apps/server/dist/index.js'), 'console.log("server")\n');
  fs.writeFileSync(path.join(dir, 'apps/web/dist/index.html'), '<div id="root"></div>\n');
  fs.writeFileSync(path.join(dir, 'packages/shared/dist/index.js'), 'export {}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const lockSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');
  const evidenceFiles = [
    'apps/server/dist/index.js',
    'apps/web/dist/index.html',
    'packages/shared/dist/index.js',
  ].map((relative) => {
    const bytes = fs.readFileSync(path.join(dir, relative));
    return { path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(dir, '.sthang/macos-release-build.json'), `${JSON.stringify({
    schemaVersion: 1,
    packageLockSha256: lockSha,
    files: evidenceFiles,
  }, null, 2)}\n`);
  const commit = '1'.repeat(40);
  const tree = '2'.repeat(40);
  const manifest = path.join(dir, '.sthang/macos-derived-runtime.json');
  const verifier = path.join(root, 'scripts/verify-macos-derived-runtime.mjs');
  const result = spawnSync(process.execPath, [verifier, dir, manifest, commit, lockSha, tree], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  success(result);
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.sourceCommit, commit);
  assert.equal(parsed.sourceTree, tree);
  assert.equal(parsed.packageLockSha256, lockSha);
  assert.equal(parsed.buildEvidenceSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, '.sthang/macos-release-build.json'))).digest('hex'));
  assert.equal(parsed.files.length, 3);
  assert.deepEqual(parsed.files.map((entry) => entry.path), [
    'apps/server/dist/index.js',
    'apps/web/dist/index.html',
    'packages/shared/dist/index.js',
  ]);

  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  const mismatch = spawnSync(process.execPath, [verifier, dir, manifest, commit, lockSha, tree], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
  assert.match(mismatch.stderr, /does not match the clean release-build lock/);
});

test('production build rejects ambient VITE variables before build tooling runs', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], {
    cwd: root,
    env: { ...process.env, VITE_RELEASE_SENTINEL: 'must-not-enter-release-output' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Refusing to build with ambient VITE_\* variables/);
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
    success(f.run('bash ./INSTALL-MACOS.sh', 180_000));
    const firstLog = f.log();
    assert.match(firstLog, /download .*node-v22\.23\.3-darwin-arm64\.tar\.gz/);
    assert.match(firstLog, /download .*cpython-3\.12\.14/);
    assert.match(firstLog, /download .*FFmpeg-arm-silicon-Tools-20260424\.zip/);
    assert.match(firstLog, /npm ci --include=dev/);
    assert.doesNotMatch(firstLog, /brew install|sudo/);

    fs.writeFileSync(path.join(f.dir, 'calls.log'), '');
    success(f.run('bash ./run-macos.sh', 180_000));
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

test('curated macOS install omits development dependencies and launches the production runtime', (t) => {
  const f = fixture(t);
  markCuratedRuntime(f);
  success(f.run('bash ./INSTALL-MACOS.sh'));
  assert.match(f.log(), /npm ci --omit=dev --ignore-scripts --workspace @kcs\/server --workspace @kcs\/shared --include-workspace-root/);
  assert.doesNotMatch(f.log(), /npm ci --include=dev/);

  fs.writeFileSync(path.join(f.dir, 'calls.log'), '');
  success(f.run('bash ./run-macos.sh'));
  assert.match(f.log(), /node .*scripts\/dev\.mjs --production/);
  assert.doesNotMatch(f.log(), /npm run dev/);
});

test('stable macOS broker child launches the curated baseline instead of recursively re-entering the broker', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos broker child '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  const app = path.join(state, 'app');
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  for (const relative of [
    'scripts',
    '.sthang',
    'node_modules',
    '.venv/bin',
    'apps/server/dist',
    'apps/web/dist',
    'packages/shared/dist',
  ]) fs.mkdirSync(path.join(app, relative), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(root, 'run-macos.sh'), path.join(app, 'run-macos.sh'));
  fs.writeFileSync(path.join(app, '.sthang/macos-curated-runtime'), 'production-runtime-v1\n');
  fs.writeFileSync(path.join(app, 'apps/server/dist/index.js'), 'server\n');
  fs.writeFileSync(path.join(app, 'apps/web/dist/index.html'), '<div id="root"></div>\n');
  fs.writeFileSync(path.join(app, 'packages/shared/dist/index.js'), 'shared\n');
  fs.writeFileSync(path.join(app, 'scripts/dev.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(app, 'scripts/launch-studio-macos.sh'), `#!/usr/bin/env bash\necho recursive-broker-called >> "${shellPath(log)}"\nexit 91\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'scripts/macos-common.sh'), `#!/usr/bin/env bash\nstudio_macos_host() { :; }\nstudio_macos_select_node() { :; }\nstudio_macos_select_ffmpeg() { :; }\nstudio_macos_require_venv() { :; }\n`);
  fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nprintf 'node %s\\n' "$*" >> "${shellPath(log)}"\n`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${shellPath(bin)}:${process.env.PATH || ''}`,
    STHANG_STUDIO_STATE_ROOT: shellPath(state),
    STHANG_STUDIO_BROKER_CHILD: '1',
  };
  const result = spawnSync(shell, [shellPath(path.join(app, 'run-macos.sh'))], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  success(result);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /node .*scripts\/dev\.mjs --production/);
  assert.doesNotMatch(calls, /recursive-broker-called/);
});

test('source macOS setup retains development dependency workflow', (t) => {
  const f = fixture(t);
  success(f.run('bash ./INSTALL-MACOS.sh'));
  assert.match(f.log(), /npm ci --include=dev/);
  assert.doesNotMatch(f.log(), /npm ci --omit=dev/);
});

test('curated macOS setup rejects a missing production build before npm install', (t) => {
  const f = fixture(t);
  markCuratedRuntime(f);
  fs.rmSync(path.join(f.dir, 'apps/web/dist/index.html'));
  const result = f.run('bash ./INSTALL-MACOS.sh');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /curated macOS package is missing a production build artifact/);
  assert.doesNotMatch(f.log(), /npm ci/);
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
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
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
  assert.equal(fs.existsSync(path.join(home, 'Applications', 'Sthang Studio.app', 'Contents', 'Info.plist')), true);
  assert.equal(fs.readFileSync(path.join(home, 'Applications', 'Sthang Studio.app', 'Contents', 'Resources', 'SthangStudio.icns'), 'utf8'), 'icns');
  assert.match(fs.readFileSync(path.join(home, 'Applications', 'Sthang Studio.app', 'Contents', 'MacOS', 'Sthang Studio'), 'utf8'), /open -a Terminal/);
  const plist = fs.readFileSync(path.join(home, 'Applications', 'Sthang Studio.app', 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>LSArchitecturePriority<\/key>[\s\S]*<string>arm64<\/string>/);
  assert.doesNotMatch(plist, /LSRequiresNativeExecution/);
});

test('release launcher remembers a custom installation state root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos custom release root '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'custom state root');
  const source = path.join(dir, 'package files');
  const marker = path.join(home, 'launched.txt');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), `#!/usr/bin/env bash\nprintf '%s' "$STHANG_STUDIO_STATE_ROOT" > "$HOME/launched.txt"\n`, { mode: 0o755 });
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  success(spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true }));

  const launcher = path.join(home, 'Applications', 'Sthang Studio.command');
  const launchEnv = { ...process.env, HOME: shellPath(home) };
  success(spawnSync(shell, [shellPath(launcher)], { env: launchEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true }));
  assert.equal(fs.readFileSync(marker, 'utf8'), shellPath(state));
  assert.match(fs.readFileSync(launcher, 'utf8'), /DEFAULT_STATE_ROOT=/);
  assert.equal(fs.existsSync(path.join(home, 'Applications', 'Sthang Studio.app', 'Contents', 'Info.plist')), true);
});

test('manual macOS recovery install transactionally returns launch authority to the new baseline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos manual resets ota '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const installed = path.join(state, 'app');
  const updates = path.join(state, 'updates');
  const versionDir = path.join(state, 'versions', '0.85.6');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(updates, { recursive: true });
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'old.txt'), 'old baseline');
  fs.writeFileSync(path.join(versionDir, 'preserved.txt'), 'immutable ota version');
  for (const name of ['active.json', 'transaction.json', 'pending-install.json', 'rollback.json', 'last-failure.json', 'high-water.json']) {
    fs.writeFileSync(path.join(updates, name), `{"name":"${name}"}\n`);
  }
  fs.writeFileSync(path.join(source, 'new.txt'), 'new baseline');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  success(spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true }));
  assert.equal(fs.readFileSync(path.join(installed, 'new.txt'), 'utf8'), 'new baseline');
  for (const name of ['active.json', 'transaction.json', 'pending-install.json', 'rollback.json', 'last-failure.json', 'high-water.json']) {
    assert.equal(fs.existsSync(path.join(updates, name)), false, `${name} should be reset by manual recovery install`);
  }
  assert.equal(fs.readFileSync(path.join(versionDir, 'preserved.txt'), 'utf8'), 'immutable ota version');
  assert.equal(fs.existsSync(path.join(state, '.manual-update-control-backup')), false);
});

test('release installer preserves prior app and launchers when Finder bundle generation fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos finder bundle rollback '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const applications = path.join(home, 'Applications');
  const installed = path.join(state, 'app');
  const launcher = path.join(applications, 'Sthang Studio.command');
  const appBundle = path.join(applications, 'Sthang Studio.app');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(path.join(appBundle, 'Contents'), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'old.txt'), 'previous install');
  fs.writeFileSync(launcher, 'previous launcher\n');
  fs.writeFileSync(path.join(appBundle, 'Contents', 'old.txt'), 'previous app bundle');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement install');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  const failingIconutil = path.join(dir, 'failing-iconutil');
  fs.writeFileSync(failingIconutil, '#!/usr/bin/env bash\nexit 9\n', { mode: 0o755 });
  const env = releaseInstallerEnv(dir, home, state, { STHANG_STUDIO_ICONUTIL: shellPath(failingIconutil) });
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(installed, 'old.txt'), 'utf8'), 'previous install');
  assert.equal(fs.existsSync(path.join(installed, 'new.txt')), false);
  assert.equal(fs.readFileSync(launcher, 'utf8'), 'previous launcher\n');
  assert.equal(fs.readFileSync(path.join(appBundle, 'Contents', 'old.txt'), 'utf8'), 'previous app bundle');
  assert.equal(fs.existsSync(path.join(state, '.manual-install-backup')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install.lock')), false);
});

test('release installer restores the prior command if app-bundle backup fails mid-publication', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos launcher backup rollback '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const applications = path.join(home, 'Applications');
  const installed = path.join(state, 'app');
  const launcher = path.join(applications, 'Sthang Studio.command');
  const appBundle = path.join(applications, 'Sthang Studio.app');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(path.join(appBundle, 'Contents'), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'old.txt'), 'previous install');
  fs.writeFileSync(launcher, 'previous launcher\n');
  fs.writeFileSync(path.join(appBundle, 'Contents', 'old.txt'), 'previous app bundle');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement install');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);

  const bin = path.join(dir, 'failing-mv-bin');
  fs.mkdirSync(bin, { recursive: true });
  const failingMv = path.join(bin, 'mv');
  fs.writeFileSync(failingMv, '#!/usr/bin/env bash\nset -e\ndest="${@: -1}"\nif [[ "$dest" == *\'.Sthang Studio.app.backup\' ]]; then\n  exit 17\nfi\nexec /usr/bin/mv "$@"\n', { mode: 0o755 });
  const env = releaseInstallerEnv(dir, home, state, {
    STHANG_STUDIO_MV: shellPath(failingMv),
  });
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(installed, 'old.txt'), 'utf8'), 'previous install');
  assert.equal(fs.existsSync(path.join(installed, 'new.txt')), false);
  assert.equal(fs.readFileSync(launcher, 'utf8'), 'previous launcher\n');
  assert.equal(fs.readFileSync(path.join(appBundle, 'Contents', 'old.txt'), 'utf8'), 'previous app bundle');
  assert.equal(fs.existsSync(path.join(applications, '.Sthang Studio.command.backup')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install.lock')), false);
});

test('release installer rolls back when launcher creation fails after the app swap', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos launcher rollback '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const oldApp = path.join(state, 'app');
  fs.mkdirSync(oldApp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(oldApp, 'old.txt'), 'previous install');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement install');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  fs.writeFileSync(path.join(home, 'Applications'), 'blocks launcher directory');
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(oldApp, 'old.txt'), 'utf8'), 'previous install');
  assert.equal(fs.existsSync(path.join(oldApp, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install-backup')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install.lock')), false);
});

test('release installer preserves the previous launcher when temporary launcher creation fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos atomic launcher rollback '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const oldApp = path.join(state, 'app');
  const applications = path.join(home, 'Applications');
  const launcher = path.join(applications, 'Sthang Studio.command');
  const blockedTemp = path.join(applications, '.Sthang Studio.command.tmp');
  fs.mkdirSync(oldApp, { recursive: true });
  fs.mkdirSync(applications, { recursive: true });
  fs.mkdirSync(blockedTemp, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(oldApp, 'old.txt'), 'previous install');
  fs.writeFileSync(launcher, 'previous launcher\n');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement install');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(oldApp, 'old.txt'), 'utf8'), 'previous install');
  assert.equal(fs.existsSync(path.join(oldApp, 'new.txt')), false);
  assert.equal(fs.readFileSync(launcher, 'utf8'), 'previous launcher\n');
  assert.equal(fs.existsSync(path.join(state, '.manual-install-backup')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install.lock')), false);
});

test('release installer recovers an interrupted prior swap before retrying setup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos interrupted install '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const installed = path.join(state, 'app');
  const backup = path.join(state, '.manual-install-backup');
  const staleLock = path.join(state, '.manual-install.lock');
  const updateControlBackup = path.join(state, '.manual-update-control-backup');
  const updates = path.join(state, 'updates');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(updateControlBackup, { recursive: true });
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(installed, 'interrupted-new.txt'), 'incomplete app');
  fs.writeFileSync(path.join(backup, 'old.txt'), 'last known good app');
  fs.writeFileSync(staleLock, '99999999\n');
  fs.writeFileSync(path.join(updateControlBackup, 'active.json'), '{"restored":true}\n');
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Recovering the previous app from an interrupted installation/);
  assert.equal(fs.readFileSync(path.join(installed, 'old.txt'), 'utf8'), 'last known good app');
  assert.equal(fs.existsSync(path.join(installed, 'interrupted-new.txt')), false);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(staleLock), false);
  assert.equal(fs.readFileSync(path.join(updates, 'active.json'), 'utf8'), '{"restored":true}\n');
  assert.equal(fs.existsSync(updateControlBackup), false);
});

test('release installer leaves app state untouched when installation lock is held', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos installer contention '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const installed = path.join(state, 'app');
  const lockFile = path.join(state, '.manual-install.lock');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'old.txt'), 'current app');
  fs.writeFileSync(path.join(source, 'new.txt'), 'replacement app');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  fs.writeFileSync(lockFile, '424242\n');
  const env = releaseInstallerEnv(dir, home, state, { MOCK_SHLOCK_DENY: '1' });
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Another Sthang Studio installation is still running/);
  assert.equal(fs.readFileSync(path.join(installed, 'old.txt'), 'utf8'), 'current app');
  assert.equal(fs.existsSync(path.join(installed, 'new.txt')), false);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '424242\n');
  assert.equal(fs.existsSync(path.join(state, '.manual-install-backup')), false);
  assert.equal(fs.existsSync(path.join(state, '.manual-install-stage')), false);
});

test('release recovery ignores an interrupted non-authoritative backup cleanup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos discard recovery '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  const source = path.join(dir, 'package files');
  const installed = path.join(state, 'app');
  const discard = path.join(state, '.manual-install-discard');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(discard, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(installed, 'current.txt'), 'committed app');
  fs.writeFileSync(path.join(discard, 'partial-old.txt'), 'partially deleted old app');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"test"}\n');
  fs.writeFileSync(path.join(source, 'INSTALL-MACOS.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(source, 'run-macos.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  completeReleaseSource(source);
  const env = releaseInstallerEnv(dir, home, state);
  const installer = path.join(root, 'scripts/install-release-package-macos.sh');
  const result = spawnSync(shell, [shellPath(installer), shellPath(source)], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(installed, 'current.txt'), 'utf8'), 'committed app');
  assert.equal(fs.existsSync(path.join(installed, 'partial-old.txt')), false);
  assert.equal(fs.existsSync(discard), false);
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
