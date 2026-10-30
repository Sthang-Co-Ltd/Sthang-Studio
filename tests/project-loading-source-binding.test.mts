import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureProjectLoadingSourceBinding, verifyProjectLoadingSourceBinding } from '../scripts/project-loading-source-binding.mjs';

const options = { entries: ['apps/server/src/services/store.ts'], metadata: [] };
async function fixture(run: (root: string, write: (name: string, text: string) => Promise<void>) => Promise<void>) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'studio-source-binding-')));
  const owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner);
  const write = async (name: string, text: string) => {
    const file = path.resolve(root, name);
    assert.ok(file.startsWith(root + path.sep));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  try { await run(root, write); }
  finally {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('standalone store graph works without integration-only scanner; unused presence is not an executed dependency', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', 'export const store = {};');
  const binding = await captureProjectLoadingSourceBinding(root, options);
  assert.deepEqual(Object.keys(binding.sourceSha256), options.entries);
  await write('apps/server/src/services/project-storage.ts', 'export const unused = true;');
  await verifyProjectLoadingSourceBinding(root, binding, options);
}));

test('integrated scanner and its validator are bound transitively, and a validator edit invalidates evidence', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', "import { scan } from './project-storage.js'; export const store = scan;");
  await write('apps/server/src/services/project-storage.ts', "export { scan } from './validator.js';");
  const validator = 'export const scan = () => true;';
  await write('apps/server/src/services/validator.ts', validator);
  const binding = await captureProjectLoadingSourceBinding(root, options);
  assert.equal(binding.sourceSha256['apps/server/src/services/validator.ts'], createHash('sha256').update(validator).digest('hex'));
  assert.deepEqual(binding.localImports['apps/server/src/services/store.ts'], ['apps/server/src/services/project-storage.ts']);
  await verifyProjectLoadingSourceBinding(root, binding, options);
  await write('apps/server/src/services/validator.ts', 'export const scan = () => false;');
  await assert.rejects(verifyProjectLoadingSourceBinding(root, binding, options), /changed during measurement/);
}));

test('an imported scanner cannot be silently omitted when missing', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', "import { scan } from './project-storage.js'; export const store = scan;");
  await assert.rejects(captureProjectLoadingSourceBinding(root, options), /Measured local import is missing/);
}));

test('literal dynamic dependencies are bound and type-only imports are excluded', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', "import type { Missing } from './not-runtime.js'; export const store = () => import('./project-storage.js');");
  await write('apps/server/src/services/project-storage.ts', 'export const scan = true;');
  const binding = await captureProjectLoadingSourceBinding(root, options);
  assert.ok(binding.sourceSha256['apps/server/src/services/project-storage.ts']);
  assert.equal(binding.sourceSha256['apps/server/src/services/not-runtime.ts'], undefined);
  await fs.unlink(path.join(root, 'apps/server/src/services/project-storage.ts'));
  await assert.rejects(verifyProjectLoadingSourceBinding(root, binding, options), /Measured local import is missing/);
}));

test('shared workspace source and actually executed compiled artifacts are both pinned', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', "import { summarize } from '@kcs/shared'; export const store = summarize;");
  await write('packages/shared/package.json', JSON.stringify({ name: '@kcs/shared', main: 'dist/index.js' }));
  await write('packages/shared/src/index.ts', 'export const summarize = () => 1;');
  await write('packages/shared/dist/index.js', 'export const summarize = () => 1;');
  const binding = await captureProjectLoadingSourceBinding(root, options);
  assert.ok(binding.sourceSha256['packages/shared/src/index.ts']);
  assert.ok(binding.runtimeArtifactSha256['packages/shared/dist/index.js']);
  await write('packages/shared/dist/index.js', 'export const summarize = () => 2;');
  await assert.rejects(verifyProjectLoadingSourceBinding(root, binding, options), /changed during measurement/);
}));

test('unresolvable dynamic or local-workspace dependencies fail closed', async () => fixture(async (root, write) => {
  await write('apps/server/src/services/store.ts', 'const entry = "./scanner.js"; export const store = () => import(entry);');
  await assert.rejects(captureProjectLoadingSourceBinding(root, options), /nonliteral dynamic import/);
  await write('apps/server/src/services/store.ts', "export { unknown } from '@kcs/unbound';");
  await assert.rejects(captureProjectLoadingSourceBinding(root, options), /Unbound local workspace import/);
}));

test('the actual standalone or integrated benchmark graph binds its executed scanner exactly when imported', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const binding = await captureProjectLoadingSourceBinding(root);
  const scanner = 'apps/server/src/services/project-storage.ts';
  const store = await fs.readFile(path.join(root, 'apps/server/src/services/store.ts'), 'utf8');
  if (store.includes("from './project-storage.js'")) {
    assert.equal(binding.sourceSha256[scanner], createHash('sha256').update(await fs.readFile(path.join(root, scanner))).digest('hex'));
  } else {
    assert.equal(binding.sourceSha256[scanner], undefined);
  }
  assert.ok(binding.sourceSha256['scripts/project-loading-source-binding.mts']);
  assert.ok(binding.runtimeArtifactSha256['packages/shared/dist/index.js']);
  await verifyProjectLoadingSourceBinding(root, binding);
});
