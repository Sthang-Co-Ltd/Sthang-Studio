import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment, QaProfileSettings } from '@kcs/shared';
import { analyzeCaptions, QA_PROFILES } from '../apps/web/src/review.js';

const settings = QA_PROFILES['khmer-tiktok-comfortable'];
const cue = (id: string, text: string, startMs = 200, endMs = 1800): CaptionSegment =>
  ({ id, text, startMs, endMs, timingQuality: 'high', timingSource: 'stt', approved: false });

// Fresh identities cannot hit the object cache. Compare every warm mutation with
// that uncached calculation, including full ordering, severity and exact reasons.
function check(captions: CaptionSegment[], vocabulary: string[] = [], profile: QaProfileSettings = settings, duration = 5000) {
  const cold = analyzeCaptions(captions.map((caption) => ({ ...caption })), vocabulary, profile, duration);
  const warm = analyzeCaptions(captions, vocabulary, profile, duration);
  assert.deepEqual(warm, cold);
  return warm;
}

test('cached Khmer, combining clusters, CRLF and blank-line metrics equal fresh calculations after in-place text edits', () => {
  const caption = cue('a', 'សួស្តី កម្ពុជា AI');
  check([caption]);
  for (const text of [
    'ក្រុមហ៊ុន  OpenAI 5.6',
    'ខ្ញុំស្រឡាញ់កម្ពុជាៗ',
    'e\u0301 café កម្ពុជា',
    'បន្ទាត់ទីមួយ\r\nsecond line\r\n\r\nបន្ទាត់ចុងក្រោយ',
    ' \t\r\n ',
    '',
    'សួស្តី កម្ពុជា AI',
  ]) {
    caption.text = text;
    check([caption]);
  }
  caption.text = 'a\r\nb\r\nc';
  assert.equal(check([caption])[0].reasons.some((reason) => reason.code === 'too-many-lines' && reason.hint === '3 lines (target: 2 or fewer).'), true);
  caption.text = '';
  assert.equal(check([caption])[0].reasons.some((reason) => reason.code === 'empty' && reason.label === 'No text'), true);
});

test('cached text never caches timing, approval, provenance, vocabulary, QA or media decisions', () => {
  const caption = cue('a', 'កម្ពុជា AI 5.6 alias');
  check([caption]);
  caption.approved = true;
  let issues = check([caption]);
  assert.equal(issues.some((issue) => issue.reasons.some((reason) => reason.code === 'mixed-language')), false);
  caption.approved = false;
  issues = check([caption]);
  assert.equal(issues.some((issue) => issue.reasons.some((reason) => reason.code === 'mixed-language')), true);
  caption.startMs = -10; caption.endMs = 80; caption.timingQuality = 'low'; caption.timingSource = 'interpolated';
  issues = check([caption], ['Canonical | alias'], { ...settings, maxCps: 2, maxCharsPerLine: 3, maxLines: 1 }, 50);
  const reasons = issues.flatMap((issue) => issue.reasons);
  for (const expected of ['Timing may be off', 'Starts before the video', 'Ends after the video', 'Use “Canonical” for “alias”']) {
    assert.equal(reasons.some((reason) => reason.label === expected), true, expected);
  }
  assert.equal(reasons.some((reason) => reason.code === 'fast-reading'), true);
  assert.equal(reasons.some((reason) => reason.code === 'long-line'), true);
  assert.equal(check([caption], [], settings, 5000).some((issue) => issue.reasons.some((reason) => reason.code === 'key-term-alias')), false);
});

test('neighbor changes and reordered duplicate IDs retain original issue ordering and reasons', () => {
  const captions = [cue('duplicate', 'same', 200, 700), cue('later', 'same', 750, 1200), cue('duplicate', 'AI', 1400, 1900)];
  check(captions);
  captions[0].endMs = 850;
  let issues = check(captions);
  assert.equal(issues.find((issue) => issue.captionId === 'later')!.reasons.some((reason) => reason.code === 'overlap'), true);
  captions[0].endMs = 730;
  issues = check(captions);
  assert.equal(issues.find((issue) => issue.captionId === 'later')!.reasons.some((reason) => reason.code === 'small-gap' && reason.hint === 'Starts only 20 ms after the previous caption (target: at least 45 ms).'), true);
  captions[0].text = 'different';
  issues = check(captions);
  assert.equal(issues.find((issue) => issue.captionId === 'later')?.reasons.some((reason) => reason.code === 'duplicate'), false);
  check([captions[2], captions[1], captions[0]]);
});

test('review reasons identify the check and what to do, including distinct aliases', () => {
  const first = cue('first', 'Earlier caption', 0, 1600);
  const second = { ...cue('second', 'ខ្មែរ cap cut capkut', 1400, 3000), timingQuality: 'low' as const };
  const reasons = analyzeCaptions([first, second], ['CapCut | cap cut | capkut'])[0].reasons;
  assert.deepEqual(reasons.filter(({ code }) => ['timing-estimated', 'mixed-language', 'key-term-alias', 'overlap'].includes(code)), [
    { code: 'timing-estimated', label: 'Timing may be off', hint: 'Play it and check that the caption matches the voice.' },
    { code: 'mixed-language', label: 'Check English words', hint: 'Khmer and English are mixed. Check that names and English words are spelled right.' },
    { code: 'key-term-alias', label: 'Use “CapCut” for “cap cut”', hint: 'Your key terms say “cap cut” should be written “CapCut”.' },
    { code: 'key-term-alias', label: 'Use “CapCut” for “capkut”', hint: 'Your key terms say “capkut” should be written “CapCut”.' },
    { code: 'overlap', label: 'Overlaps previous', hint: 'It starts before the previous caption ends.' },
  ]);
});

test('duplicate IDs retain distinct reading speeds and de-duplicate an identical legacy measurement', () => {
  const captions = [cue('same', 'abcd', 0, 100), cue('same', 'abcdef', 1000, 1100), cue('same', 'wxyz', 2000, 2100)];
  const reasons = analyzeCaptions(captions, [])[0].reasons.filter(({ code }) => code === 'fast-reading');
  assert.deepEqual(reasons.map(({ hint }) => hint), [
    'About 40 characters per second (target: 20 or fewer). Viewers may not finish reading it.',
    'About 60 characters per second (target: 20 or fewer). Viewers may not finish reading it.',
  ]);
});

test('warm single-cue changes in a heavy project resegment only changed text', (t) => {
  const original = Intl.Segmenter.prototype.segment;
  let calls = 0;
  Intl.Segmenter.prototype.segment = function (input: string) { calls++; return original.call(this, input); };
  t.after(() => { Intl.Segmenter.prototype.segment = original; });
  const captions = Array.from({ length: 1500 }, (_, index) => cue(`heavy-${index}`, `សួស្តី កម្ពុជា caption ${index}`, index * 2000, index * 2000 + 1800));
  analyzeCaptions(captions, [], settings, 3_000_000);
  assert.equal(calls, 3000);
  calls = 0;
  analyzeCaptions(captions, ['Canonical | absent'], { ...settings, maxCps: 18 }, 2_999_000);
  assert.equal(calls, 0);
  captions[750].text += ' edited';
  analyzeCaptions(captions, [], settings, 3_000_000);
  assert.equal(calls, 2);
  calls = 0;
  captions[500].startMs += 10; captions[501].approved = true;
  analyzeCaptions(captions, [], settings, 3_000_000);
  assert.equal(calls, 0);
});

test('randomized cached mutation sequences equal fresh-identity analysis', () => {
  let seed = 0x17ca9e;
  const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const captions = Array.from({ length: 80 }, (_, index) => cue(`c${index % 79}`, `កម្ពុជា AI ${index}`, index * 300, index * 300 + 250));
  check(captions);
  const texts = ['កម្ពុជាៗ', 'កម្ពុជា AI 5.6', 'alias  double space', 'first\r\nsecond\r\nthird', '', 'e\u0301'];
  for (let run = 0; run < 160; run++) {
    const caption = captions[random(captions.length)];
    if (run % 3 === 0) caption.text = texts[random(texts.length)];
    else if (run % 3 === 1) { caption.startMs = random(25000); caption.endMs = caption.startMs + 40 + random(5000); }
    else { caption.approved = !caption.approved; caption.timingQuality = random(2) ? 'low' : 'high'; }
    check(captions, run % 2 ? ['Canonical | alias'] : [], { ...settings, maxCps: 10 + random(20), maxLines: 1 + random(3) }, 23000 + random(2000));
  }
});
