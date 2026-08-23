import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const errors = [];

function normalized(file) {
  return file.replaceAll('\\', '/');
}

function forbiddenTrackedPath(file) {
  const p = normalized(file);
  const base = path.posix.basename(p);
  const segments = p.split('/');

  if (base === '.env') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
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

for (const file of tracked) {
  if (forbiddenTrackedPath(file)) errors.push(`forbidden tracked path: ${file}`);
}

const secretPatterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
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

for (const file of tracked) {
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

console.log(`Public-readiness check passed (${tracked.length} tracked files; current tree + Git history scanned).`);
