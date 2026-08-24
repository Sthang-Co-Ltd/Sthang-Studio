import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = path.join(root, 'apps', 'web', 'public', 'brand');
const manifestPath = path.join(brandDir, 'brand-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const protectedAssets = manifest.assets ?? manifest.marks ?? {};

function canonicalBrandBytes(file, buffer) {
  if (!file.toLowerCase().endsWith('.svg')) return buffer;
  // SVG source is text, and Windows Git may already have rewritten LF to CRLF
  // in an older checkout. Normalize CRLF only for hashing so visually identical
  // approved source passes across platforms while every other byte still matters.
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

let failed = false;
for (const [name, asset] of Object.entries(protectedAssets)) {
  const assetPath = path.join(brandDir, asset.file);
  const source = readFileSync(assetPath);
  const actual = createHash('sha256').update(canonicalBrandBytes(asset.file, source)).digest('hex');
  if (actual !== asset.sha256) {
    failed = true;
    console.error(`[brand] ${name} changed: ${asset.file}`);
    console.error(`        expected ${asset.sha256}`);
    console.error(`        actual   ${actual}`);
  }
}

if (failed) {
  console.error('\nApproved Sthang Studio brand assets changed beyond line-ending normalization.');
  console.error('Replace them only when the owner approves a new source set and updates brand-manifest.json.');
  process.exit(1);
}

console.log('[brand] Approved Sthang Studio brand assets verified.');
