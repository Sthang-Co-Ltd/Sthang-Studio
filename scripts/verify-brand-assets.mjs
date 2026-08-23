import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = path.join(root, 'apps', 'web', 'public', 'brand');
const manifestPath = path.join(brandDir, 'brand-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let failed = false;
for (const [name, mark] of Object.entries(manifest.marks ?? {})) {
  const assetPath = path.join(brandDir, mark.file);
  const actual = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  if (actual !== mark.sha256) {
    failed = true;
    console.error(`[brand] ${name} changed: ${mark.file}`);
    console.error(`        expected ${mark.sha256}`);
    console.error(`        actual   ${actual}`);
  }
}

if (failed) {
  console.error('\nApproved Sthang Studio logo assets must remain byte-for-byte unchanged.');
  console.error('Replace them only when the owner supplies a newly approved SVG set and updates brand-manifest.json.');
  process.exit(1);
}

console.log('[brand] Approved Sthang Studio SVG assets verified.');
