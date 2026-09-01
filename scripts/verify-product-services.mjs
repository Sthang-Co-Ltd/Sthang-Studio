import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const errors = [];

function read(relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
  } catch (error) {
    errors.push(`${relativePath} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    errors.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function exactKeys(value, label, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    errors.push(`${label} keys must be exactly ${wanted.join(', ')}; found ${actual.join(', ')}`);
  }
}

function httpsOrigin(value) {
  try {
    const raw = String(value || '').replace(/\/+$/, '');
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.origin === raw;
  } catch {
    return false;
  }
}

const services = readJson('config/product-services.json');
exactKeys(services, 'product services', ['schemaVersion', 'khmerContribution', 'productAnalytics']);
if (services.schemaVersion !== 1) errors.push('product services schemaVersion must be 1');
exactKeys(services.khmerContribution, 'khmerContribution', ['provisioned', 'endpoint']);
exactKeys(services.productAnalytics, 'productAnalytics', ['provisioned', 'host', 'projectKey']);

const serialized = JSON.stringify(services).toLowerCase();
for (const forbidden of ['admin_token', 'admin-token', 'personal_api', 'personal-api', 'secret', 'password', 'credential']) {
  if (serialized.includes(forbidden)) errors.push(`public service config must not contain ${forbidden}`);
}

if (services.khmerContribution?.provisioned === true) {
  if (services.khmerContribution.endpoint !== 'https://contribute.sthang.app') {
    errors.push('provisioned Khmer contribution endpoint must be exactly https://contribute.sthang.app');
  }
} else if (services.khmerContribution?.provisioned === false) {
  if (services.khmerContribution.endpoint !== '') errors.push('unprovisioned Khmer contribution endpoint must be empty');
} else {
  errors.push('khmerContribution.provisioned must be a boolean');
}

if (services.productAnalytics?.host !== 'https://eu.i.posthog.com' || !httpsOrigin(services.productAnalytics?.host)) {
  errors.push('product analytics host must be exactly the reviewed EU HTTPS ingestion origin');
}
if (services.productAnalytics?.provisioned === true) {
  if (!/^phc_[A-Za-z0-9_-]{8,220}$/.test(String(services.productAnalytics.projectKey || ''))) {
    errors.push('provisioned product analytics requires a public project ingestion key');
  }
} else if (services.productAnalytics?.provisioned === false) {
  if (services.productAnalytics.projectKey !== '') errors.push('unprovisioned product analytics project key must be empty');
} else {
  errors.push('productAnalytics.provisioned must be a boolean');
}

// The third-party processor remains named in formal privacy/governance docs, but
// normal app/UI/runtime/env-template copy stays provider-neutral by product decision.
for (const relativePath of [
  'apps/web/src/components/ContributorSettings.tsx',
  'apps/web/src/components/ContributionPromptHost.tsx',
  'apps/server/src/index.ts',
  '.env.example',
]) {
  if (/posthog/i.test(read(relativePath))) {
    errors.push(`${relativePath} must keep analytics provider branding out of normal Studio copy`);
  }
}

const serverConfig = read('apps/server/src/config.ts');
for (const required of [
  "config', 'product-services.json'",
  'publicServices.khmerContribution?.provisioned === true',
  'publicServices.productAnalytics?.provisioned === true',
  "httpsOrigin('STHANG_CONTRIBUTION_ENDPOINT', publicContributionEndpoint)",
  "httpsOrigin('STHANG_ANALYTICS_HOST', publicAnalyticsHost)",
]) {
  if (!serverConfig.includes(required)) errors.push(`apps/server/src/config.ts is missing public-service integration: ${required}`);
}

if (errors.length) {
  console.error('Product-service verification failed:');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Product-service verification passed (fail-closed public config + provider-neutral Studio copy).');
