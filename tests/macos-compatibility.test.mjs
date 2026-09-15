import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoints = ['INSTALL-MACOS.sh', 'setup-local-timing-macos.sh', 'run-macos.sh'];
const shell = process.env.STHANG_TEST_BASH || (process.platform === 'win32'
  ? path.resolve(path.dirname(spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]), '../bin/bash.exe')
  : '/bin/bash');

function fixture(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio macos test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['bin', 'scripts', 'node_modules', '.venv/bin']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const file of [...entrypoints, 'scripts/macos-common.sh']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), `#!/usr/bin/env bash\n${text}\n`, { mode: 0o755 });
  write('bin/uname', 'if [[ "$1" == "-s" ]]; then echo "$MOCK_OS"; else echo "$MOCK_ARCH"; fi');
  write('bin/sw_vers', 'printf "%s\\n" "$MOCK_MACOS"');
  write('bin/node', 'echo "$MOCK_NODE_VERSION $MOCK_NODE_ARCH"');
  write('bin/npm', 'printf "npm %s\\n" "$*" >> "$MOCK_LOG"');
  write('bin/brew', 'printf "brew %s\\n" "$*" >> "$MOCK_LOG"; if [[ "$1" == "--prefix" && -n "${MOCK_BREW_PREFIX:-}" ]]; then printf "%s\\n" "$MOCK_BREW_PREFIX"; else exit 1; fi');
  write('bin/ffmpeg', '[[ "$MOCK_FFMPEG" != "broken" ]] || exit 1; if [[ "$1" != "-version" && "$MOCK_FFMPEG" == "good" ]]; then echo "shaping: auto simple complex"; fi');
  write('bin/ffprobe', '[[ "$MOCK_FFPROBE" == "good" ]]');
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
    MOCK_FFMPEG: 'good', MOCK_FFPROBE: 'good', MOCK_READY: 'yes',
    MOCK_LOG: path.join(dir, 'calls.log').replaceAll('\\', '/'), ...changes,
  };
  const run = (command) => spawnSync(shell, ['--noprofile', '--norc', '-c', `export PATH="$PWD/bin:$PATH"; ${command}`], {
    cwd: dir, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  return { dir, env, write, run, log: () => fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '' };
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

test('Monterey never attempts an unsupported Homebrew install', (t) => {
  const f = fixture(t, { MOCK_NODE_VERSION: '24.13.0' });
  const result = f.run('bash ./INSTALL-MACOS.sh');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manual\/legacy/);
  assert.doesNotMatch(f.log(), /brew install|npm ci/);
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

for (const changes of [{ MOCK_FFMPEG: 'missing-shaping' }, { MOCK_FFMPEG: 'broken' }, { MOCK_FFPROBE: 'broken' }]) {
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
  const candidates = process.platform === 'win32' ? ['python', 'python3.12', 'python3'] : ['python3.12', 'python3'];
  const python = candidates.find((candidate) => spawnSync(candidate, ['--version'], { windowsHide: true }).status === 0);
  assert.ok(python, 'Python is required for the local macOS setup regressions.');
  success(spawnSync(python, ['-B', 'tests/macos_timing_check_test.py'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  }));
});
