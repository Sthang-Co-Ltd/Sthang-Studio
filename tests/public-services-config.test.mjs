import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const configPath = path.join(root, 'config', 'product-services.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.origin === String(value || '').replace(/\/+$/, '');
  } catch {
    return false;
  }
}

test('public service config contains only versioned non-secret service coordinates', () => {
  const value = readConfig();
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(Object.keys(value).sort(), ['khmerContribution', 'productAnalytics', 'schemaVersion']);
  assert.deepEqual(Object.keys(value.khmerContribution).sort(), ['endpoint', 'provisioned']);
  assert.deepEqual(Object.keys(value.productAnalytics).sort(), ['host', 'projectKey', 'provisioned']);

  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ['admin_token', 'admin-token', 'personal_api', 'personal-api', 'secret', 'password', 'credential']) {
    assert.equal(serialized.includes(forbidden), false, `public service config must not contain ${forbidden}`);
  }
});

test('unprovisioned services fail closed and provisioned services require approved public values', () => {
  const value = readConfig();
  if (value.khmerContribution.provisioned) {
    assert.equal(value.khmerContribution.endpoint, 'https://contribute.sthang.app');
  } else {
    assert.equal(value.khmerContribution.endpoint, '');
  }

  if (value.productAnalytics.provisioned) {
    assert.equal(isHttpsOrigin(value.productAnalytics.host), true);
    assert.equal(value.productAnalytics.host, 'https://eu.i.posthog.com');
    assert.match(String(value.productAnalytics.projectKey || ''), /^phc_[A-Za-z0-9_-]{8,220}$/);
  } else {
    assert.equal(value.productAnalytics.projectKey, '');
    assert.equal(value.productAnalytics.host, 'https://eu.i.posthog.com');
  }
});
