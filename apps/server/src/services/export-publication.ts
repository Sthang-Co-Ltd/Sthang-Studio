import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { VideoExportResult } from '@kcs/shared';

/** Written in the owning job before its verified partial file is published. */
export interface ExportPublication {
  version: 1;
  jobId: string;
  projectId: string;
  sourceMediaFilename: string;
  sourceMediaSize: number;
  result: VideoExportResult;
  sha256: string;
  contentFingerprint: string;
}

export interface ExportPublicationOwner {
  id: string;
  projectId: string;
  sourceMediaFilename?: string;
  sourceMediaSize?: number;
}

const digestPattern = /^[a-f0-9]{64}$/;
function validResult(value: unknown): value is VideoExportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as VideoExportResult;
  return typeof result.filename === 'string' && result.filename.length <= 220
    && !/[\\/:\0]/.test(result.filename) && result.filename !== '.' && result.filename !== '..'
    && result.filename.endsWith('.mp4') && path.basename(result.filename) === result.filename
    && result.url === `/exports/${encodeURIComponent(result.filename)}`
    && Number.isSafeInteger(result.sizeBytes) && result.sizeBytes > 0
    && Number.isSafeInteger(result.width) && result.width > 0
    && Number.isSafeInteger(result.height) && result.height > 0
    && Number.isFinite(result.frameRate) && result.frameRate > 0
    && ['h264', 'hevc'].includes(result.videoCodec)
    && typeof result.encoder === 'string' && result.encoder.length > 0 && result.encoder.length <= 100
    && (result.audioCodec === null || typeof result.audioCodec === 'string' && result.audioCodec.length <= 100)
    && Number.isFinite(result.durationMs) && result.durationMs >= 0
    && typeof result.createdAt === 'string' && Number.isFinite(Date.parse(result.createdAt));
}

export function isExportPublication(value: unknown, owner: ExportPublicationOwner): value is ExportPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as ExportPublication;
  return receipt.version === 1 && receipt.jobId === owner.id && receipt.projectId === owner.projectId
    && typeof owner.sourceMediaFilename === 'string' && receipt.sourceMediaFilename === owner.sourceMediaFilename
    && Number.isFinite(owner.sourceMediaSize) && receipt.sourceMediaSize === owner.sourceMediaSize
    && typeof receipt.sha256 === 'string' && digestPattern.test(receipt.sha256)
    && typeof receipt.contentFingerprint === 'string' && digestPattern.test(receipt.contentFingerprint)
    && validResult(receipt.result);
}

/** Stream a stable, regular file; never load a creator's whole video into memory. */
export async function hashExportFile(file: string, shouldCancel?: () => boolean): Promise<{ sha256: string; sizeBytes: number }> {
  const named = await fs.lstat(file);
  if (!named.isFile() || named.isSymbolicLink()) throw new Error('The export file could not be verified.');
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== named.ino || before.size !== named.size) throw new Error('The export file changed.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (shouldCancel?.()) throw new Error('Video export cancelled.');
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (!current.isFile() || current.isSymbolicLink() || before.ino !== current.ino
      || before.size !== after.size || before.size !== current.size
      || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs) throw new Error('The export file changed.');
    return { sha256: hash.digest('hex'), sizeBytes: before.size };
  } finally { await handle.close(); }
}

export type ExportPublicationCheck = { status: 'published'; publication: ExportPublication }
  | { status: 'missing' } | { status: 'uncertain' };

/** Read only the exact job-owned filename. No scan, guessed match, or new render. */
export async function verifyExportPublication(directory: string, value: unknown, owner: ExportPublicationOwner): Promise<ExportPublicationCheck> {
  if (!isExportPublication(value, owner)) return { status: 'uncertain' };
  try {
    const checked = await hashExportFile(path.join(directory, value.result.filename));
    return checked.sizeBytes === value.result.sizeBytes && checked.sha256 === value.sha256
      ? { status: 'published', publication: value } : { status: 'uncertain' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'uncertain' };
  }
}
