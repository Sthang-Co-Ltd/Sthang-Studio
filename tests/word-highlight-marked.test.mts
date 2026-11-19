import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPTION_DATA_LIMITS, compileHighlightPlan, createCaptionData, exportContentBasis,
  highlightAttention, normalizeCaptionAppearance, parseCaptionData, planCaptionRenderStates,
  resolveWordExport, serializeCaptionFile, validateMarkedWordTiming,
  type CaptionProject, type CaptionSegment, type CaptionWord, type DisplaySpan,
} from '../packages/shared/src/index.js';
import { buildExportCaptionIssues } from '../apps/web/src/export-checks.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'studio-marked-highlight-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
const { buildAssDocument } = await import('../apps/server/src/services/caption-renderer.js');
const { parseCaptionPreviewInput } = await import('../apps/server/src/services/caption-preview.js');
after(() => rm(root, { recursive: true, force: true }));

const word = (id: string, offsets: DisplaySpan, startMs: number, endMs: number): CaptionWord => ({
  id, startOffset: offsets[0], endOffset: offsets[1], startMs, endMs, source: 'aligned', method: 'kfa',
});
const A = word('first', [0, 2], 100, 120);
const B = word('second', [3, 9], 120, 144);
const C = word('third', [10, 12], 170, 200);
const unknown = (value: CaptionWord): CaptionWord => ({
  ...value, startMs: null, endMs: null, source: 'estimated', method: undefined, issue: 'no-fit', needsReview: true,
});
const group = (members: DisplaySpan[] = [[0, 2], [3, 9]]): CaptionWord => ({
  ...word('group', [members[0][0], members.at(-1)![1]], 100, 144), method: 'kfa-group', members,
});
const cue = (words: CaptionWord[] = [A, B], text = 'AI CapCut'): CaptionSegment => ({
  id: 'c1', text, startMs: 100, endMs: 250,
  wordTiming: { version: 1, evidence: 2, text, words: structuredClone(words), basis: 'fixture-basis' },
});
const compile = (caption: CaptionSegment) => compileHighlightPlan(caption, 'measured-and-manual');
const endpoints = (caption: CaptionSegment) => compile(caption).spans.map(({ startMs, endMs }) => [startMs, endMs]);
const good = () => cue().wordTiming!;

test('marked validator accepts exact lexical coverage and returns a normalized deep copy', () => {
  const text = '“$20 ខ្មែរ”';
  const input = cue([
    { ...group([[0, 4], [5, text.length]]), endMs: 266 },
  ], text).wordTiming!;
  const result = validateMarkedWordTiming(text, input, 266);
  assert.ok(result.ok);
  assert.deepEqual(result.timing, input);
  assert.notEqual(result.timing, input);
  assert.notEqual(result.timing.words[0].members![0], input.words[0].members![0]);
  result.timing.words[0].members![0][0] = 99;
  assert.equal(input.words[0].members![0][0], 0);
  assert.equal(validateMarkedWordTiming('AI CapCut', cue([A, unknown(B)]).wordTiming).ok, true);
  assert.equal(validateMarkedWordTiming('...', cue([], '...').wordTiming).ok, true);
  assert.equal(validateMarkedWordTiming('AI CapCut', cue([{ ...group(), source: 'manual', method: 'manual' }]).wordTiming).ok, true);
  assert.equal(validateMarkedWordTiming('AI CapCut', cue([{ ...group(), method: 'legacy' }]).wordTiming).ok, true);
});

test('marked validator rejects malformed marker, coverage, intervals, IDs and method combinations', () => {
  const firstWord = (patch: object) => ({ ...good(), words: [{ ...A, ...patch }, B] });
  const cases: [string, unknown][] = [
    ['absent marker', { ...good(), evidence: undefined }],
    ['unknown marker', { ...good(), evidence: 1 }],
    ['version', { ...good(), version: 2 }],
    ['stale snapshot', { ...good(), text: 'AI CapCut!' }],
    ['shape', { ...good(), words: null }],
    ['duplicate ID', firstWord({ id: B.id })],
    ['empty ID', firstWord({ id: '' })],
    ['long ID', firstWord({ id: 'a'.repeat(129) })],
    ['fractional offset', firstWord({ endOffset: 1.5 })],
    ['overlapping words', firstWord({ endOffset: 4 })],
    ['out of bounds', firstWord({ endOffset: Number.MAX_SAFE_INTEGER })],
    ['uncovered speech', { ...good(), words: [B] }],
    ['missing tail', { ...good(), words: [A] }],
    ['torn null pair', firstWord({ startMs: null })],
    ['non-finite interval', firstWord({ endMs: Infinity })],
    ['negative interval', firstWord({ startMs: -1 })],
    ['inverted interval', firstWord({ startMs: A.endMs })],
    ['estimated interval', firstWord({ source: 'estimated' })],
    ['missing method', firstWord({ method: undefined })],
    ['wrong method', firstWord({ method: 'manual' })],
    ['wrong source', firstWord({ source: 'manual' })],
    ['wrong issue', firstWord({ issue: 'other' })],
    ['review shape', firstWord({ needsReview: 1 })],
    ['placeholder without issue', firstWord({ ...unknown(A), issue: undefined })],
    ['placeholder without review', firstWord({ ...unknown(A), needsReview: false })],
    ['placeholder with method', firstWord({ ...unknown(A), method: 'legacy' })],
    ['individual with members', { ...good(), words: [{ ...group(), method: 'kfa' }] }],
    ['group without members', { ...good(), words: [{ ...group(), members: undefined }] }],
    ['single member', { ...good(), words: [{ ...group(), members: [[0, 9]] }] }],
    ['torn member offsets', { ...good(), words: [{ ...group(), members: [[0, 2], [3, 9, 10]] }] }],
    ['uncovered member text', { ...good(), words: [{ ...group(), members: [[0, 2], [4, 9]] }] }],
    ['overlapping members', { ...good(), words: [{ ...group(), members: [[0, 4], [3, 9]] }] }],
    ['nonspoken member', { ...good(), words: [{ ...group(), members: [[0, 2], [2, 3], [3, 9]] }] }],
    ['member outside outer range', { ...good(), words: [{ ...group(), members: [[0, 2], [3, 10]] }] }],
    ['word count limit', { ...good(), words: Array(CAPTION_DATA_LIMITS.maxWordsPerCaption + 1).fill(A) }],
  ];
  for (const [label, track] of cases) assert.equal(validateMarkedWordTiming('AI CapCut', track).ok, false, label);
  const text = 'ខ្មែរ';
  assert.equal(validateMarkedWordTiming(text, cue([word('split', [0, 1], 100, 120), word('rest', [1, text.length], 125, 150)], text).wordTiming).ok, false);
  assert.equal(validateMarkedWordTiming('AI CapCut', good(), 143).ok, false);
  assert.equal(validateMarkedWordTiming('AI CapCut', good(), 144).ok, true);
  const tooManyGraphemes = 'A'.repeat(CAPTION_DATA_LIMITS.maxGraphemesPerCaption + 1);
  assert.equal(validateMarkedWordTiming(tooManyGraphemes,
    cue([word('long', [0, tooManyGraphemes.length], 100, 120)], tooManyGraphemes).wordTiming).ok, false);
});

test('marked compiler clips and quantizes true raw anchors without widening or inventing timing', () => {
  const full = compile(cue());
  assert.equal(full.coverage, 'full-individual');
  assert.equal(full.spokenUnits, 2);
  assert.deepEqual(full.issues, []);
  assert.deepEqual(endpoints(cue()), [[100, 120], [120, 140]]);
  assert.deepEqual(endpoints(cue([{ ...A, endMs: 111 }, B])), [[100, 110], [120, 140]]);
  assert.deepEqual(endpoints(cue([{ ...A, startMs: 70 }, B])), [[100, 120], [120, 140]]);
  const outside = compile(cue([{ ...A, startMs: 60, endMs: 80 }, B]));
  assert.deepEqual(outside.issues, [{ offsets: [0, 2], code: 'outside-cue' }]);
  assert.equal(outside.spans.length, 1);
  const collapse = compile(cue([{ ...A, endMs: 103 }, B]));
  assert.deepEqual(collapse.issues, [{ offsets: [0, 2], code: 'grid-collapse' }]);
  assert.deepEqual(collapse.spans, [{ startOffset: 3, endOffset: 9, startMs: 120, endMs: 140 }]);
  const partial = compile(cue([A, unknown(B), C], 'AI CapCut OK'));
  assert.equal(partial.coverage, 'partial');
  assert.equal(partial.spokenUnits, 3);
  assert.equal(partial.paintedUnits, 2);
  assert.deepEqual(partial.spans.map(({ startOffset, endOffset }) => [startOffset, endOffset]), [[0, 2], [10, 12]]);
  assert.deepEqual(partial.issues, [{ offsets: [3, 9], code: 'no-fit' }]);
  assert.deepEqual(compile(cue([{ ...A, needsReview: true }, { ...B, issue: 'edited' }])).issues,
    [{ offsets: [0, 2], code: 'missing' }, { offsets: [3, 9], code: 'edited' }]);
  assert.deepEqual(compile(cue([], '...')), { coverage: 'none', spokenUnits: 0, paintedUnits: 0, spans: [], issues: [] });
  assert.equal(highlightAttention(cue([], '...')), 'not-applicable');
  assert.equal(highlightAttention({ ...cue([], '...'), wordTiming: undefined }), 'needs-attention');
});

test('invalid marked evidence uses current speech units and never paints', () => {
  const stale = cue();
  stale.wordTiming!.text = 'A different text snapshot';
  assert.deepEqual(compile(stale), {
    coverage: 'none', spokenUnits: 2, paintedUnits: 0, spans: [], issues: [{ offsets: null, code: 'stale' }],
  });
  assert.equal(highlightAttention(stale), 'needs-attention');
  const punctuation = { ...stale, text: '...' };
  assert.deepEqual(compile(punctuation), {
    coverage: 'none', spokenUnits: 0, paintedUnits: 0, spans: [], issues: [{ offsets: null, code: 'stale' }],
  });
  assert.equal(highlightAttention(punctuation), 'not-applicable');
});

test('raw conflicts and reversed intervals suppress both automatic spans and leave independent paint', () => {
  // These are touching on the grid but overlap in raw time.
  const collision = compile(cue([{ ...A, endMs: 121 }, B, C], 'AI CapCut OK'));
  assert.equal(collision.paintedUnits, 1);
  assert.equal(collision.spans[0].startOffset, 10);
  assert.deepEqual(collision.issues.map(({ code }) => code), ['time-conflict', 'time-conflict']);
  const reverse = compile(cue([{ ...A, startMs: 132, endMs: 146 }, { ...B, startMs: 101, endMs: 119 }, C], 'AI CapCut OK'));
  assert.deepEqual(reverse.spans, [{ startOffset: 10, endOffset: 12, startMs: 170, endMs: 200 }]);
  assert.deepEqual(reverse.issues.map(({ code }) => code), ['time-conflict', 'time-conflict']);
});

test('manual paint wins over automatic paint on overlap in either text order', () => {
  const first = { ...A, endMs: 121 };
  const manualFirst = compile(cue([{ ...first, method: 'manual', source: 'manual' }, B, C], 'AI CapCut OK'));
  assert.deepEqual(manualFirst.spans.map(({ startOffset }) => startOffset), [0, 10]);
  assert.deepEqual(manualFirst.issues, [{ offsets: [3, 9], code: 'time-conflict' }]);
  const manualSecond = compile(cue([first, { ...B, method: 'manual', source: 'manual' }, C], 'AI CapCut OK'));
  assert.deepEqual(manualSecond.spans.map(({ startOffset }) => startOffset), [3, 10]);
  assert.deepEqual(manualSecond.issues, [{ offsets: [0, 2], code: 'time-conflict' }]);
});

test('conflicting manual spans both stay plain and leave independent paint', () => {
  const manual = [A, B].map((entry): CaptionWord => ({ ...entry, method: 'manual', source: 'manual' }));
  manual[0].endMs = 121;
  const plan = compile(cue([...manual, C], 'AI CapCut OK'));
  assert.deepEqual(plan.spans.map(({ startOffset }) => startOffset), [10]);
  assert.deepEqual(plan.issues, [
    { offsets: [0, 2], code: 'time-conflict' }, { offsets: [3, 9], code: 'time-conflict' },
  ]);
});

test('one group paint span contributes each display unit and cannot pass strict word export', () => {
  const built = cue([group()]);
  const coverage = compile(built);
  assert.deepEqual(coverage, {
    coverage: 'full-with-groups', spokenUnits: 2, paintedUnits: 2,
    spans: [{ startOffset: 0, endOffset: 9, startMs: 100, endMs: 140 }], issues: [],
  });
  assert.equal(highlightAttention(built), 'ok');
  assert.equal(resolveWordExport(built).ready, false);
  assert.equal(resolveWordExport(cue([{ ...group(), source: 'manual', method: 'manual' }])).ready, false);
  const groupOfThree = compile(cue([group([[0, 2], [3, 9], [10, 12]])], 'AI CapCut OK'));
  assert.equal(groupOfThree.paintedUnits, 3);
  assert.equal(groupOfThree.spans.length, 1);
  const strict = resolveWordExport(cue());
  assert.ok(strict.ready);
  assert.deepEqual(strict.words.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 120], [120, 144]]);
  const tail = cue([{ ...A, startMs: 70 }, B]);
  assert.equal(compile(tail).coverage, 'full-individual');
  assert.equal(resolveWordExport(tail).ready, false);
  assert.equal(resolveWordExport(cue([unknown(A), B])).ready, false);
});

const appearance = normalizeCaptionAppearance({ highlightMode: 'word', textColor: '#FFFFFF', highlightColor: '#D7FF4F' });
const color = '{\\1c&H4FFFD7&}';
const baseColor = '{\\1c&HFFFFFF&}';

test('planner, preview and ASS use the same supported spans, with plain unsupported text', () => {
  const partial = cue([A, unknown(B), C], 'AI CapCut OK');
  const grouped = cue([group()], 'AI CapCut');
  const cases: [CaptionSegment, number, DisplaySpan[], string][] = [
    [partial, 110, [[0, 2]], `${color}AI${baseColor} CapCut ${baseColor}OK${baseColor}`],
    [partial, 140, [], `${baseColor}AI${baseColor} CapCut ${baseColor}OK${baseColor}`],
    [partial, 180, [[10, 12]], `${baseColor}AI${baseColor} CapCut ${color}OK${baseColor}`],
    [grouped, 110, [[0, 9]], `${color}AI CapCut${baseColor}`],
  ];
  for (const [caption, atMs, expectedOffsets, expectedAss] of cases) {
    const { captions } = parseCaptionPreviewInput({ captions: [caption], timesMs: [atMs], appearance, resolution: 'source' });
    const { basis: _basis, ...expectedTiming } = caption.wordTiming!;
    assert.deepEqual(captions[0].wordTiming, JSON.parse(JSON.stringify(expectedTiming)));
    const active = planCaptionRenderStates(captions, true, appearance).find(({ endMs, atMs: start }) => start <= atMs && atMs < endMs);
    assert.deepEqual(active!.activeWordOffsets!.map(({ startOffset, endOffset }) => [startOffset, endOffset]), expectedOffsets);
    assert.ok(buildAssDocument(captions, appearance, 640, 360, undefined, atMs).includes(expectedAss));
  }
  const invalid = cue([{ ...A, startMs: null }, B]);
  assert.throws(() => parseCaptionPreviewInput({ captions: [invalid], timesMs: [110], resolution: 'source' }),
    /Invalid caption word timing in preview request/);
});

function project(caption: CaptionSegment): CaptionProject {
  return {
    id: 'marked-fixture', title: 'Synthetic', transcript: null, mode: 'phrase', captions: [caption],
    media: { filename: 'sample.mp4', originalName: 'sample.mp4', mimeType: 'video/mp4', url: '/media/sample.mp4', size: 1 },
    createdAt: '2026-01-01', updatedAt: '2026-01-01', captionAppearance: appearance,
    wordHighlightFollow: { version: 1, mediaFingerprint: 'fixture', epoch: 'fixture', enabled: true },
  };
}

test('painted format freshness depends on actual spans; portable and word formats keep their own basis', () => {
  const original = project(cue([group(), unknown(C)], 'AI CapCut OK'));
  const samePaint = structuredClone(original);
  const [first, last] = samePaint.captions[0].wordTiming!.words;
  first.startMs = 40; // raw overhang is clipped
  first.members = [[0, 2], [3, 6], [6, 9]];
  last.issue = 'budget';
  for (const format of ['video', 'ass'] as const) assert.equal(exportContentBasis(original, format), exportContentBasis(samePaint, format));
  for (const format of ['data', 'bundle'] as const) assert.notEqual(exportContentBasis(original, format), exportContentBasis(samePaint, format));
  first.endMs = 170;
  assert.notEqual(exportContentBasis(original, 'ass'), exportContentBasis(samePaint, 'ass'));
  assert.equal(exportContentBasis(original, 'srt'), exportContentBasis(samePaint, 'srt'));
  assert.throws(() => exportContentBasis(original, 'word-srt'), /separate timing/);
});

test('mixed v4 round-trips marked evidence and rejects its fields under v1 through v3', () => {
  const legacy = cue();
  legacy.id = 'legacy';
  delete legacy.wordTiming!.evidence;
  const mixed = project(cue([group(), unknown(C)], 'AI CapCut OK'));
  mixed.captions.push(legacy);
  const input = { ...mixed, appearance: { ...appearance, motionPreset: 'soft-pop' as const }, durationMs: 300 };
  const data = createCaptionData(input);
  assert.equal(data.version, 4);
  assert.equal(data.captions[0].wordTiming?.evidence, 2);
  assert.equal(data.captions[1].wordTiming?.evidence, undefined);
  const text = serializeCaptionFile(input, 'data').text;
  assert.doesNotMatch(text, /"(?:id|basis|wordHighlightFollow|mediaFingerprint)"/);
  assert.deepEqual(parseCaptionData(text), data);
  for (const version of [1, 2, 3]) {
    assert.throws(() => parseCaptionData(JSON.stringify({ ...data, version, appearance: undefined })), /unsupported field/i);
    for (const key of ['method', 'issue', 'members'] as const) {
      const unmarked = structuredClone(data.captions[1]);
      const markedWord = key === 'issue' ? data.captions[0].wordTiming!.words[1] : data.captions[0].wordTiming!.words[0];
      Object.assign(unmarked.wordTiming!.words[0], { [key]: markedWord[key] });
      assert.throws(() => parseCaptionData(JSON.stringify({ ...data, version, appearance: undefined, captions: [unmarked] })), /unsupported field/i);
    }
  }
  assert.throws(() => parseCaptionData(JSON.stringify({ ...data, durationMs: 130 })), /timing|duration/i);
  const incorrect = structuredClone(data);
  incorrect.captions[0].wordTiming!.words[0].members = [[0, 2], [6, 9]];
  assert.throws(() => parseCaptionData(JSON.stringify(incorrect)), /invalid word timing/i);
});

test('export checks distinguish partial paint, plain paint, group export and no speech', () => {
  const partial = cue([A, unknown(B)]);
  const plain = { ...cue([unknown(A), unknown(B)]), id: 'plain' };
  const grouped = { ...cue([group()]), id: 'group' };
  const punct = { ...cue([], '...'), id: 'punctuation' };
  const input = { captions: [partial, plain, grouped, punct], appearance, reviewIssues: [] };
  const visual = buildExportCaptionIssues({ ...input, format: 'video' });
  assert.deepEqual(visual.map(({ id, severity, reasons }) => [id, severity, reasons]), [
    ['words:c1', 'advisory', ['Some words keep their normal color.']],
    ['words:plain', 'advisory', ['This caption keeps its normal color.']],
  ]);
  const strict = buildExportCaptionIssues({ ...input, format: 'word-vtt' });
  assert.equal(strict.find(({ id }) => id === 'words:group')?.severity, 'blocker');
});
