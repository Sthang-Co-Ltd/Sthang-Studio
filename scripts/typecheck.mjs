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

function isStrictlyInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function isLegacyBrokerPreparation(root, env = process.env) {
  const installRoot = typeof env.STHANG_STUDIO_INSTALL_ROOT === 'string'
    ? env.STHANG_STUDIO_INSTALL_ROOT.trim()
    : '';
  if (
    env.KCS_NONINTERACTIVE !== '1'
    || env.STHANG_STUDIO_BROKER_VERSION !== '1.0.0'
    || !installRoot
  ) {
    return false;
  }

  const resolvedRoot = path.resolve(root);
  const workRoot = path.join(path.resolve(installRoot), 'updates', 'work');
  if (path.basename(resolvedRoot).toLowerCase() !== 'source' || !isStrictlyInside(workRoot, resolvedRoot)) {
    return false;
  }

  // The OTA payload intentionally excludes repository-only tests. Requiring
  // that omission keeps this compatibility bridge from weakening an ordinary
  // full source checkout even if the broker environment leaks into it.
  return !fs.existsSync(path.join(resolvedRoot, 'tests', 'tsconfig.json'));
}

export function shouldUseRuntimeOnlyTypecheck(root, argv = process.argv.slice(2), env = process.env) {
  return argv.includes('--runtime-only') || isLegacyBrokerPreparation(root, env);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const node = process.execPath;
  // Current brokers explicitly request --runtime-only. The legacy v0.8 broker
  // invokes plain `npm run typecheck`, so recognize only its tightly bounded
  // updates/work/<version>/source preparation context. Normal source validation
  // continues to include tests/tsconfig.json.
  const runtimeOnly = shouldUseRuntimeOnlyTypecheck(root);
  for (const args of typecheckProjectArgs(root, { runtimeOnly })) {
    const result = spawnSync(node, args, { cwd: root, stdio: 'inherit', shell: false });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
