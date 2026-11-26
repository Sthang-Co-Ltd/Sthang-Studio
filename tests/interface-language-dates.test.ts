import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInterfaceDate } from '../apps/web/src/i18n/dates.js';

test('Khmer dates spell out all 12 months with Western digits and an unpadded day', () => {
  const dates = [
    '2 មករា 2026', '2 កុម្ភៈ 2026', '2 មីនា 2026', '2 មេសា 2026',
    '2 ឧសភា 2026', '2 មិថុនា 2026', '2 កក្កដា 2026', '2 សីហា 2026',
    '2 កញ្ញា 2026', '2 តុលា 2026', '2 វិច្ឆិកា 2026', '2 ធ្នូ 2026',
  ];
  for (const [month, expected] of dates.entries()) {
    assert.equal(formatInterfaceDate('km', new Date(2026, month, 2)), expected);
  }
  assert.equal(formatInterfaceDate('km', '0001-11-22T14:30:00'), '22 វិច្ឆិកា 0001');
});

test('Khmer time uses 24-hour hours and minutes for Date, string and epoch inputs', () => {
  assert.equal(formatInterfaceDate('km', new Date(2026, 10, 22), { time: true }), '22 វិច្ឆិកា 2026 · 00:00');
  assert.equal(formatInterfaceDate('km', '2026-11-22T14:30:59', { time: true }), '22 វិច្ឆិកា 2026 · 14:30');
  assert.equal(formatInterfaceDate('km', new Date(2026, 10, 22, 23, 59).getTime(), { time: true }), '22 វិច្ឆិកា 2026 · 23:59');
});

test('English default date and datetime preserve the original browser formatters byte for byte', () => {
  for (const date of [new Date(2026, 10, 22, 14, 30, 59), new Date(NaN)]) {
    assert.equal(formatInterfaceDate('en', date), date.toLocaleDateString(), 'Updates');
    for (const site of ['Export history', 'History row', 'History restore label', 'Activity', 'Library date tooltip', 'Project storage', 'AI settings']) {
      assert.equal(formatInterfaceDate('en', date, { time: true }), date.toLocaleString(), site);
    }
  }
});
