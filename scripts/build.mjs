import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reexecReviewedWindowsNode } from './windows-node-bootstrap.mjs';

const reviewedNodeExit = await reexecReviewedWindowsNode();
if (reviewedNodeExit !== null) process.exit(reviewedNodeExit);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
function run(args, cwd=root) {
  const r=spawnSync(node,args,{cwd,stdio:'inherit',shell:false});
  if(r.status!==0) process.exit(r.status??1);
}

const injectedViteEnvironment = Object.keys(process.env).filter((name) => /^VITE_/u.test(name));
if (injectedViteEnvironment.length) {
  console.error(`Refusing to build with ambient VITE_* variables: ${injectedViteEnvironment.join(', ')}`);
  process.exit(1);
}

for (const output of [
  path.join(root, 'packages', 'shared', 'dist'),
  path.join(root, 'apps', 'server', 'dist'),
  path.join(root, 'apps', 'web', 'dist'),
]) {
  fs.rmSync(output, { recursive: true, force: true });
}

run([tsc,'-p',path.join(root,'packages','shared','tsconfig.json')]);
run([tsc,'-p',path.join(root,'apps','server','tsconfig.json')]);
run([tsc,'-b',path.join(root,'apps','web','tsconfig.json')]);
run([vite,'build'], path.join(root,'apps','web'));
