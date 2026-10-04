import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  const { spawnSync } = await import('node:child_process');
  const candidates = process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]] : [['python3', []], ['python', []]];
  const chosen = candidates.find(([command, prefix]) => spawnSync(command, [...prefix, '-c', 'import sys; sys.exit(0)'], { windowsHide: true }).status === 0);
  assert.ok(chosen, 'Python is required to verify the updater readiness checker');
  const [command, prefix] = chosen;
  const result = spawnSync(command, [...prefix, '-I', '-B', 'tests/windows_timing_check_test.py'], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
