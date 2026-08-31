import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scanner = path.join(repositoryRoot, 'scripts', 'public-readiness-check.mjs');
const fixturePrefix = 'sthang-public-check-test-';
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
);
const gitOptions = [
  '-c', 'user.name=Public readiness fixture',
  '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
];

function git(root, args, input) {
  return execFileSync('git', [
    ...gitOptions,
    '-c', `core.hooksPath=${path.join(root, '.disabled-hooks')}`,
    ...args,
  ], { cwd: root, env: environment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Seed only public truth inputs; never copy local runtime data or the real Git history. */
function createFixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith(fixturePrefix));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const root = path.join(temporaryRoot, 'source');
  fs.mkdirSync(root);
  for (const relativePath of [
    '.gitignore',
    '.env.example',
    '.sthang/product-manifest.json',
    'package.json',
    'README.md',
    'PRIVACY.md',
    'packaging/windows/Read Me.txt',
    'apps/server/src/services/gemini.ts',
  ]) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), destination);
  }
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'Public fixture baseline']);
  return { root, temporaryRoot };
}

function commitFile(root, relativePath, contents) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
  git(root, ['add', '--force', '--', relativePath]);
  git(root, ['commit', '--quiet', '-m', 'Add synthetic fixture content']);
}

function removeFile(root, relativePath) {
  git(root, ['rm', '--quiet', '--', relativePath]);
  git(root, ['commit', '--quiet', '-m', 'Remove synthetic fixture content']);
}

function scan(root) {
  const result = spawnSync(process.execPath, [scanner], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function assertHistoricalPathFailure(result, relativePath) {
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(`forbidden public path in Git history: ${JSON.stringify(relativePath)}`), result.output);
}

test('allows placeholder configuration and empty runtime scaffolding', (t) => {
  const { root } = createFixture(t);
  for (const file of ['data/.gitkeep', 'uploads/.gitkeep', 'exports/.gitkeep']) {
    commitFile(root, file, '');
  }
  const result = scan(root);
  assert.equal(result.status, 0, result.output);
});

test('allows private-key parser syntax without treating marker text as key material', (t) => {
  const { root } = createFixture(t);
  commitFile(
    root,
    'parser-example.mjs',
    String.raw`const keyPattern = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----/;\n`,
  );
  const result = scan(root);
  assert.equal(result.status, 0, result.output);
});

test('rejects a plausible private key block in the current tree and Git history without printing key material', (t) => {
  const { root } = createFixture(t);
  const syntheticBody = 'A'.repeat(64);
  commitFile(
    root,
    'synthetic-secret.txt',
    `-----BEGIN PRIVATE KEY-----\n${syntheticBody}\n-----END PRIVATE KEY-----\n`,
  );
  const currentResult = scan(root);
  assert.equal(currentResult.status, 1, currentResult.output);
  assert.match(currentResult.output, /private key block pattern found in synthetic-secret\.txt/);
  assert.ok(!currentResult.output.includes(syntheticBody), 'Scanner output must not disclose private-key material');

  removeFile(root, 'synthetic-secret.txt');
  const historicalResult = scan(root);
  assert.equal(historicalResult.status, 1, historicalResult.output);
  assert.match(historicalResult.output, /private key block pattern found in Git history/);
  assert.ok(!historicalResult.output.includes(syntheticBody), 'History scan output must not disclose private-key material');
});

test('continues to reject a currently tracked private path', (t) => {
  const { root } = createFixture(t);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  const result = scan(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /forbidden public path: \.env/);
});

test('rejects a deleted environment file without relying on secret patterns', (t) => {
  const { root } = createFixture(t);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  removeFile(root, '.env');
  assertHistoricalPathFailure(scan(root), '.env');
});

test('rejects deleted binary media and preserves spaces in its path', (t) => {
  const { root } = createFixture(t);
  const file = 'uploads/private fixture.wav';
  commitFile(root, file, Buffer.from([0, 1, 2, 3]));
  removeFile(root, file);
  assertHistoricalPathFailure(scan(root), file);
});

test('rejects a private path even when its blob also has a safe name', (t) => {
  const { root } = createFixture(t);
  const contents = 'same harmless blob\n';
  commitFile(root, 'safe-fixture.txt', contents);
  commitFile(root, 'data/projects.json', contents);
  removeFile(root, 'data/projects.json');
  assertHistoricalPathFailure(scan(root), 'data/projects.json');
});

test('rejects a private file renamed to a permitted path', (t) => {
  const { root } = createFixture(t);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  git(root, ['mv', '--', '.env', 'safe-fixture.txt']);
  git(root, ['commit', '--quiet', '-m', 'Rename synthetic fixture content']);
  assertHistoricalPathFailure(scan(root), '.env');
});

test('checks fetched refs other than the checked-out branch', (t) => {
  const { root } = createFixture(t);
  git(root, ['switch', '--quiet', '-c', 'fixture-side']);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  const sideCommit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['switch', '--quiet', 'main']);
  git(root, ['update-ref', 'refs/remotes/origin/fixture-side', sideCommit]);
  git(root, ['branch', '-D', 'fixture-side']);
  assertHistoricalPathFailure(scan(root), '.env');
});

test('checks merge-only additions and never prints a matching secret value', (t) => {
  const { root } = createFixture(t);
  git(root, ['switch', '--quiet', '-c', 'fixture-side']);
  commitFile(root, 'side.txt', 'side\n');
  git(root, ['switch', '--quiet', 'main']);
  commitFile(root, 'main.txt', 'main\n');
  git(root, ['merge', '--quiet', '--no-commit', '--no-ff', 'fixture-side']);
  const syntheticSecret = ['AI', 'za', 'x'.repeat(35)].join('');
  fs.writeFileSync(path.join(root, 'merge-note.txt'), syntheticSecret);
  git(root, ['add', '--', 'merge-note.txt']);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  git(root, ['rm', '--quiet', '--', '.env', 'merge-note.txt']);
  git(root, ['commit', '--quiet', '-m', 'Remove merge-only fixture content']);
  const result = scan(root);
  assertHistoricalPathFailure(result, '.env');
  assert.match(result.output, /Google API key pattern found in Git history/);
  assert.ok(!result.output.includes(syntheticSecret), 'Scanner output must not disclose matched values');
});

test('rejects a shallow clone instead of claiming a full history scan', (t) => {
  const { root, temporaryRoot } = createFixture(t);
  commitFile(root, '.env', 'synthetic placeholder only\n');
  removeFile(root, '.env');
  const shallowRoot = path.join(temporaryRoot, 'shallow');
  git(root, ['clone', '--quiet', '--depth=1', pathToFileURL(root).href, shallowRoot]);
  const result = scan(shallowRoot);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /full clone.*shallow/i);
});

test('fails closed without printing raw Git errors when history cannot be read', (t) => {
  const { root } = createFixture(t);
  const syntheticSecret = ['gh', 'p_', 'x'.repeat(36)].join('');
  const invalidRef = path.join(root, '.git', 'refs', 'heads', syntheticSecret);
  fs.writeFileSync(invalidRef, `${'1'.repeat(40)}\n`);
  const result = scan(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /unable to scan Git history/);
  assert.ok(!result.output.includes('Public-readiness check passed'), result.output);
  assert.ok(!result.output.includes(syntheticSecret), 'Git stderr must not disclose matched values');
});
