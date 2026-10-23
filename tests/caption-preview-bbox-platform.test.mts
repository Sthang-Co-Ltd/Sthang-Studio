import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreviewBboxes as parse } from '../apps/server/src/services/caption-preview-bbox.js';
const coord = 'x1:1 x2:2 y1:3 y2:4 w:2 h:2';
const line = (n = '0', pointer = '0xa', kind = 'caption') => `[bbox@${kind} @ ${pointer}] n:${n} pts:0 pts_time:0`;
const old = (text: string) => [...text.matchAll(/\[bbox@(caption|focus) [^\]]*\][^\r\n]*?\bn:(\d+)[^\r\n]*?\bx1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/g)].map(m => Array.from(m));
test('ordinary field indexes equal old parser for both platform tokens and streams', () => {
  for (const pointer of ['0x7f916c105580', '000001ABCDEF']) for (const kind of ['caption', 'focus']) {
    const text = `${line('0', pointer, kind)} ${coord} crop=2:2:1:3 drawbox=1:3:2:2`;
    assert.deepEqual(parse(text, 640, 360).map(x => x.slice(1)), old(text).map(x => x.slice(1)));
  }
});
test('Windows foreign writer cannot contribute inline coordinates', () => {
  assert.deepEqual(parse(`${line('0','000001ABCDEF')} [other @ 000002ABCDEF] ${coord}`,640,360), []);
});
test('all newline formats and progress prefix leave normal records intact', () => {
  for (const sep of ['\r','\n','\r\n']) {
    const result = parse(`frame=1${sep}${line()} ${coord}${sep}${line('1','0xb','focus')} ${coord}`,640,360);
    assert.equal(result.length,2);
  }
});
test('zero and signed empty extents retain null contract at boxFor indexes', () => {
  for (const c of ['x1:0 x2:0 y1:0 y2:0 w:0 h:0','x1:639 x2:0 y1:359 y2:0 w:-638 h:-358']) {
    const [row] = parse(`${line()} ${c}`,640,360);
    assert.ok(!(Number(row[7])>0 && Number(row[8])>0));
  }
});
test('unsafe coordinate and index do not publish a record', () => {
  assert.deepEqual(parse(`${line('9007199254740992')} ${coord}`,640,360),[]);
  assert.deepEqual(parse(`${line()} x1:9007199254740992 x2:2 y1:3 y2:4 w:2 h:2`,640,360),[]);
});
