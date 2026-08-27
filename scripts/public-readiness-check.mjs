import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const currentFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const errors = [];

function normalized(file) {
  return file.replaceAll('\\', '/');
}

function forbiddenPublicPath(file) {
  const p = normalized(file);
  const base = path.posix.basename(p);
  const segments = p.split('/');

  if (base === '.env') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  if (/^(?:credentials.*|service-account.*)\.json$/i.test(base)) return true;
  if (segments.includes('node_modules') || segments.includes('.venv') || segments.includes('__pycache__')) return true;
  if (segments.includes('dist')) return true;
  if (/\.(?:pyc|pyo|pem|p12|pfx)$/i.test(base)) return true;
  if (/\.(?:key)$/i.test(base) && !/hotkey|keymap/i.test(base)) return true;

  return new Set([
    'data/projects.json',
    'data/profile.json',
    'data/jobs.json',
  ]).has(p)
    || p.startsWith('data/cache/')
    || p.startsWith('data/history/')
    || p.startsWith('data/proposals/')
    || p.startsWith('data/working/')
    || (p.startsWith('uploads/') && p !== 'uploads/.gitkeep')
    || (p.startsWith('exports/') && p !== 'exports/.gitkeep');
}

for (const file of currentFiles) {
  if (forbiddenPublicPath(file)) errors.push(`forbidden public path: ${file}`);
}

const secretPatterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  [
    'credential assignment',
    /(?:GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY)\s*=\s*(?!your_|example|placeholder|<)[^\s#"']{16,}/g,
  ],
];

function scan(label, text) {
  for (const [kind, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) errors.push(`${kind} pattern found in ${label}`);
  }
}

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  } catch (error) {
    errors.push(`unable to read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function requireText(relativePath, text, checks) {
  for (const [label, pattern] of checks) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) errors.push(`${relativePath} is missing required public truth: ${label}`);
  }
}

const rootPackage = JSON.parse(readText('package.json'));
const publicVersion = rootPackage.version;
const readme = readText('README.md');
const privacy = readText('PRIVACY.md');
const packageReadme = readText('packaging/windows/Read Me.txt');
const geminiRuntime = readText('apps/server/src/services/gemini.ts');

for (const [relativePath, text] of [
  ['README.md', readme],
  ['PRIVACY.md', privacy],
  ['packaging/windows/Read Me.txt', packageReadme],
]) {
  for (const [label, pattern] of [
    ['private repository claim', /\b(?:repository is private|private repository|repository remains private)\b/i],
    ['no-public-download claim', /\b(?:no public download|not (?:yet )?available (?:to|for) (?:the )?public)\b/i],
    ['release-candidate claim', /\brelease[- ]candidate\b/i],
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) errors.push(`${relativePath} contains stale ${label}`);
  }
}

requireText('README.md', readme, [
  ['current public Beta version', new RegExp(`\\b${publicVersion.replaceAll('.', '\\.') }\\b`)],
  ['matching GitHub Release tag', new RegExp(`/releases/tag/v${publicVersion.replaceAll('.', '\\.') }\\b`)],
  ['interaction store control', /`store: false`/i],
  ['Gemini Files API upload', /Gemini Files API/i],
  ['no explicit remote-file deletion', /does not\s+explicitly\s+delete\s+(?:that\s+)?remote\s+file/i],
  ['provider retention of up to 48 hours', /up to 48 hours/i],
]);

requireText('PRIVACY.md', privacy, [
  ['interaction store control', /`store: false`/i],
  ['Gemini Files API upload', /Gemini Files API/i],
  ['no explicit remote-file deletion', /does not\s+explicitly\s+delete\s+(?:that\s+)?remote\s+file/i],
  ['provider retention of up to 48 hours', /up to 48 hours/i],
  ['Files API independence from interaction retention', /independent\s+of\s+interaction\s+zero-data-retention\s+controls/i],
  ['not a zero-data-footprint workflow', /does not make Studio's current Gemini flow\s+a zero-data-footprint workflow/i],
]);

requireText('packaging/windows/Read Me.txt', packageReadme, [
  ['interaction store control', /store:false/i],
  ['Gemini Files API upload', /Gemini Files API/i],
  ['no explicit remote-file deletion', /does not\s+explicitly\s+delete\s+(?:that\s+)?remote\s+file/i],
  ['provider retention of up to 48 hours', /up to 48 hours/i],
]);

if (!/ai\.files\.upload\s*\(/.test(geminiRuntime)) {
  errors.push('Gemini runtime no longer matches the disclosed Files API upload behavior');
}
if (/ai\.files\.delete\s*\(/.test(geminiRuntime)) {
  errors.push('Gemini runtime now deletes Files API uploads; update the disclosure and product manifest before release');
}
if (!/store:\s*false\b/.test(geminiRuntime)) {
  errors.push('Gemini runtime no longer matches the disclosed store:false interaction behavior');
}

for (const file of currentFiles) {
  const full = path.join(root, file);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) continue;
  scan(file, buffer.toString('utf8'));
}

// Scan textual Git history too. CI checks out full history so this catches a
// credential that was committed and later deleted before a repository is made public.
try {
  const history = execFileSync(
    'git',
    ['log', '--all', '--format=', '--patch', '--no-ext-diff', '--'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  scan('Git history', history);
} catch (error) {
  errors.push(`unable to scan Git history: ${error instanceof Error ? error.message : String(error)}`);
}

if (errors.length) {
  console.error('Public-readiness check failed:');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Public-readiness check passed (${currentFiles.length} current files; current tree + Git history scanned).`);
