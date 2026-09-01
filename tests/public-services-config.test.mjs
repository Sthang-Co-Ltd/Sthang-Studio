import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const configPath = path.join(root, 'config', 'product-services.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

test('public service config contains only versioned non-secret Sthang service coordinates', () => {
  const value = readConfig();
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(Object.keys(value).sort(), ['khmerContribution', 'productAnalytics', 'schemaVersion']);
  assert.deepEqual(Object.keys(value.khmerContribution).sort(), ['endpoint', 'provisioned']);
  assert.deepEqual(Object.keys(value.productAnalytics).sort(), ['endpoint', 'provisioned']);

  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of [
    'admin_token', 'admin-token', 'personal_api', 'personal-api', 'secret', 'password', 'credential',
    'posthog', 'projectkey', 'project_key',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public Studio service config must not contain ${forbidden}`);
  }
});

test('unprovisioned services fail closed and provisioned services use exact Sthang origins', () => {
  const value = readConfig();
  if (value.khmerContribution.provisioned) {
    assert.equal(value.khmerContribution.endpoint, 'https://contribute.sthang.app');
  } else {
    assert.equal(value.khmerContribution.endpoint, '');
  }

  if (value.productAnalytics.provisioned) {
    assert.equal(value.productAnalytics.endpoint, 'https://analytics.sthang.app');
  } else {
    assert.equal(value.productAnalytics.endpoint, '');
  }
});
