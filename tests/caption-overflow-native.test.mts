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
const { validateCaptionOverflow, CaptionOverflowError, invalidateCaptionOverflowCache, buildCaptionOverflowProbe, captionCmapGlyph, captionOverflowSourceFilter, parseCaptionOverflowBounds } = await import('../apps/server/src/services/caption-overflow.js');
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


test('bounds source is finite before ASS and metadata evaluation', () => {
  assert.equal(captionOverflowSourceFilter(3), 'trim=end_frame=3,settb=1/1,setpts=PTS-STARTPTS');
  for (const count of [0, -1, 1.5, 8193, NaN]) assert.throws(() => captionOverflowSourceFilter(count), CaptionOverflowError);
});
test('bounds metadata requires every exact sample and complete unique coordinates', () => {
  const frame = (n: number, time = n) => `frame:${n}    pts: ${time}    pts_time:${time}\npreflight=1\nlavfi.bbox.x1=600\nlavfi.bbox.x2=650\nlavfi.bbox.y1=700\nlavfi.bbox.y2=760\n`;
  const expected = [[600, 650, 700, 760], [600, 650, 700, 760]];
  assert.deepEqual(parseCaptionOverflowBounds(frame(0) + frame(1), 2), expected);
  assert.deepEqual(parseCaptionOverflowBounds((frame(0) + frame(1)).replaceAll('\n', '\r\n'), 2), expected);
  for (const output of [
    frame(0) + frame(1).replace('x1=600', 'x1=' + '9'.repeat(400)), // non-finite coordinate
    frame(0) + frame(1).replace('x1=600', 'x1=9007199254740992'), // unsafe integer
    frame(0) + frame(1).replace('x1=600', 'x1=999'), // reversed horizontal bounds
    frame(0) + frame(1).replace('y1=700', 'y1=999'), // reversed vertical bounds
    frame(0), // dropped expected sample
    frame(0) + frame(0), // duplicated identity
    frame(1) + frame(0), // reordered samples
    frame(0) + frame(1, 2), // wrong PTS
    frame(0) + frame(1).replace('lavfi.bbox.x1=600\n', ''), // blank/incomplete sample
    frame(0) + frame(1) + 'frame:2 pts:2 pts_time:2\npreflight=1\n', // Windows-style trailing blank look-ahead
    frame(0) + frame(1) + frame(2), // extra painted sample is not ignored either
    frame(0) + frame(1) + 'lavfi.bbox.x1=600\n', // ambiguous repeated coordinate
  ]) assert.throws(() => parseCaptionOverflowBounds(output, 2), CaptionOverflowError);
});
test('finite native source measures every distinct state in a batch', async () => {
  const captions = [cue('hello'), { ...cue('world'), id: 'second', startMs: 2000, endMs: 3000 }];
  await validateCaptionOverflow({ ...base, captions });
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [...captions, {
    ...cue('SUBSCRIPTION'), id: 'overflow-last', startMs: 4000, endMs: 5000,
  }], appearance: { ...appearance, fontSize1080: 120 } }), CaptionOverflowError);
});

test('upstream finite source reaches EOF before an oversized output request', async () => {
  const { config } = await import('../apps/server/src/config.js');
  const output = execFileSync(config.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=16x16:r=1',
    '-vf', `${captionOverflowSourceFilter(3)},bbox=min_val=0,metadata=mode=print:file=-`,
    '-frames:v', '4', '-f', 'null', '-'], { windowsHide: true, timeout: 10000 }).toString();
  assert.deepEqual(parseCaptionOverflowBounds(output, 3), Array(3).fill([0, 15, 0, 15]));
});

test('layout diagnostics attribute duplicate native paint to each actual caption', async () => {
  const captions = [
    { ...cue('hello'), id: 'fits' },
    { ...cue('SUBSCRIPTION'), id: 'late-one', startMs: 2000, endMs: 3000 },
    { ...cue('SUBSCRIPTION'), id: 'late-two', startMs: 4000, endMs: 5000 },
  ];
  const a = { ...appearance, fontSize1080: 120 };
  const states = new Map<string, number[]>();
  const diagnosticDocument = buildAssDocument(captions, a, base.width, base.height, undefined, undefined, states);
  assert.equal(diagnosticDocument, buildAssDocument(captions, a, base.width, base.height), 'attribution must not change rendered bytes');
  const probe = buildCaptionOverflowProbe(diagnosticDocument, base.width, base.height, 512, 512, states);
  assert.ok(probe.captionGroups.some((groups) => JSON.stringify(groups) === '[[1],[2]]'), 'native deduplication must retain both occurrences');
  await assert.rejects(validateCaptionOverflow({ ...base, captions, appearance: a, collectIssues: true }), (error: unknown) => {
    assert.ok(error instanceof CaptionOverflowError);
    assert.equal(error.kind, 'overflow');
    assert.deepEqual(error.captionGroups, [['late-one'], ['late-two']]);
    return true;
  });
});

test('layout diagnostics report the actual overlap group without blaming a single caption', async () => {
  const text = Array(8).fill('hello').join('\n');
  const first = { ...cue(text), id: 'overlap-a' };
  const second = { ...cue(text), id: 'overlap-b', startMs: 2000, endMs: 3000 };
  await validateCaptionOverflow({ ...base, captions: [first, second], collectIssues: true });
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [first, { ...second, startMs: 500 }], collectIssues: true }), (error: unknown) => {
    assert.ok(error instanceof CaptionOverflowError);
    assert.deepEqual(error.captionGroups, [['overlap-a', 'overlap-b']]);
    return true;
  });
});

test('diagnostic opacity dominance retains different source groups and rejects unknown bounds', async () => {
  const states = new Map<string, number[]>();
  const document = buildAssDocument([
    { ...cue('hello'), id: 'first' }, { ...cue('hello'), id: 'short', startMs: 2000, endMs: 2080 },
  ], { ...appearance, motionPreset: 'fade' }, base.width, base.height, undefined, undefined, states);
  const probe = buildCaptionOverflowProbe(document, base.width, base.height, 512, 512, states);
  assert.ok(probe.captionGroups.some((groups) => groups.some((indices) => indices.join() === '0')));
  assert.ok(probe.captionGroups.some((groups) => groups.some((indices) => indices.join() === '1')));
  await assert.rejects(validateCaptionOverflow({ ...base, captions: [cue('hello')], width: 8192, height: 8192, collectIssues: true }), (error: unknown) => {
    assert.ok(error instanceof CaptionOverflowError);
    assert.equal(error.kind, 'unverifiable');
    assert.deepEqual(error.captionGroups, []);
    return true;
  });
});
