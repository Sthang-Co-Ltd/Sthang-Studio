import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptionWordTiming, type CaptionSegment, type CaptionWord } from '@kcs/shared';
import { mergeCaptionsForEditing, splitCaptionForEditing } from '../apps/web/src/caption-word-structure.js';

function word(text: string, value: string, id: string, startMs: number | null, endMs: number | null, extra: Partial<CaptionWord> = {}): CaptionWord {
  const startOffset = text.indexOf(value);
  assert.notEqual(startOffset, -1, `missing ${value} in ${text}`);
  return {
    id,
    startOffset,
    endOffset: startOffset + value.length,
    startMs,
    endMs,
    source: startMs === null || endMs === null ? 'estimated' : 'aligned',
    needsReview: startMs === null || endMs === null ? true : undefined,
    ...extra,
  };
}

function caption(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return { id: 'cue', text: 'alpha beta gamma', startMs: 0, endMs: 3_000, ...overrides };
}

test('split prefers a valid stored word boundary and preserves ready/partial owned spans', () => {
  const text = 'alpha beta gamma';
  const source = caption({ text });
  source.wordTiming = {
    version: 1,
    text,
    words: [
      word(text, 'alpha', 'alpha', 100, 800),
      word(text, 'beta', 'beta', null, null),
      word(text, 'gamma', 'gamma', 2_100, 2_800),
    ],
  };
  assert.equal(resolveCaptionWordTiming(source).state, 'partial');

  const split = splitCaptionForEditing(source, 'left', 'right');
  assert.ok(split);
  const [left, right] = split;
  assert.equal(left.text, 'alpha');
  assert.equal(right.text, 'beta gamma');
  assert.equal(left.endMs, 1_500);
  assert.equal(right.startMs, 1_500);
  assert.deepEqual(left.wordTiming?.words.map((item) => item.id), ['alpha']);
  assert.deepEqual(right.wordTiming?.words.map((item) => [item.id, item.startOffset, item.endOffset, item.startMs]), [
    ['beta', 0, 4, null],
    ['gamma', 5, 10, 2_100],
  ]);
  assert.equal(resolveCaptionWordTiming(left).state, 'ready');
  assert.equal(resolveCaptionWordTiming(right).state, 'partial');
  assert.equal(left.timingSource, 'manual');
  assert.equal(right.approved, false);
});

test('split falls back to an ICU word boundary and clears absent or malformed maps', () => {
  const source = caption({ text: 'one two three' });
  const split = splitCaptionForEditing(source, 'a', 'b');
  assert.ok(split);
  assert.deepEqual(split.map((item) => item.text), ['one two', 'three']);
  assert.equal(split[0].wordTiming, undefined);
  assert.equal(split[1].wordTiming, undefined);

  const malformed = {
    ...source,
    wordTiming: { version: 1, text: source.text, words: undefined } as unknown as NonNullable<CaptionSegment['wordTiming']>,
  };
  const safe = splitCaptionForEditing(malformed, 'c', 'd');
  assert.ok(safe);
  assert.equal(safe[0].wordTiming, undefined);
  assert.equal(safe[1].wordTiming, undefined);
});

test('split uses grapheme fallback for one unbroken unit and never splits a grapheme cluster', () => {
  const source = caption({ text: 'កាកាកា', startMs: 0, endMs: 1_000 });
  const split = splitCaptionForEditing(source, 'left', 'right');
  assert.ok(split);
  assert.equal(split[0].text + split[1].text, source.text);
  assert.ok(split[0].text.length > 0 && split[1].text.length > 0);
  assert.equal(split[0].wordTiming, undefined);
  assert.equal(split[1].wordTiming, undefined);
});

test('split and merge are blocked by text/timing locks', () => {
  assert.equal(splitCaptionForEditing(caption({ textLocked: true }), 'a', 'b'), null);
  assert.equal(splitCaptionForEditing(caption({ timingLocked: true }), 'a', 'b'), null);
  const left = caption({ id: 'l', text: 'left', startMs: 0, endMs: 500 });
  const right = caption({ id: 'r', text: 'right', startMs: 500, endMs: 1_000 });
  assert.equal(mergeCaptionsForEditing({ ...left, textLocked: true }, right, 'm'), null);
  assert.equal(mergeCaptionsForEditing(left, { ...right, timingLocked: true }, 'm'), null);
});

test('merge copies CaptionEditor Khmer/punctuation joins and rebases partial word timing exactly', () => {
  const leftText = 'ខ្មែរ ';
  const rightText = ' កម្ពុជា!';
  const left = caption({ id: 'l', text: leftText, startMs: 0, endMs: 900 });
  left.wordTiming = { version: 1, text: leftText, words: [word(leftText, 'ខ្មែរ', 'left-word', 100, 700)] };
  const right = caption({ id: 'r', text: rightText, startMs: 900, endMs: 1_800 });
  right.wordTiming = { version: 1, text: rightText, words: [word(rightText, 'កម្ពុជា!', 'right-word', null, null)] };
  assert.equal(resolveCaptionWordTiming(left).state, 'ready');
  assert.equal(resolveCaptionWordTiming(right).state, 'partial');

  const merged = mergeCaptionsForEditing(left, right, 'merged');
  assert.ok(merged);
  assert.equal(merged.text, 'ខ្មែរកម្ពុជា!');
  assert.deepEqual(merged.wordTiming?.words.map((item) => [item.id, item.startOffset, item.endOffset, item.startMs]), [
    ['left-word', 0, 'ខ្មែរ'.length, 100],
    ['right-word', 'ខ្មែរ'.length, merged.text.length, null],
  ]);
  assert.equal(resolveCaptionWordTiming(merged).state, 'partial');
  assert.equal(merged.timingSource, 'manual');
  assert.equal(merged.timingQuality, 'medium');
  assert.equal(merged.approved, false);

  const punctuation = mergeCaptionsForEditing(
    caption({ id: 'p1', text: 'Hello ', startMs: 0, endMs: 500 }),
    caption({ id: 'p2', text: ' !', startMs: 500, endMs: 1_000 }),
    'p',
  );
  assert.equal(punctuation?.text, 'Hello!');
});

test('merge avoids duplicate word ids and drops malformed timing without blocking the text merge', () => {
  const leftText = 'one';
  const rightText = ' two';
  const left = caption({ id: 'l', text: leftText, startMs: 0, endMs: 500 });
  left.wordTiming = { version: 1, text: leftText, words: [word(leftText, 'one', 'dup', 50, 400)] };
  const right = caption({ id: 'r', text: rightText, startMs: 500, endMs: 1_000 });
  right.wordTiming = { version: 1, text: rightText, words: [word(rightText, 'two', 'dup', 550, 900)] };

  const merged = mergeCaptionsForEditing(left, right, 'joined');
  assert.ok(merged?.wordTiming);
  assert.equal(merged.text, 'one two');
  assert.equal(new Set(merged.wordTiming.words.map((item) => item.id)).size, 2);
  assert.equal(merged.wordTiming.words[0].id, 'dup');
  assert.notEqual(merged.wordTiming.words[1].id, 'dup');
  assert.equal(resolveCaptionWordTiming(merged).state, 'ready');

  const malformed = {
    ...right,
    wordTiming: { version: 1, text: rightText, words: [{ bad: true }] } as unknown as NonNullable<CaptionSegment['wordTiming']>,
  };
  const safe = mergeCaptionsForEditing(left, malformed, 'safe');
  assert.ok(safe);
  assert.equal(safe.text, 'one two');
  assert.equal(safe.wordTiming, undefined);
});

test('merge never upgrades a structurally valid partial input to ready by widening cue bounds', () => {
  const leftText = 'one';
  const rightText = ' two';
  const left = caption({ id: 'l', text: leftText, startMs: 0, endMs: 500 });
  left.wordTiming = { version: 1, text: leftText, words: [word(leftText, 'one', 'one', 50, 400)] };
  const right = caption({ id: 'r', text: rightText, startMs: 500, endMs: 1_000 });
  right.wordTiming = { version: 1, text: rightText, words: [word(rightText, 'two', 'two', 450, 900)] };
  assert.equal(resolveCaptionWordTiming(right).state, 'partial', 'right word starts outside its cue');

  const merged = mergeCaptionsForEditing(left, right, 'merged-partial');
  assert.ok(merged?.wordTiming);
  assert.equal(merged.wordTiming.words[1].needsReview, true);
  assert.equal(resolveCaptionWordTiming(merged).state, 'partial');
});

test('merging nested captions preserves the entire time span and does not invent sequential word timing', () => {
  const left = caption({ id: 'long', text: 'one', startMs: 0, endMs: 1_200 });
  left.wordTiming = { version: 1, text: left.text, words: [word(left.text, 'one', 'one', 50, 1_150)] };
  const right = caption({ id: 'nested', text: 'two', startMs: 500, endMs: 700 });
  right.wordTiming = { version: 1, text: right.text, words: [word(right.text, 'two', 'two', 510, 690)] };
  const originals = structuredClone([left, right]);

  for (const [first, second] of [[left, right], [right, left]]) {
    const merged = mergeCaptionsForEditing(first, second, 'merged-nested');
    assert.ok(merged?.wordTiming);
    assert.equal(merged.startMs, 0);
    assert.equal(merged.endMs, 1_200, 'the longer caption must not be shortened by the merge');
    assert.deepEqual(merged.wordTiming.words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
      [first, second].flatMap((item) => item.wordTiming!.words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))));
    assert.equal(resolveCaptionWordTiming(merged).state, 'partial', 'overlapping word intervals still require review');
  }
  assert.deepEqual([left, right], originals);
});
