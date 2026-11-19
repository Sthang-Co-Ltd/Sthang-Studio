import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compileHighlightPlan, highlightDisplayUnits, resolveWordExport, validateMarkedWordTiming,
  type CaptionProject, type CaptionSegment, type CaptionWord,
} from '@kcs/shared';
import type { WordHighlightDependencies } from '../apps/server/src/services/word-highlight-engine.js';
import type { WindowWord } from '../apps/server/src/services/local-timing.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-word-highlight-engine-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.GEMINI_API_KEY = '';
const {
  createWordHighlightEngine, highlightFrameTime, highlightOccurrencesCollide, mapHighlightWords,
  orderHighlightCaptions, planHighlightWindows,
} = await import('../apps/server/src/services/word-highlight-engine.js');
const { LocalTimingUnavailableError } = await import('../apps/server/src/services/local-timing.js');
after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8 }));

const clock = { sampleCount: 80_000, sampleRate: 16_000, frameCount: 5_000 };
const cue = (id: string, text: string, startMs = 100, endMs = 250): CaptionSegment => ({ id, text, startMs, endMs });
const anchor = (text: string, startFrame: number, endFrame: number, peak = 0.01): WindowWord => ({
  line: 0, text, startFrame, endFrame, score: 0.2, peak,
});
const marked = (caption: CaptionSegment, words: CaptionWord[]) => ({
  ...caption, wordTiming: { version: 1 as const, evidence: 2 as const, text: caption.text, words },
});
const highlight = (caption: CaptionSegment) => compileHighlightPlan(caption, 'measured-and-manual');
function mapped(caption: CaptionSegment, anchors: WindowWord[]) {
  const result = mapHighlightWords(caption, anchors, clock);
  const words = [...result.words, ...result.spans.map(({ word }) => word)].sort((a, b) => a.startOffset - b.startOffset);
  const withTrack = marked(caption, words);
  assert.ok(validateMarkedWordTiming(caption.text, withTrack.wordTiming, 5_000).ok);
  return { ...result, caption: withTrack, sorted: words };
}

test('display units cover spoken graphemes and attach adjacent punctuation', () => {
  const fixtures = [
    '', '... 🎉', '$20 ហ្នឹងទៅ', '«ខ្មែរ»', 'AI ដែលល្បីជាងគេ។', 'ផ្សេងៗទៀត',
    '100%', 'ផ្សេង ៗ', ' ​សួស្តី\n១០ ', '« ខ្មែរ » 50€', '(AI), next!', 'a$b «café»',
  ];
  for (const text of fixtures) {
    const units = highlightDisplayUnits(text);
    const boundaries = new Set([text.length, ...Array.from(new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(text), ({ index }) => index)]);
    let previous = 0;
    const words: CaptionWord[] = units.map((unit, index) => {
      assert.ok(unit.startOffset >= previous && boundaries.has(unit.startOffset) && boundaries.has(unit.endOffset));
      assert.match(text.slice(previous, unit.startOffset), /^[\s\p{Cf}\p{P}\p{S}]*$/u);
      assert.doesNotMatch(text.slice(unit.startOffset, unit.endOffset), /[\s\u200b]/u);
      previous = unit.endOffset;
      return { ...unit, id: String(index), source: 'estimated', startMs: null, endMs: null, needsReview: true, issue: 'missing' };
    });
    assert.match(text.slice(previous), /^[\s\p{Cf}\p{P}\p{S}]*$/u);
    assert.ok(validateMarkedWordTiming(text, marked(cue('id', text), words).wordTiming).ok, text);
  }
  function pieces(text: string) {
    return highlightDisplayUnits(text).map(({ startOffset, endOffset }) => text.slice(startOffset, endOffset));
  }
  assert.deepEqual(pieces('$20 (AI), 100% «ខ្មែរ»'), ['$20', '(AI),', '100%', '«ខ្មែរ»']);
  assert.deepEqual(pieces('a$b'), ['a', '$b']);
});

test('windows retain the full target, bound padding, exclude overlap and drop the successor on equal gaps', () => {
  const captions = orderHighlightCaptions([
    cue('s', 'next', 1_700, 2_000), cue('t', 'target', 900, 1_600), cue('p', 'previous', 400, 800), cue('blank', ' ', 800, 850),
  ]);
  assert.deepEqual(planHighlightWindows(captions, 1, 5_000).variants.map(({ name, startMs, endMs, lines }) =>
    [name, startMs, endMs, lines.map(({ owner }) => owner)]), [
    ['full', 400, 2_000, ['p', 't', 's']],
    ['drop-far', 400, 1_700, ['p', 't']],
    ['target', 800, 1_700, ['t']],
  ]);
  const nested = orderHighlightCaptions([cue('outer', 'long', 0, 8_121), cue('inner', 'short', 0, 1_660)]);
  assert.deepEqual(nested.map(({ id }) => id), ['inner', 'outer']);
  assert.ok(planHighlightWindows(nested, 1, 8_201).variants.every(({ startMs, endMs, lines }) =>
    startMs === 0 && endMs === 8_201 && lines.length === 1));
  assert.ok(planHighlightWindows(nested, 0, 8_201).variants.every(({ endMs }) => endMs === 1_660));
  const ineligible = orderHighlightCaptions([
    cue('long', 'long', 100, 8_200), cue('target', 'target', 8_300, 8_400), cue('far', 'far', 10_000, 10_500),
  ]);
  const plan = planHighlightWindows(ineligible, 1, 11_000);
  assert.deepEqual(plan.variants.map(({ name, startMs, endMs }) => [name, startMs, endMs]), [
    ['full', 8_200, 9_900], ['target', 8_200, 9_900], ['target-wide', 8_200, 10_000],
  ]);
  assert.deepEqual(new Set(plan.consulted.map(({ id }) => id)), new Set(['long', 'target', 'far']));
});

test('short adjacent anchors and two-unit groups use the exact frame clock', () => {
  const caption = cue('short', 'AI CapCut');
  const short = mapped(caption, [anchor('AI', 100, 120), anchor('CapCut', 120, 144)]);
  assert.deepEqual(short.sorted.map(({ id, startMs, endMs }) => [id, startMs, endMs]), [
    ['short:0-2', 100, 120], ['short:3-9', 120, 144],
  ]);
  assert.deepEqual(highlight(short.caption).spans.map(({ startMs, endMs }) => [startMs, endMs]), [[100, 120], [120, 140]]);
  for (const [end, second, painted] of [[111, 120, 2], [102, 115, 1]]) {
    const result = mapped(caption, [anchor('AI', 100, end), anchor('CapCut', second, 144)]);
    assert.equal(result.sorted[0].endMs, end);
    assert.equal(highlight(result.caption).spans.length, painted);
  }
  const group = mapped(caption, [anchor('AICapCut', 100, 144)]);
  assert.deepEqual(group.sorted[0].members, [[0, 2], [3, 9]]);
  assert.equal(highlight(group.caption).coverage, 'full-with-groups');
  assert.equal(resolveWordExport(group.caption).ready, false);
  const nonGrid = { sampleCount: 456_789, frameCount: 1_427, sampleRate: 16_000 };
  for (const frame of [0, 49, 1_000, 1_427]) {
    const ms = highlightFrameTime(frame, nonGrid);
    assert.ok(Math.abs(ms * nonGrid.frameCount * nonGrid.sampleRate / (1_000 * nonGrid.sampleCount) - frame) < 1e-9);
  }
});

test('exact matching handles aliases, punctuation, symbols and anchored mismatches', () => {
  const pairs = [
    ['$20', '20'], ['$20', '$20'], ['«ឲ្យ»', 'ឱ្យ'], ['ម្ដង។', 'ម្តង'], ['១០០%', '100'], ['CapCut!', 'capcut'],
  ];
  for (const [text, match] of pairs) {
    const result = mapped(cue('exact', text), [anchor(match, 100, 140)]);
    assert.equal(result.mappingFailure, false, text);
    assert.equal(result.caption.text.slice(result.sorted[0].startOffset, result.sorted[0].endOffset), text);
    assert.equal(result.sorted[0].method, 'kfa');
  }
  for (const contradict of ['€20', '$21']) {
    const result = mapped(cue('different', 'Go $20\nNow'), [
      anchor('go', 100, 125), anchor(contradict, 130, 159), anchor('now', 165, 192),
    ]);
    assert.equal(result.mappingFailure, true);
    assert.deepEqual(result.sorted.map(({ issue }) => issue ?? null), [null, 'text-mismatch', null]);
  }
  const repeated = mapped(cue('repeated', 'go go stop'), [anchor('go', 100, 140), anchor('stop', 160, 190)]);
  assert.deepEqual(repeated.sorted.map(({ startMs, issue }) => [startMs, issue ?? null]), [
    [100, null], [null, 'text-mismatch'], [160, null],
  ]);
});

test('mixed components preserve group boundaries, true discontinuities and silence', () => {
  const caption = cue('words', 'one two three', 0, 2_000);
  const mixed = (gap: number, peak: number) => mapped(caption, [
    anchor('onet', 100, 140, peak), anchor('wothree', 140 + gap, 400, peak),
  ]);
  assert.deepEqual(mixed(150, 0.1).sorted[0].members, [[0, 3], [4, 7], [8, 13]]);
  assert.deepEqual(mixed(151, 0.1).sorted.map(({ issue }) => issue), Array(3).fill('discontinuous'));
  assert.deepEqual(mixed(150, 2 ** -15).sorted.map(({ issue }) => issue), Array(3).fill('no-fit'));
  assert.equal(mixed(150, 2 ** -14).sorted[0].method, 'kfa-group');
  const multiple = mapped(cue('one', 'twothree'), [anchor('two', 101, 140), anchor('three', 141, 200)]);
  assert.equal(multiple.sorted[0].method, 'kfa');
});

function projectFor(captions: CaptionSegment[]) {
  return {
    id: 'test-project', captions, media: { filename: 'media', size: 1, originalName: 'original' },
  } as CaptionProject;
}
function dependencies(project: CaptionProject, durationMs = 5_000): WordHighlightDependencies {
  return {
    getProject: async () => project,
    ensureNormalizedAudio: async () => ({ outputPath: 'unused', durationMs, dir: 'unused', fingerprint: 'unused', cacheHit: true, cachedAt: '' }),
    prepareFullEmission: async () => ({ prepared: true }),
    alignWindowsLocally: async (_wavPath, _cacheNamespace, { targets }) => ({
      clock,
      targets: targets.map(({ id, variants }) => {
        const variant = variants[0];
        const line = variant.lines.findIndex(({ target }) => target);
        return id === 'broken'
          ? { id, attempts: [{ variant: variant.name, result: 'error' }] }
          : {
            id, attempts: [{ variant: variant.name, result: 'ok', frames: 2_000, ids: 12 }],
            words: [{ ...anchor(variant.lines[line].text.replaceAll(' ', ''), variant.startMs + 20, variant.startMs + 100), line }],
          };
      }),
    }),
    clock: () => 0,
  };
}

test('preflight, reuse, per-target isolation and fallible local runtime have typed outcomes', async () => {
  const reused = cue('reused', 'old', 2_500, 2_900);
  reused.wordTiming = {
    version: 1, text: reused.text,
    words: [{ id: 'old', startOffset: 0, endOffset: 3, startMs: 2_550, endMs: 2_650, source: 'aligned' }],
  };
  const project = projectFor([
    cue('first', 'one', 20, 200), cue('broken', 'broken', 500, 900), cue('later', 'three', 1_200, 1_700),
    { ...cue('locked', 'lock', 2_000, 2_250), timingLocked: true }, reused,
    cue('too-long', 'x'.repeat(2_001), 3_100, 3_300), cue('outside', 'beyond', 5_001, 5_400),
  ]);
  const deps = dependencies(project);
  const engine = createWordHighlightEngine(deps);
  assert.equal((await engine.prepare(project.id, project.media)).ready, true);
  await assert.rejects(engine.prepare(project.id, { filename: 'other', size: 1 }), { status: 409 });
  const list = ['first', 'broken', 'later', 'locked', 'reused', 'too-long', 'outside', 'gone'];
  const snapshot = JSON.stringify(project);
  const { results } = await engine.candidates(project.id, project.media, list);
  assert.deepEqual(results.map(({ status }) => status), ['candidate', 'error', 'candidate', 'locked', 'reused', 'budget', 'outside-media', 'stale']);
  assert.ok(results[0].dependencies?.broken);
  assert.equal(results[0].basis, results[0].track?.basis);
  assert.equal(JSON.stringify(project), snapshot);
  deps.alignWindowsLocally = async () => { throw new LocalTimingUnavailableError(); };
  await assert.rejects(engine.candidates(project.id, project.media, ['first']), LocalTimingUnavailableError);
  deps.alignWindowsLocally = async () => { throw new Error('private diagnostic'); };
  assert.deepEqual((await engine.candidates(project.id, project.media, ['first'])).results, [
    { id: 'first', status: 'error', diagnostics: { attempts: [] } },
  ]);
});

const settled = { id: 'manual', startOffset: 0, endOffset: 3, startMs: 120, endMs: 160, method: 'manual', source: 'manual' } as const;
test('manual evidence survives exact and crossing automatic components', async () => {
  const caption = marked(cue('target', 'one two'), [
    settled, { id: 'two', startOffset: 4, endOffset: 7, startMs: null, endMs: null, source: 'estimated', issue: 'missing', needsReview: true },
  ]);
  const project = projectFor([caption]);
  const engine = createWordHighlightEngine(dependencies(project));
  const candidate = (await engine.candidates(project.id, project.media, [caption.id])).results[0];
  assert.deepEqual(candidate.track?.words[0], settled);
  assert.equal(candidate.track?.words[1].issue, 'manual-conflict');
  assert.equal(candidate.coverage, 'partial');

  const exact = marked(cue('target', 'one'), [settled]);
  project.captions[0] = exact;
  const unchanged = (await engine.candidates(project.id, project.media, [exact.id])).results[0];
  assert.deepEqual(unchanged.track?.words, [settled]);
  assert.equal(unchanged.coverage, 'full-individual');
});

test('occurrence guard quarantines competing automatic anchors across owners', async () => {
  const a = { core: 'go', startMs: 100, endMs: 200 };
  assert.equal(highlightOccurrencesCollide(a, { ...a, startMs: 150, endMs: 250 }), true);
  assert.equal(highlightOccurrencesCollide(a, { ...a, startMs: 151, endMs: 251 }), false);
  assert.equal(highlightOccurrencesCollide(a, { ...a, core: 'other' }), true);
  assert.equal(highlightOccurrencesCollide(a, { ...a, core: 'other', startMs: 80, endMs: 99 }), false);
  assert.equal(highlightOccurrencesCollide(a, { ...a, startMs: 200, endMs: 240 }), false);
  const earlier = cue('a', 'go', 100, 200);
  const later = cue('b', 'go', 200, 300);
  const project = projectFor([earlier, later]);
  const deps = dependencies(project);
  deps.alignWindowsLocally = async (_wav, _cache, { targets }) => ({
    clock, targets: targets.map(({ id, variants }) => {
      const { name, lines } = variants[0];
      return {
        id, attempts: [{ variant: name, result: 'ok' }],
        words: [{ ...anchor('go', 150, 230), line: lines.findIndex(({ target }) => target) }],
      };
    }),
  });
  const engine = createWordHighlightEngine(deps);
  const candidates = (await engine.candidates(project.id, project.media, ['b', 'a'])).results;
  assert.deepEqual(candidates.map(({ conflicts, coverage, track }) => [conflicts, coverage, track?.words[0].issue]), [
    [['a'], 'none', 'ambiguous-occurrence'], [['b'], 'none', 'ambiguous-occurrence'],
  ]);
  project.captions[0] = {
    ...marked(earlier, [{ ...settled, id: 'saved', source: 'aligned', method: 'kfa', startOffset: 0, endOffset: 2, startMs: 150, endMs: 230 }]),
    timingLocked: true,
  };
  const retained = (await engine.candidates(project.id, project.media, ['b'])).results[0];
  assert.deepEqual(retained.conflicts, ['a']);
  assert.equal(project.captions[0].wordTiming?.words[0].startMs, 150);
});

function occurrenceFixture(
  captions: CaptionSegment[], anchors: Record<string, WindowWord[]>,
  fixtureClock = { ...clock, sampleCount: 160_000, frameCount: 10_000 },
) {
  const project = projectFor(captions);
  const durationMs = highlightFrameTime(fixtureClock.frameCount, fixtureClock);
  const deps = dependencies(project, durationMs);
  deps.alignWindowsLocally = async (_wav, _cache, { targets }) => ({
    clock: fixtureClock, targets: targets.map(({ id, variants: [variant] }) => ({
      id, attempts: [{ variant: variant.name, result: 'ok' }],
      words: anchors[id].map((word) => ({ ...word, line: variant.lines.findIndex(({ target }) => target) })),
    })),
  });
  const engine = createWordHighlightEngine(deps);
  return (ids: string[] = captions.map(({ id }) => id)) => engine.candidates(project.id, project.media, ids).then(({ results }) => results);
}

test('contained title replay keeps only the tail and gives the same results across chunks', async () => {
  const title = cue('title', 'opening title tail', 0, 8_121);
  const children = [
    [480, 1_660], [1_960, 2_380], [3_180, 3_320], [3_340, 3_780], [4_280, 4_800],
    [4_820, 5_080], [5_360, 5_861], [6_001, 6_501], [6_561, 7_401],
  ].map(([start, end], index) => cue('child-' + (index + 1), 'speech', start, end));
  const measure = occurrenceFixture([title, ...children], {
    title: [anchor('opening', 780, 3_460), anchor('title', 3_860, 5_720), anchor('tail', 7_940, 8_120)],
    ...Object.fromEntries(children.map(({ id, startMs, endMs }) => [id, [anchor('speech', startMs + 10, endMs - 10)]])),
  });
  const together = await measure();
  assert.deepEqual(together[0].track?.words.map(({ startMs, endMs, issue }) => [startMs, endMs, issue]), [
    [null, null, 'ambiguous-occurrence'], [null, null, 'ambiguous-occurrence'], [7_940, 8_120, undefined],
  ]);
  assert.deepEqual(together[0].conflicts, children.slice(0, 7).map(({ id }) => id));
  for (const child of children) assert.ok(together[0].dependencies?.[child.id]);
  assert.ok(together.slice(1).every(({ coverage, conflicts }) => coverage === 'full-individual' && conflicts === undefined));
  assert.deepEqual(await measure([title.id]), together.slice(0, 1));
  assert.deepEqual(await measure(children.map(({ id }) => id)), together.slice(1));
});

test('paintable manual and locked parent words suppress intersecting child words only', async () => {
  const outer = cue('outer', 'parent', 0, 900);
  const inner = cue('inner', 'inside after', 350, 700);
  const manual = { ...settled, endOffset: 6, startMs: 400, endMs: 600 };
  const locked = { ...manual, source: 'aligned', method: 'kfa' } as const;
  for (const parent of [marked(outer, [manual]), { ...marked(outer, [locked]), timingLocked: true }]) {
    const measure = occurrenceFixture([parent, inner], {
      outer: [anchor('parent', 380, 620)], inner: [anchor('inside', 420, 590), anchor('after', 600, 680)],
    });
    const [parentResult, child] = await measure();
    assert.equal(parentResult.conflicts, undefined);
    if ('timingLocked' in parent) {
      assert.equal(parentResult.status, 'locked');
      assert.deepEqual(highlight(parent).spans.map(({ startMs, endMs }) => [startMs, endMs]), [[400, 600]]);
      assert.deepEqual(parent.wordTiming.words, [locked]);
    } else {
      assert.deepEqual(parentResult.track?.words, [manual]);
      assert.equal(parentResult.coverage, 'full-individual');
    }
    assert.deepEqual(child.conflicts, ['outer']);
    assert.ok(child.dependencies?.outer);
    assert.deepEqual(child.track?.words.map(({ startMs, endMs, issue }) => [startMs, endMs, issue]), [
      [null, null, 'ambiguous-occurrence'], [600, 680, undefined],
    ]);
    assert.deepEqual(await measure([inner.id]), [child]);
  }
  const malformed = { ...outer, timingLocked: true, wordTiming: { version: 1, text: outer.text } as CaptionSegment['wordTiming'] };
  const [child] = await occurrenceFixture([malformed, inner], {
    inner: [anchor('inside', 420, 590), anchor('after', 600, 680)],
  })([inner.id]);
  assert.equal(child.coverage, 'full-individual');
  assert.equal(child.conflicts, undefined);
});

test('partial and identical cues suppress whole intersecting spans and preserve half-open boundary touches', async () => {
  const left = cue('left', 'before left', 0, 600);
  const right = cue('right', 'right after', 400, 900);
  const anchors = {
    left: [anchor('before', 300, 400), anchor('left', 420, 490)],
    right: [anchor('right', 490, 560), anchor('after', 600, 700)],
  };
  const partial = await occurrenceFixture([left, right], anchors)();
  assert.deepEqual(partial.map(({ conflicts }) => conflicts), [['right'], ['left']]);
  assert.deepEqual(partial.map(({ track }) => track?.words.map(({ startMs, endMs, issue }) => [startMs, endMs, issue])), [
    [[300, 400, undefined], [null, null, 'ambiguous-occurrence']],
    [[null, null, 'ambiguous-occurrence'], [600, 700, undefined]],
  ]);
  const identical = await occurrenceFixture([{ ...left, endMs: 900 }, { ...right, startMs: 0 }], anchors)();
  assert.deepEqual(identical.map(({ conflicts }) => conflicts), [['right'], ['left']]);
  for (const { coverage, track } of identical) {
    assert.equal(coverage, 'none');
    assert.deepEqual(track?.words.map(({ issue }) => issue), ['ambiguous-occurrence', 'ambiguous-occurrence']);
  }
});

test('disjoint seam replay preserves both in-cue remainders despite reversed raw anchors', async () => {
  const earlier = cue('earlier', 'first edge', 51_165, 51_745);
  const later = cue('later', 'start next', 51_765, 52_585);
  const measure = occurrenceFixture([earlier, later], {
    earlier: [anchor('first', 2_572, 2_582), anchor('edge', 2_584, 2_587)],
    later: [anchor('start', 2_581, 2_591), anchor('next', 2_592, 2_595)],
  }, { sampleCount: 2_874_816, sampleRate: 16_000, frameCount: 8_983 });
  const results = await measure();
  for (const [index, { coverage, conflicts, track }] of results.entries()) {
    assert.equal(coverage, 'full-individual');
    assert.equal(conflicts, undefined);
    const spans = highlight({ ...[earlier, later][index], wordTiming: track }).spans;
    assert.deepEqual(spans.map(({ startMs, endMs }) => [startMs, endMs]), index === 0
      ? [[51_440, 51_640], [51_680, 51_740]] : [[51_770, 51_820], [51_840, 51_900]]);
  }
});

test('touching repeated words collide at exactly fifty percent and identical frames ignore the core', async () => {
  const left = cue('left', 'echo', 800, 1_000);
  const right = cue('right', 'echo', 1_000, 1_200);
  for (const [rightCaption, earlier, later, collision] of [
    [right, anchor('echo', 900, 1_020), anchor('echo', 960, 1_080), true],
    [right, anchor('echo', 900, 1_020), anchor('echo', 961, 1_081), false],
    [{ ...right, text: 'other' }, anchor('echo', 970, 1_030), anchor('other', 970, 1_030), true],
  ] as const) {
    const results = await occurrenceFixture([left, rightCaption], { left: [earlier], right: [later] })();
    assert.deepEqual(results.map(({ coverage, conflicts, track }) => [coverage, conflicts, track?.words[0].issue]), collision
      ? [['none', ['right'], 'ambiguous-occurrence'], ['none', ['left'], 'ambiguous-occurrence']]
      : [['full-individual', undefined, undefined], ['full-individual', undefined, undefined]]);
  }
});

test('a display word spanning the measured 280 ms gap stays plain while adjacent words paint', async () => {
  const caption = cue('target', 'sunrise now too', 122_351, 123_191);
  const [result] = await occurrenceFixture([caption], {
    target: [
      anchor('sun', 6_117, 6_122, 0.13885), anchor('rise', 6_136, 6_141, 0.12607),
      anchor('now', 6_142, 6_149, 0.15616), anchor('too', 6_151, 6_159, 0.17398),
    ],
  }, { sampleCount: 2_874_816, sampleRate: 16_000, frameCount: 8_983 })();
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.track?.words.map(({ issue }) => issue), ['discontinuous', undefined, undefined]);
  assert.deepEqual(highlight({ ...caption, wordTiming: result.track }).spans.map(({ startMs, endMs }) => [startMs, endMs]), [
    [122_850, 122_990], [123_030, 123_190],
  ]);
});

test('a successful alignment with only a zero-PCM anchor produces no paint', async () => {
  const caption = cue('target', 'quiet', 61_508, 66_348);
  const [result] = await occurrenceFixture([caption], {
    target: [anchor('quiet', 3_314, 3_317, 0)],
  }, { sampleCount: 1_448_182, sampleRate: 16_000, frameCount: 4_525 })();
  assert.equal(result.status, 'candidate');
  assert.equal(result.coverage, 'none');
  assert.deepEqual(result.track?.words.map(({ startMs, endMs, issue }) => [startMs, endMs, issue]), [[null, null, 'no-fit']]);
});

test('a leading zero-PCM anchor stays plain while two supported words paint', async () => {
  const caption = cue('target', 'quiet speak next', 66_368, 66_828);
  const [result] = await occurrenceFixture([caption], {
    target: [anchor('quiet', 3_318, 3_322, 0), anchor('speak', 3_323, 3_336, 0.03430), anchor('next', 3_337, 3_341, 0.25208)],
  }, { sampleCount: 1_448_182, sampleRate: 16_000, frameCount: 4_525 })();
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.track?.words.map(({ issue }) => issue), ['no-fit', undefined, undefined]);
  assert.deepEqual(highlight({ ...caption, wordTiming: result.track }).spans.map(({ startMs, endMs }) => [startMs, endMs]), [
    [66_470, 66_730], [66_750, 66_830],
  ]);
});
