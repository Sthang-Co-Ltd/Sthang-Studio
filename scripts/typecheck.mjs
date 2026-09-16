import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function typecheckProjectArgs(root, { runtimeOnly = false } = {}) {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const projects = [
    [tsc, '-p', path.join(root, 'packages', 'shared', 'tsconfig.json'), '--emitDeclarationOnly'],
    [tsc, '-p', path.join(root, 'apps', 'server', 'tsconfig.json'), '--noEmit'],
    [tsc, '-b', path.join(root, 'apps', 'web', 'tsconfig.json'), '--pretty', 'false'],
  ];
  if (!runtimeOnly) {
    projects.push([tsc, '-p', path.join(root, 'tests', 'tsconfig.json'), '--noEmit']);
  }
  return projects;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const node = process.execPath;
  // OTA/runtime packages intentionally exclude repository-only tests. Full source
  // checkouts still include tests/tsconfig.json and therefore retain the existing
  // test-suite typecheck unless --runtime-only is explicitly requested.
  const runtimeOnly = process.argv.includes('--runtime-only')
    || !fs.existsSync(path.join(root, 'tests', 'tsconfig.json'));
  for (const args of typecheckProjectArgs(root, { runtimeOnly })) {
    const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', shell: false });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
