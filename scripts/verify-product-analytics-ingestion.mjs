import crypto from 'node:crypto';

const host = String(process.env.STHANG_ANALYTICS_HOST || 'https://eu.i.posthog.com').trim().replace(/\/+$/, '');
const projectKey = String(process.env.STHANG_ANALYTICS_PROJECT_KEY || '').trim();

if (!host.startsWith('https://')) throw new Error('STHANG_ANALYTICS_HOST must be an approved HTTPS ingestion origin.');
if (!projectKey) throw new Error('Set STHANG_ANALYTICS_PROJECT_KEY through production configuration.');

const distinctId = `sthang-studio-synthetic-${crypto.randomBytes(8).toString('hex')}`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 12_000);

try {
  const response = await fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: projectKey,
      distinct_id: distinctId,
      event: 'studio_started',
      properties: {
        $process_person_profile: false,
        $geoip_disable: true,
        app_version: '0.8.0-synthetic',
        platform: 'synthetic-validation',
        result: 'synthetic-validation',
      },
    }),
  });
  if (!response.ok) throw new Error(`Analytics ingestion returned HTTP ${response.status}.`);
  console.log('Product analytics ingestion synthetic validation passed.');
  console.log('Synthetic distinct id:', distinctId);
} finally {
  clearTimeout(timer);
}
