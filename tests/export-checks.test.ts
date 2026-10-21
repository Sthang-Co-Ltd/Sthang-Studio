import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE, buildCaptionWordTiming, captionFileBlockers, type CaptionSegment } from '../packages/shared/src/index.js';
import { buildExportCaptionIssues, exportLayoutKey } from '../apps/web/src/export-checks.js';
import { analyzeCaptions } from '../apps/web/src/review.js';
import { createExportWorkspaceSession } from '../apps/web/src/export-session.js';

const caption = (id: string, text = 'ខ្មែរកម្ពុជា', startMs = 100, endMs = 1500): CaptionSegment => ({ id, text, startMs, endMs });
const appearance = { ...DEFAULT_CAPTION_APPEARANCE };
function issues(captions: CaptionSegment[], format: Parameters<typeof buildExportCaptionIssues>[0]['format'], look = appearance) {
  return buildExportCaptionIssues({ captions, format, appearance: look, reviewIssues: analyzeCaptions(captions, []), durationMs: 5000 });
}

test('readability and weak timing remain advisory while invalid caption files identify blockers', () => {
  const captions = [{ ...caption('first'), timingQuality: 'low' as const }, caption('empty', '', 1600, 2200), caption('late', 'past source', 4500, 5500)];
  const result = issues(captions, 'srt');
  assert.deepEqual(result.filter((issue) => issue.severity === 'blocker').map((issue) => issue.captionIds), [['empty'], ['late']]);
  assert.equal(result.find((issue) => issue.id === 'review:first')?.severity, 'advisory');
  assert.match(result.find((issue) => issue.id === 'review:first')!.reasons.join(), /listen against the source/);
  assert.equal(result.find((issue) => issue.captionIds[0] === 'empty' && issue.severity === 'blocker')?.repair, 'caption');
  assert.equal(result.find((issue) => issue.captionIds[0] === 'late' && issue.severity === 'blocker')?.repair, 'timing');
  assert.ok(result.slice(0, 2).every((issue) => issue.severity === 'blocker'));
});

test('overlap review links both exact captions and keeps other reasons on their own caption', () => {
  const captions = [caption('long-a', 'first', 0, 3000), { ...caption('short-b', 'second', 2000, 2600), timingQuality: 'low' as const }];
  const result = issues(captions, 'video');
  const overlap = result.find((issue) => issue.id.startsWith('overlap:'))!;
  assert.deepEqual(overlap.captionIds, ['long-a', 'short-b']);
  assert.equal(overlap.repair, 'timing');
  assert.equal(overlap.severity, 'advisory');
  assert.deepEqual(result.find((issue) => issue.id === 'review:short-b')?.captionIds, ['short-b']);
  assert.doesNotMatch(result.find((issue) => issue.id === 'review:short-b')!.reasons.join(), /Overlaps/);
});

test('word timing blocks only selected word files and stays advisory for styled video or bundle', () => {
  const captions = [caption('missing')];
  for (const format of ['srt', 'vtt', 'ttml', 'data'] as const) {
    assert.ok(!issues(captions, format, { ...appearance, highlightMode: 'word' }).some((issue) => issue.id.startsWith('words:')));
  }
  for (const format of ['word-srt', 'word-vtt'] as const) {
    const issue = issues(captions, format).find((item) => item.id === 'words:missing')!;
    assert.equal(issue.severity, 'blocker'); assert.equal(issue.repair, 'word-timing');
  }
  for (const format of ['video', 'ass', 'bundle'] as const) {
    assert.equal(issues(captions, format, { ...appearance, highlightMode: 'word' }).find((item) => item.id === 'words:missing')?.severity, 'advisory');
  }
  assert.ok(!issues(captions, 'video').some((issue) => issue.id.startsWith('words:')));
});

test('ready and stale Khmer word tracks use the same readiness authority without mutating text', () => {
  const cue = caption('ready', 'ខ្មែរ AI');
  cue.wordTiming = buildCaptionWordTiming(cue, [
    { id: 'khmer', text: 'ខ្មែរ', startMs: 150, endMs: 600, spaceBefore: false, timingSource: 'stt' },
    { id: 'ai', text: 'AI', startMs: 700, endMs: 1200, spaceBefore: true, timingSource: 'stt' },
  ])!;
  const before = structuredClone(cue);
  assert.ok(!issues([cue], 'word-srt').some((issue) => issue.id.startsWith('words:')));
  assert.equal(issues([{ ...cue, text: 'ខ្មែរ API' }], 'word-srt').find((issue) => issue.id === 'words:ready')?.severity, 'blocker');
  for (const format of ['srt', 'vtt', 'ttml', 'data', 'ass', 'bundle'] as const) {
    assert.ok(issues([{ ...cue, text: 'ខ្មែរ API' }], format).some((issue) => issue.severity === 'blocker' && issue.repair === 'word-timing'));
  }
  assert.deepEqual(cue, before);
});

test('a native check belongs to the complete draft, source, look, resolution and font discovery', () => {
  const value = { projectId: 'a', media: { filename: 'a.mp4', size: 123 }, captions: [caption('one')], appearance,
    resolution: 'source', fontRevision: 1, capabilityRevision: 1 };
  const key = exportLayoutKey(value);
  assert.equal(key, exportLayoutKey(structuredClone(value)));
  for (const patch of [
    { projectId: 'b' }, { media: { filename: 'replacement.mp4', size: 123 } }, { media: { filename: 'a.mp4', size: 124 } },
    { captions: [{ ...value.captions[0], text: 'ថ្មី' }] }, { captions: [{ ...value.captions[0], endMs: 1700 }] },
    { captions: [{ ...value.captions[0], wordTiming: { version: 1 as const, text: value.captions[0].text, words: [] } }] },
    { appearance: { ...appearance, fontSize1080: 90 } }, { resolution: '720p' }, { fontRevision: 2 }, { capabilityRevision: 2 },
  ]) assert.notEqual(key, exportLayoutKey({ ...value, ...patch }));
});

test('fresh editor visits get independent video and caption defaults', () => {
  const video = createExportWorkspaceSession(true);
  video.settings.resolution = '2160p'; video.handoff.destination = 'premiere';
  const next = createExportWorkspaceSession(true);
  assert.equal(next.settings.resolution, 'source');
  assert.equal(next.handoff.destination, 'capcut-desktop');
  assert.equal(next.outputMode, 'video');
  assert.equal(createExportWorkspaceSession(false).outputMode, 'captions');
});

test('serializer-specific text and timestamp failures are actionable without blocking other formats', () => {
  for (const text of ['bad\u0000text', 'bad\uD800text', 'x'.repeat(10_001)]) {
    assert.ok(issues([caption('invalid', text)], 'srt').some((issue) => issue.severity === 'blocker' && issue.captionIds[0] === 'invalid'));
  }
  const blankLine = [caption('blank', 'first\n\nsecond')];
  assert.ok(issues(blankLine, 'srt').some((issue) => issue.severity === 'blocker'));
  assert.ok(!issues(blankLine, 'ttml').some((issue) => issue.severity === 'blocker'));
  const fractional = [caption('tiny', 'short', 100.1, 100.2)];
  assert.ok(issues(fractional, 'srt').some((issue) => issue.severity === 'blocker' && issue.repair === 'timing'));
  assert.ok(!issues(fractional, 'data').some((issue) => issue.severity === 'blocker'));
  const ass = [caption('ass', 'short', 101, 104)];
  assert.ok(issues(ass, 'ass').some((issue) => issue.severity === 'blocker' && issue.repair === 'timing'));
  assert.ok(!issues(ass, 'srt').some((issue) => issue.severity === 'blocker'));
});

test('portable file size is a global blocker below the allowed caption and word counts', () => {
  const text = Array(5000).fill('a').join(' ');
  const captions: CaptionSegment[] = Array.from({ length: 6 }, (_, index) => ({
    ...caption(`large-${index}`, text), wordTiming: { version: 1, text, words: Array.from({ length: 5000 }, (_, word) => ({
      id: `w-${word}`, startOffset: word * 2, endOffset: word * 2 + 1,
      startMs: null, endMs: null, source: 'estimated' as const, needsReview: true,
    })) },
  }));
  for (const format of ['data', 'bundle'] as const) {
    const blockers = captionFileBlockers({ captions }, format);
    assert.ok(blockers.some((issue) => issue.captionIndex === null && /byte.*limit/.test(issue.message)));
  }
  assert.equal(captionFileBlockers({ captions }, 'srt').length, 0);
});
