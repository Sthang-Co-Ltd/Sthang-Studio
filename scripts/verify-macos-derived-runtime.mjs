import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const manifestPath = path.resolve(process.argv[3] || path.join(root, '.sthang', 'macos-derived-runtime.json'));
const sourceCommit = String(process.argv[4] || '').trim();
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error('A full 40-character source commit is required for the macOS derived-runtime manifest.');
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
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, sourceCommit, files: entries }, null, 2)}\n`, 'utf8');
console.log(`Verified ${entries.length} derived macOS production files and wrote ${manifestPath}.`);
