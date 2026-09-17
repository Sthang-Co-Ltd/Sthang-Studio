// Read-only ZIP inspection for an already signature/hash-verified OTA package.
// Bounds and supported methods match the production signer's parseZip contract.
// This reader never extracts archive-selected paths to the filesystem.
export const MAX_BROKER_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const protectedParts = new Set(['data', 'uploads', 'exports', 'node_modules', '.venv', 'versions', 'updates', 'broker-versions', 'release-artifacts', '.env']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function archiveCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(raw) {
  if (!raw || raw.length > 512 || raw.startsWith('/') || /[\\:*?"<>|\u0000-\u001f\u007f]/.test(raw)) throw new Error('Unsafe broker archive path.');
  const parts = raw.replace(/\/$/, '').split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[ .]$/.test(part)
        || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || protectedParts.has(part.toLowerCase())) throw new Error('Unsafe broker archive path.');
  }
  return parts.join('/');
}
async function inflate(bytes, size) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > size) throw new Error('Broker archive expansion exceeded its bound.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (total !== size) throw new Error('Broker archive entry length mismatch.');
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
export async function readBrokerArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_BROKER_ARCHIVE_BYTES) throw new Error('Broker archive size is not supported.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65557); at -= 1) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.byteLength) { end = at; break; }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new Error('Invalid broker archive directory.');
  const count = u16(end + 10), centralSize = u32(end + 12), central = u32(end + 16);
  if (!count || count > MAX_ENTRIES || central + centralSize !== end) throw new Error('Invalid broker archive directory bounds.');
  const entries = new Map(), names = new Set(), ranges = [];
  let cursor = central, expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw new Error('Invalid broker ZIP entry.');
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20), size = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32);
    const kind = (u32(cursor + 38) >>> 16) & 0xf000, local = u32(cursor + 42);
    if ((flags & ~0x080e) || ![0, 8].includes(method) || ![0, 0x8000, 0x4000].includes(kind)
        || u16(cursor + 34) !== 0 || size > MAX_EXPANDED_BYTES - expanded) throw new Error('Unsupported broker ZIP entry.');
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end) throw new Error('Invalid broker ZIP metadata.');
    const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const name = safeName(rawName), lower = name.toLowerCase();
    if (names.has(lower)) throw new Error('Duplicate broker archive path.');
    names.add(lower);
    if (local + 30 > central || u32(local) !== 0x04034b50) throw new Error('Invalid broker ZIP local header.');
    const localNameLength = u16(local + 26), localExtra = u16(local + 28);
    const start = local + 30 + localNameLength + localExtra, finish = start + compressedSize;
    if (finish > central || u16(local + 6) !== flags || u16(local + 8) !== method
        || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== rawName) throw new Error('Broker ZIP headers do not match.');
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressedSize || u32(local + 22) !== size)) throw new Error('Broker ZIP sizes do not match.');
    const content = method === 0 ? bytes.slice(start, finish) : await inflate(bytes.subarray(start, finish), size);
    if (content.byteLength !== size || archiveCrc32(content) !== crc) throw new Error('Broker archive entry integrity failed.');
    expanded += size;
    ranges.push([local, finish]);
    if (rawName.endsWith('/')) {
      if (size) throw new Error('A broker archive directory contains data.');
    } else {
      if (kind === 0x4000) throw new Error('Broker ZIP file type mismatch.');
      entries.set(name, content);
    }
    cursor = next;
  }
  if (cursor !== end) throw new Error('Broker archive directory length mismatch.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) if (ranges[i][0] < ranges[i - 1][1]) throw new Error('Overlapping broker ZIP entries.');
  const fileNames = new Set([...entries.keys()].map((name) => name.toLowerCase()));
  for (const name of entries.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/').toLowerCase();
      if (fileNames.has(parent)) throw new Error('Conflicting broker archive paths.');
    }
  }
  return { entries, totalUnpacked: expanded };
}
