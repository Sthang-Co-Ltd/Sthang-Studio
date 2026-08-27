import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { normalizeAudioFile, probeDurationMs } from './media.js';

interface AudioCacheMeta {
  mediaFingerprint: string;
  durationMs: number;
  cachedAt: string;
}

interface StageCacheEnvelope<T> {
  signature: string;
  createdAt: string;
  value: T;
}

export function mediaFingerprint(project: CaptionProject) {
  return crypto
    .createHash('sha256')
    .update(`${project.media.filename}:${project.media.size}:${project.media.originalName}`)
    .digest('hex')
    .slice(0, 24);
}

export function stageSignature(value: unknown) {
  // Project processing historically supplies `primaryModel` only for the text
  // stage. Fold the dedicated-ASR architecture into that signature here so old
  // general-model transcript caches cannot silently bypass a newly selected
  // transcription path. Timing signatures remain unchanged and continue to be
  // driven by their alignment text/model inputs.
  const signedValue = value && typeof value === 'object' && !Array.isArray(value) && 'primaryModel' in value
    ? {
        ...(value as Record<string, unknown>),
        dedicatedTranscriptionEnabled: config.geminiDedicatedTranscriptionEnabled,
        transcribeModel: config.geminiTranscribeModel,
        contextualRefinementEnabled: config.geminiContextualRefinementEnabled,
      }
    : value;
  return crypto.createHash('sha256').update(JSON.stringify(signedValue)).digest('hex').slice(0, 32);
}

export function projectCacheDir(projectId: string) {
  return path.join(config.cacheDir, projectId);
}

async function validatedWaveDuration(outputPath: string) {
  try {
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size < 44) return null;
    const handle = await fs.open(outputPath, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead < header.length) return null;
      const container = header.toString('ascii', 0, 4);
      const format = header.toString('ascii', 8, 12);
      if (!['RIFF', 'RIFX', 'RF64'].includes(container) || format !== 'WAVE') return null;
    } finally {
      await handle.close();
    }
    const durationMs = await probeDurationMs(outputPath);
    return Number.isFinite(durationMs) && durationMs >= 100 ? durationMs : null;
  } catch {
    return null;
  }
}

export async function ensureNormalizedAudio(project: CaptionProject, options: { force?: boolean } = {}) {
  const dir = projectCacheDir(project.id);
  const outputPath = path.join(dir, 'normalized.wav');
  const metaPath = path.join(dir, 'audio-meta.json');
  const fingerprint = mediaFingerprint(project);
  let meta: AudioCacheMeta | null = null;

  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as AudioCacheMeta;
  } catch {
    meta = null;
  }

  const sameMedia = meta?.mediaFingerprint === fingerprint;
  if (!options.force && sameMedia && meta && meta.durationMs > 0) {
    const verifiedDuration = await validatedWaveDuration(outputPath);
    if (verifiedDuration) {
      // Keep metadata honest if ffprobe reports a slightly different duration.
      if (Math.abs(verifiedDuration - meta.durationMs) > 250) {
        meta.durationMs = verifiedDuration;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      }
      return { dir, outputPath, durationMs: verifiedDuration, fingerprint, cacheHit: true, cachedAt: meta.cachedAt };
    }
    console.warn(`[audio cache] Invalid normalized WAV for project ${project.id}; rebuilding it.`);
  }

  if (!sameMedia) {
    // A different source media invalidates every downstream stage cache.
    await fs.rm(dir, { recursive: true, force: true });
  } else {
    // A corrupt waveform preview should not discard completed Gemini/KFA stages.
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.rm(outputPath, { force: true }),
      fs.rm(metaPath, { force: true }),
    ]);
  }

  await fs.mkdir(dir, { recursive: true });
  const normalized = await normalizeAudioFile(path.join(config.uploadDir, project.media.filename), outputPath);
  const verifiedDuration = await validatedWaveDuration(outputPath);
  if (!verifiedDuration) throw new Error('FFmpeg produced an invalid waveform preview.');
  const nextMeta: AudioCacheMeta = {
    mediaFingerprint: fingerprint,
    durationMs: verifiedDuration,
    cachedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(nextMeta, null, 2), 'utf8');
  return { dir, outputPath, durationMs: verifiedDuration, fingerprint, cacheHit: false, cachedAt: nextMeta.cachedAt };
}

export async function writeStageCache<T>(projectId: string, name: 'gemini' | 'timing', signature: string, value: T) {
  const dir = projectCacheDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const envelope: StageCacheEnvelope<T> = { signature, createdAt: new Date().toISOString(), value };
  await fs.writeFile(path.join(dir, `${name}-stage.json`), JSON.stringify(envelope, null, 2), 'utf8');
  return envelope;
}

export async function readStageCache<T>(projectId: string, name: 'gemini' | 'timing', signature: string): Promise<StageCacheEnvelope<T> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectCacheDir(projectId), `${name}-stage.json`), 'utf8')) as StageCacheEnvelope<T>;
    if (!parsed || parsed.signature !== signature || !parsed.createdAt || parsed.value == null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function cacheDuration(projectId: string) {
  try {
    return await probeDurationMs(path.join(projectCacheDir(projectId), 'normalized.wav'));
  } catch {
    return null;
  }
}

export async function invalidateProjectCache(projectId: string) {
  await fs.rm(projectCacheDir(projectId), { recursive: true, force: true });
}
