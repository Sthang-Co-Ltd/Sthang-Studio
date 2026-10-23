import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReplacementPlan, planReplacement } from '../apps/web/src/find-replace.js';
import type { CaptionSegment } from '@kcs/shared';

const cue = (id: string, text: string, locked = false): CaptionSegment => ({ id, text, startMs: 0, endMs: 1000, approved: true, textLocked: locked });

test('Khmer proposal and applied text agree without changing timing or locked captions', () => {
  const captions = [cue('a', 'ខ្មែរ ខ្មែរ'), cue('b', 'ខ្មែរ', true), cue('c', 'Other')];
  const plan = planReplacement(captions, 'ខ្មែរ', 'កម្ពុជា', 'literal');
  assert.equal(plan.count, 3); assert.equal(plan.locked, 1); assert.equal(plan.changed, 1);
  const after = applyReplacementPlan(captions, plan);
  assert.equal(after[0].text, plan.entries[0].after);
  assert.equal(after[0].approved, false); assert.equal(after[0].endMs, 1000);
  assert.equal(after[1], captions[1]); assert.equal(after[2], captions[2]);
  assert.equal(captions[0].text, 'ខ្មែរ ខ្មែរ');
});
test('selection excludes unselected captions from both proposal and apply', () => {
  const captions = [cue('a', 'word'), cue('b', 'word')];
  const plan = planReplacement(captions, 'word', 'new', 'literal', new Set(['b']));
  assert.equal(plan.entries.length, 1); assert.equal(plan.entries[0].caption.id, 'b');
  assert.deepEqual(applyReplacementPlan(captions, plan).map((c) => c.text), ['word', 'new']);
});
test('a duplicate legacy caption ID cannot cause a locked or nonmatching caption to change', () => {
  const captions = [cue('a', 'word'), cue('a', 'word', true), cue('a', 'other')];
  const plan = planReplacement(captions, 'word', 'new', 'literal');
  assert.deepEqual(applyReplacementPlan(captions, plan).map((c) => c.text), ['new', 'word', 'other']);
});
test('regex substitutions, captures and zero-width matches share preview semantics', () => {
  for (const [query, replacement, expected] of [['(Cap)(Cut)', '$2-$1', 'Cut-Cap'], ['^', 'Start ', 'Start CapCut'], ['Cut', '$&!', 'CapCut!']]) {
    const captions = [cue('a', 'CapCut')];
    const plan = planReplacement(captions, query, replacement, 'regex');
    assert.equal(plan.entries[0].after, expected);
    assert.equal(applyReplacementPlan(captions, plan)[0].text, expected);
  }
});
test('empty replacements are explicit deletion proposals', () => {
  const captions = [cue('a', 'word')];
  const plan = planReplacement(captions, 'word', '', 'literal');
  assert.equal(plan.changed, 1); assert.equal(plan.entries[0].after, '');
  assert.equal(applyReplacementPlan(captions, plan)[0].text, '');
});
test('unchanged and locked matches do not clear approval', () => {
  const captions = [cue('a', 'word'), cue('b', 'word', true)];
  const plan = planReplacement(captions, 'word', 'word', 'literal');
  assert.equal(plan.changed, 0); assert.deepEqual(applyReplacementPlan(captions, plan), captions);
});
test('invalid patterns and empty query never produce edits', () => {
  for (const query of ['[', '']) {
    const captions = [cue('a', 'word')];
    const plan = planReplacement(captions, query, 'new', 'regex');
    assert.equal(plan.changed, 0); assert.deepEqual(applyReplacementPlan(captions, plan), captions);
    assert.equal(Boolean(plan.error), Boolean(query));
  }
});
test('case-insensitive matching and literal metacharacters retain existing behavior', () => {
  assert.equal(planReplacement([cue('a', 'Word WORD')], 'word', '$100', 'case-insensitive').entries[0].after, '$100 $100');
  assert.equal(planReplacement([cue('a', 'a.b axb')], 'a.b', 'new', 'literal').entries[0].after, 'new axb');
});
