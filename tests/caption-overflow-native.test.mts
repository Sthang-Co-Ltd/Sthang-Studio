import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CAPTION_APPEARANCE } from '@kcs/shared';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-overflow-native-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'missing.env');
const { fontCapabilities, prepareCaptionFonts, buildAssDocument, buildAssCaptionFilter } = await import('../apps/server/src/services/caption-renderer.js');
const { validateCaptionOverflow, CaptionOverflowError, invalidateCaptionOverflowCache, buildCaptionOverflowProbe, captionCmapGlyph } = await import('../apps/server/src/services/caption-overflow.js');
after(async () => { invalidateCaptionOverflowCache(); await fs.rm(root, { recursive: true, force: true }); });
const fonts = await fontCapabilities();
const font = fonts.find((item) => item.available && item.boldAvailable);
assert.ok(font, 'A reviewed regular and bold Khmer font is required.');
const appearance = { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, fontSize1080: 64, outlineWidth1080: 0, shadowWidth1080: 0, bold: false };
const fontDirectory = await prepareCaptionFonts(root, appearance);
const base = { width: 360, height: 640, fontDirectory, workDir: root, appearance };
const cue = (text: string) => ({ id: 'test', text, startMs: 100, endMs: 1800 });

test('native fit preserves words and permits legitimate internal-margin overhang', async () => {
  await validateCaptionOverflow({ ...base, captions: [cue('hello world')], appearance: { ...appearance, maxWidthPct: 30 } });
  await validateCaptionOverflow({ ...base, captions: [cue('ខ្ញុំចូលចិត្តប្រទេសកម្ពុជាខ្លាំងណាស់')] });
});
test('native horizontal overflow rejects instead of shrinking or splitting', async () => {
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('SUBSCRIPTION')], appearance: { ...appearance, fontSize1080: 120 } }), CaptionOverflowError);
});
test('native vertical overflow and painted decorations reject', async () => {
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue(Array(20).fill('hello').join('\n'))] }), CaptionOverflowError);
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('SUBSCRIPTION')], appearance: { ...appearance, fontSize1080: 112, maxWidthPct: 100, backgroundEnabled: true, backgroundOpacity: 0.5, backgroundPadding1080: 28 } }), CaptionOverflowError);
});
test('black paint, faded motion and odd frame dimensions are measured', async () => {
  for (const motionPreset of ['fade', 'soft-pop', 'rise'] as const) {
    await validateCaptionOverflow({ ...base, width: 361, height: 641, captions: [cue('hello')], appearance: { ...appearance, textColor: '#000000', motionPreset } });
  }
});
test('cancellation, unsafe allocation and missing fonts never produce a cached fit', async () => {
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('hello')], shouldCancel: () => true }), /cancelled/);
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('hello')], width: 8192, height: 8192 }), CaptionOverflowError);
  const empty = path.join(root, 'empty'); await fs.mkdir(empty);
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('hello')], fontDirectory: empty }), CaptionOverflowError);
  await validateCaptionOverflow({ ...base, captions: [cue('hello')], cacheScope: 'project-a' });
  invalidateCaptionOverflowCache('project-a');
  await validateCaptionOverflow({ ...base, captions: [cue('hello')], cacheScope: 'project-a' });
});

test('asymmetric two-axis guard leaves the original native crop pixel-identical', async () => {
  const { config } = await import('../apps/server/src/config.js');
  for (const alignment of ['left', 'center', 'right'] as const) {
    const a = { ...appearance, alignment, motionPreset: 'soft-pop' as const, backgroundEnabled: true, glowEnabled: true, glowWidth1080: 12, glowOpacity: 0.7 };
    const original = buildAssDocument([cue('ខ្មែរកម្ពុជា CapCut')], a, 361, 641, undefined, 180);
    const padded = buildCaptionOverflowProbe(original, 361, 641, 512, 768);
    assert.equal(padded.count, 1);
    const render = async (document: string, padded: boolean) => {
      const file = path.join(root, `parity-${alignment}-${padded}.ass`);
      await fs.writeFile(file, document);
      return execFileSync(config.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${padded ? 1385 : 361}x${padded ? 2177 : 641}:r=1,format=rgba`, '-vf', buildAssCaptionFilter(file, fontDirectory) + (padded ? ',crop=361:641:512:768' : ''), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 4_000_000 });
    };
    assert.deepEqual(await render(padded.document, true), await render(original, false), alignment);
  }
});

test('disconnected ink beyond the guard cannot yield a false fit', async () => {
  for (const blank of ['\u00a0', '\n']) {
    await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue(`hello${blank.repeat(200)}hello${blank.repeat(200)}hello`)] }), CaptionOverflowError);
  }
});

test('ordinary nonbreaking phrases and a blank line remain supported', async () => {
  for (const text of ['hello\u00a0world', 'hello\n\nworld']) {
    await validateCaptionOverflow({ ...base, captions: [cue(text)] });
  }
});
test('opacity frontier retains only real dominating paint states', () => {
  const original = buildAssDocument([cue('hello')], { ...appearance, motionPreset: 'fade' }, 360, 640);
  const probe = buildCaptionOverflowProbe(original, 360, 640, 512);
  assert.equal(probe.count, 1, 'a full-size fade needs only its most opaque actual state');
  const overlapping = [cue('hello'), { ...cue('world'), id: 'second', startMs: 1700, endMs: 3300 }];
  const overlap = buildCaptionOverflowProbe(buildAssDocument(overlapping, { ...appearance, motionPreset: 'fade' }, 360, 640), 360, 640, 512);
  assert.ok(overlap.count > 3, 'independent fading cues retain incomparable actual paint states');
});


test('invisible format characters cannot hide distant ink beyond the guard', async () => {
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('A' + ('\n\u200B').repeat(80) + 'Z')] }), CaptionOverflowError);
  await validateCaptionOverflow({ ...base, captions: [cue('hello\u200B world')] });
});

test('ordinary 4K portrait captions fit with axis-specific native guards', async (t) => {
  await validateCaptionOverflow({ ...base, width: 2160, height: 3840, captions: [cue('hello world')] });
  for (const [name, fontSize1080, text] of [
    ['Noto Sans Khmer', 120, 'hello'],
    ['Noto Sans Khmer', 120, 'hello world'],
    ['Noto Sans Khmer', 120, 'hello\u00a0world'],
    ['Noto Serif Khmer', 64, 'hello world'],
    ['Noto Serif Khmer', 88, 'hello world'],
  ] as const) {
    await t.test(`${name} Size ${fontSize1080}: ${text}`, {
      skip: fonts.some((item) => item.name === name && item.available) ? false : `${name} is not installed; generic available-face 4K coverage still runs`,
    }, async () => {
      const a = { ...appearance, fontFamily: name, fontSize1080 };
      const directory = await fs.mkdtemp(path.join(root, 'portrait-fonts-'));
      const staged = await prepareCaptionFonts(directory, a);
      await validateCaptionOverflow({ ...base, width: 2160, height: 3840, fontDirectory: staged, appearance: a, captions: [cue(text)] });
    });
  }
});

test('bounded Unicode cmap lookup supports formats 4 and 12', () => {
  const format4 = Buffer.alloc(24);
  format4.writeUInt16BE(4, 0); format4.writeUInt16BE(24, 2); format4.writeUInt16BE(2, 6);
  format4.writeUInt16BE(32, 14); format4.writeUInt16BE(32, 18); format4.writeInt16BE(-29, 20);
  assert.equal(captionCmapGlyph(format4, 32), 3);
  const ranged = Buffer.alloc(26); format4.copy(ranged);
  ranged.writeUInt16BE(26, 2); ranged.writeInt16BE(2, 20); ranged.writeUInt16BE(2, 22); ranged.writeUInt16BE(5, 24);
  assert.equal(captionCmapGlyph(ranged, 32), 7);
  const format12 = Buffer.alloc(28);
  format12.writeUInt16BE(12, 0); format12.writeUInt32BE(28, 4); format12.writeUInt32BE(1, 12);
  format12.writeUInt32BE(32, 16); format12.writeUInt32BE(34, 20); format12.writeUInt32BE(3, 24);
  assert.equal(captionCmapGlyph(format12, 32), 3);
  assert.equal(captionCmapGlyph(format12, 33), 4);
  assert.equal(captionCmapGlyph(format12, 35), 0);
  assert.throws(() => captionCmapGlyph(format12.subarray(0, 20), 32), CaptionOverflowError);
});
