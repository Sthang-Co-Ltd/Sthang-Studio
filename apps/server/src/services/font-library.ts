import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CaptionFontImportResult, VideoExportFontCapability } from '@kcs/shared';
import { config } from '../config.js';

export interface LocalCaptionFont extends VideoExportFontCapability {
  regularPath: string;
  boldPath?: string;
}

interface ParsedFontFace {
  family: string;
  subfamily: string;
  weight: number;
  bold: boolean;
  italic: boolean;
}

interface ScannedFontFace extends ParsedFontFace {
  filePath: string;
  source: VideoExportFontCapability['source'];
}

interface FontReader {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

interface FontRoot {
  directory: string;
  source: VideoExportFontCapability['source'];
  depth: number;
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const IMPORT_EXTENSIONS = new Set(['.ttf', '.otf']);
const MAX_IMPORT_FILES = 8;
const SYSTEM_FONT_CACHE_MS = 5 * 60_000;
const MAX_FONT_FILES = 4_000;
const MAX_TABLE_BYTES = 4 * 1024 * 1024;
const KHMER_COVERAGE_SAMPLE = [
  0x1780, 0x1781, 0x1782, 0x179f, 0x17a2,
  0x17b6, 0x17bb, 0x17c1, 0x17d2, 0x17e0,
];

let systemCache: { at: number; pending: Promise<LocalCaptionFont[]> } | null = null;
let importedCache: Promise<LocalCaptionFont[]> | null = null;

async function unlinkFile(filePath: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'ENOENT') return;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function safeU16(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error('Font table is truncated.');
  return buffer.readUInt16BE(offset);
}

function safeI16(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error('Font table is truncated.');
  return buffer.readInt16BE(offset);
}

function safeU32(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error('Font table is truncated.');
  return buffer.readUInt32BE(offset);
}

function decodeUtf16Be(buffer: Buffer) {
  if (buffer.length % 2 !== 0) return '';
  let value = '';
  for (let index = 0; index < buffer.length; index += 2) value += String.fromCharCode(buffer.readUInt16BE(index));
  return value;
}

function cleanName(value: string) {
  return value.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function readNameRecord(nameTable: Buffer, wantedIds: number[]) {
  if (nameTable.length < 6) return '';
  const count = safeU16(nameTable, 2);
  const storageOffset = safeU16(nameTable, 4);
  let best = { score: -1, value: '' };
  for (let index = 0; index < Math.min(count, 512); index += 1) {
    const record = 6 + index * 12;
    if (record + 12 > nameTable.length) break;
    const platform = safeU16(nameTable, record);
    const language = safeU16(nameTable, record + 4);
    const nameId = safeU16(nameTable, record + 6);
    const length = safeU16(nameTable, record + 8);
    const offset = safeU16(nameTable, record + 10);
    const wantedIndex = wantedIds.indexOf(nameId);
    if (wantedIndex < 0 || length <= 0) continue;
    const start = storageOffset + offset;
    if (start < 0 || start + length > nameTable.length) continue;
    const raw = nameTable.subarray(start, start + length);
    const decoded = platform === 0 || platform === 3 ? decodeUtf16Be(raw) : raw.toString('latin1');
    const value = cleanName(decoded);
    if (!value) continue;
    const score = (wantedIds.length - wantedIndex) * 100
      + (platform === 3 ? 30 : platform === 0 ? 20 : 0)
      + ([0, 0x0409].includes(language) ? 5 : 0);
    if (score > best.score) best = { score, value };
  }
  return best.value;
}

function format4HasCodepoint(table: Buffer, subtableOffset: number, codepoint: number) {
  if (codepoint > 0xffff || subtableOffset + 16 > table.length) return false;
  const length = safeU16(table, subtableOffset + 2);
  const end = Math.min(table.length, subtableOffset + length);
  const segCount = safeU16(table, subtableOffset + 6) / 2;
  if (!Number.isInteger(segCount) || segCount <= 0 || segCount > 8192) return false;
  const endCode = subtableOffset + 14;
  const startCode = endCode + segCount * 2 + 2;
  const idDelta = startCode + segCount * 2;
  const idRangeOffset = idDelta + segCount * 2;
  if (idRangeOffset + segCount * 2 > end) return false;
  for (let index = 0; index < segCount; index += 1) {
    const segmentEnd = safeU16(table, endCode + index * 2);
    if (codepoint > segmentEnd) continue;
    const segmentStart = safeU16(table, startCode + index * 2);
    if (codepoint < segmentStart) return false;
    const delta = safeI16(table, idDelta + index * 2);
    const range = safeU16(table, idRangeOffset + index * 2);
    if (range === 0) return ((codepoint + delta) & 0xffff) !== 0;
    const rangeWord = idRangeOffset + index * 2;
    const glyphOffset = rangeWord + range + (codepoint - segmentStart) * 2;
    if (glyphOffset < subtableOffset || glyphOffset + 2 > end) return false;
    const glyph = safeU16(table, glyphOffset);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

function format12HasCodepoint(table: Buffer, subtableOffset: number, codepoint: number) {
  if (subtableOffset + 16 > table.length) return false;
  const length = safeU32(table, subtableOffset + 4);
  const end = Math.min(table.length, subtableOffset + length);
  const groups = safeU32(table, subtableOffset + 12);
  if (groups > 1_000_000 || subtableOffset + 16 + groups * 12 > end) return false;
  let low = 0;
  let high = groups - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const offset = subtableOffset + 16 + middle * 12;
    const start = safeU32(table, offset);
    const finish = safeU32(table, offset + 4);
    if (codepoint < start) high = middle - 1;
    else if (codepoint > finish) low = middle + 1;
    else return safeU32(table, offset + 8) + (codepoint - start) !== 0;
  }
  return false;
}

function cmapHasCodepoint(cmap: Buffer, codepoint: number) {
  if (cmap.length < 4) return false;
  const count = safeU16(cmap, 2);
  const subtables: Array<{ format: number; offset: number; score: number }> = [];
  for (let index = 0; index < Math.min(count, 64); index += 1) {
    const record = 4 + index * 8;
    if (record + 8 > cmap.length) break;
    const platform = safeU16(cmap, record);
    const encoding = safeU16(cmap, record + 2);
    const offset = safeU32(cmap, record + 4);
    if (offset + 2 > cmap.length) continue;
    const format = safeU16(cmap, offset);
    if (format !== 4 && format !== 12) continue;
    const score = (format === 12 ? 100 : 50)
      + (platform === 3 && encoding === 10 ? 30 : platform === 3 && encoding === 1 ? 20 : platform === 0 ? 10 : 0);
    subtables.push({ format, offset, score });
  }
  subtables.sort((a, b) => b.score - a.score);
  return subtables.some((subtable) => subtable.format === 12
    ? format12HasCodepoint(cmap, subtable.offset, codepoint)
    : format4HasCodepoint(cmap, subtable.offset, codepoint));
}

function supportsKhmer(cmap: Buffer) {
  return KHMER_COVERAGE_SAMPLE.every((codepoint) => cmapHasCodepoint(cmap, codepoint));
}

async function readTable(reader: FontReader, entry: { offset: number; length: number }, limit = MAX_TABLE_BYTES) {
  if (entry.offset < 0 || entry.length <= 0 || entry.length > limit || entry.offset + entry.length > reader.size) {
    throw new Error('Font table has invalid bounds.');
  }
  return reader.read(entry.offset, entry.length);
}

async function parseFace(reader: FontReader, faceOffset: number): Promise<ParsedFontFace | null> {
  const header = await reader.read(faceOffset, 12);
  if (header.length < 12) return null;
  const signature = header.subarray(0, 4).toString('latin1');
  const sfnt = safeU32(header, 0);
  if (![0x00010000, 0x74727565, 0x74797031].includes(sfnt) && signature !== 'OTTO') return null;
  const tableCount = safeU16(header, 4);
  if (tableCount <= 0 || tableCount > 256) return null;
  const directory = await reader.read(faceOffset + 12, tableCount * 16);
  if (directory.length < tableCount * 16) return null;
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < tableCount; index += 1) {
    const offset = index * 16;
    const tag = directory.subarray(offset, offset + 4).toString('latin1');
    tables.set(tag, { offset: safeU32(directory, offset + 8), length: safeU32(directory, offset + 12) });
  }
  const nameEntry = tables.get('name');
  const cmapEntry = tables.get('cmap');
  const hasOutlines = Boolean((tables.has('glyf') && tables.has('loca')) || tables.has('CFF ') || tables.has('CFF2'));
  // Khmer preview/export is a shaping contract, so a Unicode cmap alone is not
  // enough. HarfBuzz/libass need OpenType substitution and positioning evidence.
  if (!nameEntry || !cmapEntry || !hasOutlines || !tables.has('GSUB') || !tables.has('GPOS')) return null;
  const [name, cmap, os2] = await Promise.all([
    readTable(reader, nameEntry, 512 * 1024),
    readTable(reader, cmapEntry),
    tables.get('OS/2') ? readTable(reader, tables.get('OS/2')!, 256 * 1024).catch(() => Buffer.alloc(0)) : Buffer.alloc(0),
  ]);
  if (!supportsKhmer(cmap)) return null;
  const family = readNameRecord(name, [16, 1]);
  if (!family || family.includes(',')) return null;
  const subfamily = readNameRecord(name, [17, 2]) || 'Regular';
  const weight = os2.length >= 6 ? safeU16(os2, 4) : 400;
  const bold = weight >= 600 || /\b(?:semi|demi)?bold\b|\bblack\b|\bheavy\b/i.test(subfamily);
  const italic = /\bitalic\b|\boblique\b/i.test(subfamily);
  return { family, subfamily, weight, bold, italic };
}

async function parseReaderFaces(reader: FontReader) {
  const header = await reader.read(0, 12);
  if (header.length < 12) return [] as ParsedFontFace[];
  let offsets = [0];
  if (header.subarray(0, 4).toString('latin1') === 'ttcf') {
    const count = safeU32(header, 8);
    if (count <= 0 || count > 64) return [];
    const offsetBuffer = await reader.read(12, count * 4);
    if (offsetBuffer.length < count * 4) return [];
    offsets = Array.from({ length: count }, (_, index) => safeU32(offsetBuffer, index * 4));
  }
  const faces: ParsedFontFace[] = [];
  for (const offset of offsets) {
    if (offset < 0 || offset + 12 > reader.size) continue;
    const face = await parseFace(reader, offset).catch(() => null);
    if (face) faces.push(face);
  }
  return faces;
}

export async function inspectCaptionFontBuffer(buffer: Buffer) {
  const reader: FontReader = {
    size: buffer.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buffer.length) return Buffer.alloc(0);
      return buffer.subarray(offset, offset + length);
    },
  };
  return parseReaderFaces(reader);
}

async function inspectCaptionFontFile(filePath: string) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 12) return [] as ParsedFontFace[];
    const reader: FontReader = {
      size: stat.size,
      async read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > stat.size) return Buffer.alloc(0);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      },
    };
    return await parseReaderFaces(reader);
  } finally {
    await handle.close();
  }
}

async function collectFontFiles(directory: string, depth: number) {
  const files: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory, depth }];
  while (queue.length && files.length < MAX_FONT_FILES) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FONT_FILES) break;
      const item = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth > 0) queue.push({ directory: item, depth: current.depth - 1 });
      else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(item);
    }
  }
  return files;
}

async function mapLimit<T, R>(values: T[], limit: number, operation: (value: T) => Promise<R>) {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanRoot(root: FontRoot) {
  const files = await collectFontFiles(root.directory, root.depth);
  const parsed = await mapLimit(files, 12, async (filePath) => {
    const faces = await inspectCaptionFontFile(filePath).catch(() => []);
    return faces.map((face) => ({ ...face, filePath, source: root.source } satisfies ScannedFontFace));
  });
  return parsed.flat();
}

function familyKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en');
}

function importedFontId(family: string) {
  return `studio:${createHash('sha256').update(familyKey(family)).digest('hex').slice(0, 16)}`;
}

function groupFaces(faces: ScannedFontFace[], source: VideoExportFontCapability['source']) {
  const grouped = new Map<string, ScannedFontFace[]>();
  for (const face of faces.filter((item) => item.source === source && !item.italic)) {
    const key = familyKey(face.family);
    grouped.set(key, [...(grouped.get(key) || []), face]);
  }
  const fonts: LocalCaptionFont[] = [];
  for (const familyFaces of grouped.values()) {
    const regular = familyFaces.filter((face) => !face.bold).sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
    if (!regular) continue;
    const bold = familyFaces.filter((face) => face.bold).sort((a, b) => Math.abs(a.weight - 700) - Math.abs(b.weight - 700))[0];
    fonts.push({
      ...(source === 'studio-imported' ? { id: importedFontId(regular.family), removable: true } : {}),
      name: regular.family,
      available: true,
      boldAvailable: Boolean(bold),
      source,
      regularPath: regular.filePath,
      boldPath: bold?.filePath,
    });
  }
  return fonts.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function systemFontRoots(): FontRoot[] {
  if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    const roots: FontRoot[] = [{ directory: path.join(windows, 'Fonts'), source: 'windows-system', depth: 0 }];
    if (process.env.LOCALAPPDATA) roots.unshift({ directory: path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'), source: 'user-installed', depth: 0 });
    return roots;
  }
  if (process.platform === 'darwin') {
    return [
      { directory: path.join(os.homedir(), 'Library', 'Fonts'), source: 'user-installed', depth: 1 },
      { directory: '/Library/Fonts', source: 'macos-system', depth: 1 },
      { directory: '/System/Library/Fonts', source: 'macos-system', depth: 2 },
    ];
  }
  return [
    { directory: path.join(os.homedir(), '.local', 'share', 'fonts'), source: 'user-installed', depth: 3 },
    { directory: path.join(os.homedir(), '.fonts'), source: 'user-installed', depth: 3 },
    { directory: '/usr/local/share/fonts', source: 'linux-system', depth: 3 },
    { directory: '/usr/share/fonts', source: 'linux-system', depth: 4 },
  ];
}

async function scanSystemFonts() {
  const now = Date.now();
  if (systemCache && now - systemCache.at < SYSTEM_FONT_CACHE_MS) return systemCache.pending;
  const pending = (async () => {
    const roots = systemFontRoots();
    const faces = (await Promise.all(roots.map(scanRoot))).flat();
    const sources: VideoExportFontCapability['source'][] = ['user-installed', 'windows-system', 'macos-system', 'linux-system'];
    const all = sources.flatMap((source) => groupFaces(faces, source));
    const seen = new Set<string>();
    return all.filter((font) => {
      const key = familyKey(font.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  systemCache = { at: now, pending };
  try {
    return await pending;
  } catch (error) {
    systemCache = null;
    throw error;
  }
}

async function scanImportedFaces() {
  const root: FontRoot = { directory: config.userFontDir, source: 'studio-imported', depth: 0 };
  return scanRoot(root);
}

async function scanImportedFonts() {
  if (!importedCache) importedCache = scanImportedFaces().then((faces) => groupFaces(faces, 'studio-imported'));
  return importedCache;
}

export function invalidateCaptionFontCache(options: { system?: boolean } = {}) {
  importedCache = null;
  if (options.system) systemCache = null;
}

export async function discoverCaptionFonts() {
  const [imported, system] = await Promise.all([scanImportedFonts(), scanSystemFonts()]);
  const seen = new Set<string>();
  return [...imported, ...system].filter((font) => {
    const key = familyKey(font.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function publicCaptionFonts(fonts: LocalCaptionFont[]): VideoExportFontCapability[] {
  return fonts.map(({ id, name, available, boldAvailable, source, removable }) => ({
    ...(id ? { id } : {}),
    name,
    available,
    boldAvailable,
    source,
    ...(removable ? { removable: true } : {}),
  }));
}

function importKind(face: ParsedFontFace) {
  return face.bold ? 'bold' as const : 'regular' as const;
}

export async function importCaptionFonts(files: Array<{ originalName: string; buffer: Buffer }>): Promise<CaptionFontImportResult> {
  await fs.mkdir(config.userFontDir, { recursive: true });
  const warnings: string[] = [];
  const candidates: Array<{ face: ParsedFontFace; kind: 'regular' | 'bold'; extension: '.ttf' | '.otf'; buffer: Buffer; originalName: string }> = [];
  for (const file of files.slice(0, MAX_IMPORT_FILES)) {
    const extension = path.extname(file.originalName).toLowerCase();
    if (!IMPORT_EXTENSIONS.has(extension)) {
      warnings.push(`${file.originalName}: choose a .ttf or .otf font file.`);
      continue;
    }
    const faces = await inspectCaptionFontBuffer(file.buffer).catch(() => []);
    if (!faces.length) {
      warnings.push(`${file.originalName}: this file is not a usable Khmer font.`);
      continue;
    }
    const face = faces.find((item) => !item.italic) || faces[0];
    if (face.italic) {
      warnings.push(`${file.originalName}: italic/oblique faces are not supported yet.`);
      continue;
    }
    candidates.push({ face, kind: importKind(face), extension: extension as '.ttf' | '.otf', buffer: file.buffer, originalName: file.originalName });
  }

  const [existingFaces, systemFonts] = await Promise.all([scanImportedFaces(), scanSystemFonts()]);
  const existingImportedFamilies = new Set(existingFaces.map((face) => familyKey(face.family)));
  const systemFamilies = new Set(systemFonts.map((font) => familyKey(font.name)));
  const nonConflicting = candidates.filter((candidate) => {
    const key = familyKey(candidate.face.family);
    if (!systemFamilies.has(key) || existingImportedFamilies.has(key)) return true;
    warnings.push(`${candidate.originalName}: “${candidate.face.family}” is already installed on this computer. Choose that installed family from the list instead of adding a second copy.`);
    return false;
  });
  const candidateRegular = new Set(nonConflicting.filter((candidate) => candidate.kind === 'regular').map((candidate) => familyKey(candidate.face.family)));
  const existingRegular = new Set(existingFaces.filter((face) => !face.bold && !face.italic).map((face) => familyKey(face.family)));
  const usable = nonConflicting.filter((candidate) => {
    if (candidate.kind !== 'bold') return true;
    const key = familyKey(candidate.face.family);
    if (candidateRegular.has(key) || existingRegular.has(key)) return true;
    warnings.push(`${candidate.originalName}: add the Regular face for “${candidate.face.family}” first (or select Regular and Bold together).`);
    return false;
  });

  const lastCandidate = new Map<string, (typeof usable)[number]>();
  for (const candidate of usable) lastCandidate.set(`${familyKey(candidate.face.family)}:${candidate.kind}`, candidate);
  const finalCandidates = [...lastCandidate.values()];
  const replacedPaths = new Set<string>();
  for (const candidate of finalCandidates) {
    const key = familyKey(candidate.face.family);
    for (const existing of existingFaces) {
      if (familyKey(existing.family) !== key || importKind(existing) !== candidate.kind) continue;
      replacedPaths.add(existing.filePath);
    }
  }
  const importedNames = new Set<string>();
  const prepared = finalCandidates.map((candidate) => {
    const digest = createHash('sha256').update(candidate.buffer).digest('hex').slice(0, 20);
    const fileName = `${importedFontId(candidate.face.family).slice('studio:'.length)}-${candidate.kind}-${digest}${candidate.extension}`;
    const destination = path.join(config.userFontDir, fileName);
    return { candidate, destination, temporary: `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp` };
  });
  const staged: typeof prepared = [];
  const createdDestinations: string[] = [];
  try {
    for (const item of prepared) {
      const exists = await fs.stat(item.destination).then((stat) => stat.isFile()).catch(() => false);
      if (exists) continue;
      await fs.writeFile(item.temporary, item.candidate.buffer, { flag: 'wx' });
      staged.push(item);
    }
    for (const item of staged) {
      await fs.rename(item.temporary, item.destination);
      createdDestinations.push(item.destination);
    }
  } catch (error) {
    await Promise.all(staged.map((item) => unlinkFile(item.temporary).catch(() => {})));
    await Promise.all(createdDestinations.map((filePath) => unlinkFile(filePath).catch(() => {})));
    throw error;
  }
  const nextPaths = new Set(prepared.map((item) => item.destination));
  await Promise.all([...replacedPaths].filter((filePath) => !nextPaths.has(filePath)).map((filePath) => unlinkFile(filePath).catch(() => {})));
  for (const item of prepared) importedNames.add(item.candidate.face.family);

  invalidateCaptionFontCache();
  const fonts = publicCaptionFonts(await discoverCaptionFonts());
  return { fonts, imported: [...importedNames], warnings };
}

export async function removeImportedCaptionFont(id: string) {
  const faces = await scanImportedFaces();
  const matching = faces.filter((face) => importedFontId(face.family) === id);
  if (!matching.length) throw new Error('That added font is no longer in Studio. Refresh the font list and try again.');
  const family = matching[0].family;
  const systemMatch = (await scanSystemFonts()).some((font) => familyKey(font.name) === familyKey(family));
  if (systemMatch) {
    throw new Error(`“${family}” is also installed on this computer. Studio is keeping the added copy so saved projects cannot silently switch to a different local file with the same family name.`);
  }
  const paths = [...new Set(matching.map((face) => face.filePath))];
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged: Array<{ source: string; hidden: string }> = [];
  try {
    for (const source of paths) {
      const hidden = `${source}.${transactionId}.remove`;
      await fs.rename(source, hidden);
      staged.push({ source, hidden });
    }
  } catch (error) {
    for (const item of staged.reverse()) await fs.rename(item.hidden, item.source).catch(() => {});
    throw error;
  }
  invalidateCaptionFontCache();
  const fonts = publicCaptionFonts(await discoverCaptionFonts());
  await Promise.all(staged.map((item) => unlinkFile(item.hidden).catch(() => {})));
  return fonts;
}
