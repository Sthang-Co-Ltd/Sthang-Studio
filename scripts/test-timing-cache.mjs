import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests use only the Python standard library; no model setup/downloads.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const candidates = process.env.STHANG_TEST_PYTHON
  ? [[process.env.STHANG_TEST_PYTHON, []]]
  : [
    ...(existsSync(venv) ? [[venv, []]] : []),
    ...(process.platform === 'win32' ? [['py', ['-3.12']]] : []),
    ['python3', []], ['python', []],
  ];
let chosen;
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, '-I', '-c', 'import sys; print(sys.version); sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (!probe.error && probe.status === 0 && probe.signal === null) {
    chosen = [command, prefix];
    console.log(`Timing-cache test Python: ${probe.stdout.trim()}`);
    break;
  }
}
if (!chosen) {
  console.error('Python 3.10+ is required for timing-cache tests. Set STHANG_TEST_PYTHON to a Python executable; Python 3.12 is the supported Studio runtime.');
  process.exit(1);
}
const [command, prefix] = chosen;
const result = spawnSync(command, [...prefix, '-I', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'timing_cache_test.py', '-v'], { cwd: root, stdio: 'inherit', timeout: 120000, windowsHide: true });
if (result.error || result.signal || result.status !== 0) {
  console.error('Timing-cache tests failed:', result.error?.message || result.signal || `exit ${result.status}`);
  process.exit(1);
}
