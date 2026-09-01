const WORKER_VERSION = '1';
const MAX_REQUEST_BYTES = 8 * 1024;
const PROCESSOR_INGESTION = 'https://eu.i.posthog.com/i/v0/e/';

const ALLOWED_EVENTS = new Set([
  'studio_started',
  'project_created',
  'generation_started',
  'generation_completed',
  'generation_failed',
  'caption_approved',
  'export_completed',
]);

const ALLOWED_PROPERTIES = new Set([
  'app_version',
  'platform',
  'job_type',
  'caption_count_bucket',
  'duration_bucket',
  'timing_ms_bucket',
  'approval_count_bucket',
  'warning_count_bucket',
  'result',
]);

const FORBIDDEN_PROPERTY_NAMES = [
  'caption', 'transcript', 'audio', 'video', 'filename', 'project', 'path',
  'context', 'vocabulary', 'api_key', 'apikey', 'contributor', 'email', 'name',
];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function safePropertyValue(value) {
  if (typeof value === 'string') return value.length <= 80 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

export function validateAnalyticsEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be an object');
  const keys = Object.keys(raw).sort();
  if (keys.join('\0') !== ['event', 'installationId', 'properties', 'schemaVersion'].sort().join('\0')) {
    throw new Error('analytics body fields are invalid');
  }
  if (raw.schemaVersion !== 1) throw new Error('unsupported schemaVersion');

  const installationId = String(raw.installationId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) {
    throw new Error('invalid installationId');
  }
  const event = String(raw.event || '');
  if (!ALLOWED_EVENTS.has(event)) throw new Error('analytics event is not allow-listed');
  if (!raw.properties || typeof raw.properties !== 'object' || Array.isArray(raw.properties)) {
    throw new Error('analytics properties must be an object');
  }

  const properties = {};
  for (const [key, value] of Object.entries(raw.properties)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_PROPERTY_NAMES.some((part) => lowered.includes(part))) {
      throw new Error(`forbidden analytics property: ${key}`);
    }
    if (!ALLOWED_PROPERTIES.has(key)) throw new Error(`analytics property is not allow-listed: ${key}`);
    const safe = safePropertyValue(value);
    if (safe == null) throw new Error(`analytics property value is invalid: ${key}`);
    properties[key] = safe;
  }

  if (typeof properties.app_version !== 'string' || !properties.app_version) throw new Error('app_version is required');
  if (typeof properties.platform !== 'string' || !properties.platform) throw new Error('platform is required');
  return { installationId, event, properties };
}

async function readBoundedJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new Error('request too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error('request too large');
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function forwardEvent(request, env) {
  if (!env.ANALYTICS_PROJECT_KEY) return json({ error: 'Analytics relay is not configured' }, 503);
  let item;
  try {
    item = validateAnalyticsEvent(await readBoundedJson(request));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid analytics event' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(PROCESSOR_INGESTION, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.ANALYTICS_PROJECT_KEY,
        distinct_id: item.installationId,
        event: item.event,
        properties: {
          $process_person_profile: false,
          $geoip_disable: true,
          ...item.properties,
        },
      }),
    });
    if (!response.ok) return json({ error: 'Analytics processor unavailable' }, 502);
    return json({ accepted: true }, 202);
  } catch {
    return json({ error: 'Analytics processor unavailable' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'sthang-studio-analytics', version: WORKER_VERSION });
    }
    if (request.method === 'POST' && url.pathname === '/v1/events') return forwardEvent(request, env);
    return json({ error: 'Not found' }, 404);
  },
};
