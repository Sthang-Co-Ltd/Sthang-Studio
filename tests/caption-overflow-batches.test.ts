import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '@kcs/shared';
import {
  captionOverflowComponents,
  planCaptionOverflowBatches,
  CaptionOverflowBatchBudgetError,
  MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS,
  MAX_CAPTION_OVERFLOW_TOTAL_CHARACTERS,
} from '../apps/server/src/services/caption-overflow-batches.js';

const cue = (id: string, startMs: number, endMs: number, text = id): CaptionSegment => ({ id, startMs, endMs, text });

test('10ms half-open overlap chains are indivisible and preserve the source paint order', () => {
  const captions = [
    cue('C-in-source-first', 189, 301, 'C'), // 190..300
    cue('A', 101, 205, 'A'), // 100..210
    cue('B', 205, 261, 'B'), // 210..260; connected through C
    cue('touching', 301, 401, 'D'), // 300..400; touches C, does not overlap
    cue('blank', 201, 400, '  '),
    cue('too-short-to-paint', 1, 4, 'Z'),
  ];
  const before = structuredClone(captions);
  const components = captionOverflowComponents(captions);
  assert.deepEqual(components.map((component) => component.indices), [[0, 1, 2], [3]]);
  const batches = planCaptionOverflowBatches(captions, 3);
  assert.deepEqual(batches.map((batch) => batch.captions.map((caption) => caption.id)), [
    ['C-in-source-first', 'A', 'B'], ['touching'],
  ]);
  assert.deepEqual(batches.map((batch) => batch.characters), [3, 1]);
  assert.deepEqual(captions, before, 'planning must never alter source clocks or caption fields');
});

test('the accepted 200k path retains the exact original caption array, including unpainted cues', () => {
  const captions = [cue('blank', 0, 200, '   '), cue('spoken', 300, 1000, 'ខ្មែរកម្ពុជា')];
  const batches = planCaptionOverflowBatches(captions);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].captions, captions);
});

test('the 5k-caption 223893-character project is covered exactly by bounded native batches', () => {
  const captions = Array.from({ length: 5000 }, (_, index) => cue(`source-${index}`,
    index * 2000, index * 2000 + 1800, 'ខ'.repeat(44 + Number(index < 3893))));
  const originalCount = captions.reduce((total, caption) => total + caption.text.length, 0);
  assert.equal(originalCount, 223_893);
  const batches = planCaptionOverflowBatches(captions);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.characters <= MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS));
  const gathered = batches.flatMap((batch) => batch.captions);
  assert.deepEqual(gathered.map((caption) => caption.id), captions.map((caption) => caption.id));
  assert.ok(gathered.every((caption, index) => caption === captions[index]), 'the original caption objects are retained');
  assert.deepEqual(batches.map((batch) => batch.components.length), batches.map((batch) => batch.captions.length));
});

test('a transitive overlap component too large for one native batch fails closed', () => {
  // Only adjacent 10ms intervals overlap. No instant approaches the 4096-character
  // simultaneous-paint cap, but no safe split exists in this connected chain.
  const captions = Array.from({ length: 420 }, (_, index) => cue(`chain-${index}`,
    index * 990, index * 990 + 1000, 'a'.repeat(500)));
  assert.deepEqual(captionOverflowComponents(captions).map((component) => component.indices.length), [420]);
  assert.throws(() => planCaptionOverflowBatches(captions), CaptionOverflowBatchBudgetError);
});

test('finite whole-request, simultaneous-paint, batch-count and caption limits fail closed', () => {
  const tooManyCharacters = Array.from({ length: 3600 }, (_, index) => cue(`huge-${index}`,
    index * 2000, index * 2000 + 1800, 'a'.repeat(500)));
  assert.ok(tooManyCharacters.reduce((sum, caption) => sum + caption.text.length, 0) > MAX_CAPTION_OVERFLOW_TOTAL_CHARACTERS);
  assert.throws(() => planCaptionOverflowBatches(tooManyCharacters), CaptionOverflowBatchBudgetError);
  assert.throws(() => planCaptionOverflowBatches([
    cue('one', 0, 1000, 'a'.repeat(2000)), cue('two', 0, 1000, 'b'.repeat(2000)), cue('three', 0, 1000, 'c'.repeat(100)),
  ]), CaptionOverflowBatchBudgetError);
  const nine = Array.from({ length: 9 }, (_, index) => cue(`nine-${index}`, index * 1000, index * 1000 + 900, 'ok'));
  assert.throws(() => planCaptionOverflowBatches(nine, 2), CaptionOverflowBatchBudgetError);
  assert.throws(() => planCaptionOverflowBatches([cue('large-cue', 0, 1000, 'a'.repeat(4097))]), CaptionOverflowBatchBudgetError);
  assert.throws(() => planCaptionOverflowBatches([cue('bad-time', Number.NaN, 1000)]), CaptionOverflowBatchBudgetError);
  assert.throws(() => planCaptionOverflowBatches(nine, MAX_CAPTION_OVERFLOW_BATCH_CHARACTERS + 1), CaptionOverflowBatchBudgetError);
});
