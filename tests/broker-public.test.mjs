import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
function git(root, args) {
  const result = spawnSync('git', ['-c', 'user.name=Broker public fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${path.join(root, '.disabled-hooks')}`, ...args],
  { cwd: root, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-broker-public-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  // Minimal synthetic public-truth corpus; not a checkout or release assertion.
  const truth = "0.0.1 /releases/tag/v0.0.1 `store: false` store:false Gemini Files API up to 48 hours; "
    + "Studio does not explicitly delete that remote file. Files API retention is independent of interaction zero-data-retention controls. "
    + "This does not make Studio's current Gemini flow a zero-data-footprint workflow.\n";
  const files = {
    'package.json': JSON.stringify({ version: '0.0.1' }),
    '.sthang/product-manifest.json': JSON.stringify({ proposal: { release: { publicVersion: '0.0.1' } } }),
    'README.md': truth, 'PRIVACY.md': truth, 'packaging/windows/Read Me.txt': truth,
    'apps/server/src/services/gemini.ts': 'ai.files.upload({store: false});\n',
    '.gitignore': await fs.readFile(path.join(repository, '.gitignore'), 'utf8'),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  git(root, ['init', '--quiet']); git(root, ['add', '.']); git(root, ['commit', '--quiet', '-m', 'Synthetic baseline']);
  return root;
}
function scan(root) {
  return spawnSync(process.execPath, [path.join(repository, 'scripts', 'public-readiness-check.mjs')], { cwd: root, env: environment, encoding: 'utf8' });
}

test('broker version bundles are ignored locally and rejected by the public guard even after deletion', async (t) => {
  const root = await fixture(t);
  const baseline = scan(root); assert.equal(baseline.status, 0, baseline.stderr);
  const relative = 'broker-versions/1.0.1/scripts/launch-studio.ps1';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), '# synthetic runtime bundle\n');
  git(root, ['check-ignore', relative]);
  git(root, ['add', '--force', relative]); git(root, ['commit', '--quiet', '-m', 'Synthetic runtime path']);
  let result = scan(root); assert.equal(result.status, 1); assert.ok(result.stderr.includes(`forbidden public path: ${relative}`));
  git(root, ['rm', '--quiet', relative]); git(root, ['commit', '--quiet', '-m', 'Delete synthetic runtime path']);
  result = scan(root); assert.equal(result.status, 1); assert.ok(result.stderr.includes(`forbidden public path in Git history: ${JSON.stringify(relative)}`));
});

test('public guard also rejects a case-variant broker bundle path', async (t) => {
  const root = await fixture(t), relative = 'BROKER-VERSIONS/1.0.1/a.txt';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), 'synthetic');
  git(root, ['add', '--force', relative]); git(root, ['commit', '--quiet', '-m', 'Synthetic case variant']);
  const result = scan(root); assert.equal(result.status, 1); assert.ok(result.stderr.includes(`forbidden public path: ${relative}`));
});
