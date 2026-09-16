import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('packaged Windows setup explicitly uses runtime-only typecheck', async () => {
  const setup = await fs.readFile(path.join(root, 'setup-windows.bat'), 'utf8');
  assert.match(setup, /node\s+"scripts\\typecheck\.mjs"\s+--runtime-only/i);
  assert.doesNotMatch(setup, /node\s+"scripts\\typecheck\.mjs"\s*(?:\r?\n|$)/i);
});
