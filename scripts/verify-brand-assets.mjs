import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = path.join(root, 'apps', 'web', 'public', 'brand');
const manifestPath = path.join(brandDir, 'brand-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const protectedAssets = manifest.assets ?? manifest.marks ?? {};

let failed = false;
for (const [name, asset] of Object.entries(protectedAssets)) {
  const assetPath = path.join(brandDir, asset.file);
  const actual = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  if (actual !== asset.sha256) {
    failed = true;
    console.error(`[brand] ${name} changed: ${asset.file}`);
    console.error(`        expected ${asset.sha256}`);
    console.error(`        actual   ${actual}`);
  }
}

if (failed) {
  console.error('\nApproved Sthang Studio brand assets must remain byte-for-byte unchanged.');
  console.error('Replace them only when the owner approves a new source set and updates brand-manifest.json.');
  process.exit(1);
}

console.log('[brand] Approved Sthang Studio brand assets verified.');
