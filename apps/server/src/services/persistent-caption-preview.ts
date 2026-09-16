import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { planCaptionRenderStates, type CaptionAppearance, type CaptionPreviewFrame, type CaptionPreviewResult, type CaptionSegment } from '@kcs/shared';
import { config } from '../config.js';
import { buildAssCaptionFilter, buildAssDocument, preparePreviewFonts } from './caption-renderer.js';
import type { FontLease } from './preview-font-cache.js';

type Bounds = CaptionPreviewFrame['bounds'];
export interface PreviewScope { projectId: string; mediaIdentity: string }
interface FrameInput {
  captions: CaptionSegment[];
  appearance: CaptionAppearance;
  timesMs: number[];
  focusIndices?: number[];
}

/** Fixed-size, complete PPM packets avoid image2pipe waiting for a subsequent request
 * to fill its read buffer. Alternating seed dimensions deliberately reinitializes
 * FFmpeg's graph, reloading the ASS document without restarting the native process.
 * This retains the executable, NOT libass's glyph cache. The output canvas never changes.
 */
export function previewSeedPacket(size: 64 | 65): Buffer {
  const prefix = 'P6\n#';
  const suffix = `\n${size} ${size}\n255\n`;
  return Buffer.concat([
    Buffer.from(prefix + ' '.repeat(32_768 - size * size * 3 - Buffer.byteLength(prefix + suffix)) + suffix),
    Buffer.alloc(size * size * 3),
  ]);
}
const seeds = [previewSeedPacket(64), previewSeedPacket(65)];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Incremental, bounded PNG framing. Never search compressed image bytes for IEND. */
export class PreviewPngReader {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  push(chunk: Buffer): Buffer | null {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) throw new Error('Caption preview exceeded its image safety limit.');
    this.chunks.push(chunk);
    const data = Buffer.concat(this.chunks, this.bytes);
    if (data.length < 8) return null;
    if (!data.subarray(0, 8).equals(pngSignature)) throw new Error('Invalid native preview image.');
    for (let offset = 8; offset + 8 <= data.length;) {
      const length = data.readUInt32BE(offset);
      if (length > this.limit - 12) throw new Error('Invalid native preview image length.');
      const end = offset + length + 12;
      if (end > data.length) return null;
      if (data.toString('ascii', offset + 4, offset + 8) === 'IEND') {
        if (length !== 0 || end !== data.length) throw new Error('Unexpected native preview frames.');
        this.chunks = []; this.bytes = 0;
        return data;
      }
      offset = end;
    }
    return null;
  }
}

/** Static, escaped captions have no animation. Rebase only the active native state
 * to t=0, keeping overlaps in original order and preserving the exact ASS recipe.
 */
export function previewSample(input: FrameInput, atMs: number) {
  const state = planCaptionRenderStates(input.captions).find((item) => atMs >= item.atMs && atMs < item.endMs);
  const indices = state?.key ? state.key.split(',').map(Number) : [];
  const selected = new Set(input.focusIndices);
  return {
    captions: indices.map((index) => ({ ...input.captions[index], startMs: 0, endMs: 1000 })),
    focus: new Set(indices.flatMap((index, compact) => selected.has(index) ? [compact] : [])),
  };
}

interface PendingFrame {
  png?: Buffer;
  bounds?: Bounds;
  focusBounds?: Bounds;
  resolve(frame: Omit<CaptionPreviewFrame, 'atMs'>): void;
  reject(error: Error): void;
}

class NativePreviewWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: PendingFrame;
  private reader = new PreviewPngReader();
  private line = '';
  private sequence = 0;
  private closing?: Promise<void>;
  private closed?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private writing: Promise<unknown> = Promise.resolve();
  busy = false;
  touched = Date.now();
  readonly controller = new AbortController();

  constructor(
    readonly scope: PreviewScope,
    readonly key: string,
    readonly directory: string,
    readonly lease: FontLease,
    readonly width: number,
    readonly height: number,
    readonly focus: boolean,
    readonly alphaMode: boolean,
    readonly executable: string,
  ) {}

  private start() {
    const ass = buildAssCaptionFilter(path.join(this.directory, 'captions.ass'), this.lease.directory);
    const split = this.focus ? 'split=3[black][whitebase][focusbase]' : 'split[black][whitebase]';
    const focus = this.focus ? `;[focusbase]${buildAssCaptionFilter(path.join(this.directory, 'focus.ass'), this.lease.directory)},format=gray,bbox@focus=min_val=1,nullsink` : '';
    // Same black/white coverage recovery as the one-shot/export reference. Never
    // substitute ASS's alpha plane (which double-applies opacity on some builds).
    const filter = `[0:v]scale=${this.width}:${this.height},setsar=1,format=rgba,settb=1/1000,setpts=0,${split};[black]${ass},split[ink][subtract];[whitebase]lutrgb=r=255:g=255:b=255,${ass}[white];[white][subtract]blend=all_mode=subtract,format=gbrp,extractplanes=r,lut=y=255-val,split[alpha][mask];[ink][alpha]alphamerge,${this.alphaMode ? 'setparams=alpha_mode=premultiplied,' : ''}unpremultiply=inplace=1,format=rgba[png];[mask]bbox@caption=min_val=1,nullsink${focus}`;
    const child = spawn(this.executable, [
      '-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin',
      '-threads', '1', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0',
      '-f', 'image2pipe', '-framerate', '1', '-c:v', 'ppm', '-reinit_filter', '1',
      '-avioflags', 'direct', '-blocksize', '4096', '-i', 'pipe:0',
      '-filter_complex_threads', '1', '-filter_complex', filter,
      '-map', '[png]', '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1',
      '-flush_packets', '1', '-f', 'image2pipe', 'pipe:1',
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    diagnostics.starts += 1;
    this.closed = new Promise((resolve) => child.once('close', () => resolve()));
    const failed = () => { void this.dispose(new Error('The persistent caption preview stopped.')); };
    child.on('error', failed);
    child.stdin.on('error', failed);
    child.on('close', failed);
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        const png = this.reader.push(chunk);
        if (!png) return;
        if (!this.pending || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== this.width || png.readUInt32BE(20) !== this.height) throw new Error('Unexpected native preview dimensions.');
        this.pending.png = png; this.complete();
      } catch { void this.dispose(new Error('The persistent caption preview returned an invalid image.')); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.line += String(chunk);
      const lines = this.line.split(/\r?\n/);
      this.line = (lines.pop() || '').slice(-16_384);
      for (const line of lines) {
        const kind = /\[bbox@(caption|focus) [^\]]*\].*\bn:\d+/.exec(line)?.[1];
        if (!kind || !this.pending) continue;
        const box = /\bx1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/.exec(line);
        const bounds = box && Number(box[5]) > 0 && Number(box[6]) > 0
          ? { x: Number(box[1]), y: Number(box[3]), width: Number(box[5]), height: Number(box[6]) } : null;
        if (kind === 'caption') this.pending.bounds = bounds;
        else this.pending.focusBounds = bounds;
        this.complete();
      }
    });
  }

  private complete() {
    const pending = this.pending;
    if (!pending?.png || pending.bounds === undefined || (this.focus && pending.focusBounds === undefined)) return;
    this.pending = undefined;
    pending.resolve({ png: pending.png.toString('base64'), bounds: pending.bounds, ...(this.focus ? { focusBounds: pending.focusBounds } : {}) });
  }

  async render(input: FrameInput, signal?: AbortSignal): Promise<CaptionPreviewResult> {
    if (this.closing) throw new Error('Caption preview cancelled.');
    clearTimeout(this.idle);
    const abort = () => { void this.dispose(new Error('Caption preview cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    this.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const frames: CaptionPreviewFrame[] = [];
      for (const atMs of input.timesMs) {
        signal?.throwIfAborted(); this.controller.signal.throwIfAborted();
        const sample = previewSample(input, atMs);
        this.writing = Promise.all([
          fs.writeFile(path.join(this.directory, 'captions.ass'), buildAssDocument(sample.captions, input.appearance, this.width, this.height)),
          ...(this.focus ? [fs.writeFile(path.join(this.directory, 'focus.ass'), buildAssDocument(sample.captions, input.appearance, this.width, this.height, sample.focus))] : []),
        ]);
        await this.writing;
        signal?.throwIfAborted(); this.controller.signal.throwIfAborted();
        const frame = await new Promise<Omit<CaptionPreviewFrame, 'atMs'>>((resolve, reject) => {
          this.pending = { resolve, reject };
          if (!this.child) this.start();
          this.child!.stdin.write(seeds[this.sequence++ % 2]);
        });
        frames.push({ atMs, ...frame });
      }
      diagnostics.frames += frames.length;
      return { width: this.width, height: this.height, frames };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controller.signal.removeEventListener('abort', abort);
      this.busy = false;
      this.touched = Date.now();
      if (!this.closing) {
        this.idle = setTimeout(() => { void this.dispose(); }, 15_000);
        this.idle.unref();
      }
    }
  }

  dispose(error = new Error('Caption preview cancelled.')): Promise<void> {
    if (this.closing) return this.closing;
    clearTimeout(this.idle);
    // Publish the closing promise before a child event can re-enter disposal.
    this.closing = Promise.resolve().then(async () => {
      this.controller.abort();
      this.pending?.reject(error); this.pending = undefined;
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin.destroy(); child.kill();
        const hardKill = setTimeout(() => child.kill('SIGKILL'), 1500);
        hardKill.unref();
        await this.closed;
        clearTimeout(hardKill);
      } else if (child) await this.closed;
      await this.writing.catch(() => {});
      await fs.rm(this.directory, { recursive: true, force: true }).catch(() => {});
      this.lease.release();
      workers.delete(this);
    });
    return this.closing;
  }

  killAtExit() { this.child?.kill(); }
}

const workers = new Set<NativePreviewWorker>();
const admittedRequests = new Set<{ projectId: string; controller: AbortController }>();
/** Register before capability discovery so invalidation also covers requests
 * which have not allocated a worker yet. Release on every HTTP exit path.
 */
export function trackCaptionPreviewRequest(projectId: string) {
  const request = { projectId, controller: new AbortController() };
  admittedRequests.add(request);
  return { signal: request.controller.signal, release: () => { admittedRequests.delete(request); } };
}
let allocation: Promise<void> = Promise.resolve();
const diagnostics = { starts: 0, frames: 0, fallbacks: 0 };
let fallbackUntil = 0;
export function persistentPreviewDiagnostics() { return { ...diagnostics, workers: workers.size }; }

/** Serialize allocation only, never render work. The outer API already admits at
 * most two requests; worker count is bounded across idle and active projects too.
 */
export async function renderPersistentCaptionPreview(input: FrameInput, width: number, height: number, alphaMode: boolean, scope: PreviewScope, signal?: AbortSignal): Promise<CaptionPreviewResult | null> {
  if (Date.now() < fallbackUntil) return null;
  let worker: NativePreviewWorker | undefined;
  let acquired: FontLease | undefined;
  let directory: string | undefined;
  const allocate = allocation.then(async () => {
    signal?.throwIfAborted();
    const parent = path.join(config.exportDir, '.working');
    await fs.mkdir(parent, { recursive: true });
    directory = await fs.mkdtemp(path.join(parent, 'preview-session-'));
    acquired = await preparePreviewFonts(directory, input.appearance);
    signal?.throwIfAborted();
    const focus = Boolean(input.focusIndices?.length);
    const key = JSON.stringify([scope, width, height, acquired.directory, focus, config.ffmpegPath, alphaMode]);
    worker = [...workers].find((item) => item.key === key && !item.busy && !item.controller.signal.aborted);
    if (worker) { worker.busy = true; return; }
    for (const existing of [...workers].sort((a, b) => a.touched - b.touched)) {
      if (!existing.busy && (existing.scope.projectId === scope.projectId || workers.size >= 2)) await existing.dispose();
    }
    if (workers.size >= 2) throw new Error('Caption preview is busy. Try again shortly.');
    worker = new NativePreviewWorker(scope, key, directory, acquired, width, height, focus, alphaMode, config.ffmpegPath);
    workers.add(worker);
    worker.busy = true; // reserve before releasing serialized allocation
    directory = undefined; acquired = undefined; // worker owns scratch and lease now
  });
  allocation = allocate.then(() => {}, () => {});
  try {
    await allocate;
    if (signal?.aborted) { await worker!.dispose(); signal.throwIfAborted(); }
    const timeout = setTimeout(() => { void worker!.dispose(new Error('Caption preview timed out.')); }, 5000);
    try { return await worker!.render(input, signal); }
    catch (error) {
      await worker!.dispose();
      if (signal?.aborted || worker!.controller.signal.aborted && error instanceof Error && /cancelled|abort/i.test(error.message)) throw error;
      // Incompatible/crashed pipe transport falls back to the established native
      // renderer, never CSS, and cannot repeat a startup timeout on every edit.
      fallbackUntil = Date.now() + 60_000;
      diagnostics.fallbacks += 1;
      return null;
    } finally { clearTimeout(timeout); }
  } finally {
    acquired?.release();
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function disposePersistentCaptionPreviews(projectId?: string) {
  for (const request of admittedRequests) {
    if (!projectId || request.projectId === projectId) request.controller.abort();
  }
  // Await allocations already admitted before invalidation, then cancel and await
  // process close before the caller removes project/media files.
  await allocation;
  await Promise.all([...workers].filter((item) => !projectId || item.scope.projectId === projectId).map((item) => item.dispose()));
}

export async function retireIdleCaptionPreviews() {
  await Promise.all([...workers].filter((item) => !item.busy).map((item) => item.dispose()));
}

process.once('exit', () => { for (const worker of workers) worker.killAtExit(); });
