import test from 'node:test';
import assert from 'node:assert/strict';
import { captionWordBreakOffsets } from '@kcs/shared';

test('native layout keeps English words intact regardless of their character count', () => {
  for (const text of ['SUBSCRIPTION', 'GENERATE', 'RECOMMEND', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'abcdef ghijk']) {
    assert.deepEqual(captionWordBreakOffsets(text), []);
  }
});

test('Khmer uses linguistic word boundaries rather than estimated grapheme lengths', () => {
  const text = 'ខ្មែរជាភាសារបស់យើង';
  assert.deepEqual(captionWordBreakOffsets(text), [5, 7, 11, 15]);
  assert.deepEqual(captionWordBreakOffsets('កម្ពុជា'), []);
  assert.deepEqual(captionWordBreakOffsets('ខ្មែរ CapCut\r\nកម្ពុជា'), []);
});

test('break opportunities preserve graphemes, coeng, joined emoji and original UTF-16 offsets', () => {
  const text = '👩‍💻 ខ្ញុំចូលចិត្តប្រទេសកម្ពុជាខ្លាំងណាស់\r\nSUBSCRIPTION ខ្មែរជាភាសា';
  const breaks = captionWordBreakOffsets(text);
  const boundaries = new Set([...new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(text)].map((part) => part.index));
  assert.ok(breaks.length > 3);
  for (const offset of breaks) {
    assert.ok(boundaries.has(offset));
    assert.notEqual(text[offset - 1], '\u17D2');
    assert.notEqual(text[offset - 1], '\u200D');
    assert.doesNotMatch(text.slice(offset), /^[\p{M}\u200D]/u);
  }
  const pieces = [0, ...breaks].map((start, index) => text.slice(start, breaks[index]));
  assert.equal(pieces.join(''), text);
});

test('no segmentation support fails safely without guessing or splitting combining characters', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  try {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    assert.deepEqual(captionWordBreakOffsets('ខ្មែរជាភាសា'), []);
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
  }
});


test('Khmer closing punctuation and explicit zero-width separators remain attached without losing break opportunities', () => {
  assert.deepEqual(captionWordBreakOffsets('ខ្មែរ។កម្ពុជា'), [6]);
  assert.deepEqual(captionWordBreakOffsets('ខ្មែរ\u200Bកម្ពុជា'), [6]);
  assert.deepEqual(captionWordBreakOffsets('ខ្មែរ,កម្ពុជា'), [6]);
  assert.deepEqual(captionWordBreakOffsets('ខ្មែរ។ កម្ពុជា'), []);
  assert.deepEqual(captionWordBreakOffsets('SUBSCRIPTION.RECOMMEND'), []);
});
