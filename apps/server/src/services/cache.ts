import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { normalizeAudioFile, probeDurationMs, waveDurationMs } from './media.js';

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

const normalizedAudioInFlight = new Map<string, Promise<Awaited<ReturnType<typeof ensureNormalizedAudioInternal>>>>();

export function mediaFingerprint(project: CaptionProject) {
  return crypto
    .createHash('sha256')
    .update(`${project.media.filename}:${project.media.size}:${project.media.originalName}`)
    .digest('hex')
    .slice(0, 24);
}

export function stageSignature(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export function projectCacheDir(projectId: string) {
  return path.join(config.cacheDir, projectId);
}

async function validatedWaveDuration(outputPath: string) {
  try {
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size < 44) return null;
    const fastDuration = await waveDurationMs(outputPath);
    if (fastDuration != null) return fastDuration >= 100 ? fastDuration : null;
    const durationMs = await probeDurationMs(outputPath);
    return Number.isFinite(durationMs) && durationMs >= 100 ? durationMs : null;
  } catch {
    return null;
  }
}

async function ensureNormalizedAudioInternal(project: CaptionProject, options: { force?: boolean } = {}) {
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
      if (Math.abs(verifiedDuration - meta.durationMs) > 250) {
        meta.durationMs = verifiedDuration;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      }
      return { dir, outputPath, durationMs: verifiedDuration, fingerprint, cacheHit: true, cachedAt: meta.cachedAt };
    }
    console.warn(`[audio cache] Invalid normalized WAV for project ${project.id}; rebuilding it.`);
  }

  if (!sameMedia) {
    await fs.rm(dir, { recursive: true, force: true });
  } else {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.rm(outputPath, { force: true }),
      fs.rm(metaPath, { force: true }),
    ]);
  }

  await fs.mkdir(dir, { recursive: true });
  const normalized = await normalizeAudioFile(path.join(config.uploadDir, project.media.filename), outputPath);
  const verifiedDuration = normalized.durationMs;
  const nextMeta: AudioCacheMeta = {
    mediaFingerprint: fingerprint,
    durationMs: verifiedDuration,
    cachedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(nextMeta, null, 2), 'utf8');
  return { dir, outputPath, durationMs: verifiedDuration, fingerprint, cacheHit: false, cachedAt: nextMeta.cachedAt };
}

export async function ensureNormalizedAudio(project: CaptionProject, options: { force?: boolean } = {}) {
  const key = `${project.id}:${mediaFingerprint(project)}`;
  const existing = normalizedAudioInFlight.get(key);
  if (existing) {
    if (!options.force) return existing;
    // A forced rebuild must not race a normal preparation already writing the same
    // normalized.wav. Finish the current operation first, then rebuild deliberately.
    await existing.catch(() => {});
  }

  const promise = ensureNormalizedAudioInternal(project, options);
  normalizedAudioInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (normalizedAudioInFlight.get(key) === promise) normalizedAudioInFlight.delete(key);
  }
}

export async function writeStageCache<T>(projectId: string, name: 'gemini' | 'timing', signature: string, value: T) {
  const dir = projectCacheDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const envelope: StageCacheEnvelope<T> = { signature, createdAt: new Date().toISOString(), value: value };
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
  const filePath = path.join(projectCacheDir(projectId), 'normalized.wav');
  try {
    return (await waveDurationMs(filePath)) ?? await probeDurationMs(filePath);
  } catch {
    return null;
  }
}

export async function invalidateProjectCache(projectId: string) {
  await fs.rm(projectCacheDir(projectId), { recursive: true, force: true });
}
