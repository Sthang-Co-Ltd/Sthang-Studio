// Pure regressions for the observed split record and ambiguous metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePreviewBboxes } from '../apps/server/src/services/caption-preview-bbox.js';

const prefix = (kind = 'caption', pointer = '0xabc') => `[bbox@${kind} @ ${pointer}] `;
const coords = 'x1:139 x2:502 y1:301 y2:318 w:364 h:18';
const small = 'x1:1 x2:2 y1:3 y2:4 w:2 h:2';
const header = (n: number, kind = 'caption', pointer = '0xabc') =>
  `${prefix(kind, pointer)}n:${n} pts:${2600 + n * 100} pts_time:${2.6 + n / 10}`;
const parse = (text: string) => parsePreviewBboxes(text, 640, 360);
const box = (rows: string[][], n: number, kind = 'caption') => {
  const row = rows.find((value) => value[1] === kind && Number(value[2]) === n);
  return row && Number(row[7]) > 0 && Number(row[8]) > 0
    ? { x: Number(row[3]), y: Number(row[5]), width: Number(row[7]), height: Number(row[8]) } : null;
};
const expected = { x: 139, y: 301, width: 364, height: 18 };
const oldParse = (stderr: string) => [...stderr.matchAll(/\[bbox@(caption|focus) [^\]]*\][^\r\n]*?\bn:(\d+)[^\r\n]*?\bx1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/g)].map((match) => Array.from(match));

test('literal observed stderr: old parser loses n3, context parser restores it', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-preview-bbox-interleaved.json', import.meta.url), 'utf8'));
  assert.equal(box(oldParse(fixture.parserStderr), 3), null);
  const result = parse(fixture.parserStderr);
  assert.deepEqual(box(result, 3), expected);
  assert.deepEqual(result.map((row) => Number(row[2])), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(box(result, 8), expected); // Do not discard lookahead record.
  for (const n of [0, 1, 2, 4, 5, 6, 7, 8]) {
    assert.deepEqual(box(result, n), box(oldParse(fixture.parserStderr), n));
  }
});
test('ordinary one-line record and diagnostic indexes unchanged', () => {
  const rows = parse(`${header(0)} ${coords}`);
  assert.equal(rows[0].length, 9);
  assert.deepEqual(box(rows, 0), expected);
});
test('warning-interrupted record with repeated context prefix', () => {
  assert.deepEqual(box(parse(`${header(3)}Application provided invalid dts\n${prefix()} ${coords}`), 3), expected);
});
test('caption and focus continuations remain isolated', () => {
  const rows = parse(`${header(3)}\n${header(3, 'focus')}\n${prefix()}${coords}\n${prefix('focus')}${small}`);
  assert.deepEqual(box(rows, 3), expected);
  assert.deepEqual(box(rows, 3, 'focus'), { x: 1, y: 3, width: 2, height: 2 });
});
test('same kind but different pointers do not cross-associate', () => {
  assert.equal(box(parse(`${header(3)}\n${prefix('caption', '0xdef')}${coords}`), 3), null);
});
test('orphan continuation is ignored', () => {
  assert.deepEqual(parse(`${prefix()}${coords}`), []);
});
test('blank header does not inherit previous coordinates', () => {
  const rows = parse(`${header(0)} ${coords}\n${header(1)}\n${header(2)} ${small}`);
  assert.deepEqual(box(rows, 0), expected);
  assert.equal(box(rows, 1), null);
  assert.notEqual(box(rows, 2), null);
});
test('header supersedes incomplete earlier frame', () => {
  const rows = parse(`${header(0)}\n${header(1)}\n${prefix()}${coords}`);
  assert.equal(box(rows, 0), null);
  assert.deepEqual(box(rows, 1), expected);
});
test('explicit empty extents never produce a box', () => {
  assert.equal(box(parse(`${header(0)} x1:639 x2:0 y1:359 y2:0 w:-638 h:-358`), 0), null);
});
test('unprefixed continuation is rejected even with only one candidate', () => {
  assert.equal(box(parse(`${header(0)}\n${coords}`), 0), null);
});
test('ambiguous anonymous continuation poisons pending candidates', () => {
  const rows = parse(`${header(0)}\n${header(0, 'focus')}\n${coords}\n${prefix()}${coords}\n${prefix('focus')}${small}`);
  assert.equal(box(rows, 0), null);
  assert.equal(box(rows, 0, 'focus'), null);
});
test('conflicting coordinate-only duplicate fails closed', () => {
  assert.equal(box(parse(`${header(0)} ${coords}\n${prefix()}${small}`), 0), null);
});
test('conflicting repeated header fails closed, not first match wins', () => {
  assert.equal(box(parse(`${header(0)} ${coords}\n${header(0)} ${small}`), 0), null);
});
test('identical repeated header can collapse', () => {
  const rows = parse(`${header(0)} ${coords}\n${header(0)} ${coords}`);
  assert.equal(rows.length, 1);
  assert.deepEqual(box(rows, 0), expected);
});
test('same frame across distinct contexts fails closed even with equal coords', () => {
  assert.equal(box(parse(`${header(0)} ${coords}\n${header(0, 'caption', '0xdef')} ${coords}`), 0), null);
});
test('header-only duplicate conflicts with populated duplicate', () => {
  assert.equal(box(parse(`${header(0)} ${coords}\n${header(0)}`), 0), null);
});
test('CRLF, CR progress separator, and multiple prefixes on one line', () => {
  const rows = parse(`progress\r${header(0)} ${coords}\r\n${header(1)} ${coords}${header(1, 'focus')} ${small}`);
  assert.deepEqual(box(rows, 0), expected);
  assert.deepEqual(box(rows, 1), expected);
  assert.notEqual(box(rows, 1, 'focus'), null);
});
test('malformed or out-of-frame coordinates fail closed', () => {
  for (const value of ['x1:139 x2:502 y1:301', 'x1:139 x2:502 y1:301 y2:318 w:365 h:18', 'x1:639 x2:640 y1:3 y2:4 w:2 h:2', 'x1:-1 x2:0 y1:3 y2:4 w:2 h:2']) {
    assert.equal(box(parse(`${header(0)} ${value}`), 0), null);
  }
});
test('truncated tail without a header cannot invent a frame', () => {
  assert.deepEqual(parse(`pts_time:2.9\n${prefix()}${coords}`), []);
});
test('Windows plain hexadecimal context token is matched exactly', () => {
  const rows = parse(`${header(3, 'caption', '000001ABCDEF1234')}\n${prefix('caption', '000001ABCDEF1234')}${coords}`);
  assert.deepEqual(box(rows, 3), expected);
});
test('conflicting anonymous inline coordinate tuple fails closed', () => {
  assert.equal(box(parse(`${header(0)} ${coords} ${small}`), 0), null);
});
test('anonymous frame header prevents stale explicit continuation association', () => {
  const rows = parse(`${header(0)}\nn:1 pts:2700 pts_time:2.7\n${prefix()}${coords}`);
  assert.equal(box(rows, 0), null);
  assert.equal(box(rows, 1), null);
});
test('anonymous breaks retain completed records but discard later orphan continuation', () => {
  const rows = parse(`${header(0)} ${coords}\nn:1 pts:2700 pts_time:2.7\n${prefix()}${small}`);
  assert.deepEqual(box(rows, 0), expected);
  assert.equal(box(rows, 1), null);
});
test('Windows foreign context cannot donate coordinates', () => {
  assert.deepEqual(parse('[bbox@caption @ 000001ABCDEF] n:0 pts:0 pts_time:0 [other @ 000002ABCDEF] x1:1 x2:2 y1:3 y2:4 w:2 h:2'), []);
});
