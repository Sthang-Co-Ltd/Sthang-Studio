import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAnalyticsEvent } from '../infra/analytics-worker/src/index.mjs';

const valid = {
  schemaVersion: 1,
  installationId: '123e4567-e89b-42d3-a456-426614174000',
  event: 'export_completed',
  properties: {
    app_version: '0.8.0',
    platform: 'win32',
    caption_count_bucket: '<=25',
    warning_count_bucket: '<=3',
  },
};

test('analytics relay accepts only bounded personless workflow evidence', () => {
  const result = validateAnalyticsEvent(valid);
  assert.equal(result.installationId, valid.installationId);
  assert.equal(result.event, 'export_completed');
  assert.deepEqual(result.properties, valid.properties);
});

test('analytics relay rejects content/private properties and unknown events', () => {
  assert.throws(() => validateAnalyticsEvent({ ...valid, properties: { ...valid.properties, caption_text: 'សម្ងាត់' } }), /forbidden analytics property/);
  assert.throws(() => validateAnalyticsEvent({ ...valid, properties: { ...valid.properties, api_key: 'secret' } }), /forbidden analytics property/);
  assert.throws(() => validateAnalyticsEvent({ ...valid, event: 'arbitrary_event' }), /not allow-listed/);
});

test('analytics relay rejects nested, extra-top-level, and non-UUID data', () => {
  assert.throws(() => validateAnalyticsEvent({ ...valid, properties: { ...valid.properties, result: { nested: true } } }), /property value is invalid/);
  assert.throws(() => validateAnalyticsEvent({ ...valid, extra: true }), /body fields are invalid/);
  assert.throws(() => validateAnalyticsEvent({ ...valid, installationId: 'device-fingerprint' }), /invalid installationId/);
});
