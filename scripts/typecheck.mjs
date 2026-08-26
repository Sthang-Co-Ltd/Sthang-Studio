import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const node=process.execPath;
const tsc=path.join(root,'node_modules','typescript','bin','tsc');
for (const args of [
  [tsc,'-p',path.join(root,'packages','shared','tsconfig.json'),'--emitDeclarationOnly'],
  [tsc,'-p',path.join(root,'apps','server','tsconfig.json'),'--noEmit'],
  [tsc,'-b',path.join(root,'apps','web','tsconfig.json'),'--pretty','false'],
]) {
  const r=spawnSync(node,args,{cwd:root,stdio:'inherit',shell:false});
  if(r.status!==0) process.exit(r.status??1);
}
