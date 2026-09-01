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

const services = readJson('config/product-services.json');
exactKeys(services, 'product services', ['schemaVersion', 'khmerContribution', 'productAnalytics']);
if (services.schemaVersion !== 1) errors.push('product services schemaVersion must be 1');
exactKeys(services.khmerContribution, 'khmerContribution', ['provisioned', 'endpoint']);
exactKeys(services.productAnalytics, 'productAnalytics', ['provisioned', 'endpoint']);

const serialized = JSON.stringify(services).toLowerCase();
for (const forbidden of [
  'admin_token', 'admin-token', 'personal_api', 'personal-api', 'secret', 'password', 'credential',
  'posthog', 'projectkey', 'project_key',
]) {
  if (serialized.includes(forbidden)) errors.push(`public Studio service config must not contain ${forbidden}`);
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

if (services.productAnalytics?.provisioned === true) {
  if (services.productAnalytics.endpoint !== 'https://analytics.sthang.app') {
    errors.push('provisioned product analytics endpoint must be exactly https://analytics.sthang.app');
  }
} else if (services.productAnalytics?.provisioned === false) {
  if (services.productAnalytics.endpoint !== '') errors.push('unprovisioned product analytics endpoint must be empty');
} else {
  errors.push('productAnalytics.provisioned must be a boolean');
}

// The third-party processor remains named in formal privacy/governance/infra docs,
// but the ordinary app/runtime/env/public-service configuration stays Sthang-only.
for (const relativePath of [
  'apps/web/src/components/ContributorSettings.tsx',
  'apps/web/src/components/ContributionPromptHost.tsx',
  'apps/server/src/index.ts',
  'apps/server/src/config.ts',
  'apps/server/src/services/analytics.ts',
  '.env.example',
  'config/product-services.json',
]) {
  if (/posthog/i.test(read(relativePath))) {
    errors.push(`${relativePath} must keep analytics provider branding out of normal Studio app/config copy`);
  }
}

const serverConfig = read('apps/server/src/config.ts');
for (const required of [
  "config', 'product-services.json'",
  'publicServices.khmerContribution?.provisioned === true',
  'publicServices.productAnalytics?.provisioned === true',
  "httpsOrigin('STHANG_CONTRIBUTION_ENDPOINT', publicContributionEndpoint)",
  "httpsOrigin('STHANG_ANALYTICS_ENDPOINT', publicAnalyticsEndpoint)",
]) {
  if (!serverConfig.includes(required)) errors.push(`apps/server/src/config.ts is missing public-service integration: ${required}`);
}

const analyticsClient = read('apps/server/src/services/analytics.ts');
for (const required of [
  'if (!config.analyticsEndpoint) return false',
  '`${config.analyticsEndpoint}/v1/events`',
  'schemaVersion: 1',
  'installationId',
  'sanitizeAnalyticsProperties(properties)',
]) {
  if (!analyticsClient.includes(required)) errors.push(`analytics client is missing Sthang-relay behavior: ${required}`);
}
if (/api_key|\$process_person_profile|\$geoip_disable/i.test(analyticsClient)) {
  errors.push('Studio analytics client must not contain downstream processor protocol fields');
}

const relayConfig = read('infra/analytics-worker/wrangler.template.jsonc');
for (const required of [
  '"pattern": "analytics.sthang.app"',
  '"custom_domain": true',
  '"workers_dev": false',
  '"ANALYTICS_PROJECT_KEY"',
]) {
  if (!relayConfig.includes(required)) errors.push(`analytics relay deployment template is missing: ${required}`);
}
const relay = read('infra/analytics-worker/src/index.mjs');
for (const required of [
  "$process_person_profile: false",
  '$geoip_disable: true',
  'https://eu.i.posthog.com/i/v0/e/',
  "url.pathname === '/v1/events'",
]) {
  if (!relay.includes(required)) errors.push(`analytics relay is missing reviewed downstream privacy behavior: ${required}`);
}

if (errors.length) {
  console.error('Product-service verification failed:');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Product-service verification passed (Sthang-owned public endpoints + provider-neutral Studio app copy).');
