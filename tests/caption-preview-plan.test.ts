import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE, normalizeVideoExportSettings, planCaptionRenderStates, type CaptionSegment } from '@kcs/shared';
import { captionPreviewStateIndex, containedVideoFrame } from '../apps/web/src/caption-preview-plan.js';
import { buildAssDocument, requireCaptionFont } from '../apps/server/src/services/caption-renderer.js';
import { parseCaptionPreviewInput } from '../apps/server/src/services/caption-preview.js';

const cue = (id: string, startMs: number, endMs: number, text = id): CaptionSegment => ({ id, startMs, endMs, text });

test('preview state boundaries match ASS rounding, gaps, overlaps, and half-open ends', () => {
  const states = planCaptionRenderStates([cue('A', 104, 501), cue('B', 296, 601), cue('C', 905, 1104), cue('empty', 0, 2000, ' ')]);
  assert.deepEqual(states, [
    { atMs: 100, endMs: 300, key: '0', text: 'A' },
    { atMs: 300, endMs: 500, key: '0,1', text: 'A\nB' },
    { atMs: 500, endMs: 600, key: '1', text: 'B' },
    { atMs: 600, endMs: 910, key: '', text: '' },
    { atMs: 910, endMs: 1100, key: '2', text: 'C' },
  ]);
  assert.equal(captionPreviewStateIndex(states, 99), -1);
  assert.equal(captionPreviewStateIndex(states, 300), 1);
  assert.equal(captionPreviewStateIndex(states, 600), 3);
  assert.equal(captionPreviewStateIndex(states, 1100), -1);
  assert.equal(captionPreviewStateIndex([], 0), -1);
  assert.deepEqual(planCaptionRenderStates([cue('instant', 1, 4), cue('invalid', NaN, 100)]), []);
});

test('native caption surface fits portrait, landscape and letterboxed video without using the control box as the frame', () => {
  assert.deepEqual(containedVideoFrame(800, 600, 1920, 1080), { x: 0, y: 75, width: 800, height: 450 });
  assert.deepEqual(containedVideoFrame(800, 600, 1080, 1920), { x: 231.25, y: 0, width: 337.5, height: 600 });
  assert.deepEqual(containedVideoFrame(640, 360, 1280, 720), { x: 0, y: 0, width: 640, height: 360 });
  assert.equal(containedVideoFrame(640, 0, 1920, 1080), null);
  assert.equal(containedVideoFrame(640, 360, NaN, 1080), null);
});

test('numeric frame-rate inputs normalize to numbers rather than leaking string values through the contract', () => {
  assert.equal(normalizeVideoExportSettings({ frameRate: '30' as never }).frameRate, 30);
  assert.equal(normalizeVideoExportSettings({ frameRate: '0' as never }).frameRate, 'source');
});

test('native renderer blocks missing faces/weights without mutating saved choices', () => {
  const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: 'DaunPenh', bold: true };
  const fonts = [{ name: 'DaunPenh', available: true, boldAvailable: false, source: 'windows-system' as const }];
  const before = structuredClone(appearance);
  assert.throws(() => requireCaptionFont(fonts, appearance), /Bold.*unavailable/);
  assert.throws(() => requireCaptionFont([], appearance), /saved font.*unavailable/);
  assert.deepEqual(appearance, before);
  assert.equal(requireCaptionFont(fonts, { ...appearance, bold: false }), fonts[0]);
});

test('background appearance keeps independent outline, shadow, color, opacity and padding in the render document', () => {
  const a = { ...DEFAULT_CAPTION_APPEARANCE, outlineWidth1080: 3, shadowWidth1080: 4, backgroundEnabled: true, backgroundPadding1080: 12, backgroundColor: '#FF0000', backgroundOpacity: 1 };
  const doc = buildAssDocument([cue('A', 0, 1000)], a, 1920, 1080);
  const fields = doc.split('\n').find((line) => line.startsWith('Format: Name, Fontname'))!.slice('Format: '.length).split(', ');
  const style = (name: string) => {
    const values = doc.split('\n').find((line) => line.startsWith(`Style: ${name},`))!.slice('Style: '.length).split(',');
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  };
  assert.equal(style('Default').OutlineColour, '&H00000000', 'glyph outline stays black');
  assert.equal(style('Default').Outline, '3', 'box padding must not become outline width');
  assert.equal(style('Default').Shadow, '4', 'shadow remains independent');
  assert.equal(style('Background').OutlineColour, '&H000000FF', 'ASS opaque-box color is OutlineColour');
  assert.equal(style('Background').Outline, '12');
  assert.equal(style('Background').Shadow, '0');
  assert.ok(doc.includes('WrapStyle: 2'), 'native layout must not independently reflow planned lines');
});

test('preview input rejects unbounded/unsorted samples and malformed captions before native execution', () => {
  const input = { captions: [cue('A', 0, 1000)], timesMs: [0, 100], resolution: 'source', appearance: DEFAULT_CAPTION_APPEARANCE };
  assert.equal(parseCaptionPreviewInput(input).captions[0].text, 'A');
  for (const timesMs of [[], Array.from({ length: 9 }, (_, i) => i), [1, 1], [10, 0], [NaN], [-1], ['0'], [Infinity]]) assert.throws(() => parseCaptionPreviewInput({ ...input, timesMs }));
  assert.throws(() => parseCaptionPreviewInput({ ...input, resolution: "1;movie=bad" }));
  assert.throws(() => parseCaptionPreviewInput({ ...input, captions: [{ ...cue('x', 0, 1), text: {} }] }));
  assert.throws(() => parseCaptionPreviewInput(null));
  assert.deepEqual(Object.keys(parseCaptionPreviewInput({ ...input, captions: [{ ...input.captions[0], approved: true, context: 'private' }] }).captions[0]), ['id', 'text', 'startMs', 'endMs']);
});
