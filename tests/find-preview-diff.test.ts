import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '@kcs/shared';
import { findPreviewDiff, type FindPreviewSpan } from '../apps/web/src/find-preview-diff.js';
import { planReplacement } from '../apps/web/src/find-replace.js';

const text = (spans: FindPreviewSpan[]) => spans.map((span) => span.text).join('');
const changed = (spans: FindPreviewSpan[]) => spans.filter((span) => span.changed).map((span) => span.text).join('');
const plain = (spans: FindPreviewSpan[]) => spans.every((span) => !span.changed);

function exact(before: string, after: string) {
  const result = findPreviewDiff(before, after);
  assert.deepEqual(Buffer.from(text(result.before), 'utf16le'), Buffer.from(before, 'utf16le'));
  assert.deepEqual(Buffer.from(text(result.after), 'utf16le'), Buffer.from(after, 'utf16le'));
  return result;
}

test('multiple separated edits keep the wording between them unhighlighted', () => {
  const result = exact('cat stays cat', 'dog stays dog');
  assert.deepEqual(result.before, [{ text: 'cat', changed: true }, { text: ' stays ', changed: false }, { text: 'cat', changed: true }]);
  assert.deepEqual(result.after, [{ text: 'dog', changed: true }, { text: ' stays ', changed: false }, { text: 'dog', changed: true }]);
});

test('insertion and deletion have no invented text on the other side', () => {
  const removed = exact('Keep this word.', 'Keep word.');
  assert.equal(changed(removed.before), 'this ');
  assert.equal(changed(removed.after), '');
  const added = exact('Keep word.', 'Keep this word.');
  assert.equal(changed(added.before), '');
  assert.equal(changed(added.after), 'this ');
  assert.deepEqual(exact('word', '').after, []);
  assert.deepEqual(exact('', 'word').before, []);
});

test('Khmer vowels, emoji sequences, flags and combining accents remain whole graphemes', () => {
  const before = 'ដើរ កា 👩🏽‍💻 🇰🇭 e\u0301';
  const after = 'ដើរ កី 👩🏽‍🚀 🇰🇭 e\u0300';
  const result = exact(before, after);
  for (const [source, spans] of [[before, result.before], [after, result.after]] as const) {
    const boundaries = new Set([0, ...Array.from(new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(source), (part) => part.index + part.segment.length)]);
    let offset = 0;
    for (const span of spans) { offset += span.text.length; assert.ok(boundaries.has(offset), `Split grapheme at ${offset}`); }
  }
  for (const cluster of ['កា', '👩🏽‍💻', 'e\u0301']) assert.ok(changed(result.before).includes(cluster));
  for (const cluster of ['កី', '👩🏽‍🚀', 'e\u0300']) assert.ok(changed(result.after).includes(cluster));
  assert.ok(result.after.some((span) => !span.changed && span.text.includes('🇰🇭')));
  const composed = exact('é', 'e\u0301');
  assert.equal(changed(composed.before), 'é'); assert.equal(changed(composed.after), 'e\u0301');
});

test('locked and no-op plan entries remain unhighlighted; regex output is consumed verbatim', () => {
  const caption = (id: string, value: string, textLocked = false): CaptionSegment => ({ id, text: value, textLocked, startMs: 0, endMs: 1000 });
  const lockedPlan = planReplacement([caption('locked', 'CapCut', true)], '(Cap)(Cut)', '$2-$1', 'regex');
  const unchangedPlan = planReplacement([caption('same', 'CapCut')], 'CapCut', 'CapCut', 'literal');
  for (const entry of [...lockedPlan.entries, ...unchangedPlan.entries]) {
    const result = findPreviewDiff(entry.caption.text, entry.after, entry.changed && !entry.caption.textLocked);
    assert.ok(plain(result.before) && plain(result.after));
    assert.equal(text(result.after), entry.caption.text);
  }
  const entry = planReplacement([caption('editable', 'CapCut')], '(Cap)(Cut)', '$2-$1', 'regex').entries[0];
  assert.equal(text(findPreviewDiff(entry.caption.text, entry.after).after), 'Cut-Cap');
  const disabled = findPreviewDiff('before', 'after', false);
  assert.ok(plain(disabled.before) && plain(disabled.after));
});

test('hostile-looking text and exact whitespace remain plain presentation data', () => {
  const before = ' \t<img src=x onerror="run()">\r\n<script>old & unsafe</script>  ';
  const after = ' \t<img src=x onerror="run()">\r\n<script>new & unsafe</script>  ';
  const result = exact(before, after);
  assert.ok(result.before.every((span) => typeof span.text === 'string'));
  assert.ok(result.after.every((span) => typeof span.text === 'string'));
  assert.equal(text(result.before), before); assert.equal(text(result.after), after);
});

test('large text and expensive edit regions fall back without losing text; shared edges reduce work', () => {
  for (const [before, after] of [['a'.repeat(4001), 'b'], ['a'.repeat(300), 'b'.repeat(300)]]) {
    const result = exact(before, after);
    assert.ok(plain(result.before) && plain(result.after));
  }
  const prefix = 'a'.repeat(1500);
  const suffix = 'z'.repeat(1500);
  const trimmed = exact(`${prefix}cat${suffix}`, `${prefix}dog${suffix}`);
  assert.equal(changed(trimmed.before), 'cat'); assert.equal(changed(trimmed.after), 'dog');
});

test('missing grapheme segmentation falls back safely even after earlier highlighted calls', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  try {
    Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: undefined });
    const result = exact('កា 👩🏽‍💻', 'កី 👩🏽‍🚀');
    assert.ok(plain(result.before) && plain(result.after));
  } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
});
