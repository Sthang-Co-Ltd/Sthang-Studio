import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCaptionText } from '@kcs/shared';

test('caption wrapping preserves Khmer combining clusters and joined emoji', () => {
  const cluster = 'កា';
  const emoji = '👩‍💻';
  assert.equal(wrapCaptionText(cluster.repeat(7), 6), `${cluster.repeat(6)}\n${cluster}`);
  assert.equal(wrapCaptionText(`${cluster.repeat(5)}${emoji}${cluster}`, 6), `${cluster.repeat(5)}${emoji}\n${cluster}`);
});

test('caption wrapping leaves word-spaced text to native layout and hard-wraps only long unbroken runs', () => {
  assert.equal(wrapCaptionText('abcdef ghijk', 8), 'abcdef ghijk');
  assert.equal(wrapCaptionText('abcdef។ghijk', 8), 'abcdef។\nghijk');
  assert.equal(wrapCaptionText('ab cdefghijk', 8), 'ab cdefghij\nk');
  assert.equal(wrapCaptionText('abcdefghijk', 8), 'abcdefgh\nijk');
});

test('caption wrapping preserves explicit nonempty lines and skips whitespace after a wrap', () => {
  assert.equal(wrapCaptionText('កម្ពុជា\r\nCapCut', 20), 'កម្ពុជា\nCapCut');
  assert.equal(wrapCaptionText('\nabc\n\ndef\n', 6), 'abc\ndef');
  assert.equal(wrapCaptionText('abcdef   ghij', 6), 'abcdef   ghij');
  assert.equal(wrapCaptionText('', 6), '');
  assert.equal(wrapCaptionText('abcdef', 6), 'abcdef');
});

test('caption wrapping retains the code-point fallback when Intl.Segmenter is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  try {
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    assert.equal(wrapCaptionText('😀'.repeat(7), 6), `${'😀'.repeat(6)}\n😀`);
    assert.equal(wrapCaptionText('abcdef ghijk', 8), 'abcdef ghijk');
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
    else Reflect.deleteProperty(Intl, 'Segmenter');
  }
});
