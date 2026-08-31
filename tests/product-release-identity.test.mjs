import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProductReleaseIdentity } from '../scripts/product-release-identity.mjs';

test('release identity keeps an unreleased source bump separate from verified public evidence', () => {
  const identity = deriveProductReleaseIdentity({ sourceVersion: '0.8.0', publicVersion: '0.7.14' });
  assert.equal(identity.sourceVersion, '0.8.0');
  assert.equal(identity.publicVersion, '0.7.14');
  assert.equal(identity.publicTag, 'v0.7.14');
  assert.equal(identity.publicAssetName, 'Sthang-Studio-Windows-v0.7.14.zip');
  assert.equal(identity.publicChecksumName, 'Sthang-Studio-Windows-v0.7.14.zip.sha256');
  assert.equal(identity.publicArchiveRoot, 'Sthang Studio 0.7.14');
});

test('release identity still supports a source version that is already public', () => {
  const identity = deriveProductReleaseIdentity({ sourceVersion: '0.7.14', publicVersion: '0.7.14' });
  assert.equal(identity.publicTag, 'v0.7.14');
});

test('release identity rejects invalid source or public versions', () => {
  assert.throws(() => deriveProductReleaseIdentity({ sourceVersion: 'next', publicVersion: '0.7.14' }));
  assert.throws(() => deriveProductReleaseIdentity({ sourceVersion: '0.8.0', publicVersion: 'latest' }));
});
