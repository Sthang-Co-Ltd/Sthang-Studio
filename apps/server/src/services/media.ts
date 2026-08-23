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

  const durationMs = await probeDurationMs(outputPath);
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

export async function makeAudioChunk(sourceWav: string, outputPath: string, startMs: number, durationMs: number) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', (durationMs / 1000).toFixed(3),
    '-i', sourceWav,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    outputPath,
  ], 'FFmpeg timing chunk');
}

export async function removeWorkingDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}
