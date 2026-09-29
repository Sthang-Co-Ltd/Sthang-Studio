import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : repositoryRoot;
const output = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repositoryRoot, '.sthang', 'macos-release-build.json');
const derivedRoots = [
  'apps/server/dist',
  'apps/web/dist',
  'packages/shared/dist',
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const files = [];
for (const relativeRoot of derivedRoots) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`Build first; missing ${relativeRoot}.`);
  const pending = [absoluteRoot];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Release build output contains a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Release build output contains a non-regular file: ${current}`);
    const bytes = fs.readFileSync(current);
    files.push({
      path: path.relative(root, current).replaceAll('\\', '/'),
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
}
files.sort((left, right) => left.path.localeCompare(right.path));
const packageLockSha256 = sha256(fs.readFileSync(path.join(root, 'package-lock.json')));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  packageLockSha256,
  files,
}, null, 2)}\n`, 'utf8');
console.log(`Updated macOS release build evidence from ${root} with ${files.length} derived files: ${output}`);
