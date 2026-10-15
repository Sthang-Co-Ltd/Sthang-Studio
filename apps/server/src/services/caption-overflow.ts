import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizeCaptionAppearance, type CaptionAppearance, type CaptionSegment } from '@kcs/shared';
import { config } from '../config.js';
import { buildAssCaptionFilter, buildAssDocument } from './caption-renderer.js';

/** A layout rejection must not be mistaken for a failed preview transport. */
export class CaptionOverflowError extends Error {
  readonly code = 'CAPTION_OVERFLOW';
  constructor(message = 'Caption extends outside the video. Reduce Size, increase Max width, or adjust its position.') {
    super(message);
    this.name = 'CaptionOverflowError';
  }
}

const verified = new Map<string, string>();
let cacheGeneration = 0;

export function invalidateCaptionOverflowCache(cacheScope?: string) {
  cacheGeneration += 1;
  for (const [key, scope] of verified) if (cacheScope === undefined || scope === cacheScope) verified.delete(key);
}
const MAX_CACHE = 128;
const MAX_STATES = 8192;
const MAX_FRAME_PIXELS = 32_000_000;
const unverifiable = () => new CaptionOverflowError('Caption bounds could not be safely checked. Reduce Size or the number of overlapping captions, then try again.');

function timestamp(seconds: number) {
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00`;
}

/** Translate the whole ASS coordinate system without changing its wrapping budget.
 * Enlarging both PlayRes and the physical canvas keeps all font/outline scales 1:1.
 */
export function buildCaptionOverflowProbe(document: string, width: number, height: number, padX: number, padY = padX) {
  const header: string[] = [];
  const groups = new Map<string, string[]>();
  for (const line of document.split('\n')) {
    if (line.startsWith('PlayResX:')) header.push(`PlayResX: ${width + padX * 2}`);
    else if (line.startsWith('PlayResY:')) header.push(`PlayResY: ${height + padY * 2}`);
    else if (line.startsWith('Style: ')) {
      const parts = line.slice(7).split(',');
      for (const index of [19, 20, 21]) parts[index] = String(Number(parts[index]) + (index === 21 ? padY : padX));
      header.push('Style: ' + parts.join(','));
    } else if (line.startsWith('Dialogue: ')) {
      // Split only the fixed ASS fields; commas in text and \\pos must survive.
      const parts = line.slice(10).split(',');
      const key = `${parts[1]},${parts[2]}`;
      for (const index of [5, 6, 7]) if (Number(parts[index])) parts[index] = String(Number(parts[index]) + (index === 7 ? padY : padX));
      parts[1] = ''; parts[2] = '';
      const event = parts.join(',').replace(/\\pos\(([-\d.]+),([-\d.]+)\)/g,
        (_, x: string, y: string) => `\\pos(${Number(x) + padX},${Number(y) + padY})`);
      const events = groups.get(key) || [];
      events.push(event);
      groups.set(key, events);
    } else header.push(line);
  }
  const paintedStates = [...new Set([...groups.values()].filter((events) => !events.every((event) => {
    // The renderer writes one explicit temporal alpha triple before each cue.
    // A fully transparent fade endpoint has no paint and needs no measurement.
    const tags = [...event.matchAll(/\\1a&H([0-9A-F]{2})&\\3a&H([0-9A-F]{2})&\\4a&H([0-9A-F]{2})&/g)];
    return tags.length > 0 && tags.every((tag) => tag[1] === 'FF' && tag[2] === 'FF' && tag[3] === 'FF');
  })).map((events) => events.join('\n')))];
  // An actual state can cover another state's ink only when geometry, layers,
  // text and colors are byte-identical and EVERY corresponding opacity is at
  // least as high. Keep the observed Pareto frontier, never invent a combination
  // of independent cue/layer opacity maxima that did not actually occur.
  const geometry = new Map<string, Array<{ state: string; alphas: number[] }>>();
  for (const state of paintedStates) {
    const alphas: number[] = [];
    const key = state.replace(/\\([134]a)&H([0-9A-F]{2})&/g, (_, tag: string, alpha: string) => {
      alphas.push(parseInt(alpha, 16));
      return `\\${tag}&H??&`;
    });
    const candidates = geometry.get(key) || [];
    candidates.push({ state, alphas });
    geometry.set(key, candidates);
  }
  const states: string[] = [];
  for (const candidates of geometry.values()) {
    candidates.sort((a, b) => a.alphas.reduce((sum, value) => sum + value, 0) - b.alphas.reduce((sum, value) => sum + value, 0));
    const frontier: typeof candidates = [];
    for (const candidate of candidates) {
      if (!frontier.some((other) => other.alphas.every((value, index) => value <= candidate.alphas[index]))) {
        frontier.push(candidate);
        states.push(candidate.state);
      }
    }
  }
  if (states.length > MAX_STATES) throw unverifiable();
  const events = states.flatMap((state, index) => state.split('\n').map((event) => {
    const parts = event.split(',');
    parts[1] = timestamp(index); parts[2] = timestamp(index + 1);
    return 'Dialogue: ' + parts.join(',');
  }));
  return { document: header.join('\n') + '\n' + events.join('\n') + '\n', count: states.length };
}

/** Resolve a BMP codepoint from the bounded Unicode cmap formats used by the
 * reviewed faces. Unknown formats return undefined and retain max-advance guard.
 */
export function captionCmapGlyph(table: Buffer, codepoint: number): number | undefined {
  if (table.length < 2) throw unverifiable();
  const format = table.readUInt16BE(0);
  if (format === 4) {
    if (table.length < 16) throw unverifiable();
    const length = table.readUInt16BE(2);
    const segments = table.readUInt16BE(6) / 2;
    if (!Number.isInteger(segments) || !segments || length > table.length || 16 + segments * 8 > length) throw unverifiable();
    for (let index = 0; index < segments; index++) {
      const end = table.readUInt16BE(14 + index * 2);
      const start = table.readUInt16BE(16 + segments * 2 + index * 2);
      if (codepoint < start || codepoint > end) continue;
      const delta = table.readInt16BE(16 + segments * 4 + index * 2);
      const rangeAt = 16 + segments * 6 + index * 2;
      const range = table.readUInt16BE(rangeAt);
      if (!range) return (codepoint + delta) & 0xffff;
      const glyphAt = rangeAt + range + (codepoint - start) * 2;
      if (glyphAt < 16 + segments * 8 || glyphAt + 2 > length) throw unverifiable();
      const glyph = table.readUInt16BE(glyphAt);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  }
  if (format === 12) {
    if (table.length < 16) throw unverifiable();
    const length = table.readUInt32BE(4);
    const groups = table.readUInt32BE(12);
    if (groups > 65536 || length > table.length || 16 + groups * 12 > length) throw unverifiable();
    for (let index = 0; index < groups; index++) {
      const at = 16 + index * 12;
      const start = table.readUInt32BE(at); const end = table.readUInt32BE(at + 4);
      if (codepoint >= start && codepoint <= end) return table.readUInt32BE(at + 8) + codepoint - start;
    }
    return 0;
  }
  return undefined;
}

/** Read only published SFNT metrics; no guessed average glyph widths. TTC table
 * offsets are absolute within the collection. Malformed/unknown faces fail closed.
 */
function fontBounds(bytes: Buffer, spaces: ReadonlySet<number>) {
  const u16 = (at: number) => bytes.readUInt16BE(at);
  const i16 = (at: number) => bytes.readInt16BE(at);
  const u32 = (at: number) => bytes.readUInt32BE(at);
  const collection = bytes.toString('ascii', 0, 4) === 'ttcf';
  if (collection && u32(8) > 128) throw unverifiable();
  const offsets = collection
    ? Array.from({ length: u32(8) }, (_, index) => u32(12 + index * 4)) : [0];
  if (!offsets.length) throw unverifiable();
  let advance = 0; let line = 0; let glyphWidth = 0; let glyphHeight = 0;
  const spaceAdvances = new Map<number, number>();
  for (const offset of offsets) {
    const count = u16(offset + 4);
    if (count > 256) throw unverifiable();
    const tables = new Map<string, { at: number; size: number }>();
    for (let index = 0; index < count; index++) {
      const entry = offset + 12 + index * 16;
      const at = u32(entry + 8); const size = u32(entry + 12);
      if (at + size > bytes.length) throw unverifiable();
      tables.set(bytes.toString('ascii', entry, entry + 4), { at, size });
    }
    const head = tables.get('head'); const hhea = tables.get('hhea'); const os2 = tables.get('OS/2');
    if (!head || head.size < 54 || !hhea || hhea.size < 36) throw unverifiable();
    const units = u16(head.at + 18);
    const bboxWidth = i16(head.at + 40) - i16(head.at + 36);
    const bboxHeight = i16(head.at + 42) - i16(head.at + 38);
    const hheaHeight = i16(hhea.at + 4) - i16(hhea.at + 6);
    const heights = [units, hheaHeight];
    const lineHeights = [bboxHeight, hheaHeight + Math.max(0, i16(hhea.at + 8))];
    if (os2 && os2.size >= 78) {
      const typoHeight = i16(os2.at + 68) - i16(os2.at + 70);
      const winHeight = u16(os2.at + 74) + u16(os2.at + 76);
      heights.push(typoHeight, winHeight);
      lineHeights.push(typoHeight + Math.max(0, i16(os2.at + 72)), winHeight);
    }
    // libass normalizes the selected font's vertical metrics. Taking the smallest
    // positive published normalization height bounds every supported metric choice.
    const denominator = Math.min(...heights.filter((height) => height > 0));
    if (!units || !Number.isFinite(denominator) || bboxWidth <= 0 || bboxHeight <= 0) throw unverifiable();
    const maxAdvance = u16(hhea.at + 10) / denominator;
    const measuredSpaces = new Map<number, number>();
    const cmap = tables.get('cmap'); const hmtx = tables.get('hmtx'); const maxp = tables.get('maxp');
    if (cmap && cmap.size >= 4 && hmtx && maxp && maxp.size >= 6) {
      const records = u16(cmap.at + 2);
      const metrics = u16(hhea.at + 34);
      const glyphs = u16(maxp.at + 4);
      if (records > 128 || 4 + records * 8 > cmap.size || !metrics || metrics > glyphs || metrics * 4 > hmtx.size) throw unverifiable();
      for (let index = 0; index < records; index++) {
        const record = cmap.at + 4 + index * 8;
        const platform = u16(record); const encoding = u16(record + 2);
        if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
        const relative = u32(record + 4);
        if (relative + 2 > cmap.size) throw unverifiable();
        if (u16(cmap.at + relative) === 14) continue; // Variation-selector map, not a default character map.
        for (const codepoint of spaces) {
          const glyph = captionCmapGlyph(bytes.subarray(cmap.at + relative, cmap.at + cmap.size), codepoint);
          if (glyph === undefined || glyph === 0) {
            measuredSpaces.set(codepoint, Math.max(measuredSpaces.get(codepoint) ?? 0, maxAdvance));
            continue;
          }
          if (glyph >= glyphs) throw unverifiable();
          const value = u16(hmtx.at + Math.min(glyph, metrics - 1) * 4) / denominator;
          measuredSpaces.set(codepoint, Math.max(measuredSpaces.get(codepoint) ?? 0, value));
        }
      }
    }
    advance = Math.max(advance, maxAdvance);
    // Mapped Unicode whitespace receives its actual horizontal metric, including
    // NBSP. Missing mappings and unknown invisible fillers keep the face maximum.
    for (const codepoint of spaces) spaceAdvances.set(codepoint,
      Math.max(spaceAdvances.get(codepoint) ?? 0, measuredSpaces.get(codepoint) ?? maxAdvance));
    line = Math.max(line, ...lineHeights.map((height) => height / denominator));
    glyphWidth = Math.max(glyphWidth, bboxWidth / denominator);
    glyphHeight = Math.max(glyphHeight, bboxHeight / denominator);
  }
  return { advance, spaceAdvances, line, glyphWidth, glyphHeight };
}

async function fontSignature(directory: string, spaces: ReadonlySet<number>) {
  const hash = createHash('sha256');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (!files.length || entries.some((entry) => !entry.isFile())) throw unverifiable();
  let advance = 0; let line = 0; let glyphWidth = 0; let glyphHeight = 0;
  const spaceAdvances = new Map<number, number>();
  for (const name of files) {
    const bytes = await fs.readFile(path.join(directory, name));
    const bounds = fontBounds(bytes, spaces);
    advance = Math.max(advance, bounds.advance);
    for (const codepoint of spaces) spaceAdvances.set(codepoint,
      Math.max(spaceAdvances.get(codepoint) ?? 0, bounds.spaceAdvances.get(codepoint) ?? bounds.advance));
    line = Math.max(line, bounds.line);
    glyphWidth = Math.max(glyphWidth, bounds.glyphWidth);
    glyphHeight = Math.max(glyphHeight, bounds.glyphHeight);
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return { signature: hash.digest('hex'), advance, spaceAdvances, line, glyphWidth, glyphHeight };
}

/** The output frame limit does not bound upstream filter evaluation on every
 * FFmpeg scheduler. Bound the source before rendering so metadata cannot include
 * a look-ahead frame after the final ASS state has ended. */
export function captionOverflowSourceFilter(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_STATES) throw unverifiable();
  return `trim=end_frame=${count},settb=1/1,setpts=PTS-STARTPTS`;
}

/** Every synthetic state occupies exactly one second at 1 fps. Fail closed on
 * missing, repeated, reordered or mistimed samples, even if their boxes fit. */
export function parseCaptionOverflowBounds(output: string, count: number): number[][] {
  captionOverflowSourceFilter(count);
  const frames = output.split(/(?=^frame:)/m).filter((frame) => frame.startsWith('frame:'));
  if (frames.length !== count) throw unverifiable();
  return frames.map((frame, index) => {
    const header = /^frame:(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([^\s]+)[ \t]*\r?$/m.exec(frame);
    if (!header || Number(header[1]) !== index || Number(header[2]) !== index
      || Number(header[3]) !== index) throw unverifiable();
    const bounds = ['x1', 'x2', 'y1', 'y2'].map((key) => {
      const values = [...frame.matchAll(new RegExp(`^lavfi\\.bbox\\.${key}=(\\d+)$`, 'gm'))];
      if (values.length !== 1) throw unverifiable();
      const value = Number(values[0][1]);
      if (!Number.isSafeInteger(value)) throw unverifiable();
      return value;
    });
    if (bounds[0] > bounds[1] || bounds[2] > bounds[3]) throw unverifiable();
    return bounds;
  });
}

async function measure(file: string, fontDirectory: string, width: number, height: number, count: number, signal?: AbortSignal, shouldCancel?: () => boolean) {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(config.ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=1,format=rgba`,
      '-filter_complex', `[0:v]${captionOverflowSourceFilter(count)},split[black][whitebase];[black]${buildAssCaptionFilter(file, fontDirectory)}[ink];[whitebase]lutrgb=r=255:g=255:b=255,${buildAssCaptionFilter(file, fontDirectory)}[white];[white][ink]blend=all_mode=subtract,format=gbrp,extractplanes=r,lut=y=255-val,metadata=mode=add:key=preflight:value=1,bbox=min_val=0,metadata=mode=print:file=-[bounds]`,
      '-map', '[bounds]',
      '-frames:v', String(count), '-f', 'null', '-',
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      if (escalation) return;
      child.kill();
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('Caption bounds check cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    const cancellation = setInterval(() => { if (shouldCancel?.()) stop(new Error('Caption bounds check cancelled.')); }, 100);
    const timer = setTimeout(() => stop(unverifiable()), 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4_000_000) stop(unverifiable());
    });
    child.stderr.resume(); // Never expose paths, source text, or native diagnostics to users.
    child.once('error', () => { failure ||= unverifiable(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearInterval(cancellation);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure || unverifiable());
      else resolve(output);
    });
    if (signal?.aborted) abort();
  });
}

/** Measure the actual native paint, including decoration, overlaps and motion.
 * No size change, estimated Latin metrics, arbitrary token split, or clipped-frame
 * fit inference is permitted. Recovered coverage > 0 is ink, including faint antialias/glow.
 * Successful exact documents are cached only in bounded process memory.
 */
export async function validateCaptionOverflow(input: {
  captions: CaptionSegment[];
  appearance: Partial<CaptionAppearance> | undefined;
  width: number;
  height: number;
  fontDirectory: string;
  workDir: string;
  signal?: AbortSignal;
  shouldCancel?: () => boolean;
  cacheScope?: string;
}): Promise<void> {
  const { captions, width, height, fontDirectory, workDir, signal, shouldCancel, cacheScope } = input;
  const checkCancelled = () => { signal?.throwIfAborted(); if (shouldCancel?.()) throw new Error('Caption bounds check cancelled.'); };
  checkCancelled();
  signal?.throwIfAborted();
  if (!captions.some((caption) => caption.text.trim())) return;
  if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)
    || captions.length > 10_000 || captions.some((caption) => caption.text.length > 4096)
    || captions.reduce((sum, caption) => sum + caption.text.length, 0) > 200_000) throw unverifiable();
  const boundaries = captions.flatMap((caption) => [
    { at: caption.startMs, delta: caption.text.length + 1 },
    { at: caption.endMs, delta: -caption.text.length - 1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let overlappingCharacters = 0;
  for (const boundary of boundaries) {
    overlappingCharacters += boundary.delta;
    if (overlappingCharacters > 4096) throw unverifiable();
  }
  const appearance = normalizeCaptionAppearance(input.appearance);
  const document = buildAssDocument(captions, appearance, width, height);
  const generation = cacheGeneration;
  let fonts: Awaited<ReturnType<typeof fontSignature>>;
  try {
    const spaces = new Set(captions.flatMap((caption) => [...caption.text]
      .filter((char) => /\s/u.test(char) && !/[\r\n\t]/u.test(char)).map((char) => char.codePointAt(0)!)));
    fonts = await fontSignature(fontDirectory, spaces);
  } catch { throw unverifiable(); }
  const signature = createHash('sha256').update(document).update(fonts.signature)
    .update(config.ffmpegPath).update(cacheScope || '').digest('hex');
  signal?.throwIfAborted();
  checkCancelled();
  if (cacheScope && verified.get(signature) === cacheScope) return;
  // Preserve a generous native inspection guard around the saved video frame.
  // A touched guard is never accepted as a fit.
  const em = appearance.fontSize1080 * height / 1080;
  const decoration = Math.max(appearance.outlineWidth1080 + appearance.shadowWidth1080,
    appearance.backgroundPadding1080, (appearance.glowWidth1080 || 0) + 8) * height / 1080;
  // Invisible format/filler glyphs can separate blank lines without matching \s.
  // Count them conservatively too, so distant ink cannot escape the inspection guard.
  let blankAdvanceX = 0;
  let blankAdvanceY = 0;
  for (const caption of captions) {
    for (const match of caption.text.matchAll(/[\s\p{Default_Ignorable_Code_Point}\u2800]+/gu)) {
      const rows = match[0].replace(/\r\n/g, '\n').split('\n');
      blankAdvanceY = Math.max(blankAdvanceY, (rows.length - 1) * fonts.line);
      blankAdvanceX = Math.max(blankAdvanceX,
        ...rows.map((row) => [...row].reduce((sum, char) => sum + (fonts.spaceAdvances.get(char.codePointAt(0)!) ?? (char === '\t' ? 8 : 1) * fonts.advance), 0)));
    }
  }
  // Keep each axis independent: a horizontal blank span does not enlarge the
  // vertical guard. Published face bounds replace the old arbitrary four-em
  // floor, which rejected ordinary 4K portrait frames before native measurement.
  const padX = Math.ceil(Math.max(512, em * (blankAdvanceX + fonts.glyphWidth)) + decoration * 2);
  const padY = Math.ceil(Math.max(512, em * (blankAdvanceY + fonts.glyphHeight), em * fonts.line) + decoration * 2);
  const canvasWidth = width + padX * 2;
  const canvasHeight = height + padY * 2;
  const probe = buildCaptionOverflowProbe(document, width, height, padX, padY);
  if (!probe.count || canvasWidth * canvasHeight > MAX_FRAME_PIXELS) throw unverifiable();
  let directory: string;
  try {
    await fs.mkdir(workDir, { recursive: true });
    directory = await fs.mkdtemp(path.join(workDir, 'caption-bounds-'));
  } catch { throw unverifiable(); }
  try {
    const file = path.join(directory, 'bounds.ass');
    await fs.writeFile(file, probe.document);
    const output = await measure(file, fontDirectory, canvasWidth, canvasHeight, probe.count, signal, shouldCancel);
    for (const bounds of parseCaptionOverflowBounds(output, probe.count)) {
      // A blank or incomplete measurement never establishes fit.
      const [left, right, top, bottom] = bounds;
      if (left === 0 || top === 0 || right === canvasWidth - 1 || bottom === canvasHeight - 1) throw unverifiable();
      if (left < padX || right >= padX + width || top < padY || bottom >= padY + height) throw new CaptionOverflowError();
    }
    signal?.throwIfAborted();
    checkCancelled();
    if (cacheScope && cacheGeneration === generation) verified.set(signature, cacheScope);
    if (verified.size > MAX_CACHE) verified.delete(verified.keys().next().value!);
  } catch (error) {
    checkCancelled();
    if (error instanceof CaptionOverflowError) throw error;
    throw unverifiable();
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
