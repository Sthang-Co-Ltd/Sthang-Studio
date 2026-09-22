import test from 'node:test';
import assert from 'node:assert/strict';
import { planCaptionRenderStates, type CaptionSegment } from '@kcs/shared';
import { captionPreviewPaintKey, captionPreviewReplayStates, captionPreviewLookahead, captionPreviewStateIndex } from '../apps/web/src/caption-preview-plan.js';
import { captionPreviewSelection } from '../apps/web/src/caption-preview-interaction.js';

const cue = (id: string, startMs: number, endMs: number): CaptionSegment => ({ id, startMs, endMs, text: `Caption ${id}` });
const motion = { motionPreset: 'fade' as const, motionDurationMs: 160 };

test('explicit replay preparation excludes gaps and unrelated captions and stays bounded', () => {
  const captions = Array.from({ length: 80 }, (_, index) => cue(String(index), 1000 + index * 2000, 2600 + index * 2000));
  const states = planCaptionRenderStates(captions, false, motion);
  const opening = captionPreviewReplayStates(states, 2880, 4720);
  assert.ok(opening.length > 1 && opening.length <= 16);
  assert.ok(opening.every((state) => state.key === '1'));
  assert.equal(new Set(opening.map(captionPreviewPaintKey)).size, opening.length);
  assert.deepEqual(captionPreviewReplayStates(states, NaN, 100), []);
  assert.deepEqual(captionPreviewReplayStates(states, 100, 50), []);
  assert.deepEqual(captionPreviewReplayStates(states, 2700, 2800), []);
});

test('native fade requests retain the original cue clock even when selecting a compact preview subset', () => {
  const captions = [cue('earlier', 100, 500), cue('selected', 1037, 2408), cue('later', 4000, 4500)];
  const before = structuredClone(captions);
  const allStates = planCaptionRenderStates(captions, false, motion);
  const wanted = captionPreviewReplayStates(allStates, 1040, 2000);
  const input = captionPreviewSelection(captions, wanted);
  assert.equal(input.captions.length, 1);
  assert.deepEqual([input.captions[0].startMs, input.captions[0].endMs], [1037, 2408]);
  const compactStates = planCaptionRenderStates(input.captions as CaptionSegment[], false, motion);
  for (const state of wanted) {
    const compact = compactStates[captionPreviewStateIndex(compactStates, state.atMs)];
    assert.deepEqual(compact.cueOpacities?.map((entry) => entry.opacity), state.cueOpacities?.map((entry) => entry.opacity));
  }
  assert.deepEqual(captions, before);
});

test('each native motion request stays within eight distinct missing paint states', () => {
  const states = planCaptionRenderStates([cue('a', 1000, 2300)], false, motion);
  const first = captionPreviewLookahead(states, 0, new Set(), '0');
  assert.equal(first.length, 8);
  const known = new Set(first.map(captionPreviewPaintKey));
  const next = captionPreviewLookahead(states, 0, known, '0');
  assert.ok(next.length <= 8);
  assert.ok(next.every((state) => !known.has(captionPreviewPaintKey(state))));
  assert.equal(new Set(next.map(captionPreviewPaintKey)).size, next.length);
  // Both halves of the fade use one palette, not a new cache entry for every frame.
  assert.ok(new Set(states.map(captionPreviewPaintKey)).size <= 16);
});

for (const preset of ['rise', 'soft-pop'] as const) {
  test(`${preset} keeps bounded replay requests and identical original-clock geometry after preview compaction`, () => {
    const captions = [cue('past', 0, 600), cue('moving', 1037, 2418), cue('following', 2600, 3400)];
    const setting = { ...motion, motionPreset: preset };
    const all = planCaptionRenderStates(captions, false, setting);
    const opening = captionPreviewReplayStates(all, 1040, 2400);
    assert.ok(opening.length > 1 && opening.length <= 16);
    const selected = captionPreviewSelection(captions, opening);
    assert.equal(selected.captions.length, 1);
    const compact = planCaptionRenderStates(selected.captions as CaptionSegment[], false, setting);
    for (const state of opening) {
      const sample = compact[captionPreviewStateIndex(compact, state.atMs)];
      assert.equal(sample.motionScale, state.motionScale);
      assert.equal(sample.motionTranslateY1080, state.motionTranslateY1080);
      assert.deepEqual(sample.cueOpacities?.map((c) => c.opacity), state.cueOpacities?.map((c) => c.opacity));
    }
    const keys = new Set(opening.slice(0, 8).map(captionPreviewPaintKey));
    const continuation = captionPreviewLookahead(all, captionPreviewStateIndex(all, 1040), keys, '1');
    assert.ok(continuation.length <= 8 && continuation.every((state) => !keys.has(captionPreviewPaintKey(state))));
  });
}
