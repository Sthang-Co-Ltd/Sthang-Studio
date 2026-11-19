import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTION_DATA_LIMITS, compileHighlightPlan, editCaptionWord, fillEditedMarkedWordTiming,
  hasWordTimingEvidence, highlightDisplayUnits, rebaseMarkedWord, reconcileCaptionWordTiming,
  resolveCaptionWordTiming, resolveWordExport, segmentKhmerWords, validateMarkedWordTiming,
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

// Reconciliation at 23a7a1b, using the unchanged shared validators and builders.
interface SpeechUnit {
  startOffset: number;
  endOffset: number;
  key: string;
}

const KHMER_DIGITS: Record<string, string> = {
  '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4',
  '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9',
};

function normalizeWordKey(value: string) {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('en')
    .replace(/[០-៩]/g, (digit) => KHMER_DIGITS[digit] ?? digit)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function speechUnits(text: string): SpeechUnit[] | null {
  if (typeof Intl.Segmenter !== 'function') return null;
  const segments = segmentKhmerWords(text);
  const units: SpeechUnit[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.isWordLike) continue;
    const startOffset = segment.index;
    let endOffset = startOffset + segment.segment.length;

    // Keep punctuation/symbol suffixes attached to the spoken unit when they are
    // directly adjacent. Whitespace and the next word remain separate display text.
    for (let nextIndex = index + 1; nextIndex < segments.length; nextIndex += 1) {
      const next = segments[nextIndex];
      if (next.index !== endOffset || next.isWordLike || /\s/u.test(next.segment)) break;
      endOffset += next.segment.length;
      index = nextIndex;
    }

    const key = normalizeWordKey(text.slice(startOffset, endOffset));
    if (key) units.push({ startOffset, endOffset, key });
  }
  return units;
}

function hasValidInterval(word: CaptionWord) {
  return word.startMs !== null
    && word.endMs !== null
    && Number.isFinite(word.startMs)
    && Number.isFinite(word.endMs)
    && word.endMs > word.startMs;
}

function cloneWord(word: CaptionWord, unit: SpeechUnit): CaptionWord {
  return {
    ...word,
    startOffset: unit.startOffset,
    endOffset: unit.endOffset,
  };
}

function unresolvedWord(captionId: string, unit: SpeechUnit, index: number): CaptionWord {
  return {
    id: `${captionId}:word:${index}:${unit.startOffset}-${unit.endOffset}`,
    startOffset: unit.startOffset,
    endOffset: unit.endOffset,
    startMs: null,
    endMs: null,
    source: 'estimated',
    needsReview: true,
  };
}

function withoutWordTiming(caption: CaptionSegment) {
  if (!('wordTiming' in caption)) return caption;
  const { wordTiming: _wordTiming, ...rest } = caption;
  return rest as CaptionSegment;
}

function editedMarkedWord(id: string, startOffset: number, endOffset: number): CaptionWord {
  return { id, startOffset, endOffset, startMs: null, endMs: null, source: 'estimated', needsReview: true, issue: 'edited' };
}

function editedMarkedWordId(used: Set<string>, startOffset: number, endOffset: number) {
  const base = `edited:${startOffset}-${endOffset}`;
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}:${suffix}`;
  used.add(id);
  return id;
}

function demoteAlignedMarkedWords(words: CaptionWord[]): CaptionWord[] {
  const used = new Set(words.map(({ id }) => id));
  return words.flatMap((word) => {
    if (word.source !== 'aligned') return [word];
    const units = word.members ?? [[word.startOffset, word.endOffset]];
    return units.map(([start, end], index) =>
      editedMarkedWord(index === 0 ? word.id : editedMarkedWordId(used, start, end), start, end));
  });
}

function preservedMarkedWords(before: CaptionSegment, after: CaptionSegment, words: CaptionWord[]): CaptionWord[] {
  if (before.text === after.text) return words;
  const segmenter = new Intl.Segmenter('km', { granularity: 'grapheme' });
  const oldParts = [...segmenter.segment(before.text)];
  const newParts = [...segmenter.segment(after.text)];
  let prefix = 0;
  while (prefix < oldParts.length && prefix < newParts.length && oldParts[prefix].segment === newParts[prefix].segment) prefix += 1;
  let suffix = 0;
  while (suffix < oldParts.length - prefix && suffix < newParts.length - prefix
    && oldParts[oldParts.length - 1 - suffix].segment === newParts[newParts.length - 1 - suffix].segment) suffix += 1;

  const prefixEnd = newParts[prefix]?.index ?? after.text.length;
  const oldSuffixStart = oldParts[oldParts.length - suffix]?.index ?? before.text.length;
  const newSuffixStart = newParts[newParts.length - suffix]?.index ?? after.text.length;
  const oldUnits = highlightDisplayUnits(before.text);
  const newUnits = highlightDisplayUnits(after.text);
  const oldMiddle = oldUnits.filter((unit) => unit.endOffset > prefixEnd && unit.startOffset < oldSuffixStart);
  const newMiddle = newUnits.filter((unit) => unit.endOffset > prefixEnd && unit.startOffset < newSuffixStart);
  const changedKeys = new Set([
    ...oldMiddle.map((unit) => normalizeWordKey(before.text.slice(unit.startOffset, unit.endOffset))),
    ...newMiddle.map((unit) => normalizeWordKey(after.text.slice(unit.startOffset, unit.endOffset))),
  ]);
  const suffixDelta = after.text.length - before.text.length;
  return words.flatMap((word) => {
    const rebased = word.endOffset <= prefixEnd ? word
      : word.startOffset >= oldSuffixStart ? rebaseMarkedWord(word, suffixDelta) : undefined;
    if (!rebased || newMiddle.some((unit) => unit.endOffset > rebased.startOffset && unit.startOffset < rebased.endOffset)) return [];
    const members = word.members ?? [[word.startOffset, word.endOffset]];
    return members.some(([start, end]) => changedKeys.has(normalizeWordKey(before.text.slice(start, end)))) ? [] : [rebased];
  });
}

function reconcileMarkedWordTiming(before: CaptionSegment, after: CaptionSegment): CaptionSegment {
  const oldTiming = before.wordTiming!;
  const explicit = Object.hasOwn(after, 'wordTiming') && after.wordTiming !== oldTiming
    && JSON.stringify(after.wordTiming) !== JSON.stringify(oldTiming);
  if (explicit) {
    return validateMarkedWordTiming(after.text, after.wordTiming).ok ? after : withoutWordTiming(after);
  }
  const validated = validateMarkedWordTiming(before.text, oldTiming);
  if (!validated.ok) return withoutWordTiming(after);
  const delta = after.startMs - before.startMs;
  const moved = Number.isFinite(delta) && delta !== 0 && delta === after.endMs - before.endMs;
  if (before.text === after.text && !moved) return { ...after, wordTiming: oldTiming };

  let preserved = preservedMarkedWords(before, after, validated.timing.words);
  if (moved) {
    preserved = demoteAlignedMarkedWords(preserved).flatMap((word) => {
      if (word.source !== 'manual') return [word];
      const startMs = word.startMs! + delta;
      const endMs = word.endMs! + delta;
      return startMs >= 0 && endMs <= CAPTION_DATA_LIMITS.maxTimelineMs ? [{ ...word, startMs, endMs }] : [];
    });
  }
  const timing = fillEditedMarkedWordTiming(after.text, preserved);
  return timing ? { ...after, wordTiming: timing } : withoutWordTiming(after);
}

function reconcileReference(before: CaptionSegment, after: CaptionSegment): CaptionSegment {
  if (hasWordTimingEvidence(before.wordTiming)) return reconcileMarkedWordTiming(before, after);
  if (before === after) return after;
  const afterOwnsTrack = Object.prototype.hasOwnProperty.call(after, 'wordTiming');
  if (afterOwnsTrack && after.wordTiming == null && before.wordTiming != null) return after;
  if (
    before.text === after.text
    && before.startMs === after.startMs
    && before.endMs === after.endMs
    && before.wordTiming === after.wordTiming
  ) return after;

  // A caller may have already supplied a freshly built/manual track. Preserve it
  // only when it is structurally valid for the new caption and differs from old data.
  if (afterOwnsTrack && after.wordTiming && after.wordTiming !== before.wordTiming) {
    const explicit = resolveCaptionWordTiming(after);
    if (explicit.state !== 'stale' && explicit.state !== 'missing') return after;
    return withoutWordTiming(after);
  }

  if (!before.wordTiming) return after.wordTiming ? withoutWordTiming(after) : after;
  const beforeResolution = resolveCaptionWordTiming(before);
  if (beforeResolution.state === 'stale' || beforeResolution.state === 'missing') return withoutWordTiming(after);

  const oldTiming = before.wordTiming;

  const deltaStart = after.startMs - before.startMs;
  const deltaEnd = after.endMs - before.endMs;
  const uniformMove = Number.isFinite(deltaStart) && deltaStart === deltaEnd && deltaStart !== 0;

  let words: CaptionWord[];
  if (before.text === after.text) {
    words = oldTiming.words.map((word) => ({ ...word }));
  } else {
    const oldUnits = speechUnits(before.text);
    const newUnits = speechUnits(after.text);
    const oldTrackMatchesIcu = oldUnits
      && oldUnits.length === oldTiming.words.length
      && oldUnits.every((unit, index) => unit.startOffset === oldTiming.words[index].startOffset && unit.endOffset === oldTiming.words[index].endOffset);
    if (!oldUnits || !newUnits || !oldTrackMatchesIcu) return withoutWordTiming(after);
    let prefix = 0;
    while (prefix < oldUnits.length && prefix < newUnits.length && oldUnits[prefix].key === newUnits[prefix].key) prefix += 1;

    let suffix = 0;
    while (
      suffix < oldUnits.length - prefix
      && suffix < newUnits.length - prefix
      && oldUnits[oldUnits.length - 1 - suffix].key === newUnits[newUnits.length - 1 - suffix].key
    ) suffix += 1;

    const oldMiddle = oldUnits.slice(prefix, oldUnits.length - suffix);
    const newMiddle = newUnits.slice(prefix, newUnits.length - suffix);
    const changedKeys = new Set([...oldMiddle, ...newMiddle].map((unit) => unit.key));
    const preserved = new Map<number, number>();

    for (let index = 0; index < prefix; index += 1) {
      if (!changedKeys.has(newUnits[index].key)) preserved.set(index, index);
    }
    for (let offset = 0; offset < suffix; offset += 1) {
      const newIndex = newUnits.length - suffix + offset;
      const oldIndex = oldUnits.length - suffix + offset;
      if (!changedKeys.has(newUnits[newIndex].key)) preserved.set(newIndex, oldIndex);
    }

    const oneToOneChange = oldMiddle.length === 1 && newMiddle.length === 1;
    words = newUnits.map((unit, index) => {
      const oldIndex = preserved.get(index);
      if (oldIndex !== undefined) return cloneWord(oldTiming.words[oldIndex], unit);

      if (oneToOneChange && index === prefix) {
        const oldWord = oldTiming.words[prefix];
        return {
          ...cloneWord(oldWord, unit),
          needsReview: true,
        };
      }
      return unresolvedWord(after.id, unit, index);
    });
  }

  if (uniformMove) {
    words = words.map((word) => hasValidInterval(word) ? {
      ...word,
      startMs: word.startMs! + deltaStart,
      endMs: word.endMs! + deltaStart,
    } : word);
  } else if (after.startMs !== before.startMs || after.endMs !== before.endMs) {
    words = words.map((word) => hasValidInterval(word)
      && (word.startMs! < after.startMs || word.endMs! > after.endMs)
      ? { ...word, needsReview: true }
      : word);
  }

  const reconciled: CaptionSegment = {
    ...after,
    wordTiming: { version: 1, text: after.text, words },
  };
  const resolved = resolveCaptionWordTiming(reconciled);
  return resolved.state === 'stale' ? withoutWordTiming(after) : reconciled;
}

test('cached reconciliation is deep-equal to the previous implementation', () => {
  const individual = marked('one two', [aligned('one', 0, 3, 110, 200), aligned('two', 4, 7, 220, 320)]);
  const legacy: CaptionSegment = {
    ...individual,
    wordTiming: {
      version: 1, text: individual.text,
      words: individual.wordTiming!.words.map(({ method: _method, ...word }) => word),
    },
  };
  const invalid: CaptionSegment = {
    ...individual,
    wordTiming: { ...individual.wordTiming!, words: [{ ...individual.wordTiming!.words[0], endOffset: 99 }] },
  };
  const group = marked('AI CapCut', [grouped('pair', 110, 280)]);
  const manual = marked('one', [{ ...aligned('anchor', 0, 3, 130, 240), source: 'manual', method: 'manual' }]);
  const mixed = source();
  const fixtures: Array<[string, CaptionSegment, CaptionSegment]> = [
    ['legacy', legacy, { ...legacy, approved: true }],
    ['legacy text edit', legacy, { ...legacy, text: 'one three' }],
    ['marked', individual, { ...individual, approved: true }],
    ['invalid marked', invalid, { ...invalid, approved: true }],
    ['same track, cloned value', individual, { ...individual, wordTiming: structuredClone(individual.wordTiming) }],
    ['absent track property', individual, { id: individual.id, text: individual.text, startMs: 100, endMs: 900 }],
    ['explicit replacement', individual, {
      ...individual, wordTiming: { ...individual.wordTiming!, basis: 'replacement' },
    }],
    ['explicit clear', individual, { ...individual, wordTiming: undefined }],
    ['prefix edit', mixed, { ...mixed, text: 'new CapCut good day' }],
    ['middle edit', mixed, { ...mixed, text: 'AI CapCut better day' }],
    ['suffix edit', mixed, { ...mixed, text: 'AI CapCut good night' }],
    ['moved cue with manual and grouped words', mixed, { ...mixed, startMs: 300, endMs: 1100 }],
    ['trimmed cue', individual, { ...individual, endMs: 300 }],
    ['manual words', manual, { ...manual, startMs: 200, endMs: 1000 }],
    ['groups', group, { ...group, text: 'AI CapCuts' }],
  ];
  for (const [name, before, after] of fixtures) {
    for (const [label, first, second] of [
      ['transition', before, after],
      ['transition to a copy', before, { ...after }],
      ['identity before', before, before],
      ['shallow copy before', before, { ...before }],
      ['identity after', after, after],
      ['shallow copy after', after, { ...after }],
    ] as const) {
      const expected = reconcileReference(first, second);
      assert.deepEqual(reconcileCaptionWordTiming(first, second), expected, name + ' / ' + label);
      assert.deepEqual(reconcileCaptionWordTiming(first, second), expected, name + ' / cached ' + label);
    }
  }
});

test('valid marked no-ops keep identity and validate the track once per caption text', (t) => {
  const before = source();
  const segment = t.mock.method(Intl.Segmenter.prototype, 'segment');
  assert.strictEqual(reconcileCaptionWordTiming(before, before), before);
  assert.equal(segment.mock.callCount(), 1);

  const copy = { ...before, approved: true };
  assert.strictEqual(reconcileCaptionWordTiming(before, copy), copy);
  assert.strictEqual(reconcileCaptionWordTiming(copy, copy), copy);
  assert.equal(segment.mock.callCount(), 1);

  const otherText = { ...before, text: 'A different caption' };
  const { wordTiming: _discarded, ...stripped } = otherText;
  assert.deepEqual(reconcileCaptionWordTiming(otherText, otherText), stripped);
  assert.strictEqual(reconcileCaptionWordTiming(before, before), before);
  assert.equal(segment.mock.callCount(), 2);
});

test('an untouched invalid marked track is stripped on the first draft reconciliation', () => {
  const before = marked('one', [aligned('bad-offset', 0, 4, 120, 210)]);
  const { wordTiming: _discarded, ...stripped } = before;
  assert.deepEqual(reconcileCaptionWordTiming(before, before), stripped);
  assert.deepEqual(reconcileCaptionWordTiming(before, before), stripped);
});
