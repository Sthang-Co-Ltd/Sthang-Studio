import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';

export function runCommand(command: string, args: string[], label: string, timeoutMs = 0): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs) : null;

    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`${label} could not start (${command}). ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} failed (exit ${code}). ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function readUInt16(buffer: Buffer, offset: number, littleEndian: boolean) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32(buffer: Buffer, offset: number, littleEndian: boolean) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

/**
 * Fast path for Studio's normalized PCM WAVs. It avoids spawning ffprobe on every
 * cache lookup while failing closed to the existing ffprobe path for unusual WAVs.
 */
export async function waveDurationMs(filePath: string): Promise<number | null> {
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 44) return null;
    const bytesToRead = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await fs.open(filePath, 'r');
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 12) return null;

    const container = buffer.toString('ascii', 0, 4);
    const format = buffer.toString('ascii', 8, 12);
    if (!['RIFF', 'RIFX', 'RF64'].includes(container) || format !== 'WAVE') return null;
    const littleEndian = container !== 'RIFX';
    let byteRate = 0;
    let dataSize: number | null = null;
    let offset = 12;

    while (offset + 8 <= bytesRead) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = readUInt32(buffer, offset + 4, littleEndian);
      const dataOffset = offset + 8;
      if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= bytesRead) {
        const audioFormat = readUInt16(buffer, dataOffset, littleEndian);
        const channels = readUInt16(buffer, dataOffset + 2, littleEndian);
        const sampleRate = readUInt32(buffer, dataOffset + 4, littleEndian);
        byteRate = readUInt32(buffer, dataOffset + 8, littleEndian);
        const blockAlign = readUInt16(buffer, dataOffset + 12, littleEndian);
        const bitsPerSample = readUInt16(buffer, dataOffset + 14, littleEndian);
        if (![1, 3].includes(audioFormat) || channels < 1 || sampleRate < 1000 || byteRate < 1 || blockAlign < 1 || bitsPerSample < 1) return null;
      } else if (chunkId === 'data') {
        if (chunkSize === 0xffffffff) return null; // RF64 ds64 parsing stays on the ffprobe fallback path.
        dataSize = Math.min(chunkSize, Math.max(0, stat.size - dataOffset));
      }

      if (byteRate > 0 && dataSize != null) {
        const durationMs = Math.round(dataSize / byteRate * 1000);
        return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
      }

      const paddedSize = chunkSize + (chunkSize % 2);
      if (paddedSize < 0 || dataOffset + paddedSize <= offset) return null;
      offset = dataOffset + paddedSize;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function durationFastOrProbe(filePath: string) {
  const fast = await waveDurationMs(filePath);
  return fast ?? probeDurationMs(filePath);
}

export async function normalizeAudioFile(inputPath: string, outputPath: string) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-af', 'aresample=async=1:first_pts=0',
    outputPath,
  ], 'FFmpeg audio normalization');

  const durationMs = await durationFastOrProbe(outputPath);
  if (!Number.isFinite(durationMs) || durationMs < 100) throw new Error('The uploaded media does not contain usable audio.');
  return { outputPath, durationMs };
}

/** Legacy helper retained for compatibility with older code paths. */
export async function normalizeAudio(inputPath: string, projectId: string) {
  const dir = path.join(config.workingDir, projectId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, 'normalized.wav');
  const normalized = await normalizeAudioFile(inputPath, outputPath);
  return { dir, ...normalized };
}

export async function probeDurationMs(filePath: string) {
  const { stdout } = await runCommand(config.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ], 'FFprobe');
  return Math.round(Number(stdout.trim()) * 1000);
}

async function linkOrCopy(sourcePath: string, outputPath: string) {
  await fs.rm(outputPath, { force: true });
  try {
    await fs.link(sourcePath, outputPath);
  } catch {
    await fs.copyFile(sourcePath, outputPath);
  }
}

/**
 * Prepare a normalized range once and reuse it across regeneration/refinement jobs.
 * Cached range WAVs live beside normalized.wav, so media replacement invalidates
 * them with the rest of the project cache.
 */
export async function makeAudioChunk(sourceWav: string, outputPath: string, startMs: number, durationMs: number) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const sourceDurationMs = await durationFastOrProbe(sourceWav);
  const normalizedStart = Math.max(0, Math.round(startMs));
  const normalizedDuration = Math.max(1, Math.round(durationMs));
  const requestedEnd = normalizedStart + normalizedDuration;

  // Full regeneration already has the exact normalized WAV. A hard link avoids a
  // second full-video FFmpeg decode/encode while cleanup remains non-destructive.
  if (normalizedStart <= 5 && requestedEnd >= sourceDurationMs - 5) {
    await linkOrCopy(sourceWav, outputPath);
    return { outputPath, durationMs: sourceDurationMs, cacheHit: true, directSource: true };
  }

  const sourceStat = await fs.stat(sourceWav);
  const cacheKey = crypto.createHash('sha256')
    .update(`range-wav-v1:${sourceStat.size}:${Math.round(sourceStat.mtimeMs)}:${normalizedStart}:${normalizedDuration}`)
    .digest('hex')
    .slice(0, 24);
  const rangeCacheDir = path.join(path.dirname(sourceWav), 'ranges');
  const cachedPath = path.join(rangeCacheDir, `${cacheKey}.wav`);
  await fs.mkdir(rangeCacheDir, { recursive: true });

  const cachedDuration = await waveDurationMs(cachedPath);
  if (cachedDuration && Math.abs(cachedDuration - normalizedDuration) <= 250) {
    await linkOrCopy(cachedPath, outputPath);
    return { outputPath, durationMs: cachedDuration, cacheHit: true, directSource: false };
  }
  await fs.rm(cachedPath, { force: true });

  const tempPath = `${cachedPath}.${process.pid}.${Date.now()}.tmp.wav`;
  try {
    await runCommand(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (normalizedStart / 1000).toFixed(3),
      '-t', (normalizedDuration / 1000).toFixed(3),
      '-i', sourceWav,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      tempPath,
    ], 'FFmpeg timing chunk');
    const actualDuration = await durationFastOrProbe(tempPath);
    if (!Number.isFinite(actualDuration) || actualDuration < 20) throw new Error('FFmpeg produced an empty timing chunk.');
    await fs.rename(tempPath, cachedPath);
    await linkOrCopy(cachedPath, outputPath);
    return { outputPath, durationMs: actualDuration, cacheHit: false, directSource: false };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function removeWorkingDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}
