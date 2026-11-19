import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('packaged Windows setup explicitly uses runtime-only typecheck', async () => {
  const setup = await fs.readFile(path.join(root, 'setup-windows.bat'), 'utf8');
  assert.match(setup, /node\s+"scripts\\typecheck\.mjs"\s+--runtime-only/i);
  assert.doesNotMatch(setup, /node\s+"scripts\\typecheck\.mjs"\s*(?:\r?\n|$)/i);
});

test('OTA preparation retains strict KFA checks across immutable dependency provisioning', async () => {
  const setup = await fs.readFile(path.join(root, 'setup-local-timing-windows.bat'), 'utf8');
  const provision = await fs.readFile(path.join(root, 'scripts/setup-local-timing-windows.ps1'), 'utf8');
  const prepare = await fs.readFile(path.join(root, 'scripts/prepare-studio-update.ps1'), 'utf8');
  assert.match(setup, /setup-local-timing-windows\.ps1/);
  assert.match(setup, /if not "%SETUP_EXIT%"=="0" goto :finish/);
  assert.match(setup, /if "%KCS_REQUIRE_KFA%"=="1"[\s\S]*check-windows-timing\.py[\s\S]*if errorlevel 1 exit \/b 1/);
  assert.match(provision, /provision-timing\.py.*--profile windows-py312-x64/);
  assert.match(provision, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
  assert.match(prepare, /\$env:KCS_REQUIRE_KFA = '1'[\s\S]*setup-local-timing-windows\.bat/);
  assert.match(prepare, /\$env:KCS_REQUIRE_KFA = \$PreviousRequireKfa/);
  assert.match(prepare, /function Assert-PreparedTarget[\s\S]*Assert-TimingLocks \$PreparedRoot[\s\S]*check-timing-dependencies\.py[\s\S]*check-windows-timing\.py[\s\S]*Required local Khmer timing readiness validation failed/);
});

test('strict KFA readiness helper covers dependency, missing-model and session failures without models', async () => {
  const candidates = process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]] : [['python3', []], ['python', []]];
  const chosen = candidates.find(([command, prefix]) => spawnSync(command, [...prefix, '-c', 'import sys; sys.exit(0)'], { windowsHide: true }).status === 0);
  assert.ok(chosen, 'Python is required to verify the updater readiness checker');
  const [command, prefix] = chosen;
  const result = spawnSync(command, [...prefix, '-I', '-B', 'tests/windows_timing_check_test.py'], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Windows batch call resolves an explicit relative path with current-directory search disabled', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-batch-call-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const cwd = path.join(fixture, 'caller');
  const setup = path.join(fixture, 'setup files');
  await fs.mkdir(cwd);
  await fs.mkdir(setup);
  await fs.writeFile(path.join(setup, 'child.bat'), 'echo CHILD_OK\r\n');

  const parent = path.join(setup, 'parent.bat');
  const systemRoot = process.env.SystemRoot;
  const command = path.join(systemRoot, 'System32', 'cmd.exe');
  async function runParent(childPath) {
    await fs.writeFile(parent, [
      '@echo off',
      'cd /d "%~dp0"',
      `call "${childPath}"`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'));
    const result = spawnSync(command, ['/d', '/c', parent], {
      cwd,
      env: { SystemRoot: systemRoot, PATH: '', NoDefaultCurrentDirectoryInExePath: '1' },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.ifError(result.error);
    return result;
  }

  const explicit = await runParent('.\\child.bat');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /^CHILD_OK\r?$/m);

  const bare = await runParent('child.bat');
  assert.equal(bare.status, 1, bare.stderr);
  assert.doesNotMatch(bare.stdout, /^CHILD_OK\r?$/m);
});

test('Windows setup and update preparation use the explicit relative timing launcher', async () => {
  const setup = await fs.readFile(path.join(root, 'setup-windows.bat'), 'utf8');
  const prepare = await fs.readFile(path.join(root, 'scripts/prepare-studio-update.ps1'), 'utf8');
  assert.ok(setup.includes('call ".\\setup-local-timing-windows.bat"'));
  assert.ok(prepare.includes("/c '.\\setup-local-timing-windows.bat'"));
});

test('tracked Windows batch invocations specify a path', async t => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (tracked.error?.code === 'ENOENT') {
    t.skip('git is unavailable, so tracked batch invocations cannot be enumerated');
    return;
  }
  assert.ifError(tracked.error);
  assert.equal(tracked.status, 0, tracked.stderr);

  const batchExtension = /\.(?:bat|cmd)$/i;
  const scriptPath = /^scripts\/.*\.(?:ps1|mjs)$/i;
  const violations = [];
  for (const file of tracked.stdout.split('\0')) {
    const batchFile = batchExtension.test(file);
    if (!batchFile && !scriptPath.test(file)) continue;
    const source = await fs.readFile(path.join(root, file), 'utf8');
    const invocations = batchFile
      ? /\bcall[ \t]+(?:"([^"\r\n]+)"|([^\s"&|<>]+))/gi
      : /(?:\/c\s+|['"]\/c['"]\s*,\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"',)&|<>]+))/gi;
    for (const match of source.matchAll(invocations)) {
      const target = match[1] ?? match[2] ?? match[3];
      if (batchExtension.test(target) && !/[\\/]|%~dp0/i.test(target)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${file}:${line}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'Batch invocations must specify a path');
});
