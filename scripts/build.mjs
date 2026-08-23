import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
function run(args, cwd=root) {
  const r=spawnSync(node,args,{cwd,stdio:'inherit',shell:false});
  if(r.status!==0) process.exit(r.status??1);
}
run([tsc,'-p',path.join(root,'packages','shared','tsconfig.json')]);
run([tsc,'-p',path.join(root,'apps','server','tsconfig.json')]);
run([tsc,'-b',path.join(root,'apps','web','tsconfig.json')]);
run([vite,'build'], path.join(root,'apps','web'));
