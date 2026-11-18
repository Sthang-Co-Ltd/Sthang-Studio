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
interface PreviewPublication {
  signature: string;
  filename?: string; // The original signature.mp4 publication has no filename field.
  size: number;
  videoCodec: string;
}
interface PreviewHit {
  filename: string;
  size: number;
  codec: string;
}
interface PreviewUse {
  until: number;
  readers: number;
  aborters: Set<() => void>;
}
const entries = new Map<string, Entry>();
const invalidating = new Map<string, number>();
const pendingAccess = new Map<string, number>();
const cacheRoot = path.join(config.cacheDir, 'media-previews');
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_ENCODE_MS = 15 * 60 * 1000;
const INPUT_FORMATS = 'mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf';
let running = 0;
let probing = 0;
const inspections = new Map<string, Promise<Probe>>();
// Each URL refers to immutable bytes. A playing older generation can keep its
// own lease after a newer copy is published; requests pin their exact file.
const activeUses = new Map<string, PreviewUse>();
const evicting = new Set<string>();
const evictingFiles = new Set<string>();
const LEASE_MS = 120_000;
const fileKey = (id: string, filename: string) => `${id}/${filename}`;
const sidecarName = (filename: string) => `${filename}.json`;
function validPreviewFilename(signature: string, filename: string) {
  return filename === `${signature}.mp4` || new RegExp(`^${signature}\\.[0-9a-f]{32}\\.mp4$`).test(filename);
}
function touchPreview(id: string, filename: string) {
  for (const [key, use] of activeUses) if (!use.readers && use.until <= Date.now()) activeUses.delete(key);
  const key = fileKey(id, filename);
  const use = activeUses.get(key) || { until: 0, readers: 0, aborters: new Set<() => void>() };
  use.until = Date.now() + LEASE_MS;
  activeUses.set(key, use);
  return use;
}
function previewInUse(id: string, filename: string) {
  const use = activeUses.get(fileKey(id, filename));
  return Boolean(use && (use.readers || use.until > Date.now()));
}
function projectPreviewInUse(id: string) {
  for (const [key, use] of activeUses) {
    if (key.startsWith(`${id}/`) && (use.readers || use.until > Date.now())) return true;
  }
  return false;
}
function activeReaders(id: string) {
  let count = pendingAccess.get(id) || 0;
  for (const [key, use] of activeUses) if (key.startsWith(`${id}/`)) count += use.readers;
  return count;
}
function assertPreviewAvailable(id: string) {
  if (invalidating.has(id)) throw new MediaPreviewError('Media is being changed. Try again shortly.', 409);
}
async function withMediaPreviewAccess<T>(id: string, operation: () => Promise<T>): Promise<T> {
  // Own access before source identity, pointer reads or probing can suspend.
  // A drain must also wait for readers that have not pinned a filename yet.
  assertPreviewAvailable(id);
  pendingAccess.set(id, (pendingAccess.get(id) || 0) + 1);
  try { return await operation(); }
  finally {
    const remaining = pendingAccess.get(id)! - 1;
    if (remaining) pendingAccess.set(id, remaining);
    else pendingAccess.delete(id);
  }
}
async function drainPreviewReaders(id: string) {
  for (const [key, use] of activeUses) {
    if (key.startsWith(`${id}/`)) {
      for (const abort of use.aborters) { try { abort(); } catch { /* Connection may already be closed. */ } }
    }
  }
  const deadline = performance.now() + 3_000;
  while (activeReaders(id) && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (activeReaders(id)) throw new MediaPreviewError('Playback is still closing. Try the media change again.', 409);
}


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

async function readPointer(dir: string): Promise<PreviewPublication | null> {
  try {
    const meta: unknown = JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const value = meta as PreviewPublication;
    return typeof value.signature === 'string' && /^[a-f0-9]{64}$/.test(value.signature) ? value : null;
  } catch { return null; }
}

function publicationFilename(meta: PreviewPublication) {
  return meta.filename === undefined ? `${meta.signature}.mp4` : meta.filename;
}

async function validatedPreview(dir: string, signature: string, meta: PreviewPublication): Promise<PreviewHit | null> {
  const filename = publicationFilename(meta);
  if (meta.signature !== signature || !validPreviewFilename(signature, filename)
    || !Number.isFinite(meta.size) || meta.size <= 0 || meta.size > MAX_BYTES) return null;
  try {
    const file = await fs.lstat(path.join(dir, filename));
    if (!file.isFile() || file.isSymbolicLink() || file.size !== meta.size) return null;
    return { filename, size: file.size, codec: String(meta.videoCodec || '') };
  } catch { return null; }
}

async function cached(project: ProjectMedia, signature: string): Promise<PreviewHit | null> {
  const dir = projectDirectory(project.id);
  const pointer = await readPointer(dir);
  if (!pointer || pointer.signature !== signature
    || !validPreviewFilename(signature, publicationFilename(pointer))) return null;
  let release: ((discard?: boolean) => void) | undefined;
  try { release = retainMediaPreview(project.id, publicationFilename(pointer), undefined, false); }
  catch { return null; }
  let hit: PreviewHit | null = null;
  try {
    hit = await validatedPreview(dir, signature, pointer);
    if (hit) touchPreview(project.id, hit.filename);
    return hit;
  } finally { release(!hit); }
}

async function retiredCopy(dir: string, signature: string, filename: string): Promise<PreviewHit | null> {
  try {
    const meta: unknown = JSON.parse(await fs.readFile(path.join(dir, sidecarName(filename)), 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || (meta as PreviewPublication).filename !== filename) return null;
    return validatedPreview(dir, signature, meta as PreviewPublication);
  } catch { return null; }
}

async function writePublicationFile(dir: string, filename: string, publication: PreviewPublication) {
  const temporary = path.join(dir, `${filename}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(publication));
    await fs.rename(temporary, path.join(dir, filename));
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

function ready(project: ProjectMedia, hit: PreviewHit): MediaPreviewStatus {
  return { source: project.media.filename, state: 'ready', videoCodec: hit.codec, progress: 100,
    url: `/api/media-preview/${encodeURIComponent(project.id)}/file/${hit.filename}` };
}

export async function mediaPreviewStatus(project: ProjectMedia): Promise<MediaPreviewStatus> {
  return withMediaPreviewAccess(project.id, () => readMediaPreviewStatus(project));
}
async function readMediaPreviewStatus(project: ProjectMedia): Promise<MediaPreviewStatus> {
  const { signature, source } = await sourceIdentity(project);
  assertPreviewAvailable(project.id);
  const entry = entries.get(project.id);
  if (entry?.signature === signature && entry.status.state === 'processing') return { ...entry.status };
  const hit = await cached(project, signature);
  assertPreviewAvailable(project.id);
  if (hit && !evicting.has(project.id) && !evictingFiles.has(fileKey(project.id, hit.filename))) {
    touchPreview(project.id, hit.filename);
    return { ...ready(project, hit), ...(entry?.signature === signature && entry.status.state === 'failed'
      ? { message: 'The new playback copy could not be prepared. The previous copy was kept. Try Prepare playback again.' } : {}) };
  }
  if (entry?.signature === signature && entry.status.state !== 'ready') return { ...entry.status };
  const info = await inspect(source, signature);
  assertPreviewAvailable(project.id);
  return { source: project.media.filename, state: 'original', videoCodec: info.videoCodec, progress: 0 };
}

async function evictCache(keep: string) {
  const directories = await fs.readdir(cacheRoot, { withFileTypes: true });
  const candidates: Array<{ id: string; dir: string; size: number; time: number }> = [];
  const retired: Array<{ id: string; dir: string; filename: string; size: number; time: number }> = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const dir = projectDirectory(directory.name);
    const files = await fs.readdir(dir, { withFileTypes: true });
    let size = 0; let time = 0;
    const sizes = new Map<string, { size: number; time: number }>();
    for (const file of files) if (file.isFile()) {
      const stat = await fs.stat(path.join(dir, file.name));
      size += stat.size; time = Math.max(time, stat.mtimeMs);
      sizes.set(file.name, { size: stat.size, time: stat.mtimeMs });
    }
    const pointer = await readPointer(dir);
    const current = pointer && validPreviewFilename(pointer.signature, publicationFilename(pointer))
      ? publicationFilename(pointer) : null;
    for (const [filename, info] of sizes) {
      if (!/^[a-f0-9]{64}(?:\.[a-f0-9]{32})?\.mp4$/.test(filename) || filename === current) continue;
      const sidecar = sizes.get(sidecarName(filename));
      retired.push({ id: directory.name, dir, filename, size: info.size + (sidecar?.size || 0), time: info.time });
    }
    candidates.push({ id: directory.name, dir, size, time });
  }
  let count = candidates.length;
  let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
  // Old generations are charged to the same 2 GiB bound as the current copy.
  // Reclaim an expired one without evicting an otherwise active project.
  for (const file of retired.sort((a, b) => a.time - b.time)) {
    if (total <= MAX_CACHE_BYTES - MAX_BYTES) break;
    const key = fileKey(file.id, file.filename);
    if (entries.get(file.id)?.status.state === 'processing' && file.id !== keep) continue;
    if (evicting.has(file.id) || evictingFiles.has(key) || previewInUse(file.id, file.filename)) continue;
    evictingFiles.add(key);
    try {
      await fs.rm(path.join(file.dir, file.filename), { force: true });
      await fs.rm(path.join(file.dir, sidecarName(file.filename)), { force: true });
      total -= file.size;
      const owner = candidates.find((candidate) => candidate.id === file.id);
      if (owner) owner.size -= file.size;
    } finally { evictingFiles.delete(key); }
  }
  // Include protected files in the budget, plus one maximum-sized staging copy.
  for (const candidate of candidates.sort((a, b) => a.time - b.time)) {
    if (total <= MAX_CACHE_BYTES - MAX_BYTES && count <= 64) break;
    if (candidate.id === keep || entries.get(candidate.id)?.status.state === 'processing' || projectPreviewInUse(candidate.id)) continue;
    evicting.add(candidate.id);
    try { await fs.rm(candidate.dir, { recursive: true, force: true }); total -= candidate.size; count--; }
    finally { evicting.delete(candidate.id); }
  }
  if (total > MAX_CACHE_BYTES - MAX_BYTES || count > 64) throw new MediaPreviewError('Playback storage is in use. Close another project and try again shortly.', 409);
}

async function clearAbandonedStages(dir: string, id: string, signature: string, current: PreviewHit | null) {
  const preserved = new Set(current ? ['ready.json', current.filename, sidecarName(current.filename)] : []);
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}(?:\.[a-f0-9]{32})?\.mp4$/.test(file.name)) continue;
    if (previewInUse(id, file.name)
      || (file.name.startsWith(`${signature}.`) && await retiredCopy(dir, signature, file.name))) {
      preserved.add(file.name);
      preserved.add(sidecarName(file.name));
    }
  }
  for (const file of files) {
    if (preserved.has(file.name)) continue;
    // No preview producer uses subdirectories; abandoned nested data counts
    // against the same local cache rather than surviving cleanup forever.
    await fs.rm(path.join(dir, file.name), { recursive: file.isDirectory(), force: true });
  }
}

export async function startMediaPreview(project: ProjectMedia, options: { force?: boolean } = {}): Promise<MediaPreviewStatus> {
  return withMediaPreviewAccess(project.id, () => prepareMediaPreview(project, options));
}
async function prepareMediaPreview(project: ProjectMedia, options: { force?: boolean }): Promise<MediaPreviewStatus> {
  if (evicting.has(project.id)) throw new MediaPreviewError('Playback storage is being refreshed. Try again shortly.', 409);
  const { source, signature } = await sourceIdentity(project);
  assertPreviewAvailable(project.id);
  const existing = entries.get(project.id);
  if (existing?.signature === signature && existing.status.state === 'processing') return { ...existing.status };
  const hit = await cached(project, signature);
  assertPreviewAvailable(project.id);
  if (hit && !options.force && !evicting.has(project.id) && !evictingFiles.has(fileKey(project.id, hit.filename))) {
    touchPreview(project.id, hit.filename); return ready(project, hit);
  }
  if (evicting.has(project.id)) throw new MediaPreviewError('Playback storage is being refreshed. Try again shortly.', 409);
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
    const filename = `${signature}.${crypto.randomUUID().replace(/-/g, '')}.mp4`;
    const partial = path.join(dir, `${filename}.part.mp4`);
    const target = path.join(dir, filename);
    const metadata = path.join(dir, `ready.${crypto.randomUUID()}.tmp`);
    let committed = false;
    let outputCreated = false;
    try {
      // Both previously published and still leased generations keep their
      // immutable filenames throughout the rebuild.
      await clearAbandonedStages(dir, project.id, signature, hit);
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
      // A unique output cannot replace a file held open by another Windows
      // reader or change bytes returned by a later Range on the old URL.
      await fs.rename(partial, target);
      outputCreated = true;
      if (hit && !await retiredCopy(dir, signature, hit.filename)) {
        await writePublicationFile(dir, sidecarName(hit.filename), {
          signature, filename: hit.filename, size: hit.size, videoCodec: hit.codec,
        });
      }
      await writePublicationFile(dir, sidecarName(filename), {
        signature, filename, size: stat.size, videoCodec: info.videoCodec,
      });
      await fs.writeFile(metadata, JSON.stringify({ signature, filename, size: stat.size, videoCodec: info.videoCodec }));
      const latestSource = await sourceIdentity(project);
      if (abort.signal.aborted || invalidating.has(project.id) || latestSource.signature !== signature) {
        throw new MediaPreviewError('Preview preparation cancelled.');
      }
      // The pointer rename is the commit. A cancellation after it cannot
      // roll back a published copy or strand previously advertised URLs.
      await fs.rename(metadata, path.join(dir, 'ready.json'));
      committed = true;
      touchPreview(project.id, filename);
      entry.status = ready(project, { filename, codec: info.videoCodec, size: stat.size });
    } finally {
      await fs.rm(partial, { force: true }).catch(() => {});
      await fs.rm(metadata, { force: true }).catch(() => {});
      if (!committed && outputCreated) {
        await fs.rm(target, { force: true }).catch(() => {});
        await fs.rm(path.join(dir, sidecarName(filename)), { force: true }).catch(() => {});
      }
      if (abort.signal.aborted && !hit && !committed && !projectPreviewInUse(project.id)) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
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

/** Stops only an active preparation. Safe before project deletion even when
 * the original source is missing: no source probe or cache path access. */
export async function cancelMediaPreviewPreparation(projectId: string): Promise<void> {
  const entry = entries.get(projectId);
  if (entry?.status.state !== 'processing') return;
  entry.abort.abort();
  await entry.done;
}

export async function cancelMediaPreview(project: ProjectMedia) {
  const entry = entries.get(project.id);
  if (entry?.status.source === project.media.filename && entry.status.state === 'processing') {
    await cancelMediaPreviewPreparation(project.id);
  }
  return entry?.status.source === project.media.filename ? { ...entry.status } : await mediaPreviewStatus(project);
}

/** Close preview admission before draining, and keep it closed through the
 * caller's media mutation. Nested cache invalidation cannot release its owner. */
export async function withMediaPreviewDrain<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  invalidating.set(projectId, (invalidating.get(projectId) || 0) + 1);
  try {
    const entry = entries.get(projectId);
    if (entry) { entry.abort.abort(); await entry.done; }
    // Windows cannot reliably unlink an MP4 while sendFile still owns its
    // handle. Media replacement/deletion deliberately ends those streams.
    await drainPreviewReaders(projectId);
    return await operation();
  } finally {
    const remaining = invalidating.get(projectId)! - 1;
    if (remaining) invalidating.set(projectId, remaining);
    else invalidating.delete(projectId);
  }
}

export async function invalidateMediaPreview(projectId: string) {
  return withMediaPreviewDrain(projectId, async () => {
    entries.delete(projectId);
    for (let attempt = 0; ; attempt++) {
      try { await fs.rm(projectDirectory(projectId), { recursive: true, force: true }); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code || '')) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
    }
    for (const key of activeUses.keys()) if (key.startsWith(`${projectId}/`)) activeUses.delete(key);
  });
}

/** Acquire before awaiting disk metadata, so eviction cannot win between
 * validating a copy and opening its HTTP file stream. */
export async function acquireMediaPreviewFile(project: ProjectMedia, filename: string, onInvalidate?: () => void) {
  return withMediaPreviewAccess(project.id, () => readMediaPreviewFile(project, filename, onInvalidate));
}
async function readMediaPreviewFile(project: ProjectMedia, filename: string, onInvalidate?: () => void) {
  const { signature } = await sourceIdentity(project);
  if (!validPreviewFilename(signature, filename)) throw new MediaPreviewError('Playback copy expired.', 404);
  const release = retainMediaPreview(project.id, filename, onInvalidate, false);
  try {
    const dir = projectDirectory(project.id);
    // A Range/HEAD for retired generation A must not renew the latest B's
    // lease. Resolve the requested generation under its own already held pin.
    const pointer = await readPointer(dir);
    const file = pointer?.signature === signature && publicationFilename(pointer) === filename
      ? await validatedPreview(dir, signature, pointer)
      : await retiredCopy(dir, signature, filename);
    if (!file || evicting.has(project.id) || evictingFiles.has(fileKey(project.id, filename))
      || invalidating.has(project.id)) throw new MediaPreviewError('Playback copy is not ready.', 404);
    // A failed lookup must not extend or erase another paused player's lease.
    touchPreview(project.id, filename);
    return { dir, filename, release: () => release() };
  } catch (error) { release(true); throw error; }
}

export async function mediaPreviewFile(project: ProjectMedia, filename: string) {
  const file = await acquireMediaPreviewFile(project, filename);
  file.release();
  return { dir: file.dir, filename: file.filename };
}

/** The route holds this exact generation until HTTP finish/close/error. */
export function retainMediaPreview(projectId: string, filename: string, onInvalidate?: () => void, renew = true) {
  projectDirectory(projectId);
  if (!/^[a-f0-9]{64}(?:\.[a-f0-9]{32})?\.mp4$/.test(filename) || evicting.has(projectId)
    || evictingFiles.has(fileKey(projectId, filename)) || invalidating.has(projectId)) {
    throw new MediaPreviewError('Playback copy expired.', 404);
  }
  const key = fileKey(projectId, filename);
  const existing = activeUses.get(key);
  const use = existing || { until: 0, readers: 0, aborters: new Set<() => void>() };
  activeUses.set(key, use);
  use.readers++;
  if (renew) touchPreview(projectId, filename);
  if (onInvalidate) use.aborters.add(onInvalidate);
  let released = false;
  return (discard = false) => {
    if (!released) {
      released = true; use.readers--;
      if (onInvalidate) use.aborters.delete(onInvalidate);
      if (discard && !existing && !use.readers && activeUses.get(key) === use) activeUses.delete(key);
    }
  };
}
