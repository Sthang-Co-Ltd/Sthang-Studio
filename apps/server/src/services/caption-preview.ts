import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  normalizeCaptionAppearance, resolveVideoDimensions,
  type CaptionAppearance, type CaptionPreviewResult, type CaptionSegment,
  type VideoExportCapabilities, type VideoResolutionPreset,
} from '@kcs/shared';
import { config } from '../config.js';
import { buildAssDocument, buildAssCaptionFilter, prepareCaptionFonts, requireCaptionFont } from './caption-renderer.js';

let activeRenders = 0;
const maxConcurrentRenders = 2;
export const maxPreviewFrames = 8;

const alphaModeSupportCache = new Map<string, boolean>();

/** Probe whether the installed FFmpeg runtime exposes setparams=alpha_mode=premultiplied.
 * FFmpeg 8.0+ added alpha_mode to setparams, which allows unpremultiply to correctly handle
 * the premultiplied ink stream without warnings. On FFmpeg 7.x and older, setparams does
 * not expose alpha_mode, but unpremultiply runs directly and faithfully without requiring it.
 */
export async function probeSetparamsAlphaMode(ffmpegPath: string = config.ffmpegPath): Promise<boolean> {
  const cached = alphaModeSupportCache.get(ffmpegPath);
  if (cached !== undefined) return cached;
  const supported = await new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1',
      '-frames:v', '1',
      '-vf', 'setparams=alpha_mode=premultiplied',
      '-f', 'null', '-',
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); resolve(false); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(!timedOut && code === 0);
    });
  }).catch(() => false);
  alphaModeSupportCache.set(ffmpegPath, supported);
  return supported;
}

export function resetSetparamsAlphaModeCache() {
  alphaModeSupportCache.clear();
}

/** Validate at the local API boundary; never interpolate client strings into a filtergraph. */
export function parseCaptionPreviewInput(value: unknown) {
  const input = value as { captions?: unknown; timesMs?: unknown; resolution?: unknown; focusIndices?: unknown; appearance?: Partial<CaptionAppearance> } | null;
  if (!input || !Array.isArray(input.captions) || !Array.isArray(input.timesMs)) throw new Error('Caption preview needs captions and sample times.');
  if (input.timesMs.length < 1 || input.timesMs.length > maxPreviewFrames) throw new Error(`Preview requests need between 1 and ${maxPreviewFrames} frames.`);
  const timesMs = input.timesMs.map((time) => {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 1_000_000_000) throw new Error('Invalid preview time.');
    return Math.floor(time);
  });
  if (timesMs.some((time, index) => index > 0 && time <= timesMs[index - 1])) throw new Error('Preview sample times must be strictly increasing.');
  const captions: CaptionSegment[] = input.captions.map((item, index) => {
    if (!item || typeof item.text !== 'string' || typeof item.startMs !== 'number' || typeof item.endMs !== 'number'
      || !Number.isFinite(item.startMs) || !Number.isFinite(item.endMs) || item.startMs < 0 || item.endMs < item.startMs || item.endMs > 1_000_000_000) {
      throw new Error('Invalid caption in preview request.');
    }
    // Only appearance evidence is needed: approval, locks, confidence and private context stay out.
    return { id: String(index), text: item.text, startMs: item.startMs, endMs: item.endMs };
  });
  if (!['source', '720p', '1080p', '1440p', '2160p'].includes(String(input.resolution))) throw new Error('Invalid preview resolution.');
  const focusIndices = input.focusIndices;
  if (focusIndices !== undefined && (!Array.isArray(focusIndices) || focusIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= captions.length))) throw new Error('Invalid caption focus selection.');
  return { captions, timesMs, resolution: input.resolution as VideoResolutionPreset, appearance: normalizeCaptionAppearance(input.appearance), focusIndices: focusIndices as number[] | undefined };
}

/** Bound subprocesses without building an unbounded queue behind rapid scrubbing. The browser
 * coalesces edits and retries a busy response; closing a project aborts its running process.
 */
export async function renderCaptionPreview(
  input: ReturnType<typeof parseCaptionPreviewInput>,
  capabilities: VideoExportCapabilities,
  signal?: AbortSignal,
): Promise<CaptionPreviewResult> {
  signal?.throwIfAborted();
  if (!capabilities.subtitlesFilter) throw new Error('This local video runtime cannot render the caption preview. Run System check before exporting video.');
  requireCaptionFont(capabilities.fonts, input.appearance);
  if (activeRenders >= maxConcurrentRenders) throw new Error('Caption preview is busy. Try again shortly.');
  activeRenders += 1;
  let workDir: string | undefined;
  try {
    const { width, height } = resolveVideoDimensions(capabilities.source.displayWidth, capabilities.source.displayHeight, input.resolution);
    // Guard decoded-frame allocation, not output choices. Unusually large sources can select a
    // supported output resolution; no hidden downscaling is used to claim an exact preview.
    if (width * height > 33_554_432) throw new Error('This preview exceeds the local 32-megapixel safety limit. Choose a smaller video output resolution in Export.');
    const parent = path.join(config.exportDir, '.working');
    await fs.mkdir(parent, { recursive: true });
    workDir = await fs.mkdtemp(path.join(parent, 'preview-'));
    const fonts = await prepareCaptionFonts(workDir, input.appearance);
    const assPath = path.join(workDir, 'captions.ass');
    await fs.writeFile(assPath, buildAssDocument(input.captions, input.appearance, width, height), 'utf8');
    signal?.throwIfAborted();
    // One native process prepares adjacent caption states, including overlaps, rather than
    // starting FFmpeg for every playback frame. PTS is the actual project timeline in ms.
    const pts = input.timesMs.reduceRight((rest, time, index) => index === input.timesMs.length - 1 ? String(time) : `if(eq(N,${index}),${time},${rest})`, '0');
    // Recover coverage from native renders on black and white. Using ASS's alpha plane
    // directly applies style opacity twice on some FFmpeg builds (visible on soft shadows
    // and translucent boxes). White minus black is transmission; 255 minus that is coverage.
    // This keeps the preview's browser compositing faithful to native opaque-video drawing.
    const ass = buildAssCaptionFilter(assPath, fonts);
    let focusFilter = '';
    if (input.focusIndices?.length) {
      const focusPath = path.join(workDir, 'focus.ass');
      await fs.writeFile(focusPath, buildAssDocument(input.captions, input.appearance, width, height, new Set(input.focusIndices)), 'utf8');
      focusFilter = `;[focusbase]${buildAssCaptionFilter(focusPath, fonts)},format=gray,bbox@focus=min_val=1[focusBounds]`;
    }
    const split = focusFilter ? 'split=3[black][whitebase][focusbase]' : 'split[black][whitebase]';
    const supportsAlphaMode = await probeSetparamsAlphaMode(config.ffmpegPath);
    const alphaParam = supportsAlphaMode ? 'setparams=alpha_mode=premultiplied,' : '';
    const filter = `[0:v]settb=1/1000,setpts='${pts}',${split};[black]${ass},split[ink][subtract];[whitebase]lutrgb=r=255:g=255:b=255,${ass}[white];[white][subtract]blend=all_mode=subtract,format=gbrp,extractplanes=r,lut=y=255-val,split[alpha][mask];[ink][alpha]alphamerge,${alphaParam}unpremultiply=inplace=1,format=rgba[png];[mask]bbox@caption=min_val=1[minmax]${focusFilter}`;
    const count = String(input.timesMs.length);
    const stderr = await runPreview([
      '-hide_banner', '-loglevel', 'info', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=1,format=rgba`,
      '-filter_complex_threads', '1', '-filter_complex', filter,
      '-map', '[png]', '-frames:v', count, '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1', path.join(workDir, '%02d.png'),
      '-map', '[minmax]', '-frames:v', count, '-f', 'null', '-',
      ...(focusFilter ? ['-map', '[focusBounds]', '-frames:v', count, '-f', 'null', '-'] : []),
    ], signal);
    const bounds = [...stderr.matchAll(/\[bbox@(caption|focus) [^\]]*\][^\r\n]*?\bn:(\d+)[^\r\n]*?\bx1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/g)];
    const boxFor = (kind: string, index: number) => {
      const box = bounds.find((match) => match[1] === kind && Number(match[2]) === index);
      return box && Number(box[7]) > 0 && Number(box[8]) > 0
        ? { x: Number(box[3]), y: Number(box[5]), width: Number(box[7]), height: Number(box[8]) } : null;
    };
    const frames = await Promise.all(input.timesMs.map(async (atMs, index) => {
      const image = await fs.readFile(path.join(workDir!, `${String(index + 1).padStart(2, '0')}.png`));
      return { atMs, png: image.toString('base64'), bounds: boxFor('caption', index), ...(focusFilter ? { focusBounds: boxFor('focus', index) } : {}) };
    }));
    signal?.throwIfAborted();
    return { width, height, frames };
  } finally {
    // Wait for process close before touching its files, particularly on Windows.
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeRenders -= 1;
  }
}

function runPreview(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let stopped: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (stopped) return;
      stopped = error;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    };
    const abort = () => stop(new Error('Caption preview cancelled.'));
    const timeout = setTimeout(() => stop(new Error('Caption preview timed out. Your captions and source media are unchanged.')), 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-256_000); });
    child.on('error', () => { stopped ||= new Error('The local caption renderer could not start. Run System check.'); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error('The local caption preview could not render. Run System check; your saved captions are unchanged.'));
      else resolve(stderr);
    });
  });
}
