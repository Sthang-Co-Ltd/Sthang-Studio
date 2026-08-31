import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { APP_VERSION } from '../version.js';
import { profileStore } from './profile-store.js';

export type AnalyticsEvent =
  | 'studio_started'
  | 'project_created'
  | 'generation_started'
  | 'generation_completed'
  | 'generation_failed'
  | 'caption_approved'
  | 'export_completed'
  | 'contribution_choice'
  | 'contribution_submitted'
  | 'contribution_verified';

type SafePropertyValue = string | number | boolean;
const ALLOWED_PROPERTY_KEYS = new Set([
  'app_version',
  'platform',
  'job_type',
  'caption_count_bucket',
  'duration_bucket',
  'timing_ms_bucket',
  'approval_count_bucket',
  'warning_count_bucket',
  'choice',
  'result',
]);

interface AnalyticsIdentityFile {
  version: 1;
  distinctId: string;
  createdAt: string;
}

function bucket(value: number, thresholds: number[]) {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  for (const threshold of thresholds) if (safe <= threshold) return `<=${threshold}`;
  return `>${thresholds.at(-1) || 0}`;
}

export const analyticsBuckets = {
  captions: (value: number) => bucket(value, [5, 10, 25, 50, 100, 250]),
  durationSeconds: (value: number) => bucket(value, [15, 30, 60, 120, 300, 600]),
  milliseconds: (value: number) => bucket(value, [1000, 3000, 10_000, 30_000, 60_000, 180_000]),
  approvals: (value: number) => bucket(value, [1, 5, 10, 25, 50, 100]),
  warnings: (value: number) => bucket(value, [0, 1, 3, 5, 10, 25]),
};

async function identity() {
  try {
    const parsed = JSON.parse(await fs.readFile(config.analyticsIdentityFile, 'utf8')) as Partial<AnalyticsIdentityFile>;
    if (parsed.version === 1 && typeof parsed.distinctId === 'string' && parsed.distinctId.length >= 16) return parsed.distinctId;
  } catch { /* created only after explicit analytics consent */ }
  const value: AnalyticsIdentityFile = {
    version: 1,
    distinctId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(config.analyticsIdentityFile), { recursive: true });
  await fs.writeFile(config.analyticsIdentityFile, JSON.stringify(value, null, 2), 'utf8');
  return value.distinctId;
}

export function sanitizeAnalyticsProperties(properties: Record<string, unknown>) {
  const out: Record<string, SafePropertyValue> = {
    app_version: APP_VERSION,
    platform: process.platform,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key) || key === 'app_version' || key === 'platform' || value == null) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 80);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export async function captureAnalytics(
  event: AnalyticsEvent,
  properties: Record<string, SafePropertyValue | undefined> = {},
) {
  try {
    if (!config.posthogProjectKey || !config.posthogHost) return false;
    const profile = await profileStore.get();
    if ((profile.preferences.analyticsConsent || 'unset') !== 'granted') return false;
    const distinctId = await identity();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${config.posthogHost}/i/v0/e/`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: config.posthogProjectKey,
          distinct_id: distinctId,
          event,
          properties: {
            $process_person_profile: false,
            // Keep server-side analytics personless and skip GeoIP enrichment.
            // PostHog still receives ordinary HTTPS metadata such as the request IP.
            $geoip_disable: true,
            ...sanitizeAnalyticsProperties(properties),
          },
        }),
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Analytics is strictly optional and must never affect caption work.
    return false;
  }
}
