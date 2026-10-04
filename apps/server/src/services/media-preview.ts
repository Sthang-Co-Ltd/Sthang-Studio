import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { jobAdmission } from './job-admission.js';

type ProjectMedia = Pick<CaptionProject, 'id' | 'media'>;
interface Probe { duration: number; start: number; videoCodec: string; audio: boolean }
export interface MediaPreviewStatus {
  source: string;
  state: 'original' | 'processing' | 'ready' | 'failed' | 'cancelled';
  videoCodec: string;
  progress: number;
  url?: string;
  message?: string;
}
interface Entry {
  signature: string;
  status: MediaPreviewStatus;
  abort: AbortController;
  done: Promise<void>;
}
const entries = new Map<string, Entry>();
const invalidating = new Set<string>();
const cacheRoot = path.join(config.cacheDir, 'media-previews');
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_ENCODE_MS = 15 * 60 * 1000;
const INPUT_FORMATS = 'mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf';
let running = 0;
let probing = 0;
const inspections = new Map<string, Promise<Probe>>();

export class MediaPreviewError extends Error {
  constructor(message: string, readonly httpStatus = 400) { super(message); }
}
function projectDirectory(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new MediaPreviewError('Invalid project.');
  return path.join(cacheRoot, id);
}
async function safeDirectory(id: string) {
  const directory = projectDirectory(id);
  await fs.mkdir(cacheRoot, { recursive: true });
  if ((await fs.lstat(cacheRoot)).isSymbolicLink()) throw new MediaPreviewError('Preview storage is unavailable.');
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new MediaPreviewError('Preview storage is unavailable.');
  return directory;
}
async function sourceIdentity(project: ProjectMedia) {
  projectDirectory(project.id);
  const filename = project.media.filename;
  if (!filename || path.basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename)) throw new MediaPreviewError('Invalid source media.');
  const source = path.join(config.uploadDir, filename);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new MediaPreviewError('Source media is unavailable.', 404);
  const signature = crypto.createHash('sha256').update(JSON.stringify(['preview-h264-aac-v1', filename, project.media.size, stat.size, stat.mtimeMs, stat.ino])).digest('hex');
  return { source, signature };
}

/** Bounded local process: no shell, no network/playlist inputs, cancel escalates. */
export function previewProcess(command: string, args: string[], signal: AbortSignal, timeoutMs: number, progress?: (line: string) => void) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) return reject(new MediaPreviewError('Preview preparation cancelled.'));
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let pending = '';
    let failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (failed) return;
      failed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (bytes: Buffer) => {
      if (progress) {
        pending += bytes.toString('utf8');
        if (pending.length > 32_768) { stop(); return; }
        const lines = pending.split('\n'); pending = lines.pop() || '';
        for (const line of lines) progress(line.trim());
      } else {
        if (output.length + bytes.length > 128 * 1024) { stop(); return; }
        output += bytes.toString('utf8');
      }
    });
    // Drain without retaining source paths or arbitrary decoder output.
    child.stderr.on('data', () => {});
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop); };
    child.once('error', () => { cleanup(); reject(new MediaPreviewError('Local preview tools could not start. Check FFmpeg in Settings.')); });
    child.once('close', (code) => {
      cleanup();
      if (signal.aborted) reject(new MediaPreviewError('Preview preparation cancelled.'));
      else if (failed) reject(new MediaPreviewError('Preview preparation exceeded its safe resource limit.'));
      else if (code !== 0) reject(new MediaPreviewError('This file could not be prepared for browser playback.'));
      else resolve(output);
    });
  });
}

async function probe(source: string, signal: AbortSignal, input = true): Promise<Probe> {
  if (probing >= 2) throw new MediaPreviewError('Playback tools are busy. Try again shortly.', 409);
  probing++;
  try {
    const raw = await previewProcess(config.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', ...(input ? ['-format_whitelist', INPUT_FORMATS] : []), '-show_entries', 'format=duration,start_time:stream=codec_type,codec_name,duration', '-of', 'json', source], signal, 20_000);
    let value: { format?: { duration?: string; start_time?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string }> };
    try { value = JSON.parse(raw); } catch { throw new MediaPreviewError('Source media information is unavailable.'); }
    const video = value.streams?.find((stream) => stream.codec_type === 'video');
    const duration = Number(value.format?.duration || video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) throw new MediaPreviewError('Playback preparation supports videos up to two hours.');
    return { duration, start: Number(value.format?.start_time) || 0, videoCodec: video.codec_name || '', audio: Boolean(value.streams?.some((stream) => stream.codec_type === 'audio')) };
  } finally { probing--; }
}

function inspect(source: string, signature: string) {
  const existing = inspections.get(signature);
  if (existing) return existing;
  const pending = probe(source, new AbortController().signal);
  inspections.set(signature, pending);
  void pending.catch(() => { inspections.delete(signature); });
  while (inspections.size > 64) inspections.delete(inspections.keys().next().value!);
  return pending;
}

async function cached(project: ProjectMedia, signature: string) {
  const dir = projectDirectory(project.id);
  const target = path.join(dir, `${signature}.mp4`);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8'));
    const file = await fs.lstat(target);
    if (meta.signature !== signature || !file.isFile() || file.isSymbolicLink() || file.size !== meta.size || file.size === 0 || file.size > MAX_BYTES) return null;
    return { target, codec: String(meta.videoCodec || '') };
  } catch { return null; }
}

function ready(project: ProjectMedia, signature: string, videoCodec: string): MediaPreviewStatus {
  return { source: project.media.filename, state: 'ready', videoCodec, progress: 100, url: `/api/media-preview/${encodeURIComponent(project.id)}/file/${signature}.mp4` };
}

export async function mediaPreviewStatus(project: ProjectMedia): Promise<MediaPreviewStatus> {
  const { signature, source } = await sourceIdentity(project);
  const entry = entries.get(project.id);
  if (entry?.signature === signature && entry.status.state !== 'ready') return { ...entry.status };
  const hit = await cached(project, signature);
  if (hit) return ready(project, signature, hit.codec);
  const info = await inspect(source, signature);
  return { source: project.media.filename, state: 'original', videoCodec: info.videoCodec, progress: 0 };
}

async function evictCache(keep: string) {
  const directories = await fs.readdir(cacheRoot, { withFileTypes: true });
  const candidates: Array<{ dir: string; size: number; time: number }> = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.name === keep || entries.get(directory.name)?.status.state === 'processing') continue;
    const dir = projectDirectory(directory.name);
    const files = await fs.readdir(dir, { withFileTypes: true });
    let size = 0; let time = 0;
    for (const file of files) if (file.isFile()) { const stat = await fs.stat(path.join(dir, file.name)); size += stat.size; time = Math.max(time, stat.mtimeMs); }
    candidates.push({ dir, size, time });
  }
  let count = candidates.length;
  let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
  // Reserve the full per-preview maximum before launching, leaving no orphaned global copies.
  for (const candidate of candidates.sort((a, b) => a.time - b.time)) {
    if (total <= MAX_CACHE_BYTES - MAX_BYTES && count <= 63) break;
    await fs.rm(candidate.dir, { recursive: true, force: true }); total -= candidate.size; count--;
  }
}

export async function startMediaPreview(project: ProjectMedia, options: { force?: boolean } = {}): Promise<MediaPreviewStatus> {
  if (invalidating.has(project.id)) throw new MediaPreviewError('Media is being replaced. Try again shortly.', 409);
  const { source, signature } = await sourceIdentity(project);
  const existing = entries.get(project.id);
  if (existing?.signature === signature && existing.status.state === 'processing') return { ...existing.status };
  const hit = await cached(project, signature);
  if (hit && !options.force) return ready(project, signature, hit.codec);
  if (invalidating.has(project.id)) throw new MediaPreviewError('Media is being replaced. Try again shortly.', 409);
  const concurrent = entries.get(project.id);
  if (concurrent?.signature === signature && concurrent.status.state === 'processing') return { ...concurrent.status };
  if (running) throw new MediaPreviewError('Another playback copy is being prepared. Try again when it finishes.', 409);
  // Reserve before any more awaits. Concurrent tabs cannot start extra encoders.
  running++;
  const abort = new AbortController();
  const entry: Entry = { signature, status: { source: project.media.filename, state: 'processing', videoCodec: '', progress: 0 }, abort, done: Promise.resolve() };
  entries.set(project.id, entry);
  entry.done = jobAdmission.run(async () => {
    const dir = await safeDirectory(project.id);
    const partial = path.join(dir, `${signature}.${crypto.randomUUID()}.part.mp4`);
    const target = path.join(dir, `${signature}.mp4`);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await safeDirectory(project.id);
      await evictCache(project.id);
      const info = await probe(source, abort.signal);
      entry.status.videoCodec = info.videoCodec;
      await previewProcess(config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
        '-threads', '2', '-copyts', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
        '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '1', '-fps_mode', 'passthrough',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-fs', String(MAX_BYTES), '-progress', 'pipe:1', '-f', 'mp4', partial,
      ], abort.signal, MAX_ENCODE_MS, (line) => {
        if (line.startsWith('out_time_us=')) entry.status.progress = Math.max(entry.status.progress, Math.min(99, Math.round((Number(line.slice(12)) / 1_000_000 - info.start) / info.duration * 100) || 0));
      });
      const output = await probe(partial, abort.signal, false);
      const stat = await fs.stat(partial);
      if (output.videoCodec !== 'h264' || output.audio !== info.audio || Math.abs(output.duration - info.duration) > 0.25 || stat.size >= MAX_BYTES) throw new MediaPreviewError('The playback copy did not preserve the complete media timeline.');
      if (abort.signal.aborted || (await sourceIdentity(project)).signature !== signature || invalidating.has(project.id)) throw new MediaPreviewError('The source media changed. Prepare playback again.');
      await fs.rename(partial, target);
      const metadata = path.join(dir, `ready.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(metadata, JSON.stringify({ signature, size: stat.size, videoCodec: info.videoCodec }));
      await fs.rename(metadata, path.join(dir, 'ready.json'));
      // Cancellation may arrive during either publication write, not just encoding.
      if (abort.signal.aborted || invalidating.has(project.id)) throw new MediaPreviewError('Preview preparation cancelled.');
      entry.status = ready(project, signature, info.videoCodec);
    } finally {
      await fs.rm(partial, { force: true }).catch(() => {});
      if (abort.signal.aborted) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }).catch((error: unknown) => {
    entry.status = { ...entry.status, state: abort.signal.aborted ? 'cancelled' : 'failed', message: error instanceof MediaPreviewError ? error.message : 'Playback preparation failed. Try again after any update finishes.' };
  }).finally(() => {
    running--;
    // Bound in-memory history, too. Active entry is never evicted.
    for (const [id, old] of entries) if (entries.size > 64 && old.status.state !== 'processing') entries.delete(id);
  });
  return { ...entry.status };
}

export async function cancelMediaPreview(project: ProjectMedia) {
  const entry = entries.get(project.id);
  if (entry?.status.source === project.media.filename && entry.status.state === 'processing') {
    entry.abort.abort(); await entry.done;
  }
  return entry?.status.source === project.media.filename ? { ...entry.status } : await mediaPreviewStatus(project);
}

export async function invalidateMediaPreview(projectId: string) {
  invalidating.add(projectId);
  try {
    const entry = entries.get(projectId);
    if (entry) { entry.abort.abort(); await entry.done; entries.delete(projectId); }
    await fs.rm(projectDirectory(projectId), { recursive: true, force: true });
  } finally { invalidating.delete(projectId); }
}

export async function mediaPreviewFile(project: ProjectMedia, filename: string) {
  const { signature } = await sourceIdentity(project);
  if (filename !== `${signature}.mp4`) throw new MediaPreviewError('Playback copy expired.', 404);
  const hit = await cached(project, signature);
  if (!hit) throw new MediaPreviewError('Playback copy is not ready.', 404);
  return { dir: projectDirectory(project.id), filename };
}
