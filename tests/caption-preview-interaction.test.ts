import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE as a, planCaptionRenderStates } from '@kcs/shared';
import { captionPreviewSelection, captionPreviewTransform } from '../apps/web/src/caption-preview-interaction.js';
import { PreviewPngReader, previewSeedPacket, previewSample } from '../apps/server/src/services/persistent-caption-preview.js';

const bounds = { x: 120, y: 220, width: 300, height: 70 };
test('position interpolation uses rounded native margins projected into displayed video pixels', () => {
  const next = { ...a, positionBottomPct: a.positionBottomPct + 10 };
  assert.equal(captionPreviewTransform(a, next, 640, 360, bounds, 320, 180), 'matrix(1, 0, 0, 1, 0, -18)');
  assert.equal(captionPreviewTransform(a, next, 640, 360, bounds, 1280, 720), 'matrix(1, 0, 0, 1, 0, -72)');
});
test('size interpolation anchors at the ASS alignment and uses the rounded native font size', () => {
  for (const alignment of ['left', 'center', 'right'] as const) {
    const before = { ...a, alignment };
    const next = { ...before, fontSize1080: before.fontSize1080 + 5 };
    const value = captionPreviewTransform(before, next, 640, 360, bounds)!;
    assert.ok(value?.startsWith('matrix('));
    const [sx, , , sy, tx, ty] = value.slice(7, -1).split(',').map(Number);
    const anchorX = alignment === 'center' ? 320 : alignment === 'left' ? Math.max(8, Math.round(640 * (100 - a.maxWidthPct) / 200)) : 640 - Math.max(8, Math.round(640 * (100 - a.maxWidthPct) / 200));
    const anchorY = 360 - Math.max(8, Math.round(360 * a.positionBottomPct / 100));
    assert.equal(sx, sy);
    assert.ok(Math.abs(anchorX * sx + tx - anchorX) < 1e-8);
    assert.ok(Math.abs(anchorY * sy + ty - anchorY) < 1e-8);
  }
});
test('clipped images, changed typography/effects and exact frames are never falsely interpolated', () => {
  assert.equal(captionPreviewTransform(a, a, 640, 360, bounds), undefined);
  assert.equal(captionPreviewTransform(a, { ...a, fontSize1080: 80, textColor: '#ABCDEF' }, 640, 360, bounds), undefined);
  assert.equal(captionPreviewTransform(a, { ...a, maxWidthPct: 45 }, 640, 360, bounds), undefined);
  assert.equal(captionPreviewTransform(a, { ...a, positionBottomPct: 50 }, 640, 360, { ...bounds, y: 0 }), undefined);
  assert.equal(captionPreviewTransform(a, { ...a, positionBottomPct: 82 }, 640, 360, bounds), undefined);
});
test('interactive payload contains just the active overlap, remapping focus without private metadata', () => {
  const captions = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), text: `cue ${i}`, startMs: i * 1000, endMs: (i + 1) * 1000 + 500, approved: true }));
  const active = planCaptionRenderStates(captions).filter((state) => state.atMs === 20_000);
  const selected = captionPreviewSelection(captions, active, [20]);
  assert.deepEqual(selected.focusIndices, [1]);
  assert.deepEqual(selected.captions.map((c) => c.text), ['cue 19', 'cue 20']);
  assert.deepEqual(Object.keys(selected.captions[0]), ['text', 'startMs', 'endMs']);
  assert.equal(captions[20].startMs, 20_000);
  const sample = previewSample({ ...selected, captions: selected.captions.map((c, i) => ({ ...c, id: String(i) })), timesMs: [20_000], appearance: a }, 20_000);
  assert.deepEqual(sample.captions.map((c) => [c.startMs, c.endMs]), [[0, 1000], [0, 1000]]);
  assert.deepEqual([...sample.focus], [1]);
});
test('persistent pipe packets are complete and PNG framing tolerates fragmentation but rejects oversized/trailing data', () => {
  for (const size of [64, 65] as const) {
    const packet = previewSeedPacket(size);
    assert.equal(packet.length, 32768);
    assert.ok(packet.subarray(0, -size * size * 3).toString().endsWith(`\n${size} ${size}\n255\n`));
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
  const reader = new PreviewPngReader();
  for (let i = 0; i < png.length - 1; i++) assert.equal(reader.push(png.subarray(i, i + 1)), null);
  assert.deepEqual(reader.push(png.subarray(-1)), png);
  assert.deepEqual(reader.push(png), png);
  assert.throws(() => new PreviewPngReader(16).push(png), /safety limit/);
  assert.throws(() => new PreviewPngReader().push(Buffer.concat([png, Buffer.from('x')])), /Unexpected/);
  assert.throws(() => new PreviewPngReader().push(Buffer.alloc(8)), /Invalid/);
});
