import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('proxy-addr does not trust unrelated IPv4 clients through an undersized mapped-IPv6 subnet', () => {
  const proxyaddr = require('proxy-addr');
  // CVE-2026-90711: 2.0.7 accepted this spelling as trust for every IPv4 client.
  const malformed = proxyaddr.compile(['::ffff:10.0.0.0/8']);
  assert.equal(malformed('203.0.113.15'), false);
  assert.equal(malformed('192.0.2.44'), false);
  for (const subnet of ['::ffff:10.0.0.0/104', '10.0.0.0/8']) {
    const trusted = proxyaddr.compile([subnet]);
    assert.equal(trusted('10.1.2.3'), true);
    assert.equal(trusted('203.0.113.15'), false);
  }
});

test('reviewed Node runtime lines and workspace lock declarations stay synchronized', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.engines.node, '^22.23.3 || ^24.21.0');
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.match(lock.packages['node_modules/@types/node'].version, /^24\./u);
  for (const workspace of ['', 'apps/server', 'apps/web', 'packages/shared']) {
    const current = JSON.parse(fs.readFileSync(path.join(root, workspace, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies']) {
      assert.deepEqual(lock.packages[workspace][field], current[field], `${workspace || 'root'} ${field}`);
    }
  }
});
