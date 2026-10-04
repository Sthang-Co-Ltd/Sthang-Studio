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

test('OTA preparation requires KFA while manual setup retains fallback', async () => {
  const setup = await fs.readFile(path.join(root, 'setup-local-timing-windows.bat'), 'utf8');
  const prepare = await fs.readFile(path.join(root, 'scripts/prepare-studio-update.ps1'), 'utf8');
  assert.equal((setup.match(/if "%KCS_REQUIRE_KFA%"=="1"/g) || []).length, 2, 'both fresh setup and cached ready path validate strict mode');
  assert.match(setup, /if not "%KFA_OK%"=="1" goto :kfa_required_error/);
  assert.match(setup, /:kfa_required_error[\s\S]*exit \/b 1/);
  assert.match(setup, /The app can still run with its local Whisper fallback/);
  assert.match(prepare, /\$env:KCS_REQUIRE_KFA = '1'[\s\S]*setup-local-timing-windows\.bat/);
  assert.match(prepare, /\$env:KCS_REQUIRE_KFA = \$PreviousRequireKfa/);
  assert.match(prepare, /function Assert-PreparedTarget[\s\S]*check-windows-timing\.py[\s\S]*Required local Khmer timing readiness validation failed/);
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
