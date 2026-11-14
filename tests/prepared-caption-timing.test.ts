import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '@kcs/shared';
import { captionNeighborLimits, captionTimingBasisMatches, limitCaptionSelectionDelta, planCaptionTimingEdit, prepareCaptionTiming, type CaptionTimingOptions } from '../apps/web/src/caption-timing-transaction.js';

function legacyDelta(captions: CaptionSegment[], selected: Set<string>, delta: number, duration: number) {
  const targets = captions.filter((cue) => selected.has(cue.id));
  if (!targets.length) return 0;
  const outsiders = captions.filter((cue) => !selected.has(cue.id));
  let lower = -Math.min(...targets.map((cue) => cue.startMs));
  let upper = duration - Math.max(...targets.map((cue) => cue.endMs));
  for (const cue of targets) {
    const limits = captionNeighborLimits([...outsiders, cue], cue.id, duration);
    lower = Math.max(lower, limits.lower - cue.startMs);
    upper = Math.min(upper, limits.upper - cue.endMs);
  }
  return Math.max(lower, Math.min(delta, upper));
}

function randomSource(seed = 0x17c0ffee) {
  let value = seed >>> 0;
  return (maximum: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % maximum;
  };
}

const cue = (id: string, startMs: number, endMs: number): CaptionSegment => ({ id, text: `Caption ${id} កម្ពុជា`, startMs, endMs, approved: true });

test('bulk outsider preparation retains exact ties, enclosing overlaps, unsorted input and duplicate identities', () => {
  const captions = [cue('target', 1000, 1500), cue('enclosing', 0, 2200), cue('tie', 1000, 1500), cue('early', 800, 900),
    cue('later', 2400, 2900), cue('target', 1800, 2000), cue('exact', 1500, 1700)];
  const before = structuredClone(captions);
  for (const ids of [['target'], ['target', 'tie'], ['enclosing', 'later'], captions.map((item) => item.id), []]) {
    for (const delta of [-5000, -50, 0, 50, 5000]) {
      const selected = new Set(ids);
      assert.equal(limitCaptionSelectionDelta(captions, selected, delta, 3000), legacyDelta(captions, selected, delta, 3000));
    }
  }
  assert.deepEqual(captions, before);
});

test('randomized bulk limits match the old per-target sorting operation', () => {
  const random = randomSource();
  for (let run = 0; run < 200; run++) {
    const captions = Array.from({ length: 5 + random(45) }, (_, index) => {
      const start = random(35) * 100;
      return { ...cue(`c${index}`, start, start + 40 + random(15) * 100), timingLocked: random(5) === 0 };
    });
    const selected = new Set(captions.filter(() => random(3) !== 0).map((item) => item.id));
    const duration = 2000 + random(4000);
    for (const delta of [-1000, -50, 0, 50, 1000]) {
      assert.equal(limitCaptionSelectionDelta(captions, selected, delta, duration), legacyDelta(captions, selected, delta, duration), `run ${run}, delta ${delta}`);
    }
  }
});

test('large contiguous and alternating selections preserve exact outsider boundaries', () => {
  const captions = Array.from({ length: 1500 }, (_, index) => cue(`c${index}`, 200 + index * 300, 400 + index * 300));
  for (const selected of [
    new Set(captions.slice(300, 1100).map((item) => item.id)),
    new Set(captions.filter((_, index) => index % 2 === 0).map((item) => item.id)),
  ]) {
    for (const delta of [-500, -50, 50, 500]) {
      assert.equal(limitCaptionSelectionDelta(captions, selected, delta, 460000), legacyDelta(captions, selected, delta, 460000));
    }
  }
});

test('prepared plans match ordinary plans across randomized edits, overlaps, locks and shared edges', () => {
  const random = randomSource(0x177eed);
  const options: CaptionTimingOptions[] = [{}, { allowOverlap: true }, { sharedBoundary: true }, { sharedBoundary: true, allowOverlap: true }];
  for (let run = 0; run < 80; run++) {
    const captions = Array.from({ length: 3 + random(20) }, (_, index) => {
      const start = random(20) * 150;
      return { ...cue(`c${index}`, start, start + 40 + random(15) * 100), timingLocked: random(6) === 0 };
    });
    const before = structuredClone(captions);
    const duration = 4000;
    const prepared = prepareCaptionTiming(captions, duration);
    for (const target of captions.slice(0, 4)) for (const kind of ['start', 'end', 'move'] as const) for (const option of options) {
      const value = kind === 'move' ? random(1000) - 500 : random(5000);
      assert.deepEqual(planCaptionTimingEdit(captions, target.id, kind, value, duration, option, prepared),
        planCaptionTimingEdit(captions, target.id, kind, value, duration, option));
    }
    assert.deepEqual(captions, before);
  }
});

test('foreign or differently bounded preparation cannot supply timing authority', () => {
  const captions = [cue('a', 100, 500), cue('b', 700, 1000)];
  const prepared = prepareCaptionTiming(captions, 2000);
  const changed = captions.map((item) => item.id === 'b' ? { ...item, startMs: 550 } : item);
  assert.deepEqual(planCaptionTimingEdit(changed, 'a', 'end', 900, 2000, {}, prepared), planCaptionTimingEdit(changed, 'a', 'end', 900, 2000));
  assert.deepEqual(planCaptionTimingEdit(captions, 'b', 'end', 1900, 1100, {}, prepared), planCaptionTimingEdit(captions, 'b', 'end', 1900, 1100));
});

test('prepared gesture plans preserve word translation and approval clearing', () => {
  const captions = [cue('a', 200, 700), cue('b', 1000, 1500)];
  captions[0].wordTiming = { version: 1, text: captions[0].text, words: [{ id: 'w', startOffset: 0, endOffset: captions[0].text.length, startMs: 250, endMs: 650, source: 'manual' }] };
  const prepared = prepareCaptionTiming(captions, 2000);
  const result = planCaptionTimingEdit(captions, 'a', 'move', 50, 2000, {}, prepared);
  assert.deepEqual(result, planCaptionTimingEdit(captions, 'a', 'move', 50, 2000));
  assert.equal(result.after[0].approved, false);
  assert.equal(result.after[0].wordTiming!.words[0].startMs, 300);
  assert.equal(result.after[0].wordTiming!.words[0].endMs, 700);
  assert.equal(captions[0].wordTiming.words[0].startMs, 250);
});

test('a held gesture rejects newer neighbor geometry, identities, order and locks without rejecting same-value acknowledgements', () => {
  const basis = [cue('a', 1000, 1500), cue('b', 2000, 2500), cue('c', 2800, 3500)];
  assert.equal(captionTimingBasisMatches(structuredClone(basis), basis, [basis[0]]), true);
  const unrelated = structuredClone(basis);
  unrelated[1].text = 'New unrelated wording'; unrelated[1].approved = false;
  assert.equal(captionTimingBasisMatches(unrelated, basis, [basis[0]]), true);
  for (const change of [
    (current: CaptionSegment[]) => { current[1].startMs = 1700; },
    (current: CaptionSegment[]) => { current[2].endMs = 3700; },
    (current: CaptionSegment[]) => { current[1].timingLocked = true; },
    (current: CaptionSegment[]) => { current[1].id = 'replacement'; },
    (current: CaptionSegment[]) => { current.reverse(); },
    (current: CaptionSegment[]) => { current.push(cue('inserted', 1600, 1800)); },
    (current: CaptionSegment[]) => { current.pop(); },
  ]) {
    const current = structuredClone(basis); change(current);
    assert.equal(captionTimingBasisMatches(current, basis, [basis[0]]), false);
  }
  const explicitFalse = structuredClone(basis); explicitFalse[1].timingLocked = false;
  assert.equal(captionTimingBasisMatches(explicitFalse, basis, [basis[0]]), true);
  const changedOwner = structuredClone(basis); changedOwner[0].text += ' newer';
  assert.equal(captionTimingBasisMatches(changedOwner, basis, [basis[0]]), false);
});

test('shared-edge gesture ownership includes both touched revisions and changed third-cue collision geometry', () => {
  const basis = [cue('a', 1000, 1500), cue('b', 2000, 2500), cue('c', 2800, 3500)];
  const transaction = planCaptionTimingEdit(basis, 'a', 'end', 1900, 4000, { sharedBoundary: true }, prepareCaptionTiming(basis, 4000));
  assert.equal(transaction.before.length, 2);
  const changedNeighbor = structuredClone(basis); changedNeighbor[1].approved = false;
  assert.equal(captionTimingBasisMatches(changedNeighbor, basis, transaction.before), false);
  const changedThird = structuredClone(basis); changedThird[2].startMs = 1600; changedThird[2].endMs = 1800;
  assert.equal(captionTimingBasisMatches(changedThird, basis, transaction.before), false);
  const tied = [cue('a', 1000, 1500), cue('b', 1000, 1500)];
  assert.equal(captionTimingBasisMatches([tied[1], tied[0]], tied, [tied[0]]), false);
});

test('unchanged deliberate overlaps and gradual inherited-overlap repairs keep their existing gesture policy', () => {
  const inherited = [cue('a', 1000, 2200), cue('b', 2000, 2500)];
  const repair = planCaptionTimingEdit(inherited, 'a', 'end', 2100, 4000);
  assert.equal(repair.after[0].endMs, 2100);
  assert.equal(captionTimingBasisMatches(structuredClone(inherited), inherited, repair.before), true);
  const deliberate = planCaptionTimingEdit(inherited, 'a', 'end', 2400, 4000, { allowOverlap: true });
  assert.equal(deliberate.after[0].endMs, 2400);
  assert.equal(captionTimingBasisMatches(structuredClone(inherited), inherited, deliberate.before), true);
});
