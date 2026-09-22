import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment } from '../packages/shared/src/index.js';
import {
  captionMotionContextIndices,
  planCaptionRenderStates,
  type CaptionRenderState,
} from '../packages/shared/src/caption-layout.js';

type MotionPreset = 'fade' | 'rise' | 'soft-pop';

const cue = (id: string, startMs: number, endMs: number, text = id): CaptionSegment => ({
  id,
  startMs,
  endMs,
  text,
});

const motion = (motionPreset: MotionPreset, motionDurationMs = 160) => ({
  motionPreset,
  motionDurationMs,
});

function stateAt(states: CaptionRenderState[], atMs: number, key?: string) {
  return states.find((state) => state.atMs <= atMs && atMs < state.endMs && (key === undefined || state.key === key));
}

function opacity(state: CaptionRenderState, captionIndex = 0) {
  return state.cueOpacities?.find((entry) => entry.captionIndex === captionIndex)?.opacity;
}

function assertNeutralGeometry(state: CaptionRenderState, preset: 'rise' | 'soft-pop') {
  if (preset === 'rise') {
    assert.equal(state.motionTranslateY1080 ?? 0, 0);
    assert.equal(state.motionScale, undefined);
  } else {
    assert.equal(state.motionScale ?? 1, 1);
    assert.equal(state.motionTranslateY1080, undefined);
  }
}

function geometryValue(state: CaptionRenderState, preset: 'rise' | 'soft-pop') {
  return preset === 'rise' ? state.motionTranslateY1080 ?? 0 : state.motionScale ?? 1;
}

test('Fade, Rise and Soft Pop use half-open phases on the rounded original source clock', () => {
  const caption = cue('clock', 1037, 2418);
  for (const preset of ['fade', 'rise', 'soft-pop'] as const) {
    const states = planCaptionRenderStates([caption], false, motion(preset));
    const active = states.filter((state) => state.key === '0');
    assert.equal(active[0]?.atMs, 1040, `${preset}: rounded source start is inclusive`);
    assert.equal(active.at(-1)?.endMs, 2420, `${preset}: rounded source end is exclusive`);
    assert.equal(stateAt(states, 2420, '0'), undefined, `${preset}: cue is inactive at its half-open end`);

    const entrance = stateAt(states, 1040, '0')!;
    const entranceLast = stateAt(states, 1199, '0')!;
    const rest = stateAt(states, 1200, '0')!;
    const exit = stateAt(states, 2300, '0')!;
    assert.equal(opacity(entrance), 0, `${preset}: entrance starts transparent`);
    assert.ok((opacity(entranceLast) ?? 1) < 1, `${preset}: entrance remains active until the 160ms boundary`);
    assert.equal(opacity(rest), 1, `${preset}: rest begins at the half-open entrance boundary`);
    assert.ok((opacity(exit) ?? 1) < 1, `${preset}: exit fades from final placement`);

    if (preset === 'fade') {
      for (const state of [entrance, entranceLast, rest, exit]) {
        assert.equal(state.motionTranslateY1080, undefined);
        assert.equal(state.motionScale, undefined);
      }
    } else {
      assert.notEqual(geometryValue(entrance, preset), preset === 'rise' ? 0 : 1);
      assert.notEqual(geometryValue(entranceLast, preset), preset === 'rise' ? 0 : 1);
      assertNeutralGeometry(rest, preset);
      assertNeutralGeometry(exit, preset);
    }
  }
});

test('Rise and Soft Pop suppress an entire entrance when an overlap starts or ends inside it', () => {
  for (const preset of ['rise', 'soft-pop'] as const) {
    const overlapStartsDuringA = planCaptionRenderStates([
      cue('A', 100, 700),
      cue('B', 180, 500),
    ], false, motion(preset));
    assertNeutralGeometry(stateAt(overlapStartsDuringA, 120, '0')!, preset);
    assertNeutralGeometry(stateAt(overlapStartsDuringA, 180, '0,1')!, preset);

    const overlapEndsDuringB = planCaptionRenderStates([
      cue('A', 100, 220),
      cue('B', 180, 700),
    ], false, motion(preset));
    assertNeutralGeometry(stateAt(overlapEndsDuringB, 200, '0,1')!, preset);
    assertNeutralGeometry(stateAt(overlapEndsDuringB, 240, '1')!, preset);
  }
});

test('motion context keeps only selected cues and entrance blockers needed after the blocker has ended', () => {
  const captions = [
    cue('unrelated-past', 0, 50),
    cue('blocker', 100, 220),
    cue('selected', 180, 700),
    cue('unrelated-near', 900, 1200),
    cue('unrelated-future', 60_000, 61_000),
  ];
  for (const preset of ['rise', 'soft-pop'] as const) {
    const indices = captionMotionContextIndices(captions, [2], motion(preset));
    assert.deepEqual(indices, [1, 2], `${preset}: compact context includes the ended entrance blocker only`);

    const full = planCaptionRenderStates(captions, false, motion(preset));
    const compact = planCaptionRenderStates(indices.map((index) => captions[index]), false, motion(preset));
    const selectedOnly = planCaptionRenderStates([captions[2]], false, motion(preset));
    assertNeutralGeometry(stateAt(full, 240, '2')!, preset);
    assertNeutralGeometry(stateAt(compact, 240, '1')!, preset);
    assert.notEqual(geometryValue(stateAt(selectedOnly, 240, '0')!, preset), preset === 'rise' ? 0 : 1);
  }
  assert.deepEqual(captionMotionContextIndices(captions, [2], motion('fade')), [2]);
});

test('a 10ms zero-motion cue still blocks the selected Rise or Soft Pop entrance', () => {
  const captions = [
    cue('selected', 100, 900),
    cue('short-blocker', 140, 150),
  ];
  for (const preset of ['rise', 'soft-pop'] as const) {
    const appearance = motion(preset);
    const indices = captionMotionContextIndices(captions, [0], appearance);
    assert.deepEqual(indices, [0, 1], `${preset}: helper keeps the 10ms entrance blocker`);

    const full = planCaptionRenderStates(captions, false, appearance);
    const compact = planCaptionRenderStates(indices.map((index) => captions[index]), false, appearance);
    for (const atMs of [120, 160, 240]) {
      assertNeutralGeometry(stateAt(full, atMs, '0')!, preset);
      assertNeutralGeometry(stateAt(compact, atMs, '0')!, preset);
    }
  }
});

test('10ms, 20ms and 40ms cues each expose one full-opacity saved-geometry state', () => {
  for (const preset of ['fade', 'rise', 'soft-pop'] as const) {
    for (const durationMs of [10, 20, 40]) {
      const states = planCaptionRenderStates([cue('short', 0, durationMs)], false, motion(preset));
      const full = states.filter((state) => state.key === '0' && opacity(state) === 1);
      assert.equal(full.length, 1, `${preset}/${durationMs}ms has one visible full state`);
      if (preset !== 'fade') assertNeutralGeometry(full[0], preset);
    }
  }
});

test('entrance palettes stay bounded to at most 16 levels', () => {
  const caption = cue('palette', 0, 1200);
  for (const preset of ['fade', 'rise', 'soft-pop'] as const) {
    const states = planCaptionRenderStates([caption], false, motion(preset, 400))
      .filter((state) => state.key === '0' && state.atMs <= 400);
    const values = new Set(states.map((state) => preset === 'fade' ? opacity(state) : geometryValue(state, preset)));
    assert.ok(values.size > 1, `${preset}: entrance actually progresses`);
    assert.ok(values.size <= 16, `${preset}: entrance palette is bounded, got ${values.size}`);
  }
});

test('word paint boundaries never restart Rise or Soft Pop entrance clocks', () => {
  const text = 'one two';
  const caption: CaptionSegment = {
    ...cue('words', 100, 900, text),
    wordTiming: {
      version: 1,
      text,
      words: [
        { id: 'one', startOffset: 0, endOffset: 3, startMs: 130, endMs: 170, source: 'aligned' },
        { id: 'two', startOffset: 4, endOffset: 7, startMs: 230, endMs: 290, source: 'aligned' },
      ],
    },
  };
  for (const preset of ['rise', 'soft-pop'] as const) {
    const baseline = planCaptionRenderStates([caption], false, motion(preset));
    const highlighted = planCaptionRenderStates([caption], true, motion(preset));
    for (const boundary of [130, 170, 230, 290]) {
      const expected = stateAt(baseline, boundary, '0')!;
      const actual = stateAt(highlighted, boundary, '0')!;
      assert.equal(geometryValue(actual, preset), geometryValue(expected, preset), `${preset}/${boundary}: word boundary keeps cue entrance progress`);
      assert.equal(opacity(actual), opacity(expected), `${preset}/${boundary}: word boundary keeps cue opacity progress`);
    }
  }
});

test('changing duration recomputes motion progress from each cue original start clock', () => {
  const caption = cue('duration', 1037, 2000);
  for (const preset of ['fade', 'rise', 'soft-pop'] as const) {
    const fastStates = planCaptionRenderStates([caption], false, motion(preset, 80));
    const slowStates = planCaptionRenderStates([caption], false, motion(preset, 320));
    assert.equal(fastStates.find((state) => state.key === '0')?.atMs, 1040);
    assert.equal(slowStates.find((state) => state.key === '0')?.atMs, 1040);
    const fast = stateAt(fastStates, 1080, '0')!;
    const slow = stateAt(slowStates, 1080, '0')!;
    assert.ok((opacity(slow) ?? 1) < (opacity(fast) ?? 0), `${preset}: longer duration is less progressed at the same source time`);
    if (preset === 'rise') assert.ok((slow.motionTranslateY1080 ?? 0) > (fast.motionTranslateY1080 ?? 0));
    if (preset === 'soft-pop') assert.ok((slow.motionScale ?? 1) < (fast.motionScale ?? 1));
  }
});
