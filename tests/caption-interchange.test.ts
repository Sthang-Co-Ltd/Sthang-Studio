import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '../packages/shared/src/index.js';
import {
  CAPTION_DATA_LIMITS,
  analyzeCaptionInterchange,
  createCaptionData,
  parseCaptionData,
  serializeCaptionFile,
  serializeSrt,
  serializeTtml,
  serializeVtt,
  serializeWordSrt,
  serializeWordVtt,
} from '../packages/shared/src/caption-interchange.js';
import { DEFAULT_CAPTION_APPEARANCE } from '../packages/shared/src/caption-settings.js';

function cue(overrides: Partial<CaptionSegment> = {}): CaptionSegment {
  return {
    id: 'cue-1',
    text: 'សួស្តី world',
    startMs: 1_000,
    endMs: 2_000,
    ...overrides,
  };
}

function readyLiteralCue(): CaptionSegment {
  const text = '👋 Hello, world! 😊';
  const first = text.indexOf('Hello');
  const second = text.indexOf('world');
  return cue({
    id: 'literal',
    text,
    startMs: 100,
    endMs: 1_000,
    wordTiming: {
      version: 1,
      text,
      words: [
        { id: 'hello', startOffset: first, endOffset: first + 5, startMs: 120, endMs: 400, source: 'aligned' },
        { id: 'world', startOffset: second, endOffset: second + 5, startMs: 520, endMs: 880, source: 'aligned' },
      ],
    },
  });
}

test('plain SRT is stable start-sorted UTF-8 text with CRLF separators and no silent omission', () => {
  const later = cue({ id: 'later', text: 'ទីពីរ\nline', startMs: 2_000, endMs: 3_000 });
  const earlier = cue({ id: 'earlier', text: 'ទីមួយ', startMs: 500, endMs: 1_250 });
  const result = serializeSrt({ captions: [later, earlier] });
  assert.ok(result.text.startsWith('\ufeff1\r\n00:00:00,500 --> 00:00:01,250\r\nទីមួយ'));
  assert.match(result.text, /\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nទីពីរ\r\nline\r\n$/u);
  assert.equal(/(^|[^\r])\n/u.test(result.text), false, 'all physical line endings are CRLF');
  assert.ok(result.warnings.some((warning) => warning.code === 'cue-order-normalized'));
  assert.ok(result.warnings.some((warning) => warning.code === 'text-line-endings-normalized'));
});

test('plain serializers reject invalid/empty cues instead of omitting them', () => {
  assert.throws(() => serializeSrt({ captions: [cue({ text: '   ' })] }), /no text/i);
  assert.throws(() => serializeVtt({ captions: [cue({ startMs: 2_000, endMs: 2_000 })] }), /invalid timing/i);
  assert.throws(() => serializeTtml({ captions: [cue({ endMs: 2_001 })], durationMs: 2_000 }), /after the supplied media duration/i);
  assert.throws(() => serializeSrt({ captions: [cue({ text: `bad\u0000text` })] }), /control characters/i);
  assert.throws(() => serializeVtt({ captions: [cue({ text: `bad${String.fromCharCode(0xD800)}text` })] }), /invalid Unicode surrogate/i);
  assert.throws(() => serializeSrt({ captions: [cue({ text: 'line one\n\nline three' })] }), /blank line/i);
  assert.throws(() => serializeVtt({ captions: [cue({ text: 'line one\r\n \r\nline three' })] }), /blank line/i);
  assert.throws(() => serializeSrt({ captions: [cue({ text: '\nhello' })] }), /blank line/i);
  assert.throws(() => serializeVtt({ captions: [cue({ text: '   \nhello' })] }), /blank line/i);
  assert.throws(() => serializeSrt({ captions: [cue({ text: 'hello\n' })] }), /blank line/i);
});

test('subtitle derivatives round fractional milliseconds to exactly three digits and reject collapsed intervals', () => {
  const fractional = cue({ startMs: 123.375, endMs: 456.625, text: 'fraction' });
  for (const result of [serializeSrt({ captions: [fractional] }), serializeVtt({ captions: [fractional] }), serializeTtml({ captions: [fractional] })]) {
    assert.ok(result.warnings.some((warning) => warning.code === 'timing-rounded-to-millisecond'));
  }
  assert.match(serializeSrt({ captions: [fractional] }).text, /00:00:00,123 --> 00:00:00,457/u);
  assert.match(serializeVtt({ captions: [fractional] }).text, /00:00:00\.123 --> 00:00:00\.457/u);
  assert.match(serializeTtml({ captions: [fractional] }).text, /begin="00:00:00\.123" end="00:00:00\.457"/u);

  const collapsed = cue({ startMs: 100.1, endMs: 100.4, text: 'too short after rounding' });
  assert.throws(() => serializeSrt({ captions: [collapsed] }), /collapses after rounding/i);
  assert.throws(() => serializeVtt({ captions: [collapsed] }), /collapses after rounding/i);
  assert.throws(() => serializeTtml({ captions: [collapsed] }), /collapses after rounding/i);
});

test('WebVTT escapes cue markup characters while preserving visible Unicode and start ordering', () => {
  const result = serializeVtt({ captions: [
    cue({ id: 'b', text: '<Khmer> & emoji 😊', startMs: 2_000, endMs: 2_500 }),
    cue({ id: 'a', text: 'A > B', startMs: 100, endMs: 900 }),
  ] });
  assert.ok(result.text.startsWith('WEBVTT\r\n\r\n00:00:00.100 --> 00:00:00.900\r\nA &gt; B'));
  assert.match(result.text, /00:00:02\.000 --> 00:00:02\.500\r\n&lt;Khmer&gt; &amp; emoji 😊/u);
});

test('plain TTML XML-escapes text, preserves explicit line breaks and does not embed appearance styling', () => {
  const result = serializeTtml({
    captions: [cue({ text: 'A & <B>\n\nខ្មែរ' })],
    appearance: { fontFamily: 'Khmer UI', highlightMode: 'word', highlightColor: '#D7FF4F' },
  });
  assert.match(result.text, /<tt xmlns="http:\/\/www\.w3\.org\/ns\/ttml" xml:lang="und">/u);
  assert.match(result.text, /<body xml:space="preserve">/u);
  assert.match(result.text, /A &amp; &lt;B&gt;<br\/><br\/>ខ្មែរ/u);
  assert.doesNotMatch(result.text, /Khmer UI|D7FF4F|highlight/u);
  assert.ok(result.warnings.some((warning) => warning.code === 'appearance-not-transferred'));
});

test('word SRT/VTT require fully ready timing and partition punctuation/emoji/whitespace exactly', () => {
  const caption = readyLiteralCue();
  const srt = serializeWordSrt({ captions: [caption] });
  assert.match(srt.text, /00:00:00,120 --> 00:00:00,400\r\n👋 Hello, /u);
  assert.match(srt.text, /00:00:00,520 --> 00:00:00,880\r\nworld! 😊/u);
  assert.ok(srt.warnings.some((warning) => warning.code === 'word-file-presentation-differs'));

  const vtt = serializeWordVtt({ captions: [caption] });
  assert.match(vtt.text, /00:00:00\.120 --> 00:00:00\.400\r\n👋 Hello, /u);
  assert.match(vtt.text, /00:00:00\.520 --> 00:00:00\.880\r\nworld! 😊/u);
  assert.ok(vtt.warnings.some((warning) => warning.code === 'word-vtt-no-highlight-guarantee'));

  const partial = structuredClone(caption);
  partial.wordTiming!.words[0].needsReview = true;
  assert.throws(() => serializeWordSrt({ captions: [partial] }), /requires every caption to be ready/i);
  assert.throws(() => serializeWordVtt({ captions: [cue({ id: 'missing' })] }), /requires every caption to be ready/i);
});

test('word VTT escapes literal payload text instead of treating it as cue markup', () => {
  const text = 'A&B <C>';
  const caption = cue({
    text,
    startMs: 0,
    endMs: 1_000,
    wordTiming: {
      version: 1,
      text,
      words: [
        { id: 'a', startOffset: 0, endOffset: 3, startMs: 100, endMs: 350, source: 'aligned' },
        { id: 'c', startOffset: 4, endOffset: 7, startMs: 500, endMs: 800, source: 'aligned' },
      ],
    },
  });
  const result = serializeWordVtt({ captions: [caption] });
  assert.match(result.text, /A&amp;B /u);
  assert.match(result.text, /&lt;C&gt;/u);
});

test('word subtitle derivatives round raw fractional aligned times to exact millisecond stamps', () => {
  const caption = readyLiteralCue();
  caption.wordTiming!.words[0].startMs = 123.375;
  caption.wordTiming!.words[0].endMs = 400.49;
  caption.wordTiming!.words[1].startMs = 520.51;
  caption.wordTiming!.words[1].endMs = 879.6;
  const vtt = serializeWordVtt({ captions: [caption] });
  assert.match(vtt.text, /00:00:00\.123 --> 00:00:00\.400/u);
  assert.match(vtt.text, /00:00:00\.521 --> 00:00:00\.880/u);
  assert.ok(vtt.warnings.some((warning) => warning.code === 'timing-rounded-to-millisecond'));
});

test('caption data is an explicit projection with exact partial word state and appearance, excluding ids/baggage', () => {
  const text = 'ខ្មែរ AI';
  const caption = cue({
    id: 'private-id', text, confidence: 0.75, timingQuality: 'medium', timingSource: 'manual', approved: false, textLocked: true,
    wordTiming: {
      version: 1,
      text,
      words: [
        { id: 'private-word-id', startOffset: 0, endOffset: 5, startMs: 1_050, endMs: 1_400, source: 'manual' },
        { id: 'untimed', startOffset: 6, endOffset: 8, startMs: null, endMs: null, source: 'estimated', needsReview: true },
      ],
    },
  }) as CaptionSegment & { projectId?: string; localPath?: string; context?: string };
  caption.projectId = 'must-not-export';
  caption.localPath = 'C:\\private\\clip.mp4';
  caption.context = 'secret topic';
  const document = createCaptionData({
    captions: [caption], durationMs: 2_500,
    appearance: { fontFamily: 'Noto Sans Khmer', highlightMode: 'word', highlightColor: '#aabbcc' },
  });
  const serialized = JSON.stringify(document);
  assert.equal('id' in document.captions[0], false);
  assert.equal('id' in document.captions[0].wordTiming!.words[0], false);
  assert.doesNotMatch(serialized, /private-id|private-word-id|must-not-export|private\\\\clip|secret topic/u);
  assert.deepEqual(document.captions[0].wordTiming!.words[1], {
    startOffset: 6, endOffset: 8, startMs: null, endMs: null, source: 'estimated', needsReview: true,
  });
  assert.deepEqual(document.appearance, { fontFamily: 'Noto Sans Khmer', highlightMode: 'word', highlightColor: '#aabbcc' });
});

test('data file roundtrips the safe projection exactly and uses CRLF physical lines', () => {
  const input = {
    captions: [readyLiteralCue(), cue({ id: 'plain', text: 'second', startMs: 2_000, endMs: 2_500, approved: true })],
    durationMs: 3_000,
    appearance: { alignment: 'center' as const, maxWidthPct: 82 },
  };
  const expected = createCaptionData(input);
  const file = serializeCaptionFile(input, 'data');
  assert.equal(file.extension, '.sthang-captions.json');
  assert.equal(/(^|[^\r])\n/u.test(file.text), false);
  assert.deepEqual(parseCaptionData(file.text), expected);
});

test('caption data stays v1 and omits default effect keys for old-reader compatibility', () => {
  const document = createCaptionData({
    captions: [cue()],
    appearance: { ...DEFAULT_CAPTION_APPEARANCE },
  });
  assert.equal(document.version, 1);
  assert.ok(document.appearance);
  for (const key of ['glowEnabled', 'glowColor', 'glowWidth1080', 'glowOpacity', 'motionPreset', 'motionDurationMs']) {
    assert.equal(key in document.appearance!, false, `${key} must stay out of v1 caption data`);
  }
  assert.deepEqual(parseCaptionData(JSON.stringify(document)), document);
});

test('caption data uses v2 for nondefault effects and roundtrips the strict effect state', () => {
  const document = createCaptionData({
    captions: [cue()],
    appearance: {
      alignment: 'left',
      glowEnabled: true,
      glowColor: '#ABCDEF',
      glowWidth1080: 12,
      glowOpacity: 0.7,
      motionPreset: 'fade',
      motionDurationMs: 230,
    },
  });
  assert.equal(document.version, 2);
  assert.deepEqual(document.appearance, {
    alignment: 'left',
    glowEnabled: true,
    glowColor: '#ABCDEF',
    glowWidth1080: 12,
    glowOpacity: 0.7,
    motionPreset: 'fade',
    motionDurationMs: 230,
  });
  assert.deepEqual(parseCaptionData(JSON.stringify(document)), document);
});

test('caption data uses v3 only for rise and soft-pop motion and roundtrips both presets', () => {
  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    const document = createCaptionData({
      captions: [cue()],
      appearance: {
        alignment: 'right',
        glowEnabled: true,
        motionPreset,
        motionDurationMs: 240,
      },
    });
    assert.equal(document.version, 3);
    assert.equal(document.appearance?.motionPreset, motionPreset);
    assert.equal(document.appearance?.motionDurationMs, 240);
    assert.deepEqual(parseCaptionData(JSON.stringify(document)), document);
  }
});

test('caption data preserves fractional cue, word and media duration milliseconds exactly', () => {
  const caption = readyLiteralCue();
  caption.startMs = 100.125;
  caption.endMs = 2_000.875;
  caption.wordTiming!.words[0].startMs = 123.375;
  caption.wordTiming!.words[0].endMs = 456.625;
  const input = { captions: [caption], durationMs: 90_511.375 };
  const document = createCaptionData(input);
  assert.equal(document.durationMs, 90_511.375);
  assert.equal(document.captions[0].startMs, 100.125);
  assert.equal(document.captions[0].endMs, 2_000.875);
  assert.equal(document.captions[0].wordTiming!.words[0].startMs, 123.375);
  assert.equal(document.captions[0].wordTiming!.words[0].endMs, 456.625);
  assert.deepEqual(parseCaptionData(JSON.stringify(document)), document);
});

test('data parser rejects unknown file/version/fields and stale or malformed word maps', () => {
  const base = createCaptionData({ captions: [readyLiteralCue()] });
  assert.throws(() => parseCaptionData(JSON.stringify({ ...base, kind: 'other-caption-data' })), /unknown caption data file kind/i);
  assert.throws(() => parseCaptionData(JSON.stringify({ ...base, version: 4 })), /unsupported caption data version/i);
  assert.throws(() => parseCaptionData(JSON.stringify({ ...base, localPath: 'C:\\secret' })), /unsupported field/i);
  assert.throws(() => parseCaptionData(JSON.stringify({ ...base, captions: [{ ...base.captions[0], unknown: true }] })), /unsupported field/i);
  assert.throws(() => parseCaptionData(JSON.stringify({ ...base, captions: [{ ...base.captions[0], id: 'imported-id' }] })), /unsupported field/i);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...base,
    captions: [{
      ...base.captions[0],
      wordTiming: {
        ...base.captions[0].wordTiming!,
        words: [{ ...base.captions[0].wordTiming!.words[0], id: 'imported-word-id' }, ...base.captions[0].wordTiming!.words.slice(1)],
      },
    }],
  })), /unsupported field/i);

  const stale = structuredClone(base);
  stale.captions[0].wordTiming!.text = `${stale.captions[0].text}!`;
  assert.throws(() => parseCaptionData(JSON.stringify(stale)), /snapshot is stale/i);

  const malformed = structuredClone(base);
  malformed.captions[0].wordTiming!.words[0].endOffset = 1;
  assert.throws(() => parseCaptionData(JSON.stringify(malformed)), /stale or malformed/i);
});

test('caption data versions enforce effect allowlists, future fields and effect bounds', () => {
  const base = createCaptionData({ captions: [cue()] });
  assert.equal(base.version, 1);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...base,
    appearance: { glowEnabled: false },
  })), /unsupported field/i);

  const v2 = createCaptionData({ captions: [cue()], appearance: { glowEnabled: true } });
  assert.equal(v2.version, 2);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...v2,
    appearance: { ...v2.appearance, glowBlendMode: 'future' },
  })), /unsupported field/i);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...v2,
    appearance: { ...v2.appearance, glowWidth1080: 17 },
  })), /supported range/i);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...v2,
    appearance: { ...v2.appearance, glowOpacity: -0.01 },
  })), /supported range/i);
  assert.throws(() => createCaptionData({
    captions: [cue()],
    appearance: { motionPreset: 'fade', motionDurationMs: 165 },
  }), /10 ms step/i);
});

test('v1 and v2 readers reject newer motion while v2 fade compatibility stays unchanged', () => {
  const defaultDocument = createCaptionData({ captions: [cue()] });
  assert.equal(defaultDocument.version, 1);
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...defaultDocument,
    appearance: { motionPreset: 'rise' },
  })), /unsupported field/i);

  const fade = createCaptionData({
    captions: [cue()],
    appearance: { motionPreset: 'fade', motionDurationMs: 220 },
  });
  assert.equal(fade.version, 2);
  assert.deepEqual(parseCaptionData(JSON.stringify(fade)), fade);

  for (const motionPreset of ['rise', 'soft-pop'] as const) {
    assert.throws(() => parseCaptionData(JSON.stringify({
      ...fade,
      appearance: { ...fade.appearance, motionPreset },
    })), /invalid for caption data version 2/i);
  }
  assert.throws(() => parseCaptionData(JSON.stringify({
    ...fade,
    version: 3,
    appearance: { ...fade.appearance, motionPreset: 'future-motion' },
  })), /invalid for caption data version 3/i);
  for (const version of [2, 3]) {
    assert.throws(() => parseCaptionData(JSON.stringify({
      ...fade,
      version,
      appearance: { ...fade.appearance, motionPreset: [version === 2 ? 'fade' : 'rise'] },
    })), /motionPreset is invalid/i, 'an array must not masquerade as a supported preset through string coercion');
  }
});

test('data parser enforces hard UTF-8 size, cue count and grapheme bounds before accepting content', () => {
  assert.throws(() => parseCaptionData(' '.repeat(CAPTION_DATA_LIMITS.maxBytes + 1)), /byte import limit/i);
  const tooMany = { kind: 'sthang-caption-data', version: 1, captions: Array.from({ length: CAPTION_DATA_LIMITS.maxCaptions + 1 }, () => ({})) };
  assert.throws(() => parseCaptionData(JSON.stringify(tooMany)), /caption count exceeds/i);
  const tooLong = { kind: 'sthang-caption-data', version: 1, captions: [{ text: 'ក'.repeat(CAPTION_DATA_LIMITS.maxGraphemesPerCaption + 1), startMs: 0, endMs: 1 }] };
  assert.throws(() => parseCaptionData(JSON.stringify(tooLong)), /too long to interchange safely/i);
});

test('data parser preserves valid partial/null word state and rejects unknown appearance fields', () => {
  const input = createCaptionData({
    captions: [{
      ...cue({ text: 'one two' }),
      wordTiming: {
        version: 1,
        text: 'one two',
        words: [
          { id: 'one', startOffset: 0, endOffset: 3, startMs: 1_050, endMs: 1_300, source: 'aligned' },
          { id: 'two', startOffset: 4, endOffset: 7, startMs: null, endMs: null, source: 'estimated', needsReview: true },
        ],
      },
    }],
  });
  assert.deepEqual(parseCaptionData(JSON.stringify(input)), input);
  assert.throws(() => parseCaptionData(JSON.stringify({ ...input, appearance: { alignment: 'center', apiKey: 'nope' } })), /unsupported field/i);
});

test('analysis reports ready/partial/missing/stale word timing without mutating captions', () => {
  const ready = readyLiteralCue();
  const partial = structuredClone(ready);
  partial.id = 'partial';
  partial.wordTiming!.words[0].needsReview = true;
  const missing = cue({ id: 'missing', text: 'plain', startMs: 2_000, endMs: 3_000 });
  const stale = structuredClone(ready);
  stale.id = 'stale';
  stale.startMs = 4_000; stale.endMs = 5_000;
  stale.wordTiming!.text = 'different';
  const before = structuredClone([ready, partial, missing, stale]);
  const analysis = analyzeCaptionInterchange([ready, partial, missing, stale]);
  assert.deepEqual({
    ready: analysis.readyWordCaptionCount,
    partial: analysis.partialWordCaptionCount,
    missing: analysis.missingWordCaptionCount,
    stale: analysis.staleWordCaptionCount,
  }, { ready: 1, partial: 1, missing: 1, stale: 1 });
  assert.deepEqual([ready, partial, missing, stale], before);
});

test('shared dispatcher exposes only implemented formats at runtime', () => {
  const input = { captions: [cue()] };
  assert.equal(serializeCaptionFile(input, 'srt').extension, '.srt');
  assert.equal(serializeCaptionFile(input, 'vtt').extension, '.vtt');
  assert.equal(serializeCaptionFile(input, 'ttml').extension, '.ttml');
  assert.throws(() => serializeCaptionFile(input, 'ass' as never), /unsupported shared caption interchange format/i);
});
