import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp, parseTimestamp, validateTimestamp } from '../apps/web/src/timestamp';

test('timestamp parser accepts only complete supported forms and returns integer milliseconds', () => {
  assert.equal(parseTimestamp('2:03'), 123_000);
  assert.equal(parseTimestamp('2:03.4'), 123_400);
  assert.equal(parseTimestamp('2:03.45'), 123_450);
  assert.equal(parseTimestamp('02:03.004'), 123_004);
  assert.equal(parseTimestamp('1:02:03'), 3_723_000);
  assert.equal(parseTimestamp('1:02:03.4'), 3_723_400);
  assert.equal(parseTimestamp('1:02:03.45'), 3_723_450);
  assert.equal(parseTimestamp('1:02:03.456'), 3_723_456);
  assert.equal(parseTimestamp('12'), 12_000);
  assert.equal(parseTimestamp('12.3'), 12_300);
  assert.equal(parseTimestamp('12.34'), 12_340);
  assert.equal(parseTimestamp('12.345'), 12_345);

  for (const malformed of ['', '1:', '1:2', '1:02.', '1:02.3456', '1:60', '1:2:03', '1:02:60', '1:02:03.', '1:02:03.4567', '.5', '1.2345', '-1', ' 1:02.003 ']) {
    assert.equal(parseTimestamp(malformed), null, malformed);
  }
});

test('timestamp formatter emits millisecond precision and switches to hour form at one hour', () => {
  assert.equal(formatTimestamp(0), '00:00.000');
  assert.equal(formatTimestamp(62_003), '01:02.003');
  assert.equal(formatTimestamp(3_599_999), '59:59.999');
  assert.equal(formatTimestamp(3_600_000), '1:00:00.000');
  assert.equal(formatTimestamp(3_723_456), '1:02:03.456');
});

test('timestamp validation rejects values outside explicit bounds without coercing them', () => {
  assert.deepEqual(validateTimestamp('1.500', { minMs: 1_000, maxMs: 2_000 }), { ok: true, valueMs: 1_500 });
  assert.deepEqual(validateTimestamp('0.999', { minMs: 1_000 }), { ok: false, error: 'Earliest 00:01.000.' });
  assert.deepEqual(validateTimestamp('2.001', { maxMs: 2_000 }), { ok: false, error: 'Latest 00:02.000.' });
  assert.deepEqual(validateTimestamp('1.500', { minMs: 2_000, maxMs: 1_000 }), { ok: false, error: 'Adjust the other time first.' });
  assert.deepEqual(validateTimestamp('1:', { minMs: 0, maxMs: 2_000 }), {
    ok: false,
    error: 'Use m:ss / h:mm:ss / seconds (≤3 decimals).',
  });
});
