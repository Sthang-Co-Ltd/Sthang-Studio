import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileHighlightPlan, editCaptionWord, reconcileCaptionWordTiming, resolveWordExport, validateMarkedWordTiming,
  type CaptionProject, type CaptionSegment, type CaptionWord,
} from '@kcs/shared';
import { mergeCaptionsForEditing, splitCaptionForEditing } from '../apps/web/src/caption-word-structure.js';
import { changeWordTiming } from '../apps/web/src/word-timing-edit.js';
import { assessRecovery, createUnfinishedEditRecoveryStore, restoredCaptions } from '../apps/web/src/unfinished-edit-recovery.js';

const aligned = (id: string, startOffset: number, endOffset: number, startMs: number, endMs: number): CaptionWord =>
  ({ id, startOffset, endOffset, startMs, endMs, source: 'aligned', method: 'kfa' });
const grouped = (id: string, startMs: number, endMs: number): CaptionWord => ({
  ...aligned(id, 0, 9, startMs, endMs), method: 'kfa-group', members: [[0, 2], [3, 9]],
});
function marked(text: string, words: CaptionWord[], startMs = 100, endMs = 900): CaptionSegment {
  return { id: 'fixture', text, startMs, endMs, wordTiming: { version: 1, evidence: 2, text, words, basis: 'original' } };
}
function words(cue: CaptionSegment) {
  assert.equal(cue.wordTiming?.evidence, 2);
  const checked = validateMarkedWordTiming(cue.text, cue.wordTiming);
  assert.ok(checked.ok, checked.ok ? undefined : checked.reason);
  if (checked.timing.words.some((word) => word.members)) assert.equal(resolveWordExport(cue).ready, false);
  return checked.timing.words;
}
const edits = (cue: CaptionSegment) => words(cue).filter(({ issue }) => issue === 'edited')
  .map(({ startOffset, endOffset, startMs, endMs, source, needsReview }) => ({
    text: cue.text.slice(startOffset, endOffset), startMs, endMs, source, needsReview,
  }));
const placeholder = (text: string) => ({ text, startMs: null, endMs: null, source: 'estimated', needsReview: true });
const source = () => marked('AI CapCut good day', [grouped('group', 110, 280), aligned('good', 10, 14, 320, 450),
  { ...aligned('day', 15, 18, 470, 560), source: 'manual', method: 'manual' }]);

for (const { name, text, invalid, surviving } of [
  { name: 'prefix', text: 'new CapCut good day', invalid: ['new', 'CapCut'], surviving: ['good', 'day'] },
  { name: 'middle', text: 'AI CapCut better day', invalid: ['better'], surviving: ['group', 'day'] },
  { name: 'suffix', text: 'AI CapCut good night', invalid: ['night'], surviving: ['group', 'good'] },
  { name: 'group member', text: 'AI CapCuts good day', invalid: ['AI', 'CapCuts'], surviving: ['good', 'day'] },
] as const) {
  test(`a marked ${name} edit replaces only affected components and rebases the survivors`, () => {
    const before = source();
    const after = reconcileCaptionWordTiming(before, { ...before, text });
    assert.deepEqual(edits(after), invalid.map(placeholder));
    assert.deepEqual(words(after).filter(({ issue }) => !issue).map(({ id }) => id), [...surviving]);
    assert.equal(after.wordTiming?.basis, undefined);
    for (const word of words(after).filter(({ issue }) => !issue)) {
      const old = words(before).find(({ id }) => id === word.id)!;
      assert.equal(after.text.slice(word.startOffset, word.endOffset), before.text.slice(old.startOffset, old.endOffset));
      assert.deepEqual([word.startMs, word.endMs], [old.startMs, old.endMs]);
    }
  });
}

test('an unchanged stored span survives even when its offsets do not match fresh ICU segmentation', () => {
  const before = marked('sunbeam good', [
    aligned('sun', 0, 3, 130, 210), aligned('beam', 3, 7, 220, 295), aligned('good', 8, 12, 310, 380),
  ]);
  const after = reconcileCaptionWordTiming(before, { ...before, text: 'sunbeam better' });
  assert.deepEqual(words(after).slice(0, 2), words(before).slice(0, 2));
  assert.deepEqual(edits(after), [placeholder('better')]);
});

test('both edge trims keep the marked raw track and its basis, while paint clips to the cue', () => {
  const before = source();
  for (const timing of [{ startMs: 180 }, { endMs: 520 }]) {
    const after = reconcileCaptionWordTiming(before, { ...before, ...timing });
    assert.deepEqual(words(after), words(before));
    assert.equal(after.wordTiming?.basis, 'original');
    const spans = compileHighlightPlan(after, 'measured-and-manual').spans;
    assert.ok(spans.every((span) => span.startMs >= after.startMs && span.endMs <= after.endMs));
    assert.notDeepEqual(spans, compileHighlightPlan(before, 'measured-and-manual').spans);
  }
});

test('an explicit cue move demotes automatic words and moves manual measurements only', () => {
  const before = source();
  const after = reconcileCaptionWordTiming(before, { ...structuredClone(before), startMs: 200, endMs: 1_000 });
  assert.deepEqual(edits(after), ['AI', 'CapCut', 'good'].map(placeholder));
  assert.deepEqual(words(after).at(-1), { ...words(before).at(-1), startMs: 570, endMs: 660 });
  assert.equal(after.wordTiming?.basis, undefined);
});

test('demoting a measured group keeps stored display-member boundaries when current segmentation differs', () => {
  const before = marked('sunbeam', [{
    ...aligned('old-group', 0, 7, 130, 280), method: 'kfa-group', members: [[0, 3], [3, 7]],
  }]);
  const moved = reconcileCaptionWordTiming(before, { ...before, startMs: 200, endMs: 1_000 });
  assert.deepEqual(edits(moved), [placeholder('sun'), placeholder('beam')]);
  assert.equal(resolveWordExport(moved).ready, false);
});

test('explicit marked word, group, and placeholder edits produce valid manual evidence', () => {
  const before = source();
  const moved = changeWordTiming(before, 'good', 'start', 330);
  assert.deepEqual(words(moved)[1], { ...words(before)[1], source: 'manual', method: 'manual', startMs: 330 });
  const editedGroup = editCaptionWord(before, 'group', { startMs: 125, endMs: 295 });
  assert.deepEqual(words(editedGroup)[0].members, [[0, 2], [3, 9]]);
  assert.equal(words(editedGroup)[0].method, 'manual');
  assert.equal(resolveWordExport(editedGroup).ready, false);
  const untouched = marked('good', [{ id: 'placeholder', startOffset: 0, endOffset: 4, startMs: null, endMs: null,
    source: 'estimated', needsReview: true, issue: 'edited' }]);
  const timed = editCaptionWord(untouched, 'placeholder', { startMs: 140, endMs: 280 });
  assert.deepEqual(words(timed)[0], { id: 'placeholder', startOffset: 0, endOffset: 4, startMs: 140, endMs: 280,
    source: 'manual', method: 'manual' });
  assert.equal(resolveWordExport(timed).ready, true);
});

test('split inside a group or an indivisible word demotes both cut fragments', () => {
  for (const before of [marked('AI CapCut', [grouped('group', 110, 280)]), marked('sunbeam', [aligned('whole', 0, 7, 110, 560)])]) {
    const result = splitCaptionForEditing(before, 'left', 'right');
    assert.ok(result);
    for (const item of result) {
      assert.deepEqual(edits(item), [placeholder(item.text)]);
      assert.equal(resolveWordExport(item).ready, false);
      assert.equal(item.wordTiming?.basis, undefined);
    }
  }
});

test('split between components and merge preserve groups, manual anchors and automatic intervals', () => {
  const before = source();
  const split = splitCaptionForEditing(before, 'left', 'right');
  assert.ok(split);
  const [left, right] = split;
  assert.equal(left.text, 'AI CapCut');
  assert.equal(right.text, 'good day');
  assert.deepEqual(words(left), words(before).slice(0, 1));
  assert.deepEqual(words(right).map(({ startMs, endMs, source }) => ({ startMs, endMs, source })),
    words(before).slice(1).map(({ startMs, endMs, source }) => ({ startMs, endMs, source })));
  const merged = mergeCaptionsForEditing(left, right, 'merged');
  assert.ok(merged);
  assert.equal(merged.text, before.text);
  assert.deepEqual(words(merged), words(before));
  assert.equal(resolveWordExport(merged).ready, false);
  const blankSide = { ...right, wordTiming: undefined };
  const mixed = mergeCaptionsForEditing(left, blankSide, 'mixed');
  assert.ok(mixed);
  assert.deepEqual(edits(mixed), ['good', 'day'].map(placeholder));
});

test('recovery demotes all automatic measurements, retains manual words, and compares stored trust metadata', () => {
  const first = source();
  const second = { ...source(), id: 'second' };
  const project: CaptionProject = {
    id: 'draft', title: 'Fixture', captions: [first, second], mode: 'single-line', engineVersion: 'fixture', transcript: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    media: { filename: 'draft.wav', originalName: 'draft.wav', size: 4, url: '/media/draft.wav', mimeType: 'audio/wav' },
  };
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, raw: string) { values.set(key, raw); },
    removeItem(key: string) { values.delete(key); },
  };
  const recovery = createUnfinishedEditRecoveryStore(() => storage, 'owner');
  const write = recovery.write({ project, captions: [{ ...first, text: 'AI CapCut good day!' }, second] });
  assert.equal(write.status, 'saved');
  assert.ok('entry' in write);
  assert.equal(assessRecovery(write.entry, project), 'matching');
  const restored = restoredCaptions(write.entry, project);
  assert.ok(restored);
  assert.deepEqual(edits(restored[1]), ['AI', 'CapCut', 'good'].map(placeholder));
  assert.deepEqual(words(restored[1]).at(-1), words(second).at(-1));
  assert.ok(restored.every((item) => words(item).every(({ source }) => source !== 'aligned')));
  const changed = structuredClone(project);
  changed.captions[0].wordTiming!.words[0].needsReview = true;
  assert.equal(assessRecovery(write.entry, changed), 'changed');
  const changedMembers = structuredClone(project);
  changedMembers.captions[0].wordTiming!.words[0].method = 'legacy';
  assert.equal(assessRecovery(write.entry, changedMembers), 'changed');
});
