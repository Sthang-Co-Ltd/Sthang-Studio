import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let root = '';
let config: { userFontDir: string };
let fontLibrary: typeof import('../apps/server/src/services/font-library.js');

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-font-library-'));
  process.env.STHANG_STUDIO_STATE_ROOT = root;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
  if (process.platform === 'win32') {
    process.env.WINDIR = path.join(root, 'Windows');
    process.env.LOCALAPPDATA = path.join(root, 'LocalAppData');
  }
  config = (await import('../apps/server/src/config.js')).config;
  fontLibrary = await import('../apps/server/src/services/font-library.js');
});

after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

function utf16be(value: string) {
  const result = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) result.writeUInt16BE(value.charCodeAt(index), index * 2);
  return result;
}

function nameTable(family: string, subfamily: string) {
  const familyBytes = utf16be(family);
  const subfamilyBytes = utf16be(subfamily);
  const count = 2;
  const storageOffset = 6 + count * 12;
  const result = Buffer.alloc(storageOffset + familyBytes.length + subfamilyBytes.length);
  result.writeUInt16BE(0, 0);
  result.writeUInt16BE(count, 2);
  result.writeUInt16BE(storageOffset, 4);
  const records = [
    { nameId: 1, bytes: familyBytes, offset: 0 },
    { nameId: 2, bytes: subfamilyBytes, offset: familyBytes.length },
  ];
  records.forEach((record, index) => {
    const at = 6 + index * 12;
    result.writeUInt16BE(3, at);
    result.writeUInt16BE(1, at + 2);
    result.writeUInt16BE(0x0409, at + 4);
    result.writeUInt16BE(record.nameId, at + 6);
    result.writeUInt16BE(record.bytes.length, at + 8);
    result.writeUInt16BE(record.offset, at + 10);
    record.bytes.copy(result, storageOffset + record.offset);
  });
  return result;
}

function cmapFormat12(start: number, end: number) {
  const result = Buffer.alloc(40);
  result.writeUInt16BE(0, 0);
  result.writeUInt16BE(1, 2);
  result.writeUInt16BE(3, 4);
  result.writeUInt16BE(10, 6);
  result.writeUInt32BE(12, 8);
  result.writeUInt16BE(12, 12);
  result.writeUInt16BE(0, 14);
  result.writeUInt32BE(28, 16);
  result.writeUInt32BE(0, 20);
  result.writeUInt32BE(1, 24);
  result.writeUInt32BE(start, 28);
  result.writeUInt32BE(end, 32);
  result.writeUInt32BE(1, 36);
  return result;
}

function syntheticFont(options: { family: string; subfamily?: string; weight?: number; khmer?: boolean }) {
  const os2 = Buffer.alloc(64);
  os2.writeUInt16BE(options.weight ?? 400, 4);
  const tables = new Map<string, Buffer>([
    ['name', nameTable(options.family, options.subfamily || 'Regular')],
    ['cmap', cmapFormat12(options.khmer === false ? 0x20 : 0x1780, options.khmer === false ? 0x7e : 0x17ff)],
    ['OS/2', os2],
    ['GSUB', Buffer.from([0, 1, 0, 0])],
    ['GPOS', Buffer.from([0, 1, 0, 0])],
    ['glyf', Buffer.alloc(4)],
    ['loca', Buffer.alloc(4)],
  ]);
  const recordsBytes = tables.size * 16;
  let cursor = 12 + recordsBytes;
  const entries: Array<{ tag: string; data: Buffer; offset: number }> = [];
  for (const [tag, data] of tables) {
    cursor = Math.ceil(cursor / 4) * 4;
    entries.push({ tag, data, offset: cursor });
    cursor += data.length;
  }
  const result = Buffer.alloc(cursor);
  result.writeUInt32BE(0x00010000, 0);
  result.writeUInt16BE(tables.size, 4);
  entries.forEach((entry, index) => {
    const record = 12 + index * 16;
    result.write(entry.tag, record, 4, 'latin1');
    result.writeUInt32BE(0, record + 4);
    result.writeUInt32BE(entry.offset, record + 8);
    result.writeUInt32BE(entry.data.length, record + 12);
    entry.data.copy(result, entry.offset);
  });
  return result;
}

test('font inspection accepts shaped Khmer faces and identifies family/weight', async () => {
  const regular = await fontLibrary.inspectCaptionFontBuffer(syntheticFont({ family: 'Studio Test Khmer', khmer: true }));
  assert.equal(regular.length, 1);
  assert.equal(regular[0].family, 'Studio Test Khmer');
  assert.equal(regular[0].bold, false);
  assert.equal(regular[0].italic, false);

  const bold = await fontLibrary.inspectCaptionFontBuffer(syntheticFont({ family: 'Studio Test Khmer', subfamily: 'Bold', weight: 700 }));
  assert.equal(bold.length, 1);
  assert.equal(bold[0].bold, true);

  const latinOnly = await fontLibrary.inspectCaptionFontBuffer(syntheticFont({ family: 'Latin Only', khmer: false }));
  assert.deepEqual(latinOnly, []);
});

test('user font import is local, groups regular/bold, and removes only Studio copies', async () => {
  const family = 'Studio Import Fixture Khmer';
  const result = await fontLibrary.importCaptionFonts([
    { originalName: 'fixture-regular.ttf', buffer: syntheticFont({ family }) },
    { originalName: 'fixture-bold.otf', buffer: syntheticFont({ family, subfamily: 'Bold', weight: 700 }) },
  ]);
  assert.deepEqual(result.imported, [family]);
  assert.deepEqual(result.warnings, []);
  const imported = result.fonts.find((font) => font.name === family);
  assert.ok(imported);
  assert.equal(imported.source, 'studio-imported');
  assert.equal(imported.boldAvailable, true);
  assert.equal(imported.removable, true);
  assert.match(imported.id || '', /^studio:[0-9a-f]{16}$/);

  const files = await fs.readdir(config.userFontDir);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => /-(regular|bold)-[0-9a-f]{20}\.(ttf|otf)$/.test(file)));

  const afterRemoval = await fontLibrary.removeImportedCaptionFont(imported.id!);
  assert.equal(afterRemoval.some((font) => font.name === family && font.source === 'studio-imported'), false);
  assert.deepEqual(await fs.readdir(config.userFontDir), []);
});

test('bold-only imports explain how to recover instead of creating an unusable family', async () => {
  const result = await fontLibrary.importCaptionFonts([
    { originalName: 'lonely-bold.ttf', buffer: syntheticFont({ family: 'Studio Bold Only Khmer', subfamily: 'Bold', weight: 700 }) },
  ]);
  assert.deepEqual(result.imported, []);
  assert.ok(result.warnings.some((warning) => /add the Regular face/i.test(warning)));
  assert.deepEqual(await fs.readdir(config.userFontDir), []);
});
