import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAnalyticsProperties } from '../apps/server/src/services/analytics.ts';

test('analytics sanitizer keeps only the fixed coarse-property vocabulary', () => {
  const value = sanitizeAnalyticsProperties({
    job_type: 'transcribe',
    caption_count_bucket: '<=25',
    choice: 'granted',
    caption_text: 'កុំផ្ញើខ្ញុំ',
    project_name: 'private client project',
    filename: 'private-video.mp4',
    local_path: 'C:\\Users\\creator\\private.mp4',
    context: 'private topic context',
    api_key: 'secret',
    contributor_id: 'must-not-link-identities',
    app_version: 'attacker-overwrite',
    platform: 'attacker-overwrite',
  });

  assert.equal(value.job_type, 'transcribe');
  assert.equal(value.caption_count_bucket, '<=25');
  assert.ok(value.app_version);
  assert.ok(value.platform);
  for (const forbidden of [
    'choice', 'caption_text', 'project_name', 'filename', 'local_path', 'context', 'api_key', 'contributor_id',
  ]) assert.equal(forbidden in value, false, forbidden);
  assert.notEqual(value.app_version, 'attacker-overwrite');
  assert.notEqual(value.platform, 'attacker-overwrite');
});

test('analytics sanitizer drops objects and non-finite numbers', () => {
  const value = sanitizeAnalyticsProperties({
    result: { nested: 'not allowed' },
    timing_ms_bucket: Number.NaN,
    warning_count_bucket: '<=3',
  });
  assert.equal('result' in value, false);
  assert.equal('timing_ms_bucket' in value, false);
  assert.equal(value.warning_count_bucket, '<=3');
});
