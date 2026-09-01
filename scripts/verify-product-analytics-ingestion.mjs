import crypto from 'node:crypto';

const endpoint = String(process.env.STHANG_ANALYTICS_ENDPOINT || 'https://analytics.sthang.app').trim().replace(/\/+$/, '');
if (!endpoint.startsWith('https://')) throw new Error('STHANG_ANALYTICS_ENDPOINT must be an approved HTTPS Sthang analytics origin.');

const installationId = crypto.randomUUID();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 12_000);

try {
  const response = await fetch(`${endpoint}/v1/events`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      installationId,
      event: 'studio_started',
      properties: {
        app_version: '0.8.0-synthetic',
        platform: 'synthetic-validation',
        result: 'synthetic-validation',
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.accepted !== true) {
    throw new Error(`Sthang analytics relay returned HTTP ${response.status}.`);
  }
  console.log('Product analytics relay + downstream ingestion synthetic validation passed.');
  console.log('Synthetic installation id:', installationId);
} finally {
  clearTimeout(timer);
}
