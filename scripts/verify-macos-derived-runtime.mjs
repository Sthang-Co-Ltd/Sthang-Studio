import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const manifestPath = path.resolve(process.argv[3] || path.join(root, '.sthang', 'macos-derived-runtime.json'));
const sourceCommit = String(process.argv[4] || '').trim();
const expectedPackageLockSha256 = String(process.argv[5] || '').trim().toLowerCase();
const sourceTree = String(process.argv[6] || '').trim();
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error('A full 40-character source commit is required for the macOS derived-runtime manifest.');
}
if (!/^[0-9a-f]{64}$/u.test(expectedPackageLockSha256)) {
  throw new Error('A 64-character package-lock SHA-256 is required for the macOS derived-runtime manifest.');
}
if (!/^[0-9a-f]{40}$/u.test(sourceTree)) {
  throw new Error('A full 40-character source tree is required for the macOS derived-runtime manifest.');
}

const derivedRoots = [
  'apps/server/dist',
  'apps/web/dist',
  'packages/shared/dist',
];
const required = new Set([
  'apps/server/dist/index.js',
  'apps/web/dist/index.html',
  'packages/shared/dist/index.js',
]);
const allowedExtensions = new Set(['.css', '.d.ts', '.html', '.ico', '.js', '.json', '.md', '.png', '.svg']);
const textExtensions = new Set(['.css', '.d.ts', '.html', '.js', '.json', '.md', '.svg']);
const secretPatterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/u],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u],
  ['credential assignment', /(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY)\s*=\s*(?!your_|example|placeholder|<)[^\s#"']{16,}/u],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
];

function normalized(value) {
  return value.replaceAll('\\', '/');
}

function extensionFor(relative) {
  if (relative.endsWith('.d.ts')) return '.d.ts';
  return path.extname(relative).toLowerCase();
}

const entries = [];
for (const relativeRoot of derivedRoots) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) throw new Error(`Missing derived runtime root: ${relativeRoot}`);
  const pending = [absoluteRoot];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Derived runtime contains a symlink: ${normalized(path.relative(root, current))}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Derived runtime contains a non-regular file: ${normalized(path.relative(root, current))}`);
    const relative = normalized(path.relative(root, current));
    const extension = extensionFor(relative);
    if (!allowedExtensions.has(extension)) throw new Error(`Unexpected derived runtime file type: ${relative}`);
    const bytes = fs.readFileSync(current);
    if (textExtensions.has(extension)) {
      const text = bytes.toString('utf8');
      for (const [label, pattern] of secretPatterns) {
        if (pattern.test(text)) throw new Error(`${label} pattern found in derived runtime: ${relative}`);
      }
    }
    required.delete(relative);
    entries.push({
      path: relative,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
}

if (required.size) throw new Error(`Derived runtime is missing required files: ${[...required].join(', ')}`);
entries.sort((a, b) => a.path.localeCompare(b.path));

const packageLockPath = path.join(root, 'package-lock.json');
if (!fs.existsSync(packageLockPath)) throw new Error('Packaged runtime is missing package-lock.json.');
const packageLockSha256 = crypto.createHash('sha256').update(fs.readFileSync(packageLockPath)).digest('hex');
if (packageLockSha256 !== expectedPackageLockSha256) {
  throw new Error(`Packaged package-lock.json does not match the clean release-build lock: expected ${expectedPackageLockSha256}, got ${packageLockSha256}`);
}

const buildEvidencePath = path.join(root, '.sthang', 'macos-release-build.json');
if (!fs.existsSync(buildEvidencePath)) throw new Error('Packaged runtime is missing source-owned macOS release build evidence.');
const buildEvidenceBytes = fs.readFileSync(buildEvidencePath);
const buildEvidenceSha256 = crypto.createHash('sha256').update(buildEvidenceBytes).digest('hex');
let buildEvidence;
try {
  buildEvidence = JSON.parse(buildEvidenceBytes.toString('utf8'));
} catch {
  throw new Error('Source-owned macOS release build evidence is invalid.');
}
if (
  buildEvidence?.schemaVersion !== 1
  || buildEvidence?.packageLockSha256 !== expectedPackageLockSha256
  || !Array.isArray(buildEvidence?.files)
) {
  throw new Error('Source-owned macOS release build evidence identity is invalid.');
}
const expectedEvidenceFiles = [...buildEvidence.files]
  .map((entry) => ({
    path: String(entry?.path || ''),
    size: Number(entry?.size),
    sha256: String(entry?.sha256 || '').toLowerCase(),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
if (JSON.stringify(expectedEvidenceFiles) !== JSON.stringify(entries)) {
  throw new Error('Derived macOS production output does not match source-owned release build evidence.');
}

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 2,
  sourceCommit,
  sourceTree,
  packageLockSha256,
  buildEvidenceSha256,
  files: entries,
}, null, 2)}\n`, 'utf8');
console.log(`Verified ${entries.length} derived macOS production files and wrote ${manifestPath}.`);
